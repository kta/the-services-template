use crate::session::{select_refresh_cookie, SessionManager};
use crate::store::PlatformStore;
use serde::de::{self, MapAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::State;
use url::Url;

const ALLOWED_METHODS: [&str; 4] = ["GET", "POST", "PATCH", "DELETE"];
const MAX_METHOD_BYTES: usize = 16;
const MAX_PATH_BYTES: usize = 2_048;
const MAX_HEADER_COUNT: usize = 16;
const MAX_HEADER_NAME_BYTES: usize = 128;
const MAX_HEADER_VALUE_BYTES: usize = 8_192;
const MAX_REQUEST_HEADER_TOTAL_BYTES: usize = 16 * 8_192;
const MAX_REQUEST_BODY_BYTES: usize = 1_048_576;
// Tauri has already materialized an InvokeBody by the time a command handler
// receives it. Cap that envelope before deserializing bounded fields again, so
// a compromised renderer cannot make serde clone an arbitrarily large map.
const MAX_IPC_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
const MAX_IPC_JSON_DEPTH: usize = 256;
const MAX_RESPONSE_BODY_BYTES: usize = 4_194_304;
const MAX_RESPONSE_HEADER_COUNT: usize = 16;
const MAX_RESPONSE_HEADER_VALUE_BYTES: usize = 8_192;
const MAX_RESPONSE_HEADER_TOTAL_BYTES: usize = 64 * 1_024;
const MAX_SERIALIZED_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
// Bound the aggregate body memory held by simultaneous native requests. The
// per-response limit remains 4 MiB; this prevents eight concurrent responses
// from reserving 32 MiB before the renderer receives them.
const MAX_TOTAL_RESPONSE_BODY_BYTES: usize = 16 * 1024 * 1024;
const MAX_IN_FLIGHT_REQUESTS: usize = 8;
const REQUEST_TIMEOUT_SECONDS: u64 = 15;

#[derive(Debug, Clone)]
pub struct BoundedString<const MAX: usize>(String);

impl<const MAX: usize> BoundedString<MAX> {
    fn into_inner(self) -> String {
        self.0
    }
}

struct BoundedStringVisitor<const MAX: usize>;

impl<'de, const MAX: usize> Visitor<'de> for BoundedStringVisitor<MAX> {
    type Value = BoundedString<MAX>;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(formatter, "a string of at most {MAX} bytes")
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Self::Value, E> {
        if value.len() > MAX {
            return Err(E::custom(format!("string exceeds {MAX} bytes")));
        }
        Ok(BoundedString(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Self::Value, E> {
        if value.len() > MAX {
            return Err(E::custom(format!("string exceeds {MAX} bytes")));
        }
        Ok(BoundedString(value))
    }
}

impl<'de, const MAX: usize> Deserialize<'de> for BoundedString<MAX> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_str(BoundedStringVisitor)
    }
}

#[derive(Debug, Clone)]
pub struct BoundedHeaders(BTreeMap<String, String>);

impl BoundedHeaders {
    fn into_inner(self) -> BTreeMap<String, String> {
        self.0
    }
}

struct BoundedHeadersVisitor;

impl<'de> Visitor<'de> for BoundedHeadersVisitor {
    type Value = BoundedHeaders;

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("a bounded request header map")
    }

    fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
        let mut headers = BTreeMap::new();
        let mut normalized = HashSet::new();
        while let Some((name, value)) = map.next_entry::<
            BoundedString<MAX_HEADER_NAME_BYTES>,
            BoundedString<MAX_HEADER_VALUE_BYTES>,
        >()? {
            if headers.len() >= MAX_HEADER_COUNT {
                return Err(de::Error::custom("too many request headers"));
            }
            let name = name.into_inner();
            let normalized_name = name.to_ascii_lowercase();
            if !normalized.insert(normalized_name) {
                return Err(de::Error::custom("duplicate request header"));
            }
            headers.insert(name, value.into_inner());
        }
        Ok(BoundedHeaders(headers))
    }
}

impl<'de> Deserialize<'de> for BoundedHeaders {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_map(BoundedHeadersVisitor)
    }
}

#[derive(Debug, Clone)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct IpcApiRequest {
    method: BoundedString<MAX_METHOD_BYTES>,
    path: BoundedString<MAX_PATH_BYTES>,
    headers: BoundedHeaders,
    body: Option<BoundedString<MAX_REQUEST_BODY_BYTES>>,
}

