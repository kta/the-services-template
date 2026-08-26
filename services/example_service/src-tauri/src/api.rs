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
}

impl ApiState {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("reqwest client must build");
        Self {
            client,
            origin: env!("TAURI_EXAMPLE_API_ORIGIN").to_owned(),
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
        if let Some(body) = request.body {
            builder = builder.body(body);
        }

        let response = builder
            .send()
            .await
            .map_err(|error| format!("API request failed: {error}"))?;
        let status = response.status().as_u16();
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
        Ok(ApiResponse {
            status,
            headers,
            body,
        })
    }
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
    use super::{filter_response_headers, validate_request, ApiRequest};
    use std::collections::BTreeMap;

    fn request(method: &str, path: &str) -> ApiRequest {
        ApiRequest {
            method: method.to_owned(),
            path: path.to_owned(),
            headers: BTreeMap::new(),
            body: None,
        }
    }

    #[test]
    fn accepts_only_the_api_methods_and_relative_api_paths() {
        for method in ["GET", "post", "PATCH", "DELETE"] {
            assert!(
                validate_request(&request(method, "/api/items?limit=10")).is_ok(),
                "{method}"
            );
        }

        for method in ["PUT", "HEAD", "OPTIONS"] {
            assert!(
                validate_request(&request(method, "/api/items")).is_err(),
                "{method}"
            );
        }
        for path in [
            "https://evil.example/api/items",
            "//evil.example/api/items",
            "/health",
            "/api",
            "/api/",
            "/api/../secret",
            "/api/%2e%2e/secret",
            "/api/items\\admin",
            "/api/items#fragment",
        ] {
            assert!(validate_request(&request("GET", path)).is_err(), "{path}");
        }
    }

    #[test]
    fn rejects_unapproved_headers_and_header_control_characters() {
        for name in ["cookie", "host", "origin", "set-cookie", "x-request-id"] {
            let mut request = request("GET", "/api/items");
            request.headers.insert(name.to_owned(), "value".to_owned());
            assert!(validate_request(&request).is_err(), "{name}");
        }
        for value in ["Bearer good\r\nbad", "bad\n", "bad\r", "bad\0"] {
            let mut request = request("GET", "/api/items");
            request
                .headers
                .insert("authorization".to_owned(), value.to_owned());
            assert!(validate_request(&request).is_err(), "{value:?}");
        }
    }

    #[test]
    fn rejects_get_bodies_and_filters_set_cookie_from_responses() {
        let mut request = request("GET", "/api/items");
        request.body = Some("unexpected".to_owned());
        assert!(validate_request(&request).is_err());

        let headers = filter_response_headers([
            ("Content-Type", "application/json"),
            ("set-cookie", "session=secret"),
            ("X-Request-Id", "request-1"),
        ]);
        assert_eq!(
            headers.get("content-type"),
            Some(&"application/json".to_owned())
        );
        assert_eq!(headers.get("x-request-id"), Some(&"request-1".to_owned()));
        assert!(!headers.contains_key("set-cookie"));
    }
}
