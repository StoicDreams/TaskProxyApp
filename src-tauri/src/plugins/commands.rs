//! The plugin commands the UI calls through `webui.proxy.plugins`.
use super::manifest::PluginManifest;
use super::registry::{InstalledPlugin, Registry};
use super::runtime::{self, CallContext, NetworkHttp, PluginStore};
use super::settings::PluginSettings;
use crate::prelude::*;
use crate::services::git_controller::{find_git_repos, selected_repo};
use extism::CompiledPlugin;
use serde_json::{Map, json};
use std::sync::LazyLock;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInfo {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub signed: bool,
    /// `None` when the installed files cannot be read, with `error` saying why.
    pub manifest: Option<PluginManifest>,
    pub error: Option<String>,
    /// Whether the open project has every setting the plugin declares, so its pages can work.
    pub configured: bool,
    /// How many sign-ins the user has entered for it, in any project.
    pub sign_ins: usize,
}

/// Each installed plugin compiled once, by id and version.
static COMPILED: LazyLock<Mutex<HashMap<String, Arc<CompiledPlugin>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Each plugin's storage, read from its encrypted file the first time it is needed.
static STORES: LazyLock<Mutex<HashMap<String, Arc<Mutex<PluginStore>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// Saving one plugin's storage at a time keeps an older copy from replacing a newer one.
static STORE_SAVE: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

fn registry(app: &AppHandle) -> Result<Registry, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|err| format!("Could not find the app data folder: {}", err))?;
    Ok(Registry::new(dir.join("plugins")))
}

fn store_file(id: &str) -> String {
    format!("plugin-{}.enc", id)
}

/// The values the user entered in a plugin's settings, kept apart from its storage, which the plugin can change.
fn settings_file(id: &str) -> String {
    format!("plugin-{}-settings.enc", id)
}

/// The open project's id, which plugin settings are kept by.
fn current_project(app: &AppHandle) -> Option<String> {
    get_state_data::<ProjectData>(app)
        .ok()
        .map(|data| data.id)
        .filter(|id| !id.is_empty())
}

async fn read_settings(app: &AppHandle, id: &str) -> Result<PluginSettings, String> {
    let bytes = get_data_from_local_storage(app, &settings_file(id)).await?;
    let project = current_project(app);
    let settings = PluginSettings::read(&bytes, project.as_deref()).map_err(|err| {
        format!(
            "The settings for the plugin {} could not be read: {}",
            id, err
        )
    })?;
    // Settings from before projects had their own are saved in the new form at once, so they stay with the
    // project that was open when they were first read.
    if !bytes.is_empty() && !String::from_utf8_lossy(&bytes).contains("\"signIns\"") {
        write_settings(app, id, &settings).await?;
    }
    Ok(settings)
}

async fn write_settings(
    app: &AppHandle,
    id: &str,
    settings: &PluginSettings,
) -> Result<(), String> {
    let json = serde_json::to_string(settings).map_err(|err| err.to_string())?;
    save_json_to_local_storage("plugin settings", app, json, &settings_file(id))
        .await
        .map(|_| ())
}

/// One declared variable, for the settings form. Secret values are never sent to the window.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSetting {
    pub key: String,
    pub label: String,
    pub help: String,
    pub secret: bool,
    pub is_set: bool,
    pub value: Option<String>,
}

fn info(registry: &Registry, installed: InstalledPlugin) -> PluginInfo {
    let manifest = registry.manifest(&installed);
    PluginInfo {
        id: installed.id,
        version: installed.version,
        enabled: installed.enabled,
        signed: installed.signed,
        error: manifest.as_ref().err().cloned(),
        manifest: manifest.ok(),
        configured: false,
        sign_ins: 0,
    }
}

/// A sign-in to choose from, named by its values that are not secret, such as a site and an email.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInChoice {
    pub id: String,
    pub label: String,
    /// How many projects use it.
    pub projects: usize,
}

/// A plugin's settings for the open project, and the sign-ins it could use instead.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSettingsView {
    /// Whether a project is open, since settings belong to one.
    pub has_project: bool,
    /// The sign-in the open project uses, if any.
    pub sign_in: Option<String>,
    /// The settings of that sign-in, or empty ones for a new sign-in.
    pub settings: Vec<PluginSetting>,
    pub sign_ins: Vec<SignInChoice>,
}

