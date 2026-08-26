use crate::store::SessionStore;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    Authenticated,
    SignedOut,
}

#[derive(Clone)]
pub struct SessionManager<S: SessionStore> {
    store: S,
}

/// Select the last refresh-cookie header. HTTP permits unrelated Set-Cookie
/// headers and a response may contain more than one replacement; the last
/// `rt` header is the effective value for the native session.
pub fn select_refresh_cookie<I, S>(headers: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    headers
        .into_iter()
        .filter_map(|header| {
            let header = header.as_ref();
            let pair = header.split(';').next()?.trim();
            let (name, _) = pair.split_once('=')?;
            (name.trim() == "rt").then(|| header.to_owned())
        })
        .last()
}

impl<S: SessionStore> SessionManager<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn cookie_header(&self) -> Result<Option<String>, String> {
        self.restore()
    }

    /// Restore the refresh credential from protected storage. Access tokens
    /// are intentionally not part of this state and therefore cannot be
    /// restored or persisted by this manager.
    pub fn restore(&self) -> Result<Option<String>, String> {
        self.store.load()
    }

    /// Apply the response's cookie transition before its access token can be
    /// returned to JavaScript. Only auth endpoints are allowed to mutate the
    /// protected refresh-cookie store.
    pub fn handle_response(
        &self,
        path: &str,
        status: u16,
        set_cookie: Option<&str>,
    ) -> Result<SessionEvent, String> {
        if path == "/api/auth/logout" {
            self.store.clear()?;
            return Ok(SessionEvent::SignedOut);
        }

        let auth_endpoint = matches!(
            path,
            "/api/auth/login" | "/api/auth/accept-invite" | "/api/auth/refresh"
        );
        let transition = set_cookie.and_then(refresh_cookie_transition);
        // The Worker deliberately returns a deleting rt cookie for all
        // terminal refresh failures except rotation_race. Apply that explicit
        // server transition regardless of HTTP status; otherwise a disabled
        // organization leaves a stale credential in the native store.
        if auth_endpoint && matches!(transition, Some(CookieTransition::Delete)) {
            self.store.clear()?;
            return Ok(SessionEvent::SignedOut);
        }

        if path == "/api/auth/refresh" && status == 401 {
            self.store.clear()?;
            return Ok(SessionEvent::SignedOut);
        }

        if auth_endpoint && (200..300).contains(&status) {
            match transition {
                Some(CookieTransition::Save(cookie)) => {
                    // Store first; only the caller's subsequent response exposes
                    // an access JWT after this succeeds. If persistence fails,
                    // clear any previous credential and fail closed.
                    if let Err(save_error) = self.store.save(&cookie) {
                        let clear_result = self.store.clear();
                        return match clear_result {
                            Ok(()) => Err(save_error),
                            Err(clear_error) => Err(format!(
                                "{save_error}; failed to clear session after store failure: {clear_error}"
                            )),
                        };
                    }
                    return Ok(SessionEvent::Authenticated);
                }
                // A successful auth response without its replacement cookie
                // means the old value might already have been rotated away.
                // Clear it before reporting an error to avoid a reuse loop.
                None => {
                    self.store.clear()?;
                    return Err("auth response contained no refresh cookie".to_owned());
                }
                Some(CookieTransition::Delete) => unreachable!("handled above"),
            }
        }

        Ok(SessionEvent::Authenticated)
    }

    pub fn handle_network_failure(&self, path: &str) -> Result<(), String> {
        if path == "/api/auth/logout" {
            // Logout is an explicit local intent, so clear even when the
            // server cannot be reached. Other network failures are not
            // evidence that the refresh credential is invalid.
            return self.store.clear();
        }
        Ok(())
    }
}

enum CookieTransition {
    Save(String),
    Delete,
}

fn refresh_cookie_transition(set_cookie: &str) -> Option<CookieTransition> {
    let pair = set_cookie.split(';').next()?.trim();
    let (name, value) = pair.split_once('=')?;
    if name.trim() != "rt" {
        return None;
    }
    let value = value.trim();
    let deleted = value.is_empty()
        || set_cookie.split(';').skip(1).any(|attribute| {
            let Some((name, value)) = attribute.trim().split_once('=') else {
                return false;
            };
            name.trim().eq_ignore_ascii_case("max-age")
                && value.trim().parse::<i64>().is_ok_and(|age| age <= 0)
        });
    if deleted {
        Some(CookieTransition::Delete)
    } else {
        Some(CookieTransition::Save(format!("rt={value}")))
    }
}

#[cfg(test)]
mod tests {
    use super::{SessionEvent, SessionManager};
    use crate::store::{MemoryStore, SessionStore};

