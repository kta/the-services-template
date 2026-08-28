use crate::store::{validate_refresh_cookie, SessionStore};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

    /// Explicit local purge used by the logout command. Keep this public at
    /// the manager boundary so the renderer can verify that protected storage
    /// was actually cleared instead of silently swallowing a keychain error.
    pub fn clear(&self) -> Result<(), String> {
        self.clear_store()
    }

    // Keychain deletion can fail transiently while writing a replacement
    // signed-out marker still succeeds. Prefer that persistent deny state so
    // a later app restart cannot resurrect the old refresh cookie.
    fn clear_store(&self) -> Result<(), String> {
        match self.store.clear() {
            Ok(()) => Ok(()),
            Err(clear_error) => self.store.mark_signed_out().map_err(|marker_error| {
                format!("{clear_error}; failed to persist signed-out marker: {marker_error}")
            }),
        }
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
        self.handle_response_at(path, status, set_cookie, SystemTime::now())
    }

    pub fn handle_response_at(
        &self,
        path: &str,
        status: u16,
        set_cookie: Option<&str>,
        now: SystemTime,
    ) -> Result<SessionEvent, String> {
        let path = path_without_query(path);
        if path == "/api/auth/logout" {
            self.clear_store()?;
            return Ok(SessionEvent::SignedOut);
        }

        let auth_endpoint = matches!(
            path,
            "/api/auth/login" | "/api/auth/accept-invite" | "/api/auth/refresh"
        );
        let transition = set_cookie.and_then(|cookie| refresh_cookie_transition_at(cookie, now));
        // The Worker deliberately returns a deleting rt cookie for all
        // terminal refresh failures except rotation_race. Apply that explicit
        // server transition regardless of HTTP status; otherwise a disabled
        // organization leaves a stale credential in the native store.
        if auth_endpoint && matches!(transition, Some(CookieTransition::Delete)) {
            self.clear_store()?;
            return Ok(SessionEvent::SignedOut);
        }
        if auth_endpoint && matches!(transition, Some(CookieTransition::Invalid)) {
            self.clear_store()?;
            return Err("auth response contained an invalid refresh cookie".to_owned());
        }

        if path == "/api/auth/refresh" && status == 401 {
            self.clear_store()?;
            return Ok(SessionEvent::SignedOut);
        }

        if auth_endpoint && (200..300).contains(&status) {
            match transition {
                Some(CookieTransition::Save(cookie)) => {
                    // Store first; only the caller's subsequent response exposes
                    // an access JWT after this succeeds. If persistence fails,
                    // clear any previous credential and fail closed.
                    if let Err(save_error) = self.store.save(&cookie) {
                        let clear_result = self.clear_store();
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
                    self.clear_store()?;
                    return Err("auth response contained no refresh cookie".to_owned());
                }
                Some(CookieTransition::Delete) => unreachable!("handled above"),
                Some(CookieTransition::Invalid) => unreachable!("handled above"),
            }
        }

        Ok(SessionEvent::Authenticated)
    }

    pub fn handle_network_failure(&self, path: &str) -> Result<(), String> {
        let path = path_without_query(path);
        if path == "/api/auth/logout" {
            // Logout is an explicit local intent, so clear even when the
            // server cannot be reached. Other network failures are not
            // evidence that the refresh credential is invalid.
            return self.clear_store();
        }
        Ok(())
    }
}

fn path_without_query(path: &str) -> &str {
    path.split_once('?').map_or(path, |(path, _)| path)
}

enum CookieTransition {
    Save(String),
    Delete,
    Invalid,
}

fn refresh_cookie_transition_at(set_cookie: &str, now: SystemTime) -> Option<CookieTransition> {
    let pair = set_cookie.split(';').next()?.trim();
    let (name, value) = pair.split_once('=')?;
    if name.trim() != "rt" {
        return None;
    }
    let value = value.trim();
    let deleted = value.is_empty()
        || set_cookie.split(';').skip(1).any(|attribute| {
            let Some((name, attribute_value)) = attribute.trim().split_once('=') else {
                return false;
            };
            name.trim().eq_ignore_ascii_case("max-age")
                && attribute_value
                    .trim()
                    .parse::<i64>()
                    .is_ok_and(|age| age <= 0)
        })
        || set_cookie.split(';').skip(1).any(|attribute| {
            attribute
                .trim()
                .split_once('=')
                .filter(|(name, _)| name.trim().eq_ignore_ascii_case("expires"))
                .and_then(|(_, value)| parse_http_date(value.trim()))
                .is_some_and(|expires_at| expires_at <= now)
        });
    if deleted {
        Some(CookieTransition::Delete)
    } else if validate_refresh_cookie(&format!("rt={value}")).is_err() {
        Some(CookieTransition::Invalid)
    } else {
        Some(CookieTransition::Save(format!("rt={value}")))
    }
}