/// Return a conservative upper bound for the UTF-8 JSON representation without
/// serializing the whole `Value`. Tauri has already materialized the invoke
/// envelope by the time the custom handler receives it; this additional check
/// prevents a compromised renderer from making the dispatcher allocate another
/// arbitrarily large serialized copy before bounded field deserialization.
fn json_value_within_limit(value: &serde_json::Value) -> bool {
    fn add(total: &mut usize, amount: usize) -> bool {
        let Some(next) = total.checked_add(amount) else {
            return false;
        };
        *total = next;
        next <= MAX_IPC_PAYLOAD_BYTES
    }

    fn add_escaped_string(total: &mut usize, value: &str) -> bool {
        // Every UTF-8 byte can conservatively expand to a six-byte `\uXXXX`
        // escape. The estimate may reject some valid values near the limit,
        // but it must never accept a value whose serialized form is larger.
        let Some(escaped) = value.len().checked_mul(6) else {
            return false;
        };
        add(total, escaped.saturating_add(2))
    }

    fn visit(value: &serde_json::Value, total: &mut usize, depth: usize) -> bool {
        if depth > MAX_IPC_JSON_DEPTH {
            return false;
        }
        match value {
            serde_json::Value::Null => add(total, 4),
            serde_json::Value::Bool(value) => add(total, if *value { 4 } else { 5 }),
            serde_json::Value::Number(value) => {
                // serde_json::Number is a bounded primitive in this build;
                // avoid serializing the containing object just to measure it.
                add(total, value.to_string().len())
            }
            serde_json::Value::String(value) => add_escaped_string(total, value),
            serde_json::Value::Array(values) => {
                if !add(total, 2) {
                    return false;
                }
                for (index, value) in values.iter().enumerate() {
                    if index > 0 && !add(total, 1) {
                        return false;
                    }
                    if !visit(value, total, depth.saturating_add(1)) {
                        return false;
                    }
                }
                true
            }
            serde_json::Value::Object(values) => {
                if !add(total, 2) {
                    return false;
                }
                for (index, (key, value)) in values.iter().enumerate() {
                    if index > 0 && !add(total, 1) {
                        return false;
                    }
                    if !add_escaped_string(total, key) || !add(total, 1) {
                        return false;
                    }
                    if !visit(value, total, depth.saturating_add(1)) {
                        return false;
                    }
                }
                true
            }
        }
    }

    let mut total = 0;
    visit(value, &mut total, 0)
}

/// Tauri has already parsed the invoke envelope by the time the custom
/// handler receives it. This is an additional application boundary, not a
/// replacement for an upstream raw-body limit.
pub(crate) fn ipc_payload_within_limit(body: &tauri::ipc::InvokeBody) -> bool {
    match body {
        tauri::ipc::InvokeBody::Json(value) => json_value_within_limit(value),
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.len() <= MAX_IPC_PAYLOAD_BYTES,
    }
}

fn decode_ipc_body(body: &tauri::ipc::InvokeBody) -> Result<IpcApiRequest, String> {
    if !ipc_payload_within_limit(body) {
        return Err("IPC request payload is too large".to_owned());
    }
    match body {
        tauri::ipc::InvokeBody::Json(value) => serde_json::from_value(value.clone())
            .map_err(|error| format!("invalid IPC request: {error}")),
        tauri::ipc::InvokeBody::Raw(bytes) => {
            serde_json::from_slice(bytes).map_err(|error| format!("invalid IPC request: {error}"))
        }
    }
}

