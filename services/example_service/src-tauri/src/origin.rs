use url::{Origin, Url};

/// Parse and canonicalize the API origin embedded into the native binary.
/// Debug accepts only HTTP loopback; release accepts only HTTPS.
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
        Origin::Tuple(_, _, _) => Ok(url.origin().ascii_serialization()),
        Origin::Opaque(_) => Err("API origin must have a network authority".to_owned()),
    }
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn accepts_localhost_debug_origin_without_a_trailing_slash() {
        assert_eq!(
            parse("http://localhost:5173", false).unwrap(),
            "http://localhost:5173"
        );
    }

    #[test]
    fn accepts_https_release_origin() {
        assert_eq!(
            parse("https://example.test", true).unwrap(),
            "https://example.test"
        );
    }

    #[test]
    fn rejects_release_http_and_debug_remote_origins() {
        assert!(parse("http://example.test", true).is_err());
        assert!(parse("http://192.0.2.10:5173", false).is_err());
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
