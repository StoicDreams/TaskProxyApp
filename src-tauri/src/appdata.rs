use crate::prelude::*;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Nonce};
use keyring::Entry;
use std::sync::Mutex;

const KEYCHAIN_SERVICE_NAME: &str = "com.task-proxy.app";
const KEYCHAIN_USERNAME: &str = "task_proxy_user";
const PROJECTS_FILENAME: &str = "projects.data.enc";
const APPDATA_FILENAME: &str = "app.data.enc";

const NONCE_LENGTH: usize = 12;
const UNREADABLE_SUFFIX: &str = ".unreadable";

static MEMORY_PASSPHRASE: Mutex<Option<String>> = Mutex::new(None);

#[tauri::command]
pub(crate) async fn has_securitykey() -> bool {
    task::spawn_blocking(|| match get_passphrase() {
        Ok(_) => true,
        Err(err) => {
            println!("Does not have security key: {}", err);
            false
        }
    })
    .await
    .unwrap_or(false)
}

#[tauri::command]
pub(crate) async fn get_app_data(
    app_handle: AppHandle,
    state: State<'_, SharedAppData>,
) -> Result<TaskProxyData, String> {
    {
        let app_data = state
            .lock()
            .map_err(|err| format!("get_app_data State failure: {}", err))?;
        if app_data.is_saved {
            return Ok(app_data.to_owned());
        }
    }
    let mut data = match get_app_data_from_local_storage(&app_handle).await {
        Ok(data) => data,
        Err(_) => TaskProxyData::new(),
    };
    if !data.is_saved {
        data.is_saved = true;
        _ = save_app_data_to_local_storage(&app_handle, &data).await;
    }
    {
        let mut app_data = state
            .lock()
            .map_err(|err| format!("get_app_data State failure: {}", err))?;
        *app_data = data.clone();
    }
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
pub(crate) async fn save_app_data(
    app_handle: AppHandle,
    state: State<'_, SharedAppData>,
    data: TaskProxyData,
) -> Result<String, String> {
    let data = {
        let mut app_data = state
            .lock()
            .map_err(|err| format!("save_app_data State failure: {}", err))?;
        let mut data = data;
        if !data.is_saved {
            data.is_saved = true;
        }
        *app_data = data.clone();
        data
    };
    save_app_data_to_local_storage(&app_handle, &data).await
}

/// Set the encryption passphrase to the keychain, carrying existing data over to it.
#[tauri::command]
pub(crate) async fn set_securitykey(
    app_handle: AppHandle,
    state: State<'_, SharedProjects>,
    security_key: &str,
) -> Result<String, String> {
    let new_key = security_key.to_owned();
    let data_dir = app_data_dir(&app_handle)?;
    let needs_reload = task::spawn_blocking(move || apply_new_passphrase(&data_dir, new_key))
        .await
        .map_err(|err| format!("{}", err))??;
    if needs_reload {
        // Memory holds blank defaults while disk holds real data. Restart without saving.
        // If no new copy starts, exit anyway, since autosaves from this copy would replace the real data.
        if crate::services::updates::restart_app(&app_handle)
            .await
            .is_err()
        {
            app_handle.exit(0);
        }
        return Ok(String::from("Security Key Saved! Restarting..."));
    }
    _ = save_projects_if_any(&app_handle, &state).await;
    Ok(String::from("Security Key Saved!"))
}

#[tauri::command]
pub(crate) async fn delete_securitykey() -> Result<String, String> {
    let result = task::spawn_blocking(move || {
        let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
            .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
        entry
            .delete_credential()
            .map_err(|e| format!("Failed to delete security key from keychain: {:?}", e))?;
        if let Ok(mut cache) = MEMORY_PASSPHRASE.lock() {
            *cache = None;
        }
        Ok(String::from("Security Key Deleted!"))
    })
    .await;
    let result = result.map_err(|err| format!("{}", err))?;
    result
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
    let mut cache = MEMORY_PASSPHRASE
        .lock()
        .map_err(|_| "Failed to lock passphrase cache")?;
    if let Some(cached_pass) = cache.as_ref() {
        return Ok(SecretString::from(cached_pass.clone()));
    }
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    match entry.get_password() {
        Ok(password) => {
            *cache = Some(password.clone());
            Ok(SecretString::from(password))
        }
        Err(e) => Err(format!(
            "Failed to retrieve security key from keychain: {:?}",
            e
        )),
    }
}

async fn save_projects_if_any(
    app_handle: &AppHandle,
    state: &State<'_, SharedProjects>,
) -> Result<String, String> {
    let projects = {
        let projects = state
            .lock()
            .map_err(|err| format!("save_projects_if_any State failure: {}", err))?;
        let projects = projects.to_vec();
        if projects.is_empty() {
            return Ok(String::from("Projects is empty"));
        }
        projects
    };
    save_projects_to_local_storage(&app_handle, &projects).await
}

/// Save projects to local data storage
pub(crate) async fn save_projects_to_local_storage(
    app_handle: &AppHandle,
    projects: &Vec<Project>,
) -> Result<String, String> {
    let json = serde_json::to_string(projects)
        .map_err(|err| format!("Failed to serialize projects: {}", err))?;
    save_json_to_local_storage("Projects", app_handle, json, PROJECTS_FILENAME).await
}

pub(crate) async fn save_app_data_to_local_storage(
    app_handle: &AppHandle,
    app_data: &TaskProxyData,
) -> Result<String, String> {
    let json = serde_json::to_string(app_data)
        .map_err(|err| format!("Failed to serialize app data: {}", err))?;
    save_json_to_local_storage("app data", app_handle, json, APPDATA_FILENAME).await
}

/// Get projects from local data storage
pub(crate) async fn get_projects_from_local_storage(
    app_handle: &AppHandle,
) -> Result<Vec<Project>, String> {
    let decrypted = get_data_from_local_storage(app_handle, PROJECTS_FILENAME).await?;
    if decrypted.is_empty() {
        return Ok(Vec::new());
    }
    parse_or_preserve(
        &app_data_dir(app_handle)?.join(PROJECTS_FILENAME),
        &decrypted,
    )
}

pub(crate) async fn get_app_data_from_local_storage(
    app_handle: &AppHandle,
) -> Result<TaskProxyData, String> {
    let decrypted = get_data_from_local_storage(app_handle, APPDATA_FILENAME).await?;
    if decrypted.is_empty() {
        return Ok(TaskProxyData::new());
    }
    parse_or_preserve(
        &app_data_dir(app_handle)?.join(APPDATA_FILENAME),
        &decrypted,
    )
}

/// The app carries on with blank data when a file cannot be parsed, and its next save would
/// replace that file. It decrypts fine, so the save would not move it aside on its own.
fn parse_or_preserve<T: DeserializeOwned>(path: &Path, decrypted: &[u8]) -> Result<T, String> {
    serde_json::from_slice::<T>(decrypted).map_err(|err| {
        let _ = quarantine_file(path);
        format!("Failed to read {:?}, so it was kept aside: {}", path, err)
    })
}

pub(crate) async fn save_json_to_local_storage(
    data_type: &str,
    app_handle: &AppHandle,
    json: String,
    file_name: &str,
) -> Result<String, String> {
    let file_path = get_app_data_path(app_handle, file_name).await?;
    let data_type_string = data_type.to_string();
    let result = task::spawn_blocking(move || {
        let passphrase = get_passphrase()?;
        store_encrypted(&file_path, passphrase.expose_secret(), json.as_bytes())
            .map_err(|err| format!("Error saving {}: {}", data_type_string, err))?;
        Ok(format!("{} saved", data_type_string))
    })
    .await;
    let result = result.map_err(|err| format!("Task failed: {}", err))?;
    match result {
        Ok(msg) => {
            eprintln!("Successfully saved {}!", data_type);
            Ok(msg)
        }
        Err(err) => {
            eprintln!("Failed to save {}!", data_type);
            Err(err)
        }
    }
}

pub(crate) async fn get_data_from_local_storage(
    app_handle: &AppHandle,
    file_path: &str,
) -> Result<Vec<u8>, String> {
    let file_path = get_app_data_path(app_handle, file_path).await?;
    let result = task::spawn_blocking(move || {
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
        let passphrase = get_passphrase()?;
        decrypt_bytes(passphrase.expose_secret(), &encrypted_data)
            .map_err(|err| format!("{} ({:?})", err, file_path))
    })
    .await;
    result.map_err(|err| format!("Task failed: {}", err))?
}

async fn get_app_data_path(app_handle: &AppHandle, file_name: &str) -> Result<PathBuf, String> {
    Ok(app_data_dir(app_handle)?.join(file_name))
}

fn app_data_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    app_handle
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Could not resolve application data directory.\n{}", err))
}