fn decode_ipc_request(request: &tauri::ipc::Request<'_>) -> Result<ApiRequest, String> {
    let args = decode_ipc_body(request.body())?;
    Ok(ApiRequest {
        method: args.method.into_inner(),
        path: args.path.into_inner(),
        headers: args.headers.into_inner(),
        body: args.body.map(BoundedString::into_inner),
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

fn serialize_response_for_ipc(response: &ApiResponse) -> Result<Vec<u8>, String> {
    let encoded = serde_json::to_vec(response)
        .map_err(|error| format!("API response is not serializable: {error}"))?;
    if encoded.len() > MAX_SERIALIZED_RESPONSE_BYTES {
        return Err("serialized API response is too large".to_owned());
    }
    Ok(encoded)
}

fn json_string_upper_bound(value: &str) -> Option<usize> {
    let mut total = 2usize;
    for character in value.chars() {
        let additional = match character {
            '"' | '\\' | '\u{08}' | '\u{09}' | '\u{0a}' | '\u{0c}' | '\u{0d}' => 2,
            '\u{00}'..='\u{1f}' => 6,
            _ => character.len_utf8(),
        };
        total = total.checked_add(additional)?;
    }
    Some(total)
}

fn serialized_response_upper_bound(response: &ApiResponse) -> Option<usize> {
    let mut total = 1usize;
    let add = |total: &mut usize, amount| total.checked_add(amount).map(|next| *total = next);
    add(&mut total, json_string_upper_bound("status")?)?;
    add(&mut total, 1)?;
    add(&mut total, response.status.to_string().len())?;
    add(&mut total, 1)?;
    add(&mut total, json_string_upper_bound("headers")?)?;
    add(&mut total, 1)?;
    add(&mut total, 1)?;
    for (index, (name, value)) in response.headers.iter().enumerate() {
        if index > 0 {
            add(&mut total, 1)?;
        }
        add(&mut total, json_string_upper_bound(name)?)?;
        add(&mut total, 1)?;
        add(&mut total, json_string_upper_bound(value)?)?;
    }
    add(&mut total, 1)?;
    add(&mut total, 1)?;
    add(&mut total, json_string_upper_bound("body")?)?;
    add(&mut total, 1)?;
    add(&mut total, json_string_upper_bound(&response.body)?)?;
    add(&mut total, 1)?;
    Some(total)
}

pub fn validate_request(request: &ApiRequest) -> Result<(), String> {
    if request.method.len() > MAX_METHOD_BYTES {
        return Err("method is too large".to_owned());
    }
    let method = request.method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!("method is not allowed: {}", request.method));
    }
    if !request.path.starts_with("/api/") || request.path == "/api/" || request.path.contains('\\')
    {
        return Err("path must be a non-empty relative /api/ path".to_owned());
    }
    if request.path.len() > MAX_PATH_BYTES {
        return Err("path is too large".to_owned());
    }

    // Reject dot segments before URL parsing: `Url::parse` normalizes them,
    // which would otherwise make the raw request and the forwarded path
    // differ at the security boundary.
    let raw_path = request.path.split(['?', '#']).next().unwrap_or_default();
    for segment in raw_path.split('/') {
        let decoded = percent_decode(segment)?;
        if decoded == "." || decoded == ".." || decoded.contains(['/', '\\']) {
            return Err("path traversal is not allowed".to_owned());
        }
    }

    // Parsing against a sentinel authority rejects absolute and network-path
    // references. Fragments are never sent to an HTTP server.
    let parsed = Url::parse(&format!("https://tauri.invalid{}", request.path))
        .map_err(|error| format!("malformed path: {error}"))?;
    if parsed.host_str() != Some("tauri.invalid") || parsed.fragment().is_some() {
        return Err("path must be relative".to_owned());
    }
    let decoded_path = percent_decode(parsed.path())?;
    if decoded_path.contains(['\\', '?', '#']) || decoded_path.contains('%') {
        return Err("path must not contain encoded delimiters".to_owned());
    }
    if decoded_path.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
        return Err("path must not contain control characters".to_owned());
    }
    let segments: Vec<&str> = decoded_path.split('/').collect();
    if !decoded_path.starts_with("/api/")
        || segments
            .iter()
            .any(|segment| *segment == "." || *segment == "..")
    {
        return Err("path traversal is not allowed".to_owned());
    }

    if request.headers.len() > MAX_HEADER_COUNT {
        return Err("too many request headers".to_owned());
    }
    let mut normalized_headers = HashSet::new();
    for name in request.headers.keys() {
        if name.len() > MAX_HEADER_NAME_BYTES {
            return Err(format!("request header name is too large: {name}"));
        }
        let normalized = name.to_ascii_lowercase();
        if !matches!(normalized.as_str(), "authorization" | "content-type") {
            return Err(format!("request header is not allowed: {name}"));
        }
        if !normalized_headers.insert(normalized) {
            return Err(format!("duplicate request header is not allowed: {name}"));
        }
    }
    let mut total_header_bytes = 0usize;
    for (name, value) in &request.headers {
        if value.len() > MAX_HEADER_VALUE_BYTES {
            return Err(format!("request header value is too large: {name}"));
        }
        total_header_bytes = total_header_bytes
            .saturating_add(name.len())
            .saturating_add(value.len());
        if total_header_bytes > MAX_REQUEST_HEADER_TOTAL_BYTES {
            return Err("request headers are too large".to_owned());
        }
        if value.bytes().any(|byte| byte < 0x20 || byte == 0x7f) {
            return Err(format!(
                "request header contains control characters: {name}"
            ));
        }
    }
    if method == "GET" && request.body.is_some() {
        return Err("GET requests cannot have a body".to_owned());
    }
    if request
        .body
        .as_ref()
        .is_some_and(|body| body.len() > MAX_REQUEST_BODY_BYTES)
    {
        return Err("request body is too large".to_owned());
    }
    Ok(())
}

fn percent_decode(value: &str) -> Result<String, String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err("malformed percent escape".to_owned());
            }
            let high =
                hex(bytes[index + 1]).ok_or_else(|| "malformed percent escape".to_owned())?;
            let low = hex(bytes[index + 2]).ok_or_else(|| "malformed percent escape".to_owned())?;
            output.push((high << 4) | low);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(|_| "path is not valid UTF-8".to_owned())
}