fn parse_http_date(value: &str) -> Option<SystemTime> {
    let parts = value.split_whitespace().collect::<Vec<_>>();
    if parts.len() != 6 || !parts[0].ends_with(',') || parts[5] != "GMT" {
        return None;
    }
    let day = parts[1].parse::<u32>().ok()?;
    let month = match parts[2] {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year = parts[3].parse::<i64>().ok()?;
    if !(1601..=9999).contains(&year) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let time = parts[4].split(':').collect::<Vec<_>>();
    if time.len() != 3 {
        return None;
    }
    let hour = time[0].parse::<u64>().ok()?;
    let minute = time[1].parse::<u64>().ok()?;
    let second = time[2].parse::<u64>().ok()?;
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::try_from(hour * 3_600 + minute * 60 + second).ok()?)?;
    if seconds >= 0 {
        UNIX_EPOCH.checked_add(Duration::from_secs(u64::try_from(seconds).ok()?))
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_secs(seconds.unsigned_abs()))
    }
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

// Civil date to Unix days, based on the proleptic Gregorian calendar.
fn days_from_civil(year: i64, month: u32, day: u32) -> Option<i64> {
    let year = year.checked_sub(i64::from(month <= 2))?;
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
}

#[cfg(test)]
mod tests {
    use super::{SessionEvent, SessionManager};
    use crate::store::{MemoryStore, SessionStore};
    use std::time::{Duration, UNIX_EPOCH};

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
    fn invalid_or_expiring_refresh_cookie_clears_store_and_fails_closed() {
        for header in [
            "rt=bad value; Path=/",
            "rt=bad; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/",
        ] {
            let store = MemoryStore::with_cookie("rt=live");
            let manager = SessionManager::new(store.clone());
            let result = manager.handle_response("/api/auth/refresh", 200, Some(header));
            if header.contains("Expires") {
                assert_eq!(result.unwrap(), SessionEvent::SignedOut);
            } else {
                assert!(result.is_err());
            }
            assert_eq!(store.load().unwrap(), None, "header {header}");
        }
    }

    #[test]
    fn future_expires_is_not_treated_as_cookie_deletion() {
        let store = MemoryStore::with_cookie("rt=live");
        let manager = SessionManager::new(store.clone());
        let now = UNIX_EPOCH + Duration::from_secs(1_700_000_000);

        assert_eq!(
            manager
                .handle_response_at(
                    "/api/auth/refresh",
                    200,
                    Some("rt=future; Expires=Thu, 01 Jan 2099 00:00:00 GMT; Path=/"),
                    now,
                )
                .unwrap(),
            SessionEvent::Authenticated
        );
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=future"));

        assert_eq!(
            manager
                .handle_response_at(
                    "/api/auth/refresh",
                    200,
                    Some("rt=expired; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/"),
                    now,
                )
                .unwrap(),
            SessionEvent::SignedOut
        );
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
    fn auth_state_transitions_ignore_query_strings() {
        let store = MemoryStore::with_cookie("rt=live");
        let manager = SessionManager::new(store.clone());

        manager
            .handle_response(
                "/api/auth/refresh?source=native",
                200,
                Some("rt=rotated; Path=/"),
            )
            .unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=rotated"));

        manager
            .handle_response("/api/auth/logout?source=native", 200, None)
            .unwrap();
        assert_eq!(store.load().unwrap(), None);
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

    #[test]
    fn clear_failure_falls_back_to_a_persistent_signed_out_marker() {
        let store = ClearFailStore::with_cookie("rt=old");
        let manager = SessionManager::new(store.clone());

        assert_eq!(manager.clear(), Ok(()));
        assert_eq!(store.load().unwrap(), None);
        assert!(store.marker_written());
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

    #[derive(Clone, Default)]
    struct ClearFailStore {
        value: std::sync::Arc<std::sync::Mutex<Option<String>>>,
        marker: std::sync::Arc<std::sync::Mutex<bool>>,
    }

    impl ClearFailStore {
        fn with_cookie(cookie: &str) -> Self {
            Self {
                value: std::sync::Arc::new(std::sync::Mutex::new(Some(cookie.to_owned()))),
                marker: std::sync::Arc::new(std::sync::Mutex::new(false)),
            }
        }

        fn marker_written(&self) -> bool {
            *self.marker.lock().unwrap()
        }
    }

    impl crate::store::SessionStore for ClearFailStore {
        fn load(&self) -> Result<Option<String>, String> {
            if *self.marker.lock().unwrap() {
                return Ok(None);
            }
            Ok(self.value.lock().unwrap().clone())
        }

        fn save(&self, cookie: &str) -> Result<(), String> {
            *self.value.lock().unwrap() = Some(cookie.to_owned());
            Ok(())
        }

        fn clear(&self) -> Result<(), String> {
            Err("delete failed".to_owned())
        }

        fn mark_signed_out(&self) -> Result<(), String> {
            *self.marker.lock().unwrap() = true;
            Ok(())
        }
    }
}
