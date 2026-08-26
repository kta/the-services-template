use url::{Origin, Url};

/// Parse and canonicalize the API origin embedded into the native binary.
/// Debug accepts only HTTP loopback; release accepts only HTTPS.
pub fn parse(raw: &str, release: bool) -> Result<String, String> {
    let url = Url::parse(raw).map_err(|error| format!("invalid API origin: {error}"))?;

    if url.username() != ""
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
        Origin::Tuple(_, _, _) => Ok(url.origin().ascii_serialization()),
        Origin::Opaque(_) => Err("API origin must have a network authority".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn release_accepts_https_and_canonicalizes_host() {
        assert_eq!(
            parse("HTTPS://Admin.Example.com:8443", true),
            Ok("https://admin.example.com:8443".to_owned())
        );
    }

    #[test]
    fn release_rejects_non_https_invalid_authority_and_components() {
        for raw in [
            "http://admin.example.com",
            "https://:443",
            "https://admin.example.com/path",
            "https://admin.example.com?query=1",
            "https://admin.example.com#fragment",
            "https://user:password@admin.example.com",
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