fn hex(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn collect_set_cookie_headers<'a, I>(headers: I) -> Result<Vec<String>, String>
where
    I: Iterator<Item = &'a reqwest::header::HeaderValue>,
{
    const MAX_SET_COOKIE_COUNT: usize = 16;
    const MAX_SET_COOKIE_VALUE_BYTES: usize = 8 * 1024;
    const MAX_SET_COOKIE_TOTAL_BYTES: usize = 64 * 1024;
    let mut cookies = Vec::new();
    let mut total = 0usize;
    for value in headers {
        if cookies.len() >= MAX_SET_COOKIE_COUNT {
            return Err("too many Set-Cookie headers".to_owned());
        }
        let value = value
            .to_str()
            .map_err(|_| "Set-Cookie header is not valid ASCII".to_owned())?;
        if value.len() > MAX_SET_COOKIE_VALUE_BYTES {
            return Err("Set-Cookie header is too large".to_owned());
        }
        total = total
            .checked_add(value.len())
            .ok_or_else(|| "Set-Cookie headers are too large".to_owned())?;
        if total > MAX_SET_COOKIE_TOTAL_BYTES {
            return Err("Set-Cookie headers are too large".to_owned());
        }
        cookies.push(value.to_owned());
    }
    Ok(cookies)
}

pub fn filter_response_headers<I, K, V>(headers: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    const ALLOWED: [&str; 5] = [
        "cache-control",
        "content-type",
        "etag",
        "retry-after",
        "x-request-id",
    ];
    let mut filtered = BTreeMap::new();
    let mut total_bytes = 0usize;
    for (name, value) in headers {
        let normalized = name.as_ref().to_ascii_lowercase();
        if !ALLOWED.contains(&normalized.as_str())
            || value.as_ref().len() > MAX_RESPONSE_HEADER_VALUE_BYTES
            || value
                .as_ref()
                .bytes()
                .any(|byte| byte < 0x20 || byte == 0x7f)
        {
            continue;
        }
        let is_new = !filtered.contains_key(&normalized);
        if is_new && filtered.len() >= MAX_RESPONSE_HEADER_COUNT {
            continue;
        }
        let next_total = total_bytes
            .saturating_add(normalized.len())
            .saturating_add(value.as_ref().len());
        if next_total > MAX_RESPONSE_HEADER_TOTAL_BYTES {
            continue;
        }
        total_bytes = next_total;
        filtered.insert(normalized, value.as_ref().to_owned());
    }
    filtered
}

#[derive(Clone)]
pub struct ApiState {
    client: reqwest::Client,
    origin: String,
    session: SessionManager<PlatformStore>,
    in_flight: Arc<AtomicUsize>,
    auth_in_flight: Arc<AtomicBool>,
    response_bytes_in_flight: Arc<AtomicUsize>,
    // A clear and an in-flight auth response must be serialized. The epoch
    // makes the ordering explicit: a response that started before clear_session
    // may not write a new refresh cookie after the clear has completed.
    session_guard: Arc<Mutex<()>>,
    session_epoch: Arc<AtomicU64>,
}

impl ApiState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
            .http2_max_header_list_size(MAX_RESPONSE_HEADER_TOTAL_BYTES as u32)
            .build()
            .expect("reqwest client must build");
        Self {
            client,
            origin: env!("TAURI_ADMIN_API_ORIGIN").to_owned(),
            session: SessionManager::new(PlatformStore),
            in_flight: Arc::new(AtomicUsize::new(0)),
            auth_in_flight: Arc::new(AtomicBool::new(false)),
            response_bytes_in_flight: Arc::new(AtomicUsize::new(0)),
            session_guard: Arc::new(Mutex::new(())),
            session_epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    fn try_acquire_request(&self) -> Result<RequestPermit, String> {
        let mut current = self.in_flight.load(Ordering::Acquire);
        loop {
            if current >= MAX_IN_FLIGHT_REQUESTS {
                return Err("too many concurrent API requests".to_owned());
            }
            match self.in_flight.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Ok(RequestPermit(Arc::clone(&self.in_flight))),
                Err(next) => current = next,
            }
        }
    }

    fn try_acquire_auth(&self) -> Result<AuthPermit, String> {
        self.auth_in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| AuthPermit(Arc::clone(&self.auth_in_flight)))
            .map_err(|_| "authentication request already in progress".to_owned())
    }

    fn response_budget(&self) -> ResponseBudget {
        ResponseBudget {
            in_flight: Arc::clone(&self.response_bytes_in_flight),
            reserved: 0,
        }
    }

    async fn execute(&self, request: ApiRequest) -> Result<ApiResponse, String> {
        validate_request(&request)?;
        let request_epoch = self.session_epoch.load(Ordering::Acquire);
        let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
            .map_err(|error| format!("invalid method: {error}"))?;
        let url = format!("{}{}", self.origin, request.path);
        let mut builder = self.client.request(method, url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if should_attach_refresh_cookie(&request.path) {
            if let Some(cookie) = self.session.cookie_header()? {
                builder = builder.header(reqwest::header::COOKIE, cookie);
            }
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                let _session_guard = self
                    .session_guard
                    .lock()
                    .map_err(|_| "native session lock is poisoned".to_owned())?;
                if self.session_epoch.load(Ordering::Acquire) == request_epoch {
                    self.session.handle_network_failure(&request.path)?;
                }
                return Err(format!("API request failed: {error}"));
            }
        };
        let mut response_budget = self.response_budget();
        let status = response.status().as_u16();
        if response.status().is_redirection() {
            return Err("API redirects are not followed".to_owned());
        }
        let set_cookies = collect_set_cookie_headers(
            response
                .headers()
                .get_all(reqwest::header::SET_COOKIE)
                .iter(),
        )?;
        let set_cookie = select_refresh_cookie(set_cookies.iter().map(String::as_str));
        let headers = filter_response_headers(
            response
                .headers()
                .iter()
                .filter_map(|(name, value)| Some((name.as_str(), value.to_str().ok()?))),
        );
        if response
            .content_length()
            .is_some_and(|length| length > MAX_RESPONSE_BODY_BYTES as u64)
        {
            return Err("API response body is too large".to_owned());
        }
        let mut response = response;
        let mut body_bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| format!("API response read failed: {error}"))?
        {
            if body_bytes.len().saturating_add(chunk.len()) > MAX_RESPONSE_BODY_BYTES {
                return Err("API response body is too large".to_owned());
            }
            response_budget.reserve(chunk.len())?;
            body_bytes.extend_from_slice(&chunk);
        }
        let body = String::from_utf8(body_bytes)
            .map_err(|_| "API response is not valid UTF-8".to_owned())?;
        // A rotation race is a recoverable 401: another client already won
        // rotation and the server deliberately leaves the winning cookie
        // valid. Inspect the native-only body before applying refresh failure
        // deletion; the body is still held in Rust and is not exposed until
        // after the session transition is complete.
        let rotation_race = is_rotation_race(&request.path, status, &body);
        if !rotation_race {
            let _session_guard = self
                .session_guard
                .lock()
                .map_err(|_| "native session lock is poisoned".to_owned())?;
            if self.session_epoch.load(Ordering::Acquire) != request_epoch {
                return Err("native session changed while request was in flight".to_owned());
            }
            self.session
                .handle_response(&request.path, status, set_cookie.as_deref())?;
        }
        let response = ApiResponse {
            status,
            headers,
            body,
        };
        let encoded_bound = serialized_response_upper_bound(&response)
            .ok_or_else(|| "serialized API response is too large".to_owned())?;
        if encoded_bound > MAX_SERIALIZED_RESPONSE_BYTES {
            return Err("serialized API response is too large".to_owned());
        }
        response_budget.reserve(encoded_bound)?;
        let encoded = serialize_response_for_ipc(&response)?;
        if encoded.len() > encoded_bound {
            return Err("serialized API response exceeds its memory bound".to_owned());
        }
        response_budget.release(encoded_bound - encoded.len());
        Ok(response)
    }
}

