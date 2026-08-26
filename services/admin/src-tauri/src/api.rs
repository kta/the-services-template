use crate::session::{select_refresh_cookie, SessionManager};
use crate::store::PlatformStore;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;
use url::Url;

const ALLOWED_METHODS: [&str; 4] = ["GET", "POST", "PATCH", "DELETE"];

#[derive(Debug, Clone, Deserialize)]
pub struct ApiRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: String,
}

pub fn validate_request(request: &ApiRequest) -> Result<(), String> {
    let method = request.method.to_ascii_uppercase();
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!("method is not allowed: {}", request.method));
    }
    if !request.path.starts_with("/api/") || request.path == "/api/" || request.path.contains('\\')
    {
        return Err("path must be a non-empty relative /api/ path".to_owned());
    }

    // Parsing against a sentinel authority rejects absolute and network-path
    // references. Fragments are never sent to an HTTP server.
    let parsed = Url::parse(&format!("https://tauri.invalid{}", request.path))
        .map_err(|error| format!("malformed path: {error}"))?;
    if parsed.host_str() != Some("tauri.invalid") || parsed.fragment().is_some() {
        return Err("path must be relative".to_owned());
    }
    let decoded_path = percent_decode(parsed.path())?;
    let segments: Vec<&str> = decoded_path.split('/').collect();
    if !decoded_path.starts_with("/api/")
        || segments
            .iter()
            .any(|segment| *segment == "." || *segment == "..")
    {
        return Err("path traversal is not allowed".to_owned());
    }

    for name in request.headers.keys() {
        let normalized = name.to_ascii_lowercase();
        if !matches!(normalized.as_str(), "authorization" | "content-type") {
            return Err(format!("request header is not allowed: {name}"));
        }
    }
    for (name, value) in &request.headers {
        if value
            .bytes()
            .any(|byte| byte == b'\r' || byte == b'\n' || byte == 0)
        {
            return Err(format!(
                "request header contains control characters: {name}"
            ));
        }
    }
    if method == "GET" && request.body.is_some() {
        return Err("GET requests cannot have a body".to_owned());
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

pub fn filter_response_headers<I, K, V>(headers: I) -> BTreeMap<String, String>
where
    I: IntoIterator<Item = (K, V)>,
    K: AsRef<str>,
    V: AsRef<str>,
{
    headers
        .into_iter()
        .filter(|(name, _)| !name.as_ref().eq_ignore_ascii_case("set-cookie"))
        .map(|(name, value)| {
            (
                name.as_ref().to_ascii_lowercase(),
                value.as_ref().to_owned(),
            )
        })
        .collect()
}

#[derive(Clone)]
pub struct ApiState {
    client: reqwest::Client,
    origin: String,
    session: SessionManager<PlatformStore>,
}

impl ApiState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client must build");
        Self {
            client,
            origin: env!("TAURI_ADMIN_API_ORIGIN").to_owned(),
            session: SessionManager::new(PlatformStore),
        }
    }

    async fn execute(&self, request: ApiRequest) -> Result<ApiResponse, String> {
        validate_request(&request)?;
        let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
            .map_err(|error| format!("invalid method: {error}"))?;
        let url = format!("{}{}", self.origin, request.path);
        let mut builder = self.client.request(method, url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(cookie) = self.session.cookie_header()? {
            builder = builder.header(reqwest::header::COOKIE, cookie);
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let response = match builder.send().await {
            Ok(response) => response,
            Err(error) => {
                self.session.handle_network_failure(&request.path)?;
                return Err(format!("API request failed: {error}"));
            }
        };
        let status = response.status().as_u16();
        let set_cookies: Vec<String> = response
            .headers()
            .get_all(reqwest::header::SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_owned))
            .collect();
        let set_cookie = select_refresh_cookie(set_cookies.iter().map(String::as_str));
        let headers = filter_response_headers(
            response
                .headers()
                .iter()
                .filter_map(|(name, value)| Some((name.as_str(), value.to_str().ok()?))),
        );
        let body = response
            .text()
            .await
            .map_err(|error| format!("API response read failed: {error}"))?;
        // A rotation race is a recoverable 401: another client already won
        // rotation and the server deliberately leaves the winning cookie
        // valid. Inspect the native-only body before applying refresh failure
        // deletion; the body is still held in Rust and is not exposed until
        // after the session transition is complete.
        let rotation_race = is_rotation_race(&request.path, status, &body);
        if !rotation_race {
            self.session
                .handle_response(&request.path, status, set_cookie.as_deref())?;
        }
        Ok(ApiResponse {
            status,
            headers,
            body,
        })
    }
}

fn is_rotation_race(path: &str, status: u16, body: &str) -> bool {
    path == "/api/auth/refresh"
        && (400..500).contains(&status)
        && serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|value| value.get("error")?.as_str().map(str::to_owned))
            .as_deref()
            == Some("rotation_race")
}

#[tauri::command]
pub async fn api_request(
    state: State<'_, ApiState>,
    method: String,
    path: String,
    headers: BTreeMap<String, String>,
    body: Option<String>,
) -> Result<ApiResponse, String> {
    state
        .execute(ApiRequest {
            method,
            path,
            headers,
            body,
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::{
        filter_response_headers, is_rotation_race, validate_request, ApiRequest, ApiResponse,
    };

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
            "/api/%2e%2e/secret",
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
    }

    #[test]
    fn redacts_set_cookie_from_response_headers() {
        let filtered = filter_response_headers([
            ("content-type", "application/json"),
            ("set-cookie", "rt=refresh-secret; HttpOnly"),
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
            headers: filtered,
            body: "{}".to_owned(),
        };
        let encoded = serde_json::to_string(&response).expect("response serializes");
        assert!(!encoded.contains("refresh-secret"));
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
    fn recognizes_only_refresh_rotation_race_as_recoverable_failure() {
        assert!(is_rotation_race(
            "/api/auth/refresh",
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
    }
}
