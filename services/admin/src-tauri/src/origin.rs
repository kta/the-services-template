use url::{Origin, Url};

#[cfg_attr(not(debug_assertions), allow(dead_code))]
const APPROVED_RELEASE_ORIGINS: [&str; 1] = ["https://admin.example.com"];

/// Parse and canonicalize the API origin embedded into the native binary.
/// Debug accepts only HTTP loopback; release accepts one exact HTTPS origin.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
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
    #[cfg(not(debug_assertions))]
    let _ = debug_origin;
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
            "http://localhost:5174/invite",
        ] {
            assert!(
                navigation_allowed(
                    &url::Url::parse(raw).unwrap(),
                    env!("TAURI_ADMIN_API_ORIGIN")
                ),
                "rejected app navigation: {raw}"
            );
        }
        for raw in [
            "https://attacker.example/",
            "https://admin.example.com/",
            "http://localhost:5173/",
            "http://tauri.localhost:8443/",
            "https://user:pass@tauri.localhost/",
            "http://user:pass@localhost:5174/",
        ] {
            assert!(
                !navigation_allowed(
                    &url::Url::parse(raw).unwrap(),
                    env!("TAURI_ADMIN_API_ORIGIN")
                ),
                "accepted external navigation: {raw}"
            );
        }
    }

    #[test]
    fn release_accepts_https_and_canonicalizes_host() {
        assert_eq!(
            parse("HTTPS://Admin.Example.com", true),
            Ok("https://admin.example.com".to_owned())
        );
    }

    #[test]
    fn release_rejects_non_https_invalid_authority_and_components() {
        for raw in [
            "http://admin.example.com",
            "https://:443",
            "https://admin.example.com/path",
            "https://admin.example.com?query=1",
            "https://admin.example.com:8443",
            "https://evil.example.com",
            "https://admin.example.com#fragment",
            "https://user:password@admin.example.com",
            "https://@admin.example.com",
        ] {
            assert!(parse(raw, true).is_err(), "accepted invalid origin: {raw}");
        }
    }

    #[test]
    fn debug_accepts_only_http_loopback() {
        for raw in [
            "http://localhost:5174",
            "http://127.0.0.1:5174",
            "http://[::1]:5174",
        ] {
            assert!(parse(raw, false).is_ok(), "rejected loopback origin: {raw}");
        }
        for raw in [
            "https://localhost:5174",
            "http://localhost.example.com:5174",
            "http://192.168.1.2:5174",
        ] {
            assert!(
                parse(raw, false).is_err(),
                "accepted non-loopback origin: {raw}"
            );
        }
    }
}