struct RequestPermit(Arc<AtomicUsize>);

impl Drop for RequestPermit {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

struct AuthPermit(Arc<AtomicBool>);

impl Drop for AuthPermit {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct ResponseBudget {
    in_flight: Arc<AtomicUsize>,
    reserved: usize,
}

impl ResponseBudget {
    fn reserve(&mut self, amount: usize) -> Result<(), String> {
        if amount == 0 {
            return Ok(());
        }
        let mut current = self.in_flight.load(Ordering::Acquire);
        loop {
            let next = current
                .checked_add(amount)
                .ok_or_else(|| "native response memory budget exceeded".to_owned())?;
            if next > MAX_TOTAL_RESPONSE_BODY_BYTES {
                return Err("native response memory budget exceeded".to_owned());
            }
            match self.in_flight.compare_exchange_weak(
                current,
                next,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    self.reserved += amount;
                    return Ok(());
                }
                Err(next_current) => current = next_current,
            }
        }
    }

    fn release(&mut self, amount: usize) {
        if amount == 0 {
            return;
        }
        debug_assert!(amount <= self.reserved);
        self.reserved -= amount;
        self.in_flight.fetch_sub(amount, Ordering::AcqRel);
    }
}

impl Drop for ResponseBudget {
    fn drop(&mut self) {
        self.in_flight.fetch_sub(self.reserved, Ordering::AcqRel);
    }
}

fn is_auth_path(path: &str) -> bool {
    matches!(
        path.split_once('?').map_or(path, |(path, _)| path),
        "/api/auth/login" | "/api/auth/refresh" | "/api/auth/logout" | "/api/auth/accept-invite"
    )
}

fn should_attach_refresh_cookie(path: &str) -> bool {
    matches!(
        path.split_once('?').map_or(path, |(path, _)| path),
        "/api/auth/refresh" | "/api/auth/logout"
    )
}

fn is_rotation_race(path: &str, status: u16, body: &str) -> bool {
    path.split_once('?').map_or(path, |(path, _)| path) == "/api/auth/refresh"
        && status == 401
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
            .as_deref()
            == Some("rotation_race")
}

#[tauri::command]
pub async fn api_request(
    state: State<'_, ApiState>,
    request: tauri::ipc::Request<'_>,
) -> Result<ApiResponse, String> {
    let _request_permit = state.try_acquire_request()?;
    let request = decode_ipc_request(&request)?;
    let path = request.path.clone();
    let _auth_permit = if is_auth_path(&path) {
        Some(state.try_acquire_auth()?)
    } else {
        None
    };
    state.execute(request).await
}

#[tauri::command]
pub fn clear_session(state: State<'_, ApiState>) -> Result<(), String> {
    let _session_guard = state
        .session_guard
        .lock()
        .map_err(|_| "native session lock is poisoned".to_owned())?;
    state.session_epoch.fetch_add(1, Ordering::AcqRel);
    state.session.clear()
}

#[cfg(test)]
mod tests {
    use super::{
        collect_set_cookie_headers, decode_ipc_body, filter_response_headers,
        ipc_payload_within_limit, is_rotation_race, serialize_response_for_ipc,
        serialized_response_upper_bound, should_attach_refresh_cookie, validate_request,
        ApiRequest, ApiResponse, ApiState, BoundedHeaders, BoundedString,
    };
    use std::sync::atomic::Ordering;