fn cipher_for(passphrase: &str) -> Aes256Gcm {
    let mut hasher = Sha256::new();
    hasher.update(passphrase.as_bytes());
    let key_bytes = hasher.finalize();
    Aes256Gcm::new_from_slice(&key_bytes).expect("SHA-256 output is always 32 bytes")
}

fn encrypt_bytes(passphrase: &str, plain: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = cipher_for(passphrase);
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng); // 96-bits; 12 bytes
    let ciphertext = cipher
        .encrypt(&nonce, plain)
        .map_err(|err| format!("Failed to encrypt: {}", err))?;
    let mut encrypted = nonce.to_vec();
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

fn decrypt_bytes(passphrase: &str, encrypted: &[u8]) -> Result<Vec<u8>, String> {
    if encrypted.len() < NONCE_LENGTH {
        return Err(String::from("Data file is corrupted."));
    }
    let (nonce_bytes, ciphertext) = encrypted.split_at(NONCE_LENGTH);
    cipher_for(passphrase)
        .decrypt(Nonce::from_slice(nonce_bytes), ciphertext)
        .map_err(|err| format!("Failed to decrypt file: {}", err))
}

/// Encrypt and write a file without ever destroying data the current key cannot read.
/// An existing file that fails to decrypt is moved aside so that re-entering the
/// original key can recover it, see `restore_unreadable_files`.
fn store_encrypted(path: &Path, passphrase: &str, plain: &[u8]) -> Result<(), String> {
    if let Ok(existing) = fs::read(path) {
        if !existing.is_empty() && decrypt_bytes(passphrase, &existing).is_err() {
            quarantine_file(path).map_err(|err| err.to_string())?;
        }
    }
    let encrypted = encrypt_bytes(passphrase, plain)?;
    write_atomic(path, &encrypted).map_err(|err| err.to_string())
}

