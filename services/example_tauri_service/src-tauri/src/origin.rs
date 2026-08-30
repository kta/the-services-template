use url::{Origin, Url};

const APPROVED_RELEASE_ORIGINS: [&str; 1] = ["https://example.example.com"];

/// Parse and canonicalize the API origin embedded into the native binary.
/// Debug accepts only HTTP loopback; release accepts one exact HTTPS origin.
pub fn parse(raw: &str, release: bool) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|error| format!("invalid API origin: {error}"))?;
    let has_userinfo_delimiter = raw
        .split_once("://")
        .and_then(|(_, rest)| rest.split(['/', '?', '#']).next())
        .is_some_and(|authority| authority.contains('@'));

    if has_userinfo_delimiter
        || url.username() != ""
        || url.password().is_some()
        // url::Url normalizes an authority-only URL to `/`; reject an
        // explicitly supplied slash while still accepting `https://host`.
        || raw.ends_with('/')
        || (url.path() != "" && url.path() != "/")
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_none()
    {
        return Err("API origin must contain only scheme, host, and optional port".to_owned());
    }

    let allowed = if release {
        url.scheme() == "https"
    } else {
        url.scheme() == "http"
            && matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
            )
    };
    if !allowed {
        return Err(if release {
            "release API origin must use HTTPS".to_owned()
        } else {
            "debug API origin must be HTTP on localhost or loopback".to_owned()
        });
    }

    match url.origin() {
        Origin::Tuple(_, _, _) => {
            let canonical = url.origin().ascii_serialization();
            if release && !APPROVED_RELEASE_ORIGINS.contains(&canonical.as_str()) {
                return Err("release API origin is not approved for this application".to_owned());
            }
            Ok(canonical)
        }
        Origin::Opaque(_) => Err("API origin must have a network authority".to_owned()),
    }
}

/// Keep top-level WebView navigation inside the Tauri asset origin. In debug,
/// the one exact loopback Vite origin compiled by build.rs is also allowed.
/// API requests do not use WebView navigation; they go through the Rust
/// bridge, so the production API origin is intentionally not a navigable page.
#[allow(dead_code)]
pub fn navigation_allowed(url: &Url, debug_origin: &str) -> bool {
    let local_asset = (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (matches!(url.scheme(), "http" | "https")
            && url.host_str() == Some("tauri.localhost")
            && url.port().is_none());
    if local_asset && url.username().is_empty() && url.password().is_none() && url.port().is_none()
    {
        return true;
    }

    #[cfg(debug_assertions)]
    {
        url.username().is_empty()
            && url.password().is_none()
            && parse(debug_origin, false)
                .map(|origin| url.origin().ascii_serialization() == origin)
                .unwrap_or(false)
    }

    #[cfg(not(debug_assertions))]
    false
}

#[cfg(test)]
mod tests {
    use super::{navigation_allowed, parse};

    #[test]
    fn navigation_allows_only_the_embedded_app_or_debug_origin() {
        for raw in [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
            "http://localhost:5175/items",
        ] {
            assert!(
                navigation_allowed(
                    &url::Url::parse(raw).unwrap(),
                    env!("TAURI_EXAMPLE_TAURI_SERVICE_API_ORIGIN")
                ),
                "rejected app navigation: {raw}"
            );
        }
        for raw in [
            "https://attacker.example/",
            "https://example.example.com/",
            "http://localhost:5174/",
            "http://tauri.localhost:8443/",
            "https://user:pass@tauri.localhost/",
            "http://user:pass@localhost:5175/",
        ] {
            assert!(
                !navigation_allowed(
                    &url::Url::parse(raw).unwrap(),
                    env!("TAURI_EXAMPLE_TAURI_SERVICE_API_ORIGIN")
                ),
                "accepted external navigation: {raw}"
            );
        }
    }

    #[test]
    fn accepts_localhost_debug_origin_without_a_trailing_slash() {
        assert_eq!(
            parse("http://localhost:5175", false).unwrap(),
            "http://localhost:5175"
        );
    }

    #[test]
    fn accepts_https_release_origin() {
        assert_eq!(
            parse("https://example.example.com", true).unwrap(),
            "https://example.example.com"
        );
    }

    #[test]
    fn rejects_release_http_and_debug_remote_origins() {
        assert!(parse("http://example.test", true).is_err());
        assert!(parse("https://example.test", true).is_err());
        assert!(parse("https://example.example.com:8443", true).is_err());
        assert!(parse("http://192.0.2.10:5175", false).is_err());
    }

    #[test]
    fn rejects_origin_with_path_query_fragment_userinfo_or_trailing_slash() {
        for raw in [
            "https://example.test/api",
            "https://example.test?tenant=one",
            "https://example.test#fragment",
            "https://user:pass@example.test",
            "https://@example.test",
            "https://example.test/",
        ] {
            assert!(parse(raw, true).is_err(), "accepted invalid origin: {raw}");
        }
    }
}