    #[test]
    fn accepts_only_api_methods_and_relative_paths() {
        for method in ["GET", "POST", "PATCH", "DELETE"] {
            let request = ApiRequest {
                method: method.to_owned(),
                path: "/api/organizations?limit=10".to_owned(),
                headers: Default::default(),
                body: None,
            };
            assert!(validate_request(&request).is_ok(), "{method}");
        }

        for path in [
            "https://evil.example/api/auth/refresh",
            "//evil.example/api/auth/refresh",
            "/api/../secret",
            "/api/organizations/../secret",
            "/api/%2e%2e/secret",
            "/api/%252e%252e/secret",
            "/api/%255cadmin",
            "/api/items%5Cadmin",
            "/api/items%2Fadmin",
            "/api/items%3Fadmin",
            "/api/items%23admin",
            "/api/items\\admin",
            "/health",
            "/api",
            "/api/",
        ] {
            let request = ApiRequest {
                method: "GET".to_owned(),
                path: path.to_owned(),
                headers: Default::default(),
                body: None,
            };
            assert!(validate_request(&request).is_err(), "accepted {path}");
        }
    }

    #[test]
    fn rejects_unsupported_methods_and_credential_authority_headers() {
        let request = |method: &str, header: Option<(&str, &str)>| ApiRequest {
            method: method.to_owned(),
            path: "/api/health".to_owned(),
            headers: header
                .map(|(name, value)| [(name.to_owned(), value.to_owned())].into_iter().collect())
                .unwrap_or_default(),
            body: None,
        };

        assert!(validate_request(&request("PUT", None)).is_err());
        for name in ["cookie", "host", "origin", "set-cookie", "x-request-id"] {
            assert!(
                validate_request(&request("GET", Some((name, "secret")))).is_err(),
                "{name}"
            );
        }
        assert!(validate_request(&request("GET", Some(("authorization", "Bearer x")))).is_ok());
        assert!(
            validate_request(&request("POST", Some(("content-type", "application/json")))).is_ok()
        );

        let mut duplicate = ApiRequest {
            method: "GET".to_owned(),
            path: "/api/health".to_owned(),
            headers: Default::default(),
            body: None,
        };
        duplicate
            .headers
            .insert("Authorization".to_owned(), "Bearer one".to_owned());
        duplicate
            .headers
            .insert("authorization".to_owned(), "Bearer two".to_owned());
        assert!(validate_request(&duplicate).is_err());
    }