fn quarantine_file(path: &Path) -> io::Result<()> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut target = path.with_file_name(format!("{}{}", name, UNREADABLE_SUFFIX));
    if target.exists() {
        target = path.with_file_name(format!(
            "{}{}-{}",
            name,
            UNREADABLE_SUFFIX,
            Uuid::now_v7().simple()
        ));
    }
    eprintln!("Preserving unreadable data file at {:?}", target);
    fs::rename(path, target)
}

fn encrypted_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && path.extension().is_some_and(|ext| ext == "enc"))
        .collect();
    files.sort();
    files
}

/// Decrypt every data file with the old key and encrypt it with the new one, without
/// writing anything, so a failure before the keychain update changes nothing on disk.
fn reencrypt_files(
    dir: &Path,
    old_key: &str,
    new_key: &str,
) -> Result<Vec<(PathBuf, Vec<u8>)>, String> {
    let mut rekeyed = Vec::new();
    for path in encrypted_files(dir) {
        let existing = fs::read(&path).map_err(|err| err.to_string())?;
        if existing.is_empty() {
            continue;
        }
        match decrypt_bytes(old_key, &existing) {
            Ok(plain) => rekeyed.push((path, encrypt_bytes(new_key, &plain)?)),
            Err(_) => eprintln!("Skipping {:?}: not readable with the current key", path),
        }
    }
    Ok(rekeyed)
}

/// Put quarantined files back when the given key can read them. Returns how many were restored.
fn restore_unreadable_files(dir: &Path, passphrase: &str) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut quarantined: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .is_some_and(|name| name.to_string_lossy().contains(UNREADABLE_SUFFIX))
        })
        .collect();
    quarantined.sort();
    let mut restored = 0;
    for path in quarantined {
        let readable = fs::read(&path)
            .map(|bytes| decrypt_bytes(passphrase, &bytes).is_ok())
            .unwrap_or(false);
        if !readable {
            continue;
        }
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        let original = name.split(UNREADABLE_SUFFIX).next().unwrap_or_default();
        if !original.is_empty() && fs::rename(&path, path.with_file_name(original)).is_ok() {
            restored += 1;
        }
    }
    restored
}