fn sign_in_label(manifest: &PluginManifest, values: &HashMap<String, String>, id: &str) -> String {
    let shown: Vec<String> = manifest
        .permissions
        .variables
        .iter()
        .filter(|variable| !variable.secret)
        .filter_map(|variable| {
            values
                .get(&variable.key)
                .filter(|value| !value.is_empty())
                .cloned()
        })
        .collect();
    if shown.is_empty() {
        id.replace('-', " ")
    } else {
        shown.join(" · ")
    }
}

fn forget_compiled(id: &str) {
    if let Ok(mut compiled) = COMPILED.lock() {
        compiled.retain(|key, _| !key.starts_with(&format!("{}@", id)));
    }
}

fn compiled(
    registry: &Registry,
    installed: &InstalledPlugin,
) -> Result<Arc<CompiledPlugin>, String> {
    let key = format!("{}@{}", installed.id, installed.version);
    if let Some(found) = COMPILED.lock().map_err(|err| err.to_string())?.get(&key) {
        return Ok(found.clone());
    }
    let compiled = Arc::new(runtime::compile(&registry.wasm(installed)?)?);
    COMPILED
        .lock()
        .map_err(|err| err.to_string())?
        .insert(key, compiled.clone());
    Ok(compiled)
}

async fn plugin_store(app: &AppHandle, id: &str) -> Result<Arc<Mutex<PluginStore>>, String> {
    if let Some(found) = STORES.lock().map_err(|err| err.to_string())?.get(id) {
        return Ok(found.clone());
    }
    let bytes = get_data_from_local_storage(app, &store_file(id)).await?;
    let values = if bytes.is_empty() {
        HashMap::new()
    } else {
        serde_json::from_slice(&bytes).map_err(|err| {
            format!(
                "The saved data for the plugin {} could not be read: {}",
                id, err
            )
        })?
    };
    let store = Arc::new(Mutex::new(PluginStore {
        values,
        changed: false,
    }));
    let mut stores = STORES.lock().map_err(|err| err.to_string())?;
    Ok(stores.entry(id.to_string()).or_insert(store).clone())
}

async fn save_store(
    app: &AppHandle,
    id: &str,
    store: &Arc<Mutex<PluginStore>>,
) -> Result<(), String> {
    let _saving = STORE_SAVE.lock().await;
    let json = {
        let mut store = store.lock().map_err(|err| err.to_string())?;
        if !store.changed {
            return Ok(());
        }
        store.changed = false;
        serde_json::to_string(&store.values).map_err(|err| err.to_string())?
    };
    save_json_to_local_storage("plugin data", app, json, &store_file(id))
        .await
        .map(|_| ())
}

fn text_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

/// The declared variables' values: a project variable first, then a global one, then the plugin's own settings.
/// Variables let a project override a setting, such as using another Jira site.
fn declared_variables(
    app: &AppHandle,
    manifest: &PluginManifest,
    settings: &HashMap<String, String>,
) -> HashMap<String, String> {
    let project = get_state_data::<ProjectData>(app)
        .map(|data| data.data)
        .unwrap_or_default();
    let global = get_state_data::<TaskProxyData>(app)
        .map(|data| data.data)
        .unwrap_or_default();
    manifest
        .permissions
        .variables
        .iter()
        .filter_map(|variable| {
            project
                .get(&variable.key)
                .and_then(text_value)
                .or_else(|| global.get(&variable.key).and_then(text_value))
                .or_else(|| {
                    settings
                        .get(&variable.key)
                        .filter(|value| !value.is_empty())
                        .cloned()
                })
                .map(|value| (variable.key.clone(), value))
        })
        .collect()
}

/// The open project's root, and its selected repo, or its first when none is chosen, as the Git Controller does.
fn project_and_repo(app: &AppHandle) -> (Option<PathBuf>, Option<PathBuf>) {
    let Ok(project) = get_state_data::<ProjectData>(app) else {
        return (None, None);
    };
    if project.path.is_empty() {
        return (None, None);
    }
    let root = PathBuf::from(project.path.replace('\\', "/"));
    let repos = find_git_repos(&root);
    let repo = selected_repo(&project.data)
        .filter(|selected| repos.contains(selected))
        .or_else(|| repos.first().cloned())
        .and_then(|repo| safe_relative_path(&repo).ok())
        .map(|repo| root.join(repo));
    (Some(root), repo)
}