    #[test]
    fn login_invite_and_refresh_save_cookie_before_access_is_exposed() {
        let store = MemoryStore::default();
        let manager = SessionManager::new(store.clone());
        assert_eq!(
            manager
                .handle_response("/api/auth/login", 200, Some("rt=first; Path=/"))
                .unwrap(),
            SessionEvent::Authenticated
        );
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=first"));

        manager
            .handle_response("/api/auth/accept-invite", 200, Some("rt=invite; Path=/"))
            .unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=invite"));

        manager
            .handle_response("/api/auth/refresh", 200, Some("rt=rotated; Path=/"))
            .unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=rotated"));
    }

    #[test]
    fn invalid_refresh_and_logout_clear_store() {
        let store = MemoryStore::with_cookie("rt=live");
        let manager = SessionManager::new(store.clone());
        assert_eq!(
            manager
                .handle_response("/api/auth/refresh", 401, None)
                .unwrap(),
            SessionEvent::SignedOut
        );
        assert_eq!(store.load().unwrap(), None);

        store.save("rt=live-again").unwrap();
        manager
            .handle_response("/api/auth/logout", 200, None)
            .unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn refresh_keeps_cookie_for_retryable_or_non_auth_failures() {
        for status in [400, 403, 429, 500, 502, 503] {
            let store = MemoryStore::with_cookie("rt=still-valid");
            let manager = SessionManager::new(store.clone());

            assert_eq!(
                manager
                    .handle_response("/api/auth/refresh", status, None)
                    .unwrap(),
                SessionEvent::Authenticated,
                "status {status} must not sign the native session out"
            );
            assert_eq!(store.load().unwrap().as_deref(), Some("rt=still-valid"));
        }
    }

    #[test]
    fn network_failure_does_not_change_existing_cookie() {
        let store = MemoryStore::with_cookie("rt=still-valid");
        let manager = SessionManager::new(store.clone());
        manager.handle_network_failure("/api/auth/refresh").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=still-valid"));
    }

    #[test]
    fn logout_network_failure_clears_cookie() {
        let store = MemoryStore::with_cookie("rt=to-delete");
        let manager = SessionManager::new(store.clone());
        manager.handle_network_failure("/api/auth/logout").unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn selects_the_last_refresh_cookie_and_ignores_other_cookies() {
        let selected = super::select_refresh_cookie([
            "csrf=public; Path=/",
            "rt=first; Path=/",
            "other=public; Path=/",
            "rt=last; Path=/",
        ]);
        assert_eq!(selected.as_deref(), Some("rt=last; Path=/"));
    }

    #[test]
    fn refresh_cookie_deletion_attributes_clear_the_store() {
        let store = MemoryStore::with_cookie("rt=live");
        let manager = SessionManager::new(store.clone());
        manager
            .handle_response("/api/auth/refresh", 200, Some("rt=; Max-Age=0; Path=/"))
            .unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn refresh_deletion_response_clears_store_even_when_request_fails() {
        for status in [400, 401, 403, 429, 500, 503] {
            let store = MemoryStore::with_cookie("rt=live");
            let manager = SessionManager::new(store.clone());

            manager
                .handle_response("/api/auth/refresh", status, Some("rt=; Max-Age=0; Path=/"))
                .unwrap();

            assert_eq!(store.load().unwrap(), None, "status {status} must clear");
        }
    }

    #[test]
    fn successful_refresh_without_cookie_clears_store_and_fails_closed() {
        let store = MemoryStore::with_cookie("rt=live");
        let manager = SessionManager::new(store.clone());

        let result = manager.handle_response("/api/auth/refresh", 200, None);

        assert!(result.is_err());
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn store_failure_clears_existing_cookie_and_fails_closed() {
        let store = FailingStore::with_cookie("rt=old");
        let manager = SessionManager::new(store.clone());
        let result = manager.handle_response("/api/auth/login", 200, Some("rt=new"));
        assert!(result.is_err());
        assert_eq!(store.load().unwrap(), None);
    }

    #[derive(Clone, Default)]
    struct FailingStore {
        value: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    }

    impl FailingStore {
        fn with_cookie(cookie: &str) -> Self {
            Self {
                value: std::sync::Arc::new(std::sync::Mutex::new(Some(cookie.to_owned()))),
            }
        }
    }

    impl crate::store::SessionStore for FailingStore {
        fn load(&self) -> Result<Option<String>, String> {
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, _cookie: &str) -> Result<(), String> {
            Err("write failed".to_owned())
        }

        fn clear(&self) -> Result<(), String> {
            *self.value.lock().unwrap() = None;
            Ok(())
        }
    }
}
