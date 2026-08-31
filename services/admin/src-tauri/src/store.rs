use std::sync::{Arc, Mutex};

pub type StoreResult<T> = Result<T, String>;

// This value is a deny marker, not a credential. It lets the native session
// remain signed out across an app restart when keychain deletion fails but a
// protected write still succeeds.
#[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
const SIGNED_OUT_MARKER: &[u8] = b"__app_signed_out_v1__";

/// Native refresh-cookie persistence boundary. Access JWTs and passwords are
/// deliberately not represented by this trait.
pub trait SessionStore: Clone + Send + Sync + 'static {
    fn load(&self) -> StoreResult<Option<String>>;
    fn save(&self, cookie: &str) -> StoreResult<()>;
    fn clear(&self) -> StoreResult<()>;

    /// Persist a deny marker when deleting an existing credential is not
    /// available. Stores that cannot distinguish a marker may use clear as a
    /// best-effort fallback.
    fn mark_signed_out(&self) -> StoreResult<()> {
        self.clear()
    }
}

const MAX_REFRESH_COOKIE_VALUE_BYTES: usize = 512;

pub(crate) fn validate_refresh_cookie(cookie: &str) -> StoreResult<()> {
    let value = cookie
        .strip_prefix("rt=")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "session store accepts only a non-empty rt cookie".to_owned())?;
    if value.len() > MAX_REFRESH_COOKIE_VALUE_BYTES {
        return Err("refresh cookie is too large".to_owned());
    }
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("refresh cookie contains invalid characters".to_owned());
    }
    Ok(())
}

#[allow(dead_code)]
#[derive(Clone, Default)]
pub struct MemoryStore {
    value: Arc<Mutex<Option<String>>>,
}

#[allow(dead_code)]
impl MemoryStore {
    pub fn with_cookie(cookie: &str) -> Self {
        Self {
            value: Arc::new(Mutex::new(Some(cookie.to_owned()))),
        }
    }
}

impl SessionStore for MemoryStore {
    fn load(&self) -> StoreResult<Option<String>> {
        self.value
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "session store lock poisoned".to_owned())
    }

    fn save(&self, cookie: &str) -> StoreResult<()> {
        validate_refresh_cookie(cookie)?;
        self.value
            .lock()
            .map(|mut value| *value = Some(cookie.to_owned()))
            .map_err(|_| "session store lock poisoned".to_owned())
    }

    fn clear(&self) -> StoreResult<()> {
        self.value
            .lock()
            .map(|mut value| *value = None)
            .map_err(|_| "session store lock poisoned".to_owned())
    }
}

/// Platform adapter. Release Apple builds use the app-scoped Protected Data
/// store; unsigned macOS debug builds use the legacy keychain only so local
/// development remains usable. Android uses the Android-native keyring
/// provider, whose value is encrypted by Android Keystore. Other targets fail
/// closed instead of silently writing plaintext.
#[derive(Clone, Default)]
pub struct PlatformStore;

#[allow(dead_code)]
const APPLE_ACCESS_POLICY: &str = "when-unlocked-this-device-only";

#[allow(dead_code)]
fn apple_protected_modifiers() -> std::collections::HashMap<&'static str, &'static str> {
    std::collections::HashMap::from([("access-policy", APPLE_ACCESS_POLICY)])
}

#[cfg(all(target_os = "macos", debug_assertions))]
fn native_entry() -> StoreResult<keyring_core::Entry> {
    use apple_native_keyring_store::keychain::Store;
    use keyring_core::api::CredentialStoreApi;
    use std::collections::HashMap;

    let store = Store::new().map_err(|error| format!("keychain unavailable: {error}"))?;
    store
        .build(
            "com.kta.admin",
            "refresh-cookie",
            None::<&HashMap<&str, &str>>,
        )
        .map_err(|error| format!("keychain entry unavailable: {error}"))
}

#[cfg(all(target_os = "macos", not(debug_assertions)))]
fn native_entry() -> StoreResult<keyring_core::Entry> {
    use apple_native_keyring_store::protected::Store;
    use keyring_core::api::CredentialStoreApi;

    let store = Store::new().map_err(|error| format!("protected keychain unavailable: {error}"))?;
    store
        .build(
            "com.kta.admin",
            "refresh-cookie",
            Some(&apple_protected_modifiers()),
        )
        .map_err(|error| format!("protected keychain entry unavailable: {error}"))
}

