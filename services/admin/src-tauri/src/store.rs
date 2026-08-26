use std::sync::{Arc, Mutex};

pub type StoreResult<T> = Result<T, String>;

/// Native refresh-cookie persistence boundary. Access JWTs and passwords are
/// deliberately not represented by this trait.
pub trait SessionStore: Clone + Send + Sync + 'static {
    fn load(&self) -> StoreResult<Option<String>>;
    fn save(&self, cookie: &str) -> StoreResult<()>;
    fn clear(&self) -> StoreResult<()>;
}

fn validate_refresh_cookie(cookie: &str) -> StoreResult<()> {
    let value = cookie
        .strip_prefix("rt=")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "session store accepts only a non-empty rt cookie".to_owned())?;
    if value
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() || byte == b';')
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

/// Platform adapter. Apple uses Keychain Services and Android uses the
/// Android-native keyring provider, whose value is encrypted by Android
/// Keystore. Other targets fail closed instead of silently writing plaintext.
#[derive(Clone, Default)]
pub struct PlatformStore;

#[allow(dead_code)]
const IOS_ACCESS_POLICY: &str = "when-unlocked-this-device-only";

#[allow(dead_code)]
fn ios_keychain_modifiers() -> std::collections::HashMap<&'static str, &'static str> {
    std::collections::HashMap::from([("access-policy", IOS_ACCESS_POLICY)])
}

#[cfg(target_os = "macos")]
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

#[cfg(target_os = "ios")]
fn native_entry() -> StoreResult<keyring_core::Entry> {
    use apple_native_keyring_store::protected::Store;
    use keyring_core::api::CredentialStoreApi;

    let store = Store::new().map_err(|error| format!("protected keychain unavailable: {error}"))?;
    store
        .build(
            "com.kta.admin",
            "refresh-cookie",
            Some(&ios_keychain_modifiers()),
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
                Ok(secret) => String::from_utf8(secret)
                    .map(Some)
                    .map_err(|_| "stored refresh cookie is not valid UTF-8".to_owned()),
                Err(error) if matches!(error, keyring_core::Error::NoEntry) => Ok(None),
                Err(error) => Err(format!("session load failed: {error}")),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            native_entry().map(|never| never)
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
                Err(error) => Err(format!("session clear failed: {error}")),
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
        {
            native_entry()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ios_keychain_modifiers, MemoryStore, SessionStore, IOS_ACCESS_POLICY};

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
        for value in ["password", "access-token", "refresh=secret", "rt="] {
            assert!(
                store.save(value).is_err(),
                "accepted sensitive value: {value}"
            );
        }
    }

    #[test]
    fn ios_keychain_uses_this_device_only_accessibility_policy() {
        assert_eq!(
            ios_keychain_modifiers().get("access-policy"),
            Some(&IOS_ACCESS_POLICY)
        );
    }
}