/// Calls a plugin export with a fresh context, then saves its storage if it changed.
async fn run(
    app: &AppHandle,
    id: &str,
    export: &'static str,
    input: Value,
) -> Result<Value, String> {
    let registry = registry(app)?;
    let installed = registry.enabled(id)?;
    let manifest = registry.manifest(&installed)?;
    let compiled = compiled(&registry, &installed)?;
    let store = plugin_store(app, id).await?;
    let settings = read_settings(app, id).await?;
    let variables = declared_variables(
        app,
        &manifest,
        &settings.values(current_project(app).as_deref()),
    );
    let app_handle = app.clone();
    let context_store = store.clone();
    let result = task::spawn_blocking(move || {
        let (project_root, repo_path) = project_and_repo(&app_handle);
        let context = Arc::new(CallContext {
            manifest,
            variables,
            store: context_store,
            project_root,
            repo_path,
            http: Arc::new(NetworkHttp),
        });
        runtime::call(&compiled, export, &input, context)
    })
    .await
    .map_err(|err| format!("The plugin call failed: {}", err))?;
    if let Err(err) = save_store(app, id, &store).await {
        eprintln!("Could not save the data for the plugin {}: {}", id, err);
    }
    result
}

#[tauri::command]
pub(crate) async fn plugin_list(app_handle: AppHandle) -> Result<Vec<PluginInfo>, String> {
    let registry = registry(&app_handle)?;
    let project = current_project(&app_handle);
    let mut list = Vec::new();
    for installed in registry.list() {
        let mut plugin = info(&registry, installed);
        if let Some(manifest) = &plugin.manifest {
            let declared = &manifest.permissions.variables;
            if declared.is_empty() {
                plugin.configured = true;
            } else if let Ok(settings) = read_settings(&app_handle, &plugin.id).await {
                let values =
                    declared_variables(&app_handle, manifest, &settings.values(project.as_deref()));
                plugin.configured = declared
                    .iter()
                    .all(|variable| values.contains_key(&variable.key));
                plugin.sign_ins = settings.sign_ins.len();
            }
        }
        list.push(plugin);
    }
    Ok(list)
}

/// The plugins Stoic Dreams publishes, for the Plugins page to offer.
#[tauri::command]
pub(crate) async fn plugin_catalog() -> Result<Vec<super::catalog::CatalogEntry>, String> {
    super::catalog::fetch_catalog().await
}

/// Installs or updates a plugin from the catalog, after checking its signatures.
#[tauri::command]
pub(crate) async fn plugin_install_catalog(
    app_handle: AppHandle,
    id: String,
) -> Result<PluginInfo, String> {
    let public_key = super::catalog::app_public_key(&app_handle)?;
    let entry = super::catalog::fetch_catalog()
        .await?
        .into_iter()
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("The plugin catalog has no plugin named {}.", id))?;
    let (manifest, wasm) = super::catalog::download_package(&entry, &public_key).await?;
    let registry = registry(&app_handle)?;
    let installed = task::spawn_blocking({
        let dir = registry.dir.clone();
        move || Registry::new(dir).install(&manifest, &wasm, true)
    })
    .await
    .map_err(|err| err.to_string())??;
    forget_compiled(&installed.id);
    let installed = registry
        .list()
        .into_iter()
        .find(|plugin| plugin.id == installed.id)
        .ok_or_else(|| String::from("The plugin was not recorded as installed."))?;
    Ok(info(&registry, installed))
}

/// Reads a plugin folder's manifest without installing it, so its permissions can be shown first.
#[tauri::command]
pub(crate) async fn plugin_inspect_folder(folder: String) -> Result<PluginManifest, String> {
    let text = fs::read_to_string(Path::new(&folder).join("plugin.json"))
        .map_err(|_| format!("{} has no plugin.json.", folder))?;
    PluginManifest::parse(&text)
}

#[tauri::command]
pub(crate) async fn plugin_install_folder(
    app_handle: AppHandle,
    folder: String,
) -> Result<PluginInfo, String> {
    let registry = registry(&app_handle)?;
    let manifest = task::spawn_blocking({
        let dir = registry.dir.clone();
        move || Registry::new(dir).install_folder(Path::new(&folder))
    })
    .await
    .map_err(|err| err.to_string())??;
    forget_compiled(&manifest.id);
    let installed = registry
        .list()
        .into_iter()
        .find(|installed| installed.id == manifest.id)
        .ok_or_else(|| String::from("The plugin was not recorded as installed."))?;
    Ok(info(&registry, installed))
}

