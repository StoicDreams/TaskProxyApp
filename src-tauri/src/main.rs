// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{http::ResponseBuilder, Manager};

// Learn more about Tauri commands at https://tauri.app/v1/guides/features/command
#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

fn main() {
    tauri::Builder::default()
        .register_uri_scheme_protocol("taskproxy", |app, req| {
            // get the request URI
            let uri = req.uri();

            // do something with the app instance and the request data
            // for example, send a message to the webview
            let _ = app.emit_all("sdauth", format!("uri: {}", uri));

            // return a response builder
            ResponseBuilder::new().status(200).body(Vec::new())
        })
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