    #[test]
    fn redacts_set_cookie_from_response_headers() {
        let filtered = filter_response_headers([
            ("content-type", "application/json"),
            ("set-cookie", "rt=refresh-secret; HttpOnly"),
            ("set-cookie2", "other-secret"),
            ("location", "https://evil.example"),
            ("server", "origin-detail"),
            ("x-request-id", "abc"),
        ]);
        assert_eq!(
            filtered.get("content-type"),
            Some(&"application/json".to_owned())
        );
        assert_eq!(filtered.get("x-request-id"), Some(&"abc".to_owned()));
        assert!(!filtered
            .keys()
            .any(|name| name.eq_ignore_ascii_case("set-cookie")));
        let response = ApiResponse {
            status: 200,
            headers: filtered.clone(),
            body: "{}".to_owned(),
        };
        let encoded = serde_json::to_string(&response).expect("response serializes");
        assert!(!encoded.contains("refresh-secret"));
        assert!(!filtered.contains_key("location"));
        assert!(!filtered.contains_key("set-cookie2"));
        assert!(!filtered.contains_key("server"));
    }

    #[test]
    fn rejects_header_control_characters_before_request_is_sent() {
        for value in ["Bearer secret\r\nX-Leak: yes", "application/json\0"] {
            let request = ApiRequest {
                method: "GET".to_owned(),
                path: "/api/health".to_owned(),
                headers: [("authorization".to_owned(), value.to_owned())]
                    .into_iter()
                    .collect(),
                body: None,
            };
            assert!(
                validate_request(&request).is_err(),
                "accepted unsafe header"
            );
        }
    }