/// Removes a plugin with its settings and saved data.
#[tauri::command]
pub(crate) async fn plugin_remove(app_handle: AppHandle, id: String) -> Result<(), String> {
    let registry = registry(&app_handle)?;
    if !super::manifest::is_slug(&id) {
        return Err(format!("The plugin {} is not installed.", id));
    }
    forget_compiled(&id);
    registry.remove(&id)?;
    if let Ok(mut stores) = STORES.lock() {
        stores.remove(&id);
    }
    if let Some(data_dir) = registry.dir.parent() {
        for file in [store_file(&id), settings_file(&id)] {
            let _ = fs::remove_file(data_dir.join(file));
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn plugin_set_enabled(
    app_handle: AppHandle,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    registry(&app_handle)?.set_enabled(&id, enabled)
}

fn installed_manifest(registry: &Registry, id: &str) -> Result<PluginManifest, String> {
    let installed = registry
        .list()
        .into_iter()
        .find(|installed| installed.id == id)
        .ok_or_else(|| format!("The plugin {} is not installed.", id))?;
    registry.manifest(&installed)
}

/// The plugin's settings for the open project, and the sign-ins it could use instead. Secret values never leave.
#[tauri::command]
pub(crate) async fn plugin_settings(
    app_handle: AppHandle,
    id: String,
) -> Result<PluginSettingsView, String> {
    let manifest = installed_manifest(&registry(&app_handle)?, &id)?;
    let settings = read_settings(&app_handle, &id).await?;
    let project = current_project(&app_handle);
    let current = settings.for_project(project.as_deref());
    let values = current
        .map(|(_, sign_in)| sign_in.values.clone())
        .unwrap_or_default();
    Ok(PluginSettingsView {
        has_project: project.is_some(),
        sign_in: current.map(|(id, _)| id.clone()),
        settings: manifest
            .permissions
            .variables
            .iter()
            .map(|variable| {
                let value = values.get(&variable.key).filter(|value| !value.is_empty());
                PluginSetting {
                    key: variable.key.clone(),
                    label: if variable.label.is_empty() {
                        variable.key.clone()
                    } else {
                        variable.label.clone()
                    },
                    help: variable.help.clone(),
                    secret: variable.secret,
                    is_set: value.is_some(),
                    value: if variable.secret {
                        None
                    } else {
                        value.cloned()
                    },
                }
            })
            .collect(),
        sign_ins: settings
            .sign_ins
            .iter()
            .map(|(id, sign_in)| SignInChoice {
                id: id.clone(),
                label: sign_in_label(&manifest, &sign_in.values, id),
                projects: settings.uses(id),
            })
            .collect(),
    })
}

/// Saves the open project's settings, to its own sign-in, or a new one when it has none. A key left out is kept
/// as it was, and an empty value removes it, so a secret can be kept without the window ever holding it.
#[tauri::command]
pub(crate) async fn plugin_save_settings(
    app_handle: AppHandle,
    id: String,
    values: HashMap<String, String>,
) -> Result<(), String> {
    let manifest = installed_manifest(&registry(&app_handle)?, &id)?;
    if let Some(key) = values.keys().find(|key| !manifest.declares_variable(key)) {
        return Err(format!("{} has no setting named {}.", manifest.name, key));
    }
    let project = current_project(&app_handle)
        .ok_or_else(|| format!("Open a project to set up {} for it.", manifest.name))?;
    let mut settings = read_settings(&app_handle, &id).await?;
    settings.save(&project, values);
    write_settings(&app_handle, &id, &settings).await
}

/// Has the open project use one of the plugin's existing sign-ins, or none.
#[tauri::command]
pub(crate) async fn plugin_use_sign_in(
    app_handle: AppHandle,
    id: String,
    sign_in: Option<String>,
) -> Result<(), String> {
    let manifest = installed_manifest(&registry(&app_handle)?, &id)?;
    let project = current_project(&app_handle)
        .ok_or_else(|| format!("Open a project to set up {} for it.", manifest.name))?;
    let mut settings = read_settings(&app_handle, &id).await?;
    settings.link(&project, sign_in.as_deref())?;
    write_settings(&app_handle, &id, &settings).await
}

#[tauri::command]
pub(crate) async fn plugin_render(
    app_handle: AppHandle,
    id: String,
    page: String,
    params: Option<Map<String, Value>>,
) -> Result<Value, String> {
    let input = json!({ "page": page, "params": params.unwrap_or_default() });
    run(&app_handle, &id, "render", input).await
}

/// `request` holds the page, its params, the action's id and params, and any form values.
#[tauri::command]
pub(crate) async fn plugin_action(
    app_handle: AppHandle,
    id: String,
    request: Value,
) -> Result<Value, String> {
    run(&app_handle, &id, "action", request).await
}

/// A card from each enabled plugin that contributes to the Git Controller, about the selected repo's branch.
#[tauri::command]
pub(crate) async fn plugin_branch_info(app_handle: AppHandle) -> Result<Vec<Value>, String> {
    let registry = registry(&app_handle)?;
    let handle = app_handle.clone();
    let branch = task::spawn_blocking(move || {
        let (_, repo) = project_and_repo(&handle);
        runtime::current_branch(&repo?)
    })
    .await
    .map_err(|err| err.to_string())?;
    let Some(branch) = branch else {
        return Ok(Vec::new());
    };
    let mut cards = Vec::new();
    for installed in registry
        .list()
        .into_iter()
        .filter(|installed| installed.enabled)
    {
        let Ok(manifest) = registry.manifest(&installed) else {
            continue;
        };
        if !manifest.contributes("gitBranchInfo") {
            continue;
        }
        let card = run(
            &app_handle,
            &installed.id,
            "branch_info",
            json!({ "branch": branch }),
        )
        .await;
        match card {
            Ok(Value::Null) => {}
            Ok(card) => {
                cards.push(json!({ "id": manifest.id, "name": manifest.name, "card": card }))
            }
            Err(err) => {
                cards.push(json!({ "id": manifest.id, "name": manifest.name, "error": err }))
            }
        }
    }
    Ok(cards)
}

/// The notifications of each enabled plugin that contributes them, for the Alerts panel, as
/// `[{ id, name, items }]`, or `{ id, name, error }` for a plugin that failed.
#[tauri::command]
pub(crate) async fn plugin_notifications(app_handle: AppHandle) -> Result<Vec<Value>, String> {
    let registry = registry(&app_handle)?;
    let mut lists = Vec::new();
    for installed in registry
        .list()
        .into_iter()
        .filter(|installed| installed.enabled)
    {
        let Ok(manifest) = registry.manifest(&installed) else {
            continue;
        };
        if !manifest.contributes("notifications") {
            continue;
        }
        match run(&app_handle, &installed.id, "notifications", json!({})).await {
            Ok(items) => {
                lists.push(json!({ "id": manifest.id, "name": manifest.name, "items": items }))
            }
            Err(err) => {
                lists.push(json!({ "id": manifest.id, "name": manifest.name, "error": err }))
            }
        }
    }
    Ok(lists)
}

/// The user closed one of a plugin's notifications.
#[tauri::command]
pub(crate) async fn plugin_notification_read(
    app_handle: AppHandle,
    id: String,
    notification: String,
) -> Result<(), String> {
    let registry = registry(&app_handle)?;
    let manifest = registry.manifest(&registry.enabled(&id)?)?;
    if !manifest.contributes("notifications") {
        return Err(format!("{} has no notifications.", manifest.name));
    }
    run(
        &app_handle,
        &id,
        "notification_read",
        json!({ "id": notification }),
    )
    .await
    .map(|_| ())
}

/// Runs something a plugin's button asked Task Proxy to do, after the user clicked it.
#[tauri::command]
pub(crate) async fn plugin_host_action(
    app_handle: AppHandle,
    id: String,
    action: Value,
) -> Result<String, String> {
    let registry = registry(&app_handle)?;
    let manifest = registry.manifest(&registry.enabled(&id)?)?;
    let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "git.createBranch" => {
            if !manifest.allows_git("createBranch") {
                return Err(format!("{} did not ask to create branches.", manifest.name));
            }
            let name = action
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !git2::Branch::name_is_valid(&name).unwrap_or(false) {
                return Err(format!("'{}' is not a valid branch name.", name));
            }
            let handle = app_handle.clone();
            task::spawn_blocking(move || {
                let (_, repo) = project_and_repo(&handle);
                let repo = repo.ok_or_else(|| String::from("The open project has no git repo."))?;
                let repository = git2::Repository::open(&repo).map_err(|err| err.to_string())?;
                crate::services::git_controller::create_branch(&repository, &name, "")
            })
            .await
            .map_err(|err| err.to_string())?
        }
        "openUrl" => {
            use tauri_plugin_opener::OpenerExt;
            let url = action.get("url").and_then(Value::as_str).unwrap_or("");
            let parsed =
                reqwest::Url::parse(url).map_err(|_| format!("Invalid address: {}", url))?;
            if parsed.scheme() != "https" {
                return Err(String::from("Plugins can only open https addresses."));
            }
            app_handle
                .opener()
                .open_url(parsed.as_str(), None::<&str>)
                .map_err(|err| format!("Could not open {}: {}", url, err))?;
            Ok(String::new())
        }
        other => Err(format!("Task Proxy does not know how to '{}'.", other)),
    }
}