#[cfg(target_os = "ios")]
fn native_entry() -> StoreResult<keyring_core::Entry> {
    use apple_native_keyring_store::protected::Store;
    use keyring_core::api::CredentialStoreApi;

    let store = Store::new().map_err(|error| format!("protected keychain unavailable: {error}"))?;
    store
        .build(
            "com.kta.admin",
            "refresh-cookie",
            Some(&apple_protected_modifiers()),
        )
        .map_err(|error| format!("protected keychain entry unavailable: {error}"))
}

#[cfg(target_os = "android")]
fn native_entry() -> StoreResult<keyring_core::Entry> {
    use android_native_keyring_store::Store;
    use keyring_core::api::CredentialStoreApi;
    use std::collections::HashMap;

    let store = Store::new().map_err(|error| format!("android keystore unavailable: {error}"))?;
    store
        .build(
            "com.kta.admin",
            "refresh-cookie",
            None::<&HashMap<&str, &str>>,
        )
        .map_err(|error| format!("android keystore entry unavailable: {error}"))
}

#[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
fn native_entry() -> StoreResult<()> {
    Err("protected session storage is unavailable on this target".to_owned())
}

impl SessionStore for PlatformStore {
    fn load(&self) -> StoreResult<Option<String>> {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        {
            match native_entry()?.get_secret() {
                Ok(secret) => {
                    if secret == SIGNED_OUT_MARKER {
                        return Ok(None);
                    }
                    let cookie = String::from_utf8(secret)
                        .map_err(|_| "stored refresh cookie is not valid UTF-8".to_owned())?;
                    validate_refresh_cookie(&cookie)?;
                    Ok(Some(cookie))
                }
                Err(keyring_core::Error::NoEntry) => Ok(None),
                Err(error) => Err(format!("session load failed: {error}")),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            Err("protected session storage is unavailable on this target".to_owned())
        }
    }

    fn save(&self, cookie: &str) -> StoreResult<()> {
        validate_refresh_cookie(cookie)?;
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        {
            native_entry()?
                .set_secret(cookie.as_bytes())
                .map_err(|error| format!("session save failed: {error}"))
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            native_entry()
        }
    }

    fn clear(&self) -> StoreResult<()> {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        {
            match native_entry()?.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
                Err(error) => self.mark_signed_out().map_err(|marker_error| {
                    format!(
                        "session clear failed: {error}; signed-out marker failed: {marker_error}"
                    )
                }),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            native_entry()
        }
    }

    fn mark_signed_out(&self) -> StoreResult<()> {
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        {
            native_entry()?
                .set_secret(SIGNED_OUT_MARKER)
                .map_err(|error| format!("session signed-out marker failed: {error}"))
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            native_entry()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{apple_protected_modifiers, MemoryStore, SessionStore, APPLE_ACCESS_POLICY};

    #[test]
    fn memory_store_round_trips_only_refresh_cookie() {
        let store = MemoryStore::default();
        assert_eq!(store.load().unwrap(), None);
        store.save("rt=refresh-secret").unwrap();
        assert_eq!(store.load().unwrap().as_deref(), Some("rt=refresh-secret"));
        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn memory_store_rejects_values_that_are_not_refresh_cookie_pairs() {
        let store = MemoryStore::default();
        for value in [
            "password",
            "access-token",
            "refresh=secret",
            "rt=",
            "rt=with space",
            "rt=with:semicolon;",
            "rt=with/slash",
            "rt=with+plus",
        ] {
            assert!(
                store.save(value).is_err(),
                "accepted sensitive value: {value}"
            );
        }
    }

    #[test]
    fn memory_store_rejects_overlong_refresh_cookie_values() {
        let store = MemoryStore::default();
        assert!(store.save(&format!("rt={}", "a".repeat(513))).is_err());
        assert!(store.save(&format!("rt={}", "a".repeat(512))).is_ok());
    }

    #[test]
    fn apple_protected_store_uses_this_device_only_accessibility_policy() {
        assert_eq!(
            apple_protected_modifiers().get("access-policy"),
            Some(&APPLE_ACCESS_POLICY)
        );
    }
}
