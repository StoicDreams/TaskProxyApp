use crate::prelude::*;
use age::secrecy::{ExposeSecret, SecretString};
use keyring::Entry;
use std::{fs, io, path::PathBuf};
use tauri::{AppHandle, Manager, State};

const KEYCHAIN_SERVICE_NAME: &str = "com.task-proxy.app";
const KEYCHAIN_USERNAME: &str = "task_proxy_user";
const PROJECTS_FILENAME: &str = "projects.data.enc";

#[tauri::command]
pub(crate) fn has_securitykey() -> bool {
    match get_passphrase() {
        Ok(_) => true,
        Err(err) => {
            log::info!("Does not have security key: {}", err);
            false
        }
    }
}

/// Set the encryption passphrase to the keychain
#[tauri::command]
pub(crate) fn set_securitykey(
    app_handle: AppHandle,
    state: State<SharedProjects>,
    security_key: &str,
) -> Result<String, String> {
    let secret = SecretString::from(security_key);
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    entry
        .set_password(secret.expose_secret())
        .map_err(|e| format!("Failed to store new security key in keychain: {:?}", e))?;
    save_projects_if_any(&app_handle, &state);
    Ok(String::from("Security Key Saved!"))
}

#[tauri::command]
pub(crate) fn delete_securitykey() -> Result<String, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    entry
        .delete_credential()
        .map_err(|e| format!("Failed to delete security key from keychain: {:?}", e))?;
    Ok(String::from("Security Key Deleted!"))
}

/// Get encryption passphrase from the keychain
fn get_passphrase() -> Result<SecretString, String> {
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    match entry.get_password() {
        Ok(password) => Ok(SecretString::from(password)),
        Err(e) => Err(format!(
            "Failed to retrieve security key from keychain: {:?}",
            e
        )),
    }
}

fn save_projects_if_any(app_handle: &AppHandle, state: &State<SharedProjects>) {
    let projects = state.lock().unwrap();
    let projects = projects.to_vec();
    if projects.is_empty() {
        return;
    }
    _ = save_projects_to_local_storage(&app_handle, &projects);
}

/// Save projects to local data storage
pub(crate) fn save_projects_to_local_storage(
    app_handle: &AppHandle,
    projects: &Vec<ProjectFull>,
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
) -> Result<Vec<ProjectFull>, String> {
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
    match serde_json::from_slice::<Vec<ProjectFull>>(&decrypted) {
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
    Ok(file_path)
}
