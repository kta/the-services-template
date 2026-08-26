use std::env;

#[path = "src/origin.rs"]
mod origin;

fn main() {
    println!("cargo:rerun-if-env-changed=TAURI_ADMIN_API_ORIGIN");

    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_owned());
    let raw_origin = env::var("TAURI_ADMIN_API_ORIGIN").unwrap_or_else(|_| {
        if profile == "debug" {
            "http://localhost:5174".to_owned()
        } else {
            panic!("TAURI_ADMIN_API_ORIGIN must be set for a release build and use an HTTPS origin")
        }
    });

    let origin = origin::parse(&raw_origin, profile != "debug")
        .unwrap_or_else(|error| panic!("TAURI_ADMIN_API_ORIGIN: {error}"));

    // The API origin is compiled into the native binary. Later transport code
    // must not read a runtime or JavaScript-provided replacement.
    println!("cargo:rustc-env=TAURI_ADMIN_API_ORIGIN={origin}");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["api_request"])),
    )
    .expect("failed to generate Tauri ACL");
}
