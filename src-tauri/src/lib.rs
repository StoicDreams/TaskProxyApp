use tauri::Manager;

// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    //#[cfg(debug_assertions)] // only enable instrumentation in development builds
    let devtools = tauri_plugin_devtools::init();

    let mut builder = tauri::Builder::default();

    //#[cfg(debug_assertions)]
    //{
    builder = builder.plugin(devtools);
    //}

    builder = builder.setup(|app| {
        // Get a handle to your main window using its label
        if let Some(window) = app.get_webview_window("taskproxy") {
            // Explicit nav required because Tauri initially tries loading page before assets are available.
            let url_to_load = "/";
            let nav_script = format!("window.location.replace('{}')", url_to_load);
            //std::thread::sleep(std::time::Duration::from_millis(100));
            let _ = window.eval(&nav_script);
        } else {
            eprintln!("Could not get main window handle");
        }
        Ok(())
    });
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
