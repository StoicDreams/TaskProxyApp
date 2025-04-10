use crate::errors::TaskProxyError;

/// Example greeting to test interaction from JavaScript to Rust
#[tauri::command]
pub fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Create or load a project from the given path.
#[tauri::command]
pub fn add_project(path: &str) -> Result<String, String> {
    Err(
        TaskProxyError::NotImplemented(format!("Unable to add project for path {}", path))
            .to_string(),
    )
}