fn has_readable_files(dir: &Path, passphrase: &str) -> bool {
    encrypted_files(dir).iter().any(|path| {
        fs::read(path)
            .map(|bytes| !bytes.is_empty() && decrypt_bytes(passphrase, &bytes).is_ok())
            .unwrap_or(false)
    })
}

/// Switch to a new passphrase, carrying all stored data over to it.
/// Returns true when data on disk now differs from what the app has in memory.
fn apply_new_passphrase(dir: &Path, new_key: String) -> Result<bool, String> {
    let old_key = get_passphrase()
        .ok()
        .map(|key| key.expose_secret().to_string());
    let rekeyed = match &old_key {
        Some(old_key) if *old_key != new_key => reencrypt_files(dir, old_key, &new_key)?,
        _ => Vec::new(),
    };
    let secret = SecretString::from(new_key.clone());
    let entry = Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_USERNAME)
        .map_err(|e| format!("Failed to create keychain entry: {:?}", e))?;
    entry
        .set_password(secret.expose_secret())
        .map_err(|e| format!("Failed to store new security key in keychain: {:?}", e))?;
    if let Ok(mut cache) = MEMORY_PASSPHRASE.lock() {
        *cache = Some(new_key.clone());
    }
    for (path, bytes) in rekeyed {
        write_atomic(&path, &bytes)
            .map_err(|err| format!("Failed to re-encrypt {:?}: {}", path, err))?;
    }
    let restored = restore_unreadable_files(dir, &new_key);
    Ok(restored > 0 || (old_key.is_none() && has_readable_files(dir, &new_key)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypted_round_trip_requires_the_right_key() {
        let encrypted = encrypt_bytes("right", b"secret").unwrap();
        assert_eq!(decrypt_bytes("right", &encrypted).unwrap(), b"secret");
        assert!(decrypt_bytes("wrong", &encrypted).is_err());
        assert!(decrypt_bytes("right", b"short").is_err());
    }

    #[test]
    fn saving_with_a_different_key_preserves_the_unreadable_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.data.enc");
        store_encrypted(&path, "original", b"precious").unwrap();
        store_encrypted(&path, "other", b"blank").unwrap();
        let current = fs::read(&path).unwrap();
        assert_eq!(decrypt_bytes("other", &current).unwrap(), b"blank");
        assert_eq!(restore_unreadable_files(dir.path(), "wrong"), 0);
        assert_eq!(restore_unreadable_files(dir.path(), "original"), 1);
        let restored = fs::read(&path).unwrap();
        assert_eq!(decrypt_bytes("original", &restored).unwrap(), b"precious");
    }

    #[test]
    fn saving_with_the_same_key_creates_no_quarantine_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.data.enc");
        store_encrypted(&path, "key", b"one").unwrap();
        store_encrypted(&path, "key", b"two").unwrap();
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn rekeying_covers_every_data_file_and_writes_nothing_itself() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["app.data.enc", "projects.data.enc", "abc.enc", "abc.cp.enc"] {
            store_encrypted(&dir.path().join(name), "old", name.as_bytes()).unwrap();
        }
        let rekeyed = reencrypt_files(dir.path(), "old", "new").unwrap();
        assert_eq!(rekeyed.len(), 4);
        assert!(has_readable_files(dir.path(), "old"));
        for (path, bytes) in rekeyed {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            assert_eq!(decrypt_bytes("new", &bytes).unwrap(), name.as_bytes());
        }
    }

    #[test]
    fn data_that_cannot_be_parsed_is_kept_aside_instead_of_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(APPDATA_FILENAME);
        store_encrypted(&path, "key", b"{\"unexpected\": true").unwrap();
        let result = parse_or_preserve::<TaskProxyData>(&path, b"{\"unexpected\": true");
        assert!(result.is_err());
        assert!(!path.exists());
        assert!(
            dir.path()
                .join(format!("{}{}", APPDATA_FILENAME, UNREADABLE_SUFFIX))
                .exists()
        );
    }

    #[test]
    fn data_that_parses_is_returned_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PROJECTS_FILENAME);
        let json = br#"[{"name":"A","path":"/a"}]"#;
        store_encrypted(&path, "key", json).unwrap();
        let projects = parse_or_preserve::<Vec<Project>>(&path, json).unwrap();
        assert_eq!(projects[0].name, "A");
        assert!(path.exists());
    }
}
