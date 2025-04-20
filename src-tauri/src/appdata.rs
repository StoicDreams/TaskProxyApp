use crate::prelude::*;
use age::secrecy::{ExposeSecret, SecretString};
use keyring::Entry;

const KEYCHAIN_SERVICE_NAME: &str = "com.task-proxy.app";
const KEYCHAIN_USERNAME: &str = "task_proxy_user";
const PROJECTS_FILENAME: &str = "projects.data.enc";
const APPDATA_FILENAME: &str = "app.data.enc";

#[tauri::command]
pub(crate) fn has_securitykey() -> bool {
    match get_passphrase() {
        Ok(_) => true,
        Err(err) => {
            println!("Does not have security key: {}", err);
            false
        }
    }
}

#[tauri::command]
pub(crate) fn get_app_data(
    app_handle: AppHandle,
    state: State<SharedAppData>,
) -> Result<TaskProxyData, String> {
    let mut app_data = state
        .lock()
        .map_err(|err| format!("get_app_data State failure: {}", err))?;
    let data = app_data.to_owned();
    if data.is_saved {
        return Ok(data);
    }
    let data = match get_app_data_from_local_storage(&app_handle) {
        Ok(data) => data,
        Err(_) => TaskProxyData::new(),
    };
    let mut data = data;
    if !data.is_saved {
        data.is_saved = true;
        _ = save_app_data_to_local_storage(&app_handle, &data);
    }
    *app_data = data.clone();
    Ok(data)
}

#[tauri::command]
pub(crate) fn sync_app_data(
    state: State<SharedAppData>,
    data: TaskProxyData,
) -> Result<String, String> {
    let mut app_data = state
        .lock()
        .map_err(|err| format!("sync_app_data State failure: {}", err))?;
    let data = data;
    *app_data = data.clone();
    Ok(String::from("App Data Synced"))
}

#[tauri::command]
pub(crate) fn save_app_data(
    app_handle: AppHandle,
    state: State<SharedAppData>,
    data: TaskProxyData,
) -> Result<String, String> {
    let mut app_data = state
        .lock()
        .map_err(|err| format!("save_app_data State failure: {}", err))?;
    let mut data = data;
    if !data.is_saved {
        data.is_saved = true;
    }
    *app_data = data.clone();
    save_app_data_to_local_storage(&app_handle, &data)
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
    _ = save_projects_if_any(&app_handle, &state);
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

pub(crate) fn get_state_data<T: Clone + Send + Sync + 'static>(
    app_handle: &AppHandle,
) -> Result<T, String> {
    if let Some(state) = app_handle.try_state::<Arc<Mutex<T>>>() {
        let app_data = state
            .lock()
            .map_err(|_| "Failed to acquire lock".to_string())?;
        Ok(app_data.clone())
    } else {
        Err("Failed to load state".to_string())
    }
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

fn save_projects_if_any(
    app_handle: &AppHandle,
    state: &State<SharedProjects>,
) -> Result<String, String> {
    let projects = state
        .lock()
        .map_err(|err| format!("save_projects_if_any State failure: {}", err))?;
    let projects = projects.to_vec();
    if projects.is_empty() {
        return Ok(String::from("Projects is empty"));
    }
    save_projects_to_local_storage(&app_handle, &projects)
}

/// Save projects to local data storage
pub(crate) fn save_projects_to_local_storage(
    app_handle: &AppHandle,
    projects: &Vec<Project>,
) -> Result<String, String> {
    let json = serde_json::to_string(projects)
        .map_err(|err| format!("Failed to serialize projects: {}", err))?;
    save_json_to_local_storage("Projects", app_handle, json, PROJECTS_FILENAME)
}

pub(crate) fn save_app_data_to_local_storage(
    app_handle: &AppHandle,
    app_data: &TaskProxyData,
) -> Result<String, String> {
    let json = serde_json::to_string(app_data)
        .map_err(|err| format!("Failed to serialize app data: {}", err))?;
    save_json_to_local_storage("app data", app_handle, json, APPDATA_FILENAME)
}

/// Get projects from local data storage
pub(crate) fn get_projects_from_local_storage(
    app_handle: &AppHandle,
) -> Result<Vec<Project>, String> {
    let decrypted = get_data_from_local_storage(app_handle, PROJECTS_FILENAME)?;
    if decrypted.is_empty() {
        return Ok(Vec::new());
    }
    Ok(serde_json::from_slice::<Vec<Project>>(&decrypted)
        .map_err(|err| format!("Failed to deserialize projects: {}", err))?)
}

pub(crate) fn get_app_data_from_local_storage(
    app_handle: &AppHandle,
) -> Result<TaskProxyData, String> {
    let decrypted = get_data_from_local_storage(app_handle, APPDATA_FILENAME)?;
    if decrypted.is_empty() {
        return Ok(TaskProxyData::new());
    }
    Ok(serde_json::from_slice::<TaskProxyData>(&decrypted)
        .map_err(|err| format!("Failed to deserialize app data: {}", err))?)
}

pub(crate) fn save_json_to_local_storage(
    data_type: &str,
    app_handle: &AppHandle,
    json: String,
    file_name: &str,
) -> Result<String, String> {
    let file_path = get_app_data_path(app_handle, file_name)?;
    let passphrase = get_passphrase()?;
    let recipient = age::scrypt::Recipient::new(passphrase.clone());
    let encrypted = match age::encrypt(&recipient, json.as_bytes()) {
        Ok(encrypted) => encrypted,
        Err(err) => return Err(format!("Failed to save {}: {}", data_type, err)),
    };
    match fs::write(&file_path, encrypted) {
        Ok(()) => {
            eprintln!("Successfully saved {}!", data_type);
            Ok(format!("{} saved", data_type))
        }
        Err(err) => {
            eprintln!("Failed to save {}!", data_type);
            Err(format!("Error saving {}: {}", data_type, err))
        }
    }
}

pub(crate) fn get_data_from_local_storage(
    app_handle: &AppHandle,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let file_path = get_app_data_path(app_handle, file_path)?;
    let passphrase = get_passphrase()?;
    let identity = age::scrypt::Identity::new(passphrase);
    let encrypted_data = match fs::read(&file_path) {
        Ok(data) => data,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            println!("Data file not found at {:?}.", file_path);
            return Ok(Vec::new());
        }
        Err(e) => {
            return Err(format!("Error reading data file {:?}: {}", file_path, e));
        }
    };
    if encrypted_data.is_empty() {
        println!("Data file {:?} is empty.", file_path);
        return Ok(Vec::new());
    }
    match age::decrypt(&identity, &encrypted_data) {
        Ok(decrypted) => Ok(decrypted),
        Err(err) => Err(format!("Failed to decrypt file: {}", err)),
    }
}

fn get_app_data_path(app_handle: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
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
    let file_path = data_dir.join(file_name);
    Ok(file_path)
}