    #[test]
    fn rejects_oversized_ipc_fields_before_request_is_sent() {
        let mut request = ApiRequest {
            method: "POST".to_owned(),
            path: format!("/api/{}", "a".repeat(2_044)),
            headers: [("content-type".to_owned(), "x".repeat(8_193))]
                .into_iter()
                .collect(),
            body: Some("x".repeat(1_048_577)),
        };
        assert!(validate_request(&request).is_err());

        request.path = "/api/health".to_owned();
        request.headers.clear();
        request.body = Some("x".repeat(1_048_577));
        assert!(validate_request(&request).is_err());

        request.body = None;
        request.headers = (0..17)
            .map(|index| (format!("authorization-{index}"), "value".to_owned()))
            .collect();
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn bounded_command_deserialization_rejects_large_fields_and_maps() {
        assert!(
            serde_json::from_str::<BoundedString<16>>(&format!("\"{}\"", "x".repeat(17))).is_err()
        );
        assert!(serde_json::from_str::<BoundedString<1_048_576>>(&format!(
            "\"{}\"",
            "x".repeat(1_048_577)
        ))
        .is_err());
        let entries = (0..17)
            .map(|index| format!("\"x-{index}\":\"v\""))
            .collect::<Vec<_>>()
            .join(",");
        assert!(serde_json::from_str::<BoundedHeaders>(&format!("{{{entries}}}")).is_err());
    }

    #[test]
    fn ipc_envelope_is_bounded_before_field_deserialization() {
        let body = serde_json::json!({
            "method": "POST",
            "path": "/api/items",
            "headers": {},
            "body": "x".repeat(super::MAX_IPC_PAYLOAD_BYTES),
        });
        let invoke_body = tauri::ipc::InvokeBody::Json(body);
        assert!(super::decode_ipc_body(&invoke_body).is_err());
    }

    #[test]
    fn dispatcher_budget_checks_json_and_raw_invoke_bodies() {
        let small = tauri::ipc::InvokeBody::Json(serde_json::json!({
            "method": "GET",
            "path": "/api/organizations",
            "headers": {},
            "body": null,
        }));
        assert!(ipc_payload_within_limit(&small));

        let large_json = tauri::ipc::InvokeBody::Json(serde_json::json!({
            "body": "x".repeat(super::MAX_IPC_PAYLOAD_BYTES),
        }));
        assert!(!ipc_payload_within_limit(&large_json));

        let large_raw = tauri::ipc::InvokeBody::Raw(vec![0; super::MAX_IPC_PAYLOAD_BYTES + 1]);
        assert!(!ipc_payload_within_limit(&large_raw));
    }

    #[test]
    fn dispatcher_json_budget_is_checked_without_serializing_an_unbounded_value() {
        let nested = serde_json::json!({
            "outer": [
                serde_json::json!({
                    "body": "x".repeat(super::MAX_IPC_PAYLOAD_BYTES * 2),
                }),
            ],
        });
        assert!(!ipc_payload_within_limit(&tauri::ipc::InvokeBody::Json(
            nested
        )));
    }

    #[test]
    fn dispatcher_rejects_excessive_json_nesting() {
        let mut nested = serde_json::Value::Null;
        for _ in 0..=super::MAX_IPC_JSON_DEPTH {
            nested = serde_json::Value::Array(vec![nested]);
        }
        assert!(!ipc_payload_within_limit(&tauri::ipc::InvokeBody::Json(
            nested
        )));
    }

    #[test]
    fn rejects_unknown_ipc_fields() {
        let body = serde_json::json!({
            "method": "GET",
            "path": "/api/organizations",
            "headers": {},
            "body": null,
            "unexpected": "renderer-controlled field",
        });
        let invoke_body = tauri::ipc::InvokeBody::Json(body);
        assert!(decode_ipc_body(&invoke_body).is_err());
    }

    #[test]
    fn caps_serialized_response_expansion() {
        let response = ApiResponse {
            status: 200,
            headers: Default::default(),
            body: "\0".repeat(super::MAX_SERIALIZED_RESPONSE_BYTES / 6 + 1),
        };
        assert!(serialize_response_for_ipc(&response).is_err());
    }

    #[test]
    fn serialized_response_bound_covers_json_escaping_before_encoding() {
        let response = ApiResponse {
            status: 200,
            headers: [("x\"name".to_owned(), "line\nvalue".to_owned())]
                .into_iter()
                .collect(),
            body: "日本語\0".to_owned(),
        };
        let encoded = serialize_response_for_ipc(&response).expect("response serializes");
        assert!(serialized_response_upper_bound(&response).unwrap() >= encoded.len());
    }

    #[test]
    fn bounds_set_cookie_headers_before_collecting_them() {
        let headers = (0..17)
            .map(|_| reqwest::header::HeaderValue::from_static("rt=short"))
            .collect::<Vec<_>>();
        assert!(collect_set_cookie_headers(headers.iter()).is_err());
        let huge = reqwest::header::HeaderValue::from_str(&format!("rt={}", "x".repeat(8_193)))
            .expect("header value");
        assert!(collect_set_cookie_headers([huge].iter()).is_err());
    }

    #[test]
    fn native_api_has_request_and_auth_concurrency_limits() {
        let state = ApiState::new();
        let mut permits = (0..8)
            .map(|_| state.try_acquire_request().expect("request slot"))
            .collect::<Vec<_>>();
        assert!(state.try_acquire_request().is_err());
        drop(permits.pop());
        assert!(state.try_acquire_request().is_ok());

        let auth = state.try_acquire_auth().expect("auth slot");
        assert!(state.try_acquire_auth().is_err());
        drop(auth);
        assert!(state.try_acquire_auth().is_ok());
    }

    #[test]
    fn native_api_limits_aggregate_response_memory() {
        let state = ApiState::new();
        let mut budget = state.response_budget();
        assert!(budget.reserve(super::MAX_TOTAL_RESPONSE_BODY_BYTES).is_ok());
        assert!(budget.reserve(1).is_err());
        drop(budget);

        let mut next = state.response_budget();
        assert!(next.reserve(1).is_ok());
    }

    #[test]
    fn recognizes_only_refresh_rotation_race_as_recoverable_failure() {
        assert!(is_rotation_race(
            "/api/auth/refresh",
            401,
            r#"{ "error": "rotation_race" }"#
        ));
        assert!(is_rotation_race(
            "/api/auth/refresh?source=native",
            401,
            r#"{ "error": "rotation_race" }"#
        ));
        assert!(!is_rotation_race(
            "/api/auth/refresh",
            401,
            r#"{"error":"invalid"}"#
        ));
        assert!(!is_rotation_race(
            "/api/auth/login",
            401,
            r#"{"error":"rotation_race"}"#
        ));
        assert!(!is_rotation_race(
            "/api/auth/refresh",
            403,
            r#"{"error":"rotation_race"}"#
        ));
    }

    #[test]
    fn sends_the_native_refresh_cookie_only_to_refresh_and_logout() {
        assert!(should_attach_refresh_cookie("/api/auth/refresh"));
        assert!(should_attach_refresh_cookie(
            "/api/auth/logout?source=native"
        ));
        assert!(!should_attach_refresh_cookie("/api/auth/login"));
        assert!(!should_attach_refresh_cookie("/api/auth/accept-invite"));
        assert!(!should_attach_refresh_cookie("/api/organizations"));
    }

    #[test]
    fn clearing_session_invalidates_an_in_flight_response_epoch() {
        let state = ApiState::new();
        let request_epoch = state.session_epoch.load(Ordering::Acquire);
        state.session_epoch.fetch_add(1, Ordering::AcqRel);
        assert_ne!(state.session_epoch.load(Ordering::Acquire), request_epoch);
    }
}
