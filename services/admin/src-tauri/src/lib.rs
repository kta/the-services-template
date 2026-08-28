mod origin;

mod api;
mod session;
mod store;

use api::ApiState;

fn generated_invoke_handler<R: tauri::Runtime>() -> impl Fn(tauri::ipc::Invoke<R>) -> bool {
    tauri::generate_handler![api::api_request, api::clear_session]
}

fn invoke_handler<R: tauri::Runtime>(invoke: tauri::ipc::Invoke<R>) -> bool {
    // Check every custom command before generated dispatch. The generated
    // clear_session command currently has no arguments, but keeping the
    // envelope guard command-agnostic prevents a future command from creating
    // an unbounded alternate IPC path.
    if !api::ipc_payload_within_limit(invoke.message.payload()) {
        invoke.resolver.reject("IPC request payload is too large");
        return true;
    }
    generated_invoke_handler::<R>()(invoke)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ApiState::new())
        .invoke_handler(invoke_handler)
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("navigation-guard")
                .on_navigation(|_, url| {
                    origin::navigation_allowed(url, env!("TAURI_ADMIN_API_ORIGIN"))
                })
                .build(),
        )
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
