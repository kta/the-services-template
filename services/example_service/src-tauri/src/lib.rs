mod api;
mod origin;

fn generated_invoke_handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool {
    tauri::generate_handler![api::api_request]
}

fn invoke_handler<R: tauri::Runtime>(invoke: tauri::ipc::Invoke<R>) -> bool {
    // Keep the envelope budget in front of generated dispatch for every
    // command, including future commands that do not exist in the template.
    if !api::ipc_payload_within_limit(invoke.message.payload()) {
        invoke.resolver.reject("IPC request payload is too large");
        return true;
    }
    generated_invoke_handler::<R>()(invoke)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(api::ApiState::new())
        .invoke_handler(invoke_handler)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_, url| {
                    origin::navigation_allowed(url, env!("TAURI_EXAMPLE_API_ORIGIN"))
                })
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
