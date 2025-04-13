use crate::prelude::*;
use age::secrecy::{ExposeSecret, SecretString};
use keyring::Entry;
use std::{fs, io, path::PathBuf};
use tauri::{AppHandle, Manager};

// Define constants for keychain service and data filename
const KEYCHAIN_SERVICE_NAME: &str = "com.task-proxy.app"; // Use your app's bundle ID or similar
const KEYCHAIN_USERNAME: &str = "task_proxy_user"; // Identifier for the passphrase within the service
const PROJECTS_FILENAME: &str = "projects.data.enc";

#[tauri::command]
pub(crate) fn has_securitykey() -> bool {
    match get_passphrase() {
        Ok(_) => true,
        Err(_) => false,
    }
}

/// Set the encryption passphrase to the keychain
#[tauri::command]
pub(crate) fn set_securitykey(password: &str) -> Result<String, String> {
    let secret = SecretString::from(password);
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    entry
        .set_password(secret.expose_secret())
        .map_err(|e| format!("Failed to store new passphrase in keychain: {:?}", e))?;
    Ok(String::from("Password Saved!"))
}

/// Get encryption passphrase from the keychain
fn get_passphrase() -> Result<SecretString, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(SecretString::from(password)),
        Err(e) => Err(format!(
            "Failed to retrieve passphrase from keychain: {:?}",
            e
        )),
    }
}

/// Save projects to local data storage
pub(crate) fn save_projects_to_local_storage(
    app_handle: &AppHandle,
    projects: &Vec<Project>,
) -> Result<String, String> {
    let file_path = get_app_data_path(app_handle)?;
    let passphrase = get_passphrase()?;
    let recipient = age::scrypt::Recipient::new(passphrase.clone());
    let json = match serde_json::to_string(projects) {
        Ok(json) => json,
        Err(err) => return Err(format!("Failed to serialize projects: {}", err)),
    };
    let encrypted = match age::encrypt(&recipient, json.as_bytes()) {
        Ok(encrypted) => encrypted,
        Err(err) => return Err(format!("Failed to save project: {}", err)),
    };
    match fs::write(&file_path, encrypted) {
        Ok(()) => Ok(String::from("Projects saved")),
        Err(err) => Err(format!("Error saving projects: {}", err)),
    }
}

/// Get projects from local data storage
pub(crate) fn get_projects_from_local_storage(
    app_handle: &AppHandle,
) -> Result<Vec<Project>, String> {
    let file_path = get_app_data_path(app_handle)?;
    let passphrase = get_passphrase()?;
    let identity = age::scrypt::Identity::new(passphrase);
    let encrypted_data = match fs::read(&file_path) {
        Ok(data) => data,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            log::info!(
                "Data file not found at {:?}. Returning empty project list.",
                file_path
            );
            return Ok(Vec::new());
        }
        Err(e) => {
            return Err(format!("Error reading data file {:?}: {}", file_path, e));
        }
    };
    if encrypted_data.is_empty() {
        log::info!(
            "Data file {:?} is empty. Returning empty project list.",
            file_path
        );
        return Ok(Vec::new());
    }
    let decrypted = match age::decrypt(&identity, &encrypted_data) {
        Ok(decrypted) => decrypted,
        Err(err) => {
            return Err(format!("Failed to decrypt file: {}", err));
        }
    };
    match serde_json::from_slice::<Vec<Project>>(&decrypted) {
        Ok(projects) => Ok(projects),
        Err(err) => Err(format!("Failed to deserialize projects: {}", err)),
    }
}

fn get_app_data_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = match app_handle.path().app_local_data_dir() {
        Ok(dir) => dir,
        Err(err) => {
            return Err(format!(
                "Could not resolve application data directory.\n{}",
                err
            ));
        }
    };
    if let Err(err) = fs::create_dir_all(&data_dir) {
        return Err(format!(
            "Could not create application data directory {:?}: {}",
            data_dir, err
        ));
    }
    let file_path = data_dir.join(PROJECTS_FILENAME);
    log::info!("Using data file path: {:?}", file_path); // Log for debugging
    Ok(file_path)
}
