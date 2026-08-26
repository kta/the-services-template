mod api;
#[cfg(test)]
#[path = "origin.rs"]
mod origin;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(api::ApiState::new())
        .invoke_handler(tauri::generate_handler![api::api_request])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
