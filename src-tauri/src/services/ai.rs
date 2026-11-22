//! AI writing help: drafts the user reviews, such as commit messages, code reviews, page segments, scripts, and
//! suggestions for importing markdown files as pages.
//!
//! The user sets up any number of providers in Settings: OpenAI-compatible servers (OpenAI, Ollama, LM Studio, ...),
//! the Anthropic API, or a command such as `claude -p --model {model}`. Every call is made here, so API keys never
//! reach the window. The window says which instructions and model to use, since it holds both scopes of them.

use crate::prelude::*;
use git2::Repository;
use std::sync::LazyLock;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

const SETTINGS_FILE: &str = "ai-settings.enc";
const DEFAULT_TIMEOUT_SECS: u64 = 120;
const DEFAULT_MAX_CHARS: usize = 40_000;
/// Files larger than this are left out of a whole-project review.
const REVIEW_FILE_LIMIT: u64 = 200 * 1024;
const ANTHROPIC_BASE: &str = "https://api.anthropic.com";
const ANTHROPIC_VERSION: &str = "2023-06-01";
/// The most of a server's answer that is read, far more than any reply, so a broken server can't fill the memory.
const BODY_LIMIT: usize = 16 * 1024 * 1024;
/// The most of a refusal that is read. Only its start is shown.
const REFUSAL_LIMIT: usize = 64 * 1024;
/// A command's model is passed in this environment variable, where `{model}` reads it, so no model id can change
/// what the command line does.
const MODEL_VARIABLE: &str = "TASKPROXY_AI_MODEL";
const CANCELLED: &str = "Cancelled.";
const REQUEST_IN_USE: &str = "Another AI request with this id is still running.";

/// Each integration's built-in instructions, which the user's own instructions follow.
/// What every request is told first: that it is helping in Task Proxy, how a project's `.taskproxy` folder is laid
/// out, and how pages run their scripts, so drafts fit what Task Proxy does with them. Settings shows it as the
/// built-in shared instructions.
pub(crate) const TASK_PROXY_CONTEXT: &str = "You are helping a developer inside Task Proxy, a desktop app for working \
     on software projects. What you write is a draft: the developer reviews and changes it in Task Proxy before \
     anything is saved, committed, or run.\n\n\
     Task Proxy keeps its own files for a project in the project's .taskproxy folder, committed with the project:\n\
     - .taskproxy/pages/*.md: the project's documentation pages, shown in Task Proxy. A page starts with \
     <webui-data data-page-title=\"Title\" data-page-subtitle=\"One-line description\"></webui-data>, and its \
     content is markdown inside <webui-page-segment> and </webui-page-segment> blocks, with a heading line such \
     as ### Setup between blocks.\n\
     - .taskproxy/Navigation.json: the pages' navigation, a tree of folders and pages, each page linking to /<its \
     file name without .md>.\n\
     - .taskproxy/Variables.json: the names of the project's variables. Their values are kept by Task Proxy, never \
     in the project.\n\
     - .taskproxy/scripts/*.ps1: PowerShell 7 scripts saved in Task Proxy's Script Manager.\n\
     - .taskproxy/Project.json: the project's own settings, such as its icon.\n\n\
     In a page, a fenced code block marked pwsh, powershell, or ps1 gets a Run button, which runs it with \
     PowerShell 7 in the project's folder, in Task Proxy's Terminal Manager, where the developer watches it and \
     answers what it asks. Before it runs, each line such as $name = 'default' is given the value of the variable \
     called name, from the page, the project, or the global variables. So a page gives commands in such a block, \
     never asking anyone to copy a command into a terminal. Never put a secret in a draft: use a variable for it.";

pub(crate) const INTEGRATIONS: [(&str, &str); 5] = [
    (
        "git",
        "You write git commit messages. From the changes below, write a commit message: a short first line that \
         summarizes the change, then a blank line and the details when they help. Say what changed and why, not \
         how the diff looks. Reply with only the commit message.",
    ),
    (
        "review",
        "You review code. Report real problems: bugs, security issues, missing error handling, and anything that \
         breaks the instructions below. For each finding give the file, and the line when you can, what is wrong, \
         and how to fix it. Order the findings by severity, most severe first. Reply in markdown. If there is \
         nothing worth reporting, say so.",
    ),
    (
        "pages",
        "You write a project's documentation pages in markdown. Write the part of the page the user asks for, \
         matching the rest of the page. Reply with only the markdown for that part.",
    ),
    (
        "scripts",
        "You write PowerShell 7 scripts that run in a developer's project folder. Write the script the user asks \
         for, with any parameters in a `param()` block at the top. Reply with only the script.",
    ),
    (
        "markdown",
        "You organize a project's markdown files into documentation pages. For each file listed, suggest a short \
         title, a one-line description, and the navigation folders it belongs in, as a list of folder names from \
         the top (an empty list for the top level). Reply with only JSON: an array of objects with \"file\", \
         \"title\", \"subtitle\", and \"navPath\".",
    ),
];

fn built_in(integration: &str) -> Result<&'static str, String> {
    INTEGRATIONS
        .iter()
        .find(|(name, _)| *name == integration)
        .map(|(_, text)| *text)
        .ok_or_else(|| format!("Task Proxy has no AI integration '{}'.", integration))
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ProviderKind {
    #[default]
    OpenAi,
    Anthropic,
    Command,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiModel {
    /// What is sent to the provider, such as `gpt-4o`, `qwen2.5-coder:7b`, or `opus` for a command.
    pub id: String,
    /// What the user sees, such as Claude Opus 5.5. The id when empty.
    #[serde(default)]
    pub name: String,
}

/// A provider as it is saved, its key included.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct StoredProvider {
    id: String,
    name: String,
    kind: ProviderKind,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    command: String,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    models: Vec<AiModel>,
    #[serde(default)]
    hidden: Vec<String>,
    #[serde(default)]
    last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct AiStore {
    #[serde(default)]
    providers: Vec<StoredProvider>,
    #[serde(default = "default_timeout")]
    timeout_secs: u64,
    #[serde(default = "default_max_chars")]
    max_chars: usize,
}

fn default_timeout() -> u64 {
    DEFAULT_TIMEOUT_SECS
}
fn default_max_chars() -> usize {
    DEFAULT_MAX_CHARS
}

impl Default for AiStore {
    fn default() -> Self {
        Self {
            providers: Vec::new(),
            timeout_secs: DEFAULT_TIMEOUT_SECS,
            max_chars: DEFAULT_MAX_CHARS,
        }
    }
}

/// A provider as the window sees it: whether a key is set, never the key.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderView {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub command: String,
    pub key_set: bool,
    pub models: Vec<AiModel>,
    pub hidden: Vec<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiSettingsView {
    pub providers: Vec<ProviderView>,
    pub timeout_secs: u64,
    pub max_chars: usize,
    /// Each integration's built-in instructions, which the window shows as the instructions' placeholders.
    pub defaults: HashMap<String, String>,
    /// The operating system of the computer Task Proxy runs on, as Rust names it (`windows`, `linux`, `macos`), so a
    /// browser on another computer is shown the commands for this one.
    pub os: String,
}

fn view(store: &AiStore) -> AiSettingsView {
    AiSettingsView {
        providers: store
            .providers
            .iter()
            .map(|p| ProviderView {
                id: p.id.clone(),
                name: p.name.clone(),
                kind: p.kind,
                base_url: p.base_url.clone(),
                command: p.command.clone(),
                key_set: p.api_key.as_deref().is_some_and(|key| !key.is_empty()),
                models: p.models.clone(),
                hidden: p.hidden.clone(),
                last_error: p.last_error.clone(),
            })
            .collect(),
        timeout_secs: store.timeout_secs,
        max_chars: store.max_chars,
        defaults: INTEGRATIONS
            .iter()
            .map(|(name, text)| (name.to_string(), text.to_string()))
            .chain([(String::from("shared"), TASK_PROXY_CONTEXT.to_string())])
            .collect(),
        os: std::env::consts::OS.to_string(),
    }
}

/// A provider sent to be saved. A missing `apiKey` keeps the saved one, and an empty one removes it.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderUpdate {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    #[serde(default)]
    pub base_url: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub api_key: Option<String>,
    /// The models. A command's are typed in by the user; a server's come from refreshing, and are kept when missing.
    #[serde(default)]
    pub models: Option<Vec<AiModel>>,
    #[serde(default)]
    pub hidden: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SettingsUpdate {
    pub providers: Vec<ProviderUpdate>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub max_chars: Option<usize>,
}

/// Applies an update to the saved settings. Providers left out are removed, with their keys.
fn apply_update(store: &AiStore, update: SettingsUpdate) -> Result<AiStore, String> {
    let mut providers = Vec::new();
    for item in update.providers {
        let name = item.name.trim().to_string();
        if name.is_empty() {
            return Err(String::from("Each AI provider needs a name."));
        }
        let saved = store
            .providers
            .iter()
            .find(|p| !item.id.is_empty() && p.id == item.id);
        let id = if item.id.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            item.id.clone()
        };
        if providers.iter().any(|p: &StoredProvider| p.id == id) {
            return Err(format!("The AI provider {} is listed twice.", name));
        }
        let base_url = item.base_url.trim().trim_end_matches('/').to_string();
        let command = item.command.trim().to_string();
        let command = upgraded_claude_command(&command).unwrap_or(command);
        // A saved key only goes to the server it was saved for, so it is left behind when the provider moves.
        let same_server = saved.is_some_and(|p| p.kind == item.kind && p.base_url == base_url);
        let api_key = match item.api_key {
            None => saved
                .filter(|_| same_server)
                .and_then(|p| p.api_key.clone()),
            Some(key) if key.trim().is_empty() => None,
            Some(key) => Some(key.trim().to_string()),
        };
        match item.kind {
            ProviderKind::OpenAi if base_url.is_empty() => {
                return Err(format!("{} needs its server's address.", name));
            }
            ProviderKind::Command if command.is_empty() => {
                return Err(format!("{} needs the command to run.", name));
            }
            // In single quotes PowerShell would pass the words `${env:TASKPROXY_AI_MODEL}` rather than the model.
            ProviderKind::Command if model_in_single_quotes(&command) => {
                return Err(format!(
                    "{}'s command has {{model}} in single quotes. Leave the quotes out, or use double quotes: the model \
                     is always passed as one word.",
                    name
                ));
            }
            _ => {}
        }
        let models = item
            .models
            .unwrap_or_else(|| saved.map(|p| p.models.clone()).unwrap_or_default())
            .into_iter()
            .filter_map(|model| {
                let id = model.id.trim().to_string();
                (!id.is_empty()).then(|| AiModel {
                    name: model.name.trim().to_string(),
                    id,
                })
            })
            .collect::<Vec<AiModel>>();
        // A command can't list its models, so without one typed in it could never be chosen.
        if item.kind == ProviderKind::Command && models.is_empty() {
            return Err(format!("{} needs at least one model.", name));
        }
        // What failed last is kept while the provider is set up the same way.
        let same_setup = saved.is_some_and(|p| {
            p.kind == item.kind
                && p.base_url == base_url
                && p.command == command
                && p.api_key == api_key
        });
        providers.push(StoredProvider {
            id,
            name,
            kind: item.kind,
            base_url,
            command,
            api_key,
            models,
            hidden: item.hidden,
            last_error: if same_setup {
                saved.and_then(|p| p.last_error.clone())
            } else {
                None
            },
        });
    }
    Ok(AiStore {
        providers,
        timeout_secs: update
            .timeout_secs
            .unwrap_or(store.timeout_secs)
            .clamp(10, 3600),
        max_chars: update
            .max_chars
            .unwrap_or(store.max_chars)
            .clamp(2_000, 2_000_000),
    })
}

/// Saved settings are read and written one at a time, so two saves can't lose each other's changes.
static STORE_LOCK: LazyLock<tokio::sync::Mutex<()>> = LazyLock::new(|| tokio::sync::Mutex::new(()));

async fn load_store(app: &AppHandle) -> Result<AiStore, String> {
    let bytes = get_data_from_local_storage(app, SETTINGS_FILE).await?;
    if bytes.is_empty() {
        return Ok(AiStore::default());
    }
    let mut store: AiStore = serde_json::from_slice(&bytes)
        .map_err(|err| format!("The AI settings could not be read: {}", err))?;
    upgrade_claude_commands(&mut store);
    Ok(store)
}

/// Claude Code's command as Settings writes it now: only the user's own Claude settings and no MCP servers, so a
/// project's `.claude` hooks and `.mcp.json` servers can't run, in the default permission mode, with only the tools
/// that read the project, or none.
pub(crate) fn claude_command(reads: bool) -> String {
    format!(
        "claude -p --setting-sources user --strict-mcp-config --permission-mode default --model {{model}} --tools \"{}\"",
        if reads { "Read,Grep,Glob" } else { "" }
    )
}

/// The command Claude Code's choice in Settings wrote in earlier releases, which turned off a list of tools instead,
/// some without the settings and MCP flags.
static LEGACY_CLAUDE_COMMAND: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(
        r#"^claude\s+-p(?:\s+--setting-sources\s+user\s+--strict-mcp-config)?\s+--model\s+\{model\}(?:\s+--disallowedTools\s+"([^"]*)")?$"#,
    )
    .expect("a valid pattern")
});

/// The current form of a Claude Code command saved by an earlier release, or None when `command` isn't one. It reads
/// the project when the old command left Read on.
fn upgraded_claude_command(command: &str) -> Option<String> {
    let found = LEGACY_CLAUDE_COMMAND.captures(command.trim())?;
    let reads = !found
        .get(1)
        .is_some_and(|tools| tools.as_str().split(',').any(|tool| tool.trim() == "Read"));
    Some(claude_command(reads))
}

/// Brings Claude Code commands saved by earlier releases up to date as the settings are read, so they are never run
/// with a project's own Claude settings and MCP servers, even before the user saves again.
fn upgrade_claude_commands(store: &mut AiStore) {
    for provider in &mut store.providers {
        if provider.kind == ProviderKind::Command
            && let Some(command) = upgraded_claude_command(&provider.command)
        {
            provider.command = command;
        }
    }
}

async fn save_store(app: &AppHandle, store: &AiStore) -> Result<(), String> {
    let json = serde_json::to_string(store).map_err(|err| err.to_string())?;
    save_json_to_local_storage("AI settings", app, json, SETTINGS_FILE).await?;
    Ok(())
}

/// Notes what a provider's last call did, so Settings and each model picker can say why it failed.
async fn note_result(app: &AppHandle, provider_id: &str, error: Option<String>) {
    let _guard = STORE_LOCK.lock().await;
    let Ok(mut store) = load_store(app).await else {
        return;
    };
    let Some(provider) = store.providers.iter_mut().find(|p| p.id == provider_id) else {
        return;
    };
    if provider.last_error == error {
        return;
    }
    provider.last_error = error;
    if save_store(app, &store).await.is_ok() {
        settings_changed(app, &view(&store));
    }
}

#[tauri::command]
pub(crate) async fn ai_settings(app_handle: AppHandle) -> Result<AiSettingsView, String> {
    Ok(view(&load_store(&app_handle).await?))
}

/// The settings as a remote browser sees them: each provider's name and models, to choose from. Its address,
/// command and last error are left out, since they can hold a token the user typed, such as `?key=` in an address.
pub(crate) fn for_browser(mut shown: AiSettingsView) -> AiSettingsView {
    for provider in &mut shown.providers {
        provider.base_url.clear();
        provider.command.clear();
        provider.last_error = None;
    }
    shown
}

/// Tells the window, and remote browsers without what they don't get, that the settings changed.
fn settings_changed(app: &AppHandle, shown: &AiSettingsView) {
    crate::remote::hub::broadcast_redacted(app, "ai-settings-changed", shown.clone(), || {
        serde_json::to_value(for_browser(shown.clone())).ok()
    });
}

#[tauri::command]
pub(crate) async fn ai_save_settings(
    app_handle: AppHandle,
    settings: SettingsUpdate,
) -> Result<AiSettingsView, String> {
    let _guard = STORE_LOCK.lock().await;
    let store = apply_update(&load_store(&app_handle).await?, settings)?;
    save_store(&app_handle, &store).await?;
    let shown = view(&store);
    settings_changed(&app_handle, &shown);
    Ok(shown)
}

/// Reads a provider's models from its server and keeps them. A command's models are the ones the user typed in.
#[tauri::command]
pub(crate) async fn ai_models(
    app_handle: AppHandle,
    provider_id: String,
) -> Result<AiSettingsView, String> {
    let provider = provider(&app_handle, &provider_id).await?;
    let listed = list_models(&provider).await;
    let _guard = STORE_LOCK.lock().await;
    let mut store = load_store(&app_handle).await?;
    keep_listed(&mut store, &provider, &listed)?;
    save_store(&app_handle, &store).await?;
    let shown = view(&store);
    settings_changed(&app_handle, &shown);
    listed.map(|_| shown)
}

/// Keeps the models read from `read_from`'s server, or why they couldn't be, on the provider saved now. Saved again
/// while they were read, for another server or key, what was read isn't its own, and nothing is kept.
fn keep_listed(
    store: &mut AiStore,
    read_from: &StoredProvider,
    listed: &Result<Vec<AiModel>, String>,
) -> Result<(), String> {
    let Some(saved) = store.providers.iter_mut().find(|p| p.id == read_from.id) else {
        return Err(String::from("That AI provider was removed."));
    };
    if saved.kind != read_from.kind
        || saved.base_url != read_from.base_url
        || saved.api_key != read_from.api_key
    {
        return Err(format!(
            "{} was changed while its models were read. Refresh its models again.",
            saved.name
        ));
    }
    match listed {
        Ok(models) => {
            saved.models = models.clone();
            saved.last_error = None;
        }
        Err(err) => saved.last_error = Some(err.clone()),
    }
    Ok(())
}

async fn provider(app: &AppHandle, provider_id: &str) -> Result<StoredProvider, String> {
    load_store(app)
        .await?
        .providers
        .into_iter()
        .find(|p| p.id == provider_id)
        .ok_or_else(|| {
            String::from("That AI provider isn't set up any more. Choose another model.")
        })
}

// ---- Calling providers ----

static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    // Each call has its own timeout, from the settings, since local models can be slow.
    reqwest::Client::builder()
        .user_agent("TaskProxy")
        .build()
        .ok()
});

fn client() -> Result<&'static reqwest::Client, String> {
    CLIENT
        .as_ref()
        .ok_or_else(|| String::from("Task Proxy could not start its web client."))
}

/// A server's answer, up to `limit` bytes, and whether there was more.
async fn read_capped(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<(Vec<u8>, bool), reqwest::Error> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > limit {
            body.extend_from_slice(&chunk[..limit - body.len()]);
            return Ok((body, true));
        }
        body.extend_from_slice(&chunk);
    }
    Ok((body, false))
}

/// A server's answer read as JSON.
async fn read_json(response: reqwest::Response, name: &str) -> Result<Value, String> {
    let (body, more) = read_capped(response, BODY_LIMIT)
        .await
        .map_err(|err| unreachable(name, err))?;
    if more {
        return Err(format!(
            "{} answered with more than {} MB.",
            name,
            BODY_LIMIT / 1024 / 1024
        ));
    }
    serde_json::from_slice(&body).map_err(|err| err.to_string())
}

/// What a server said when it refused a call, briefly.
async fn refused(response: reqwest::Response, name: &str) -> String {
    let status = response.status();
    let body = read_capped(response, REFUSAL_LIMIT)
        .await
        .map(|(body, _)| String::from_utf8_lossy(&body).to_string())
        .unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|json| {
            // The first of these that is text, so an `error` object without a message still finds `message`.
            ["/error/message", "/error", "/message"]
                .iter()
                .find_map(|pointer| json.pointer(pointer).and_then(Value::as_str))
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(300).collect());
    match status.as_u16() {
        401 | 403 => format!("{} refused the API key ({}). {}", name, status, detail)
            .trim()
            .to_string(),
        _ => format!("{} answered {}. {}", name, status, detail)
            .trim()
            .to_string(),
    }
}

/// Why a server couldn't be reached or read, without its address, which can hold a key such as `?key=`.
fn unreachable(name: &str, err: reqwest::Error) -> String {
    if err.is_timeout() {
        format!("{} took too long to answer.", name)
    } else {
        format!("{} can't be reached: {}", name, err.without_url())
    }
}

async fn list_models(provider: &StoredProvider) -> Result<Vec<AiModel>, String> {
    match provider.kind {
        ProviderKind::Command => Ok(provider.models.clone()),
        ProviderKind::OpenAi => {
            let mut request = client()?
                .get(endpoint(provider, &provider.base_url, &["models"])?)
                .timeout(Duration::from_secs(30));
            if let Some(key) = provider.api_key.as_deref().filter(|key| !key.is_empty()) {
                request = request.bearer_auth(key);
            }
            let response = request
                .send()
                .await
                .map_err(|err| unreachable(&provider.name, err))?;
            if !response.status().is_success() {
                return Err(refused(response, &provider.name).await);
            }
            let json = read_json(response, &provider.name).await?;
            Ok(models_from(&json, "id", None))
        }
        ProviderKind::Anthropic => {
            let key = anthropic_key(provider)?;
            let mut models = Vec::new();
            let mut after: Option<String> = None;
            // A page at a time, up to a limit, so a server that always says there is more can't keep it asking.
            for _ in 0..MODEL_PAGES {
                let mut url = endpoint(provider, anthropic_base(provider), &["v1", "models"])?;
                url.query_pairs_mut().append_pair("limit", "100");
                if let Some(after) = &after {
                    url.query_pairs_mut().append_pair("after_id", after);
                }
                let response = client()?
                    .get(url)
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
                    .timeout(Duration::from_secs(30))
                    .send()
                    .await
                    .map_err(|err| unreachable(&provider.name, err))?;
                if !response.status().is_success() {
                    return Err(refused(response, &provider.name).await);
                }
                let json = read_json(response, &provider.name).await?;
                models.extend(models_from(&json, "id", Some("display_name")));
                let more = json.get("has_more").and_then(Value::as_bool) == Some(true);
                after = json
                    .get("last_id")
                    .and_then(Value::as_str)
                    .filter(|_| more)
                    .map(str::to_string);
                if after.is_none() {
                    break;
                }
            }
            models.sort_by(|a, b| a.id.cmp(&b.id));
            models.dedup_by(|a, b| a.id == b.id);
            Ok(models)
        }
    }
}

/// The most pages of models read from the Anthropic API, 100 models each.
const MODEL_PAGES: usize = 20;

fn models_from(json: &Value, id_field: &str, name_field: Option<&str>) -> Vec<AiModel> {
    let mut models: Vec<AiModel> = json
        .get("data")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get(id_field)?.as_str()?.to_string();
                    let name = name_field
                        .and_then(|field| item.get(field))
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    Some(AiModel { id, name })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models.dedup_by(|a, b| a.id == b.id);
    models
}

/// `path` under a server's address, keeping any query the address has, such as `?api-version=` or `?key=`.
fn endpoint(provider: &StoredProvider, base: &str, path: &[&str]) -> Result<reqwest::Url, String> {
    let not_web = || format!("{}'s address isn't a web address.", provider.name);
    let mut url = reqwest::Url::parse(base).map_err(|_| not_web())?;
    url.path_segments_mut()
        .map_err(|_| not_web())?
        .pop_if_empty()
        .extend(path);
    Ok(url)
}

fn anthropic_base(provider: &StoredProvider) -> &str {
    if provider.base_url.is_empty() {
        ANTHROPIC_BASE
    } else {
        &provider.base_url
    }
}

fn anthropic_key(provider: &StoredProvider) -> Result<&str, String> {
    provider
        .api_key
        .as_deref()
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            format!(
                "{} needs an API key, set in Settings under AI.",
                provider.name
            )
        })
}

/// Why a reply that reached the model's length limit is refused: it looks whole, but its end is missing.
fn cut_off(name: &str) -> String {
    format!(
        "{} reached its reply length limit before finishing, so its reply was cut off. Ask for less, such as with \
         fewer files, or choose a model that writes longer replies.",
        name
    )
}

/// Task Proxy's own checks of the model chosen, made before the provider is asked.
fn check_model(provider: &StoredProvider, model: &str) -> Result<(), String> {
    if model.trim().is_empty() {
        return Err(String::from("Choose a model to write with."));
    }
    // Only the models the user listed for a command, which a remote browser can't change.
    if provider.kind == ProviderKind::Command
        && !provider.models.iter().any(|item| item.id == model)
    {
        return Err(format!(
            "{} has no model {}. Choose one of its models.",
            provider.name, model
        ));
    }
    Ok(())
}

/// Asks a provider's model for a reply to a system and a user message.
async fn complete(
    provider: &StoredProvider,
    model: &str,
    system: &str,
    user: &str,
    folder: Option<&Path>,
    timeout: Duration,
) -> Result<String, String> {
    check_model(provider, model)?;
    let reply = match provider.kind {
        ProviderKind::OpenAi => {
            let body = serde_json::json!({
                "model": model,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user },
                ],
            });
            let mut request = client()?
                .post(endpoint(
                    provider,
                    &provider.base_url,
                    &["chat", "completions"],
                )?)
                .json(&body)
                .timeout(timeout);
            if let Some(key) = provider.api_key.as_deref().filter(|key| !key.is_empty()) {
                request = request.bearer_auth(key);
            }
            let response = request
                .send()
                .await
                .map_err(|err| unreachable(&provider.name, err))?;
            if !response.status().is_success() {
                return Err(refused(response, &provider.name).await);
            }
            let json = read_json(response, &provider.name).await?;
            if json
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                == Some("length")
            {
                return Err(cut_off(&provider.name));
            }
            json.pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| format!("{} answered without any text.", provider.name))?
        }
        ProviderKind::Anthropic => {
            let body = serde_json::json!({
                "model": model,
                "max_tokens": 8192,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            });
            let response = client()?
                .post(endpoint(
                    provider,
                    anthropic_base(provider),
                    &["v1", "messages"],
                )?)
                .header("x-api-key", anthropic_key(provider)?)
                .header("anthropic-version", ANTHROPIC_VERSION)
                .json(&body)
                .timeout(timeout)
                .send()
                .await
                .map_err(|err| unreachable(&provider.name, err))?;
            if !response.status().is_success() {
                return Err(refused(response, &provider.name).await);
            }
            let json = read_json(response, &provider.name).await?;
            if json.get("stop_reason").and_then(Value::as_str) == Some("max_tokens") {
                return Err(cut_off(&provider.name));
            }
            let text: String = json
                .get("content")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|part| part.get("text").and_then(Value::as_str))
                        .collect::<Vec<_>>()
                        .join("")
                })
                .unwrap_or_default();
            if text.is_empty() {
                return Err(format!("{} answered without any text.", provider.name));
            }
            text
        }
        ProviderKind::Command => {
            let prompt = format!("{}\n\n{}", system, user);
            tokio::time::timeout(timeout, run_command(provider, model, &prompt, folder))
                .await
                .map_err(|_| format!("{} took too long to answer.", provider.name))??
        }
    };
    let cleaned = clean_reply(&reply);
    if cleaned.is_empty() {
        return Err(format!("{} answered without any text.", provider.name));
    }
    Ok(cleaned)
}

/// A command line with `{model}` reading the model from its environment variable. PowerShell passes a variable's
/// value as one argument, whatever it holds, so it can't end a quote or start another command. The braces keep text
/// right after `{model}` from becoming part of the variable's name.
fn command_line(command: &str) -> String {
    command.replace("{model}", &format!("${{env:{}}}", MODEL_VARIABLE))
}

/// PowerShell's single quotes, including the typographic ones it also reads as single quotes.
fn is_single_quote(c: char) -> bool {
    matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201a}' | '\u{201b}')
}

/// PowerShell's double quotes, including the typographic ones it also reads as double quotes.
fn is_double_quote(c: char) -> bool {
    matches!(c, '"' | '\u{201c}' | '\u{201d}' | '\u{201e}')
}

/// Whether `{model}` appears anywhere inside single quotes in a PowerShell command, where it would be passed as the
/// literal text rather than the model, such as `'--model={model}'`. Quotes are followed as PowerShell reads them: a
/// doubled quote inside quotes is one quote, a backtick escapes the next character outside single quotes, each kind of
/// quote is plain text inside the other, and a subexpression `$( ... )` inside double quotes is read as a command of
/// its own, with quotes of its own, as in `"$('{model}')"`.
fn model_in_single_quotes(command: &str) -> bool {
    #[derive(PartialEq)]
    enum Quote {
        /// Outside quotes, or inside parentheses when not at the bottom: `)` ends them.
        None,
        Single,
        Double,
    }
    let chars: Vec<char> = command.chars().collect();
    let mut stack = vec![Quote::None];
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let depth = stack.len();
        match stack.last().unwrap_or(&Quote::None) {
            Quote::Single => {
                if is_single_quote(c) {
                    if chars.get(i + 1).copied().is_some_and(is_single_quote) {
                        i += 1;
                    } else {
                        stack.pop();
                    }
                } else if chars[i..].starts_with(&['{', 'm', 'o', 'd', 'e', 'l', '}']) {
                    return true;
                }
            }
            Quote::Double => {
                if c == '`' {
                    i += 1;
                } else if c == '$' && chars.get(i + 1) == Some(&'(') {
                    stack.push(Quote::None);
                    i += 1;
                } else if is_double_quote(c) {
                    if chars.get(i + 1).copied().is_some_and(is_double_quote) {
                        i += 1;
                    } else {
                        stack.pop();
                    }
                }
            }
            Quote::None => {
                if c == '`' {
                    i += 1;
                } else if c == '(' {
                    stack.push(Quote::None);
                } else if c == ')' && depth > 1 {
                    stack.pop();
                } else if is_single_quote(c) {
                    stack.push(Quote::Single);
                } else if is_double_quote(c) {
                    stack.push(Quote::Double);
                }
            }
        }
        i += 1;
    }
    false
}

/// The PATH with the user's `~/.local/bin` added at its end, where Claude Code's installer, and many other tools,
/// put their commands without adding it to PATH. Task Proxy, started from the desktop, often doesn't have it, so
/// `claude` wasn't found. None when it is already there.
fn with_user_bin(path: &std::ffi::OsStr, home: &Path) -> Option<std::ffi::OsString> {
    let bin = home.join(".local").join("bin");
    let mut paths: Vec<PathBuf> = std::env::split_paths(path).collect();
    if paths.iter().any(|item| item == &bin) {
        return None;
    }
    paths.push(bin);
    std::env::join_paths(paths).ok()
}

/// A command's process, and every process it starts. Dropped before it ends, such as when the user cancels or it
/// takes too long, it ends all of them: `kill_on_drop` ends only PowerShell, and `claude` would keep running. Once
/// the command ends, what it left running in the background ends too, which nothing else would end.
struct ProcessTree {
    /// Always set until it is dropped, when Windows hands it to the thread that ends the tree.
    child: Option<tokio::process::Child>,
    /// A job holding the command and everything it starts, which ends them all when it is closed.
    #[cfg(windows)]
    job: Option<Job>,
}

impl ProcessTree {
    fn new(child: tokio::process::Child) -> Self {
        Self {
            #[cfg(windows)]
            job: Job::holding(&child),
            child: Some(child),
        }
    }

    /// Waits for the command to end. On Unix, what it left in its process group is ended before the command is
    /// waited for: until then the group's id can't go to another group, and after it, it could.
    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let Some(child) = self.child.as_mut() else {
            return Err(std::io::Error::other("The command was already ended."));
        };
        #[cfg(unix)]
        if let Some(pid) = child.id()
            && let Ok(group) = libc::pid_t::try_from(pid)
            && task::spawn_blocking(move || ended_unreaped(pid))
                .await
                .unwrap_or(false)
        {
            // SAFETY: killpg only sends a signal. The command leads the group and hasn't been waited for yet, so
            // the group is still its own.
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
        child.wait().await
    }
}

/// Waits for a process to end, leaving it to be waited for again, so its id stays its own. False when it can't be
/// waited for, such as when it was already.
#[cfg(unix)]
fn ended_unreaped(pid: u32) -> bool {
    loop {
        // SAFETY: waitid writes only to the zeroed siginfo given. WNOWAIT leaves the process to be reaped later.
        let result = unsafe {
            let mut info: libc::siginfo_t = std::mem::zeroed();
            libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT)
        };
        if result == 0 {
            return true;
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            return false;
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        // The id is gone once the process has ended and been waited for, when `wait` has already ended its group.
        if let Some(child) = self.child.take()
            && child.id().is_some()
        {
            kill_tree(child);
        }
        // On Windows, closing the job as this is dropped ends what is left in it.
    }
}

/// A Windows job object that ends every process in it when it is closed. PowerShell is put in it as it starts, and
/// every process it starts after that is in it too.
#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a job's handle can be used and closed from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    /// A job holding `child`, or None when one couldn't be made, when the command ends as it did before jobs.
    fn holding(child: &tokio::process::Child) -> Option<Job> {
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
            SetInformationJobObject,
        };
        let process = child.raw_handle()?;
        // SAFETY: each call is given a valid handle, and the limits a pointer to a value of the size given.
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            // Closed by its drop if it can't be set up.
            let job = Job(handle);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return None;
            }
            if AssignProcessToJobObject(job.0, process.cast()) == 0 {
                return None;
            }
            Some(job)
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: the handle is this job's own, and closed only here.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Ends a command's process group. The command leads its own group, so this reaches only what it started.
#[cfg(unix)]
fn kill_tree(mut child: tokio::process::Child) {
    if let Some(group) = child.id().and_then(|id| libc::pid_t::try_from(id).ok()) {
        // SAFETY: killpg only sends a signal. The group can't be another's, since its leader hasn't been waited for.
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
}

/// Ends a command's process and every process under it. `taskkill` is waited for on a thread of its own, since this
/// runs on one of the async runtime's threads. The thread keeps the process until then, so PowerShell is still
/// running for `taskkill` to find the tree under it, and its id can't go to another process meanwhile.
#[cfg(windows)]
fn kill_tree(mut child: tokio::process::Child) {
    let Some(id) = child.id() else {
        return;
    };
    std::thread::spawn(move || {
        let _ = create_command("taskkill")
            .args(["/PID", &id.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
        let _ = child.start_kill();
    });
}

#[cfg(not(any(unix, windows)))]
fn kill_tree(mut child: tokio::process::Child) {
    let _ = child.start_kill();
}

/// A pipe's output up to `limit` bytes, and the pipe when there was more.
async fn read_upto<R: AsyncRead + Unpin>(pipe: Option<R>, limit: usize) -> (Vec<u8>, Option<R>) {
    let mut output = Vec::new();
    let Some(pipe) = pipe else {
        return (output, None);
    };
    let mut capped = pipe.take(limit as u64 + 1);
    let _ = capped.read_to_end(&mut output).await;
    if output.len() > limit {
        output.truncate(limit);
        return (output, Some(capped.into_inner()));
    }
    (output, None)
}

/// A size limit as the user reads it.
fn size_text(limit: usize) -> String {
    if limit >= 1024 * 1024 {
        format!("{} MB", limit / 1024 / 1024)
    } else {
        format!("{} KB", limit / 1024)
    }
}

/// Runs a provider's command in PowerShell, with the prompt on stdin, and reads the reply from stdout. The process
/// and everything it starts end with the request, such as when the user cancels.
async fn run_command(
    provider: &StoredProvider,
    model: &str,
    prompt: &str,
    folder: Option<&Path>,
) -> Result<String, String> {
    run_command_capped(provider, model, prompt, folder, BODY_LIMIT).await
}

/// `run_command`, failing once the command prints more than `limit` bytes, as a server's answer does. Its errors are
/// kept to `REFUSAL_LIMIT`, and the rest of them is read and left out.
async fn run_command_capped(
    provider: &StoredProvider,
    model: &str,
    prompt: &str,
    folder: Option<&Path>,
    limit: usize,
) -> Result<String, String> {
    let (installed, pwsh) = crate::services::terminal_controller::resolve_pwsh();
    if !installed {
        return Err(String::from(
            "PowerShell is needed to run an AI command, and it isn't installed.",
        ));
    }
    let mut command = tokio::process::Command::from(create_command(&pwsh));
    command
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &command_line(&provider.command),
        ])
        .env(MODEL_VARIABLE, model)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    if let Some(home) = home {
        let path = std::env::var_os("PATH").unwrap_or_default();
        if let Some(path) = with_user_bin(&path, Path::new(&home)) {
            command.env("PATH", path);
        }
    }
    if let Some(folder) = folder.filter(|folder| folder.is_dir()) {
        command.current_dir(folder);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("{} could not start: {}", provider.name, err))?;
    let stdin = child.stdin.take();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let mut tree = ProcessTree::new(child);
    // The prompt is written while the output is read, since a command can fill its output pipe before reading all of
    // its input, and then neither side would go on.
    let write = async move {
        if let Some(mut stdin) = stdin {
            // A command that doesn't read its input ends early, which is fine.
            let _ = stdin.write_all(prompt.as_bytes()).await;
        }
        Ok::<(), String>(())
    };
    let read_out = async {
        match read_upto(stdout, limit).await {
            (output, None) => Ok(output),
            (_, Some(_)) => Err(format!(
                "{} printed more than {}.",
                provider.name,
                size_text(limit)
            )),
        }
    };
    let read_err = async {
        let (output, rest) = read_upto(stderr, REFUSAL_LIMIT).await;
        if let Some(mut rest) = rest {
            let _ = tokio::io::copy(&mut rest, &mut tokio::io::sink()).await;
        }
        Ok(output)
    };
    let wait = async {
        tree.wait()
            .await
            .map_err(|err| format!("{} stopped: {}", provider.name, err))
    };
    // Printing too much ends the wait here, and the command with it, when `tree` is dropped.
    let ((), stdout, stderr, status) = tokio::try_join!(write, read_out, read_err, wait)?;
    let stdout = String::from_utf8_lossy(&stdout).to_string();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!(
            "{} failed{}: {}",
            provider.name,
            status
                .code()
                .map(|code| format!(" (exit code {})", code))
                .unwrap_or_default(),
            detail.chars().take(500).collect::<String>()
        ));
    }
    Ok(stdout)
}

/// The reply without what models often wrap it in: a code fence around all of it, or a line introducing it.
pub(crate) fn clean_reply(reply: &str) -> String {
    let mut text = reply.trim().to_string();
    if let Some(first) = text.lines().next() {
        let lower = first.trim().to_lowercase();
        let introduces = (lower.starts_with("here is")
            || lower.starts_with("here's")
            || lower.starts_with("sure"))
            && lower.ends_with(':');
        if introduces {
            text = text
                .lines()
                .skip(1)
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string();
        }
    }
    let lines: Vec<&str> = text.lines().collect();
    // Only one fence around all of it. A reply that starts and ends with separate code blocks keeps them.
    let wrapped = lines.len() >= 2
        && lines[0].trim_start().starts_with("```")
        && lines[lines.len() - 1].trim() == "```"
        && !lines[1..lines.len() - 1]
            .iter()
            .any(|line| line.trim_start().starts_with("```"));
    if wrapped {
        text = lines[1..lines.len() - 1].join("\n").trim().to_string();
    }
    text
}

/// Task Proxy's context, the built-in instructions for an integration, then the user's instructions in the order given
/// (shared, then the integration's, each the project's when it has its own or else the global one), so later ones
/// refine earlier ones.
pub(crate) fn system_prompt(integration: &str, instructions: &[String]) -> Result<String, String> {
    let mut prompt = format!("{}\n\n{}", TASK_PROXY_CONTEXT, built_in(integration)?);
    for text in instructions
        .iter()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
    {
        prompt.push_str("\n\n");
        prompt.push_str(text);
    }
    Ok(prompt)
}

// ---- Requests, cancelling, and progress ----

static REQUESTS: LazyLock<Mutex<HashMap<String, Arc<Notify>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// A running request's place in the list, which it leaves when it ends or is dropped.
struct Registered {
    id: String,
    notify: Arc<Notify>,
}

impl Drop for Registered {
    fn drop(&mut self) {
        // Only its own entry, in case another request has the id now.
        if let Ok(mut requests) = REQUESTS.lock()
            && requests
                .get(&self.id)
                .is_some_and(|notify| Arc::ptr_eq(notify, &self.notify))
        {
            requests.remove(&self.id);
        }
    }
}

/// A request listed under its id from the moment its command starts, so a cancel sent while it reads files or
/// settings is kept, and stops it before the provider is asked. An id already running is refused, since the window,
/// or a remote browser, chooses them, and the first request could then no longer be cancelled.
struct Request {
    notify: Arc<Notify>,
    _registered: Option<Registered>,
}

impl Request {
    fn register(request_id: &str) -> Result<Self, String> {
        let notify = Arc::new(Notify::new());
        let registered = if request_id.is_empty() {
            None
        } else {
            let mut requests = REQUESTS
                .lock()
                .map_err(|err| format!("State failure: {}", err))?;
            if requests.contains_key(request_id) {
                return Err(String::from(REQUEST_IN_USE));
            }
            requests.insert(request_id.to_string(), notify.clone());
            Some(Registered {
                id: request_id.to_string(),
                notify: notify.clone(),
            })
        };
        Ok(Self {
            notify,
            _registered: registered,
        })
    }

    /// Runs `work` until it finishes, or fails with `Cancelled.` when the request is cancelled. A cancel sent before
    /// this was called stops it before `work` starts.
    async fn run<T>(&self, work: impl Future<Output = Result<T, Failure>>) -> Result<T, Failure> {
        tokio::select! {
            biased;
            _ = self.notify.notified() => Err(Failure::Local(String::from(CANCELLED))),
            result = work => result,
        }
    }
}

/// Why a request failed: the provider's own failure, which is noted as its last error, or one of Task Proxy's checks
/// or a cancel, which says nothing about the provider.
#[derive(Debug, PartialEq)]
enum Failure {
    Provider(String),
    Local(String),
}

impl From<Failure> for String {
    fn from(failure: Failure) -> String {
        match failure {
            Failure::Provider(text) | Failure::Local(text) => text,
        }
    }
}

/// What to note as a provider's last error after a request: nothing (`None`) when Task Proxy stopped it, or else
/// the provider's error, or none when it worked.
fn provider_outcome<T>(result: &Result<T, Failure>) -> Option<Option<String>> {
    match result {
        Ok(_) => Some(None),
        Err(Failure::Provider(error)) => Some(Some(error.clone())),
        Err(Failure::Local(_)) => None,
    }
}

/// Notes a request's outcome on its provider, when it says something about the provider.
async fn note_outcome<T>(app: &AppHandle, provider_id: &str, result: &Result<T, Failure>) {
    if let Some(error) = provider_outcome(result) {
        note_result(app, provider_id, error).await;
    }
}

#[tauri::command]
pub(crate) async fn ai_cancel(request_id: String) -> Result<bool, String> {
    let notify = REQUESTS
        .lock()
        .ok()
        .and_then(|requests| requests.get(&request_id).cloned());
    Ok(match notify {
        Some(notify) => {
            notify.notify_one();
            true
        }
        None => false,
    })
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelChoice {
    pub provider: String,
    pub model: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    request_id: String,
    done: usize,
    total: usize,
}

/// A draft for one integration. Git builds its context from the repo's files here; the others send it.
#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WriteRequest {
    #[serde(default)]
    pub request_id: String,
    pub integration: String,
    pub model: ModelChoice,
    #[serde(default)]
    pub instructions: Vec<String>,
    /// What the user asked for, such as what a segment or script should do.
    #[serde(default)]
    pub request: String,
    /// The page, script, or file list the draft is for.
    #[serde(default)]
    pub context: String,
    /// For Git: the repo, and the files the commit will take.
    #[serde(default)]
    pub repo: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
}

fn project_folder(state: &State<'_, CurrentProject>) -> Option<PathBuf> {
    let project = state.lock().ok()?;
    (!project.path.is_empty()).then(|| PathBuf::from(&project.path))
}

/// A command runs in the project's folder, where a cloned repo's own settings can run code as it starts, such as
/// Claude Code's hooks and MCP servers. So, as with page scripts, it runs there only once the project is trusted.
fn may_run_in(
    provider: &StoredProvider,
    folder: Option<&Path>,
    global: &HashMap<String, Value>,
) -> Result<(), String> {
    match folder {
        Some(folder)
            if provider.kind == ProviderKind::Command
                && !crate::services::page_scripts::is_trusted(
                    global,
                    &folder.to_string_lossy(),
                ) =>
        {
            Err(format!(
                "{} runs in the project's folder, and this project is not trusted to run its scripts yet.",
                provider.name
            ))
        }
        _ => Ok(()),
    }
}

/// `may_run_in` with the global values as they are now.
fn check_trusted(
    app: &AppHandle,
    provider: &StoredProvider,
    folder: Option<&Path>,
) -> Result<(), String> {
    let state = app.state::<SharedAppData>();
    let global = state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    may_run_in(provider, folder, &global.data)
}

#[tauri::command]
pub(crate) async fn ai_write(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    request: WriteRequest,
) -> Result<String, String> {
    // Listed first, so a cancel sent while files are read isn't lost.
    let running = Request::register(&request.request_id)?;
    // The project is read before anything is awaited, so opening another one meanwhile doesn't change what is sent.
    let folder = project_folder(&state);
    let repo_path = if request.integration == "git" {
        Some(crate::services::git_controller::get_repo_path(
            &state,
            request.repo.as_deref().unwrap_or(""),
        )?)
    } else {
        None
    };
    let store = load_store(&app_handle).await?;
    let provider = store
        .providers
        .iter()
        .find(|p| p.id == request.model.provider)
        .cloned()
        .ok_or_else(|| {
            String::from("That AI provider isn't set up any more. Choose another model.")
        })?;
    let timeout = Duration::from_secs(store.timeout_secs);
    let work = async {
        check_trusted(&app_handle, &provider, folder.as_deref()).map_err(Failure::Local)?;
        check_model(&provider, &request.model.model).map_err(Failure::Local)?;
        let system =
            system_prompt(&request.integration, &request.instructions).map_err(Failure::Local)?;
        let user = if let Some(repo_path) = repo_path {
            let files = request.files.clone();
            let blocks = task::spawn_blocking(move || {
                let repository = Repository::open(&repo_path).map_err(|e| e.to_string())?;
                change_blocks(&repository, &files)
            })
            .await
            .map_err(|err| Failure::Local(err.to_string()))?
            .map_err(Failure::Local)?;
            if blocks.is_empty() {
                return Err(Failure::Local(String::from(
                    "Include at least one file to write a commit message for.",
                )));
            }
            commit_message(blocks, store.max_chars)
        } else {
            user_message(&request.request, &request.context, store.max_chars)
        };
        complete(
            &provider,
            &request.model.model,
            &system,
            &user,
            folder.as_deref(),
            timeout,
        )
        .await
        .map_err(Failure::Provider)
    };
    // A cancel sent at any point since the request was listed stops the work, before the provider is asked when it
    // came before then.
    let result = running.run(work).await;
    note_outcome(&app_handle, &provider.id, &result).await;
    result.map_err(String::from)
}

const CHANGES_HEADING: &str = "The changes:\n\n";

/// What a commit message is written from: the changes, cut to the size limit with their heading.
fn commit_message(blocks: Vec<Block>, max_chars: usize) -> String {
    let room = max_chars.saturating_sub(CHANGES_HEADING.chars().count());
    format!(
        "{}{}",
        CHANGES_HEADING,
        fit_blocks(blocks, room).join(SEPARATOR)
    )
}

/// What it is about, then what the user asked for, together cut to the size limit: the shorter is kept whole, and
/// the longer gets the rest.
fn user_message(request: &str, context: &str, max_chars: usize) -> String {
    let request = if request.trim().is_empty() {
        "Write it."
    } else {
        request.trim()
    };
    let mut parts = Vec::new();
    if !context.trim().is_empty() {
        parts.push(Block {
            path: String::from("context"),
            text: context.trim().to_string(),
        });
    }
    parts.push(Block {
        path: String::from("request"),
        text: request.to_string(),
    });
    fit_blocks(parts, max_chars).join(SEPARATOR)
}

/// Sends a short prompt to a model, to check a provider is set up right.
#[tauri::command]
pub(crate) async fn ai_test(app_handle: AppHandle, model: ModelChoice) -> Result<String, String> {
    let provider = provider(&app_handle, &model.provider).await?;
    // Choosing no model says nothing about the provider, so it isn't noted as its last error.
    check_model(&provider, &model.model)?;
    let result = complete(
        &provider,
        &model.model,
        "You are checking that a connection works.",
        "Reply with only the words: Task Proxy can reach me.",
        None,
        Duration::from_secs(60),
    )
    .await
    .map_err(Failure::Provider);
    note_outcome(&app_handle, &provider.id, &result).await;
    result.map_err(String::from)
}

// ---- Building what is sent from a repo ----

/// One file's part of what is sent: a heading, then its diff or content.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Block {
    pub path: String,
    pub text: String,
}

/// A path the window, or a remote browser, sent, checked to stay inside the repo and out of its `.git` folder, which
/// can hold credentials.
fn repo_file(file: &str) -> Result<(PathBuf, String), String> {
    let relative = safe_relative_path(file)?;
    if targets_git_dir(&relative) {
        return Err(format!("Invalid path: {}", file));
    }
    let file = relative.to_string_lossy().replace('\\', "/");
    Ok((relative, file))
}

/// A file in the repo's working folder, read to be sent, or why it isn't: a symbolic link, which could lead to any
/// file on the computer, a file reached through one out of the repo, or one that is too large.
fn read_repo_file(root: &Path, relative: &Path, limit: u64) -> Result<Vec<u8>, &'static str> {
    let path = root.join(relative);
    let meta = fs::symlink_metadata(&path).map_err(|_| "deleted")?;
    if meta.file_type().is_symlink() {
        return Err("symbolic link, not sent");
    }
    if !meta.is_file() {
        return Err("not a file");
    }
    ensure_inside_root(root, &path).map_err(|_| "outside the repo, not sent")?;
    if meta.len() > limit {
        return Err("too large to send");
    }
    fs::read(&path).map_err(|_| "unreadable")
}

/// The given changed files as blocks: each text file's diff (a new file's whole content), and each binary file's
/// name and size only. Paths that leave the repo are refused.
fn change_blocks(repository: &Repository, files: &[String]) -> Result<Vec<Block>, String> {
    let checked = files
        .iter()
        .map(|file| repo_file(file))
        .collect::<Result<Vec<_>, _>>()?;
    let stats = crate::services::git_controller::change_line_stats(repository)?;
    let root = repository
        .workdir()
        .map(Path::to_path_buf)
        .ok_or("The repo has no working folder.")?;
    let mut blocks = Vec::new();
    for (relative, file) in &checked {
        if let Some(stat) = stats.iter().find(|stat| &stat.path == file && stat.binary) {
            let size = |bytes: Option<u64>| {
                bytes
                    .map(|b| format!("{} bytes", b))
                    .unwrap_or_else(|| "none".into())
            };
            blocks.push(Block {
                path: file.clone(),
                text: format!(
                    "### {} (binary)\nSize before: {}, after: {}",
                    file,
                    size(stat.saved_size),
                    size(stat.size)
                ),
            });
            continue;
        }
        let diff = match crate::services::git_controller::file_diff(repository, file) {
            Ok(diff) => diff,
            Err(err) => {
                // Such as a file libgit2 looks for by another case of its name when `core.ignorecase` is on.
                blocks.push(Block {
                    path: file.clone(),
                    text: format!("### {} (its changes could not be read: {})", file, err),
                });
                continue;
            }
        };
        let body = if diff.trim().is_empty() {
            let status = repository
                .status_file(relative)
                .unwrap_or(git2::Status::CURRENT);
            if status.intersects(git2::Status::WT_NEW | git2::Status::INDEX_NEW) {
                // A file git doesn't track yet has no diff: all of it is new.
                match read_repo_file(&root, relative, crate::services::projects::TEXT_MAX_BYTES) {
                    Ok(bytes) if !is_binary(&bytes) => String::from_utf8_lossy(&bytes)
                        .lines()
                        .map(|line| format!("+{}\n", line))
                        .collect(),
                    Ok(_) => {
                        blocks.push(Block {
                            path: file.clone(),
                            text: format!("### {} (binary, new)", file),
                        });
                        continue;
                    }
                    Err(reason) => {
                        blocks.push(Block {
                            path: file.clone(),
                            text: format!("### {} ({})", file, reason),
                        });
                        continue;
                    }
                }
            } else if status.intersects(git2::Status::WT_DELETED | git2::Status::INDEX_DELETED) {
                String::from("(deleted)\n")
            } else {
                // Nothing changed in its lines, so nothing of it is sent.
                String::from("(no line changes)\n")
            }
        } else {
            diff
        };
        blocks.push(Block {
            path: file.clone(),
            text: format!("### {}\n```diff\n{}```", file, body),
        });
    }
    Ok(blocks)
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0) || std::str::from_utf8(bytes).is_err()
}

fn shorten(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit.saturating_sub(60)).collect();
    let left = text.chars().count() - kept.chars().count();
    format!("{}\n… ({} more characters left out)", kept, left)
}

/// The least of a file that is sent: any less says too little about it.
const SMALLEST_PART: usize = 200;
/// Room kept for the note that says how many files were left out.
const LEFT_OUT_ROOM: usize = 80;

/// What parts sent together are joined with.
const SEPARATOR: &str = "\n\n";

/// Blocks cut to fit the limit together, joined with `SEPARATOR`: the smallest are kept whole, and the largest share
/// what is left evenly. Each gets at least the smallest part, and files there is no room left for are left out and
/// counted in a last note.
pub(crate) fn fit_blocks(blocks: Vec<Block>, max_chars: usize) -> Vec<String> {
    fit(blocks, max_chars, "files")
}

/// `fit_blocks`, counting what is left out as `noun`.
fn fit(blocks: Vec<Block>, max_chars: usize, noun: &str) -> Vec<String> {
    let separator = SEPARATOR.chars().count();
    let total: usize = blocks
        .iter()
        .map(|block| block.text.chars().count())
        .sum::<usize>()
        + separator * blocks.len().saturating_sub(1);
    if total <= max_chars {
        return blocks.into_iter().map(|block| block.text).collect();
    }
    let mut order: Vec<usize> = (0..blocks.len()).collect();
    order.sort_by_key(|&index| blocks[index].text.chars().count());
    let mut limits: Vec<Option<usize>> = vec![None; blocks.len()];
    // Each block is counted with a separator, and the first one needs none.
    let mut budget = (max_chars + separator).saturating_sub(LEFT_OUT_ROOM);
    for (position, &index) in order.iter().enumerate() {
        let share = (budget / (order.len() - position)).saturating_sub(separator);
        let size = blocks[index].text.chars().count();
        let limit = size.min(share.max(SMALLEST_PART));
        // The rest are larger, so there is no room for them either.
        if limit + separator > budget {
            break;
        }
        limits[index] = Some(limit);
        budget -= limit + separator;
    }
    let left_out = limits.iter().filter(|limit| limit.is_none()).count();
    let mut fitted: Vec<String> = blocks
        .into_iter()
        .zip(limits)
        .filter_map(|(block, limit)| limit.map(|limit| shorten(&block.text, limit)))
        .collect();
    if left_out > 0 {
        fitted.push(format!(
            "… {} more {} left out to fit the size limit.",
            left_out, noun
        ));
    }
    fitted
}

/// Room kept in each review request for its heading, such as `The changes (part 2 of 9):`.
const PART_HEADING_ROOM: usize = 60;
/// The most requests one review's files are sent in, so a review of a large project can't make any number of paid
/// calls. One more joins their reviews.
const MAX_REVIEW_PARTS: usize = 20;

/// Blocks put into batches of whole files that each fit the limit with their separators and a part's heading. A
/// file larger than that is its own batch, shortened to fit.
pub(crate) fn batch_blocks(blocks: Vec<Block>, max_chars: usize) -> Vec<Vec<String>> {
    let room = max_chars.saturating_sub(PART_HEADING_ROOM);
    let separator = SEPARATOR.chars().count();
    let mut batches: Vec<Vec<String>> = Vec::new();
    let mut size = 0;
    for block in blocks {
        let length = block.text.chars().count();
        if length > room {
            batches.push(vec![shorten(&block.text, room)]);
            size = room;
            continue;
        }
        match batches.last_mut() {
            Some(batch) if size + separator + length <= room => {
                batch.push(block.text);
                size += separator + length;
            }
            _ => {
                batches.push(vec![block.text]);
                size = length;
            }
        }
    }
    batches
}

/// What each review request sends: its heading, then its batch of files, each within the limit. A review that would
/// take more requests than one review may make is refused.
fn review_parts(blocks: Vec<Block>, what: &str, max_chars: usize) -> Result<Vec<String>, String> {
    let batches = batch_blocks(blocks, max_chars);
    let count = batches.len();
    if count > MAX_REVIEW_PARTS {
        return Err(format!(
            "This review would take {} requests to the model, and one review makes at most {}. Review fewer \
             files, or raise the size limit in Settings under AI.",
            count + 1,
            MAX_REVIEW_PARTS + 1
        ));
    }
    Ok(batches
        .into_iter()
        .enumerate()
        .map(|(index, batch)| {
            let heading = if count > 1 {
                format!("{} (part {} of {}):", what, index + 1, count)
            } else {
                format!("{}:", what)
            };
            format!("{}{}{}", heading, SEPARATOR, batch.join(SEPARATOR))
        })
        .collect())
}

/// The parts' reviews, each under its heading, cut to fit the limit together.
fn join_message(reports: &[String], max_chars: usize) -> String {
    let blocks = reports
        .iter()
        .enumerate()
        .map(|(index, report)| Block {
            path: format!("Part {}", index + 1),
            text: format!("## Part {}{}{}", index + 1, SEPARATOR, report),
        })
        .collect();
    fit(blocks, max_chars, "reviews").join(SEPARATOR)
}

/// Every file in the project a review reads: tracked files, and new files git doesn't ignore, except binary files
/// and files larger than the review limit.
fn project_blocks(repository: &Repository) -> Result<Vec<Block>, String> {
    let root = repository
        .workdir()
        .map(Path::to_path_buf)
        .ok_or("The repo has no working folder.")?;
    let mut paths: Vec<String> = Vec::new();
    let index = repository.index().map_err(|e| e.to_string())?;
    for entry in index.iter() {
        paths.push(String::from_utf8_lossy(&entry.path).replace('\\', "/"));
    }
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .include_ignored(false);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?;
    for status in statuses.iter() {
        if status.status().contains(git2::Status::WT_NEW)
            && let Some(path) = status.path()
        {
            paths.push(path.replace('\\', "/"));
        }
    }
    paths.sort();
    paths.dedup();
    let mut blocks = Vec::new();
    for path in paths {
        // Symbolic links, and files reached through them out of the repo, are left out: a link committed to an
        // untrusted repo could lead to any file on the computer.
        let Ok((relative, path)) = repo_file(&path) else {
            continue;
        };
        let Ok(bytes) = read_repo_file(&root, &relative, REVIEW_FILE_LIMIT) else {
            continue;
        };
        if bytes.is_empty() || is_binary(&bytes) {
            continue;
        }
        blocks.push(Block {
            text: format!(
                "### {}\n```\n{}\n```",
                path,
                String::from_utf8_lossy(&bytes).trim_end()
            ),
            path,
        });
    }
    Ok(blocks)
}

// ---- Code review ----

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewRequest {
    #[serde(default)]
    pub request_id: String,
    pub model: ModelChoice,
    #[serde(default)]
    pub instructions: Vec<String>,
    #[serde(default)]
    pub repo: String,
    /// `changes` for the files given, or `project` for every file in the repo.
    pub scope: String,
    #[serde(default)]
    pub files: Vec<String>,
    /// What this review should look for, beyond the standing instructions.
    #[serde(default)]
    pub focus: String,
}

const JOIN_INSTRUCTIONS: &str = "These are reviews of parts of one project, made one batch of files at a time. \
    Combine them into one review: merge findings that repeat, keep every distinct finding with its file and line, \
    order them by severity, most severe first, and reply in markdown.";

#[tauri::command]
pub(crate) async fn ai_review(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    request: ReviewRequest,
) -> Result<String, String> {
    // Listed first, so a cancel sent while files are read isn't lost.
    let running = Request::register(&request.request_id)?;
    // The project is read before anything is awaited, so opening another one meanwhile doesn't change what is reviewed.
    let repo_path = crate::services::git_controller::get_repo_path(&state, &request.repo)?;
    let folder = project_folder(&state);
    let store = load_store(&app_handle).await?;
    let provider = store
        .providers
        .iter()
        .find(|p| p.id == request.model.provider)
        .cloned()
        .ok_or_else(|| {
            String::from("That AI provider isn't set up any more. Choose another model.")
        })?;
    let timeout = Duration::from_secs(store.timeout_secs);
    let request_id = request.request_id.clone();
    let model = request.model.model.clone();
    let work = async {
        check_trusted(&app_handle, &provider, folder.as_deref()).map_err(Failure::Local)?;
        check_model(&provider, &model).map_err(Failure::Local)?;
        let scope = request.scope.clone();
        let files = request.files.clone();
        let blocks = task::spawn_blocking(move || {
            let repository = Repository::open(&repo_path).map_err(|e| e.to_string())?;
            if scope == "project" {
                project_blocks(&repository)
            } else {
                change_blocks(&repository, &files)
            }
        })
        .await
        .map_err(|err| Failure::Local(err.to_string()))?
        .map_err(Failure::Local)?;
        if blocks.is_empty() {
            return Err(Failure::Local(String::from(
                if request.scope == "project" {
                    "The repo has no text files to review."
                } else {
                    "Include at least one changed file to review."
                },
            )));
        }
        let mut system = system_prompt("review", &request.instructions).map_err(Failure::Local)?;
        if !request.focus.trim().is_empty() {
            system.push_str("\n\nFor this review, look especially at: ");
            system.push_str(request.focus.trim());
        }
        let what = if request.scope == "project" {
            "The project's files"
        } else {
            "The changes"
        };
        let parts = review_parts(blocks, what, store.max_chars).map_err(Failure::Local)?;
        let total = parts.len() + usize::from(parts.len() > 1);
        let mut reports = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            crate::remote::hub::broadcast(
                &app_handle,
                "ai-progress",
                Progress {
                    request_id: request_id.clone(),
                    done: index,
                    total,
                },
            );
            reports.push(
                complete(&provider, &model, &system, part, folder.as_deref(), timeout)
                    .await
                    .map_err(Failure::Provider)?,
            );
        }
        if reports.len() == 1 {
            return Ok(reports.remove(0));
        }
        crate::remote::hub::broadcast(
            &app_handle,
            "ai-progress",
            Progress {
                request_id: request_id.clone(),
                done: total - 1,
                total,
            },
        );
        let join_system = format!("{}\n\n{}", system, JOIN_INSTRUCTIONS);
        complete(
            &provider,
            &model,
            &join_system,
            &join_message(&reports, store.max_chars),
            folder.as_deref(),
            timeout,
        )
        .await
        .map_err(Failure::Provider)
    };
    // A cancel sent at any point since the request was listed stops the work, before the provider is asked when it
    // came before then.
    let result = running.run(work).await;
    note_outcome(&app_handle, &provider.id, &result).await;
    result.map_err(String::from)
}

#[cfg(test)]
mod tests {
    #[test]
    fn commands_find_tools_in_the_users_local_bin() {
        let home = std::path::Path::new("/home/someone");
        let bin = home.join(".local").join("bin");
        let path = std::env::join_paths([std::path::PathBuf::from("/usr/bin")]).unwrap();
        let added = super::with_user_bin(&path, home).unwrap();
        assert_eq!(
            std::env::split_paths(&added).collect::<Vec<_>>(),
            vec![std::path::PathBuf::from("/usr/bin"), bin.clone()]
        );
        // Already there, it is left as it is.
        assert_eq!(super::with_user_bin(&added, home), None);
    }

    use super::*;
    use crate::services::page_scripts::TRUSTED_PROJECTS;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn map(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    fn provider(kind: ProviderKind, base_url: &str) -> StoredProvider {
        StoredProvider {
            id: "p1".into(),
            name: "Test".into(),
            kind,
            base_url: base_url.into(),
            api_key: Some("secret-key".into()),
            ..Default::default()
        }
    }

    /// A one-request HTTP server that answers with `body` and hands back what it was sent.
    async fn serve_once(
        status: u16,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        let (address, handle) = serve_each(status, vec![body]).await;
        (
            address,
            tokio::spawn(async move { handle.await.unwrap().remove(0) }),
        )
    }

    /// An HTTP server that answers one request with each of `bodies` in turn, then hands back what it was sent.
    async fn serve_each(
        status: u16,
        bodies: Vec<&'static str>,
    ) -> (String, tokio::task::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            let mut requests = Vec::new();
            for body in bodies {
                requests.push(answer(&listener, status, body).await);
            }
            requests
        });
        (address, handle)
    }

    async fn answer(listener: &TcpListener, status: u16, body: &str) -> String {
        {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let mut buffer = [0u8; 8192];
            loop {
                let read = socket.read(&mut buffer).await.unwrap();
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text[..end]
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if received.len() >= end + 4 + length {
                        break;
                    }
                }
                if read == 0 {
                    break;
                }
            }
            let reply = format!(
                "HTTP/1.1 {} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                status,
                body.len(),
                body
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8_lossy(&received).to_string()
        }
    }

    #[test]
    fn instructions_follow_the_built_in_ones_in_the_order_given() {
        let prompt = system_prompt(
            "git",
            &[
                "Global shared".into(),
                "  ".into(),
                "Global git".into(),
                "Project shared".into(),
                "Project git".into(),
            ],
        )
        .unwrap();
        // Task Proxy's context comes first, then what to write.
        assert!(prompt.starts_with(TASK_PROXY_CONTEXT));
        assert!(prompt.find(built_in("git").unwrap()).unwrap() > TASK_PROXY_CONTEXT.len());
        let at = |text: &str| prompt.find(text).unwrap();
        assert!(at("Global shared") < at("Global git"));
        assert!(at("Global git") < at("Project shared"));
        assert!(at("Project shared") < at("Project git"));
        assert!(!prompt.contains("\n\n  \n\n"));
        assert!(system_prompt("nothing", &[]).is_err());
    }

    #[test]
    fn a_reply_loses_a_fence_or_an_introduction_around_it() {
        assert_eq!(clean_reply("```\nFeature: Thing\n```"), "Feature: Thing");
        assert_eq!(
            clean_reply("```powershell\n$a = 1\nWrite-Host $a\n```\n"),
            "$a = 1\nWrite-Host $a"
        );
        assert_eq!(
            clean_reply("Here is the commit message:\n\nBug: Fixed it"),
            "Bug: Fixed it"
        );
        // A fence inside the text is the text's own.
        assert_eq!(
            clean_reply("Intro\n```\ncode\n```"),
            "Intro\n```\ncode\n```"
        );
        // Separate code blocks at the start and the end keep their fences.
        let two = "```js\nfirst()\n```\nThen:\n```js\nsecond()\n```";
        assert_eq!(clean_reply(two), two);
    }

    #[test]
    fn blocks_over_the_limit_keep_small_files_whole_and_share_the_rest() {
        let block = |path: &str, size: usize| Block {
            path: path.into(),
            text: "x".repeat(size),
        };
        let fitted = fit_blocks(
            vec![block("big", 5000), block("small", 300), block("mid", 2000)],
            3000,
        );
        assert_eq!(fitted[1].len(), 300);
        assert!(
            fitted
                .iter()
                .map(|text| text.chars().count())
                .sum::<usize>()
                <= 3000
        );
        assert!(fitted[0].contains("more characters left out"));
        // Under the limit, nothing changes.
        assert_eq!(fit_blocks(vec![block("a", 10)], 100), vec!["x".repeat(10)]);
    }

    #[test]
    fn many_blocks_still_fit_the_limit_and_those_left_out_are_counted() {
        let blocks = (0..30)
            .map(|index| Block {
                path: index.to_string(),
                text: "x".repeat(1000),
            })
            .collect();
        let fitted = fit_blocks(blocks, 2000);
        assert!(
            fitted
                .iter()
                .map(|text| text.chars().count())
                .sum::<usize>()
                <= 2000
        );
        assert_eq!(fitted.len(), 10);
        assert_eq!(fitted[9], "… 21 more files left out to fit the size limit.");
    }

    #[test]
    fn batches_hold_whole_files_and_a_file_over_the_limit_is_its_own_shortened_batch() {
        let block = |size: usize| Block {
            path: "f".into(),
            text: "y".repeat(size),
        };
        let batches = batch_blocks(
            vec![block(400), block(400), block(400), block(5000), block(100)],
            1000,
        );
        assert_eq!(
            batches.iter().map(Vec::len).collect::<Vec<_>>(),
            vec![2, 1, 1, 1]
        );
        assert!(batches[2][0].chars().count() <= 1000);
        assert!(
            batches
                .iter()
                .all(|batch| batch.iter().map(|t| t.chars().count()).sum::<usize>() <= 1000)
        );
    }

    #[test]
    fn saving_keeps_a_key_left_out_removes_an_empty_one_and_never_shows_one() {
        let saved = AiStore {
            providers: vec![StoredProvider {
                id: "a".into(),
                name: "OpenAI".into(),
                kind: ProviderKind::OpenAi,
                base_url: "https://api.openai.com/v1".into(),
                api_key: Some("sk-1".into()),
                models: vec![AiModel {
                    id: "gpt".into(),
                    name: String::new(),
                }],
                ..Default::default()
            }],
            ..Default::default()
        };
        let update = |api_key: Option<&str>| SettingsUpdate {
            providers: vec![ProviderUpdate {
                id: "a".into(),
                name: "OpenAI".into(),
                kind: ProviderKind::OpenAi,
                base_url: "https://api.openai.com/v1/".into(),
                api_key: api_key.map(str::to_string),
                ..Default::default()
            }],
            ..Default::default()
        };
        let kept = apply_update(&saved, update(None)).unwrap();
        assert_eq!(kept.providers[0].api_key.as_deref(), Some("sk-1"));
        // A server's models are kept when the update leaves them out, and the address loses its trailing slash.
        assert_eq!(kept.providers[0].models.len(), 1);
        assert_eq!(kept.providers[0].base_url, "https://api.openai.com/v1");
        assert_eq!(
            apply_update(&saved, update(Some(""))).unwrap().providers[0].api_key,
            None
        );
        assert_eq!(
            apply_update(&saved, update(Some("sk-2")))
                .unwrap()
                .providers[0]
                .api_key
                .as_deref(),
            Some("sk-2")
        );
        let shown = serde_json::to_string(&view(&kept)).unwrap();
        assert!(!shown.contains("sk-1"));
        assert!(view(&kept).providers[0].key_set);
        // A provider left out is removed with its key.
        assert!(
            apply_update(&saved, SettingsUpdate::default())
                .unwrap()
                .providers
                .is_empty()
        );
    }

    #[test]
    fn a_saved_key_is_left_behind_when_its_provider_moves_to_another_server_or_kind() {
        let saved = AiStore {
            providers: vec![StoredProvider {
                id: "a".into(),
                name: "OpenAI".into(),
                kind: ProviderKind::OpenAi,
                base_url: "https://api.openai.com/v1".into(),
                api_key: Some("sk-1".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let moved = |kind, base_url: &str| SettingsUpdate {
            providers: vec![ProviderUpdate {
                id: "a".into(),
                name: "OpenAI".into(),
                kind,
                base_url: base_url.into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            apply_update(
                &saved,
                moved(ProviderKind::OpenAi, "https://elsewhere.example/v1")
            )
            .unwrap()
            .providers[0]
                .api_key,
            None
        );
        assert_eq!(
            apply_update(
                &saved,
                moved(ProviderKind::Anthropic, "https://api.openai.com/v1")
            )
            .unwrap()
            .providers[0]
                .api_key,
            None
        );
        assert_eq!(
            apply_update(
                &saved,
                moved(ProviderKind::OpenAi, "https://api.openai.com/v1")
            )
            .unwrap()
            .providers[0]
                .api_key
                .as_deref(),
            Some("sk-1")
        );
    }

    #[test]
    fn saving_a_command_the_same_way_keeps_what_failed_last() {
        let saved = AiStore {
            providers: vec![StoredProvider {
                id: "c".into(),
                name: "Claude".into(),
                kind: ProviderKind::Command,
                command: "my-ai --model {model}".into(),
                models: vec![AiModel {
                    id: "m".into(),
                    ..Default::default()
                }],
                last_error: Some("Claude failed".into()),
                ..Default::default()
            }],
            ..Default::default()
        };
        let update = |command: &str| SettingsUpdate {
            providers: vec![ProviderUpdate {
                id: "c".into(),
                name: "Claude".into(),
                kind: ProviderKind::Command,
                command: command.into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let kept = apply_update(&saved, update(" my-ai --model {model} ")).unwrap();
        assert_eq!(
            kept.providers[0].last_error.as_deref(),
            Some("Claude failed")
        );
        assert_eq!(
            apply_update(&saved, update("my-ai")).unwrap().providers[0].last_error,
            None
        );
    }

    #[test]
    fn a_provider_needs_a_name_and_what_its_kind_needs() {
        let one = |kind, base_url: &str, command: &str, name: &str| SettingsUpdate {
            providers: vec![ProviderUpdate {
                name: name.into(),
                kind,
                base_url: base_url.into(),
                command: command.into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let store = AiStore::default();
        assert!(apply_update(&store, one(ProviderKind::OpenAi, "", "", "Ollama")).is_err());
        assert!(apply_update(&store, one(ProviderKind::Command, "", " ", "Claude")).is_err());
        assert!(apply_update(&store, one(ProviderKind::Anthropic, "", "", " ")).is_err());
        // A command can't list its models, so it needs one typed in.
        assert_eq!(
            apply_update(
                &store,
                one(ProviderKind::Command, "", "my-ai {model}", "Mine")
            )
            .unwrap_err(),
            "Mine needs at least one model."
        );
        let made =
            apply_update(&store, one(ProviderKind::Anthropic, "", "", "Claude API")).unwrap();
        assert!(!made.providers[0].id.is_empty());
    }

    #[test]
    fn models_read_from_a_server_are_kept_only_while_the_provider_is_set_up_the_same_way() {
        let read_from = StoredProvider {
            id: "o".into(),
            name: "Ollama".into(),
            kind: ProviderKind::OpenAi,
            base_url: "http://a/v1".into(),
            api_key: Some("k".into()),
            ..Default::default()
        };
        let listed = Ok(vec![AiModel {
            id: "llama3".into(),
            ..Default::default()
        }]);
        let mut store = AiStore {
            providers: vec![read_from.clone()],
            ..Default::default()
        };
        keep_listed(&mut store, &read_from, &listed).unwrap();
        assert_eq!(store.providers[0].models[0].id, "llama3");
        keep_listed(&mut store, &read_from, &Err("down".into())).unwrap();
        assert_eq!(store.providers[0].last_error.as_deref(), Some("down"));
        for moved in [
            StoredProvider {
                base_url: "http://b/v1".into(),
                ..read_from.clone()
            },
            StoredProvider {
                api_key: Some("other".into()),
                ..read_from.clone()
            },
            StoredProvider {
                kind: ProviderKind::Anthropic,
                ..read_from.clone()
            },
        ] {
            let mut store = AiStore {
                providers: vec![moved],
                ..Default::default()
            };
            let error = keep_listed(&mut store, &read_from, &listed).unwrap_err();
            assert!(error.contains("was changed"), "{}", error);
            assert!(store.providers[0].models.is_empty());
            assert_eq!(store.providers[0].last_error, None);
        }
        let mut empty = AiStore::default();
        assert!(keep_listed(&mut empty, &read_from, &listed).is_err());
    }

    #[test]
    fn claude_code_commands_from_earlier_releases_are_brought_up_to_date() {
        let reads = claude_command(true);
        let none = claude_command(false);
        assert_eq!(
            reads,
            "claude -p --setting-sources user --strict-mcp-config --permission-mode default --model {model} --tools \"Read,Grep,Glob\""
        );
        assert!(none.ends_with("--tools \"\""));
        for (old, now) in [
            ("claude -p --model {model}", &reads),
            (
                "claude -p --setting-sources user --strict-mcp-config --model {model}",
                &reads,
            ),
            (
                "claude -p --model {model} --disallowedTools \"Bash,Edit,Write\"",
                &reads,
            ),
            (
                "claude -p --setting-sources user --strict-mcp-config --model {model} --disallowedTools \"Bash,Edit,Write,Read,Grep,Glob\"",
                &none,
            ),
        ] {
            assert_eq!(upgraded_claude_command(old).as_ref(), Some(now), "{}", old);
        }
        // Commands typed some other way, and the current ones, are left as they are.
        for kept in [
            &reads,
            &none,
            "claude -p --model {model} --verbose",
            "my-ai {model}",
        ] {
            assert_eq!(upgraded_claude_command(kept), None, "{}", kept);
        }
        let mut store = AiStore {
            providers: vec![
                StoredProvider {
                    kind: ProviderKind::Command,
                    command: "claude -p --model {model}".into(),
                    ..Default::default()
                },
                StoredProvider {
                    kind: ProviderKind::OpenAi,
                    command: "claude -p --model {model}".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        upgrade_claude_commands(&mut store);
        assert_eq!(store.providers[0].command, reads);
        assert_eq!(store.providers[1].command, "claude -p --model {model}");
        // Saving one sent in the old form saves it in the new one too.
        let saved = apply_update(
            &AiStore::default(),
            SettingsUpdate {
                providers: vec![ProviderUpdate {
                    name: "Claude Code".into(),
                    kind: ProviderKind::Command,
                    command: "claude -p --model {model}".into(),
                    models: Some(vec![AiModel {
                        id: "sonnet".into(),
                        ..Default::default()
                    }]),
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(saved.providers[0].command, reads);
    }

    #[test]
    fn a_command_with_the_model_in_single_quotes_is_refused() {
        let one = |command: &str| SettingsUpdate {
            providers: vec![ProviderUpdate {
                name: "Claude".into(),
                kind: ProviderKind::Command,
                command: command.into(),
                models: Some(vec![AiModel {
                    id: "sonnet".into(),
                    ..Default::default()
                }]),
                ..Default::default()
            }],
            ..Default::default()
        };
        let store = AiStore::default();
        for command in [
            "claude -p --model '{model}'",
            "claude -p \"$('{model}')\"",
            "claude -p \"$(\"x\" + ('{model}'))\"",
            "claude -p \"a $(\"b\") '{model}'\" '{model}'",
            "claude -p '--model={model}'",
            "claude -p 'it''s {model}'",
            "claude -p \u{2018}{model}\u{2019}",
            "claude -p \"a\" '{model}'",
        ] {
            let error = apply_update(&store, one(command)).unwrap_err();
            assert!(error.contains("in single quotes"), "{}: {}", command, error);
        }
        // Double quotes still expand the variable, and a quote that is escaped or inside the other kind is text.
        for command in [
            "claude -p --model \"{model}\"",
            "claude -p --model {model}",
            "claude -p \"--model={model}\"",
            "claude -p \"it's {model}\"",
            "claude -p 'a' {model} 'b'",
            "claude -p `'{model}",
            "claude -p \"`\"'\" {model}",
            "claude -p \"$(\"{model}\")\"",
            "claude -p \"$('a') {model}\"",
            "claude -p \"(') {model}\"",
        ] {
            assert!(apply_update(&store, one(command)).is_ok(), "{}", command);
        }
    }

    #[test]
    fn a_command_runs_in_the_project_folder_only_once_the_project_is_trusted() {
        let global = map(json!({ TRUSTED_PROJECTS: ["/repo"] }));
        let command = command_provider("claude -p");
        let error = may_run_in(&command, Some(Path::new("/other")), &global).unwrap_err();
        assert!(error.contains("not trusted"), "{}", error);
        assert!(may_run_in(&command, Some(Path::new("/repo")), &global).is_ok());
        assert!(may_run_in(&command, Some(Path::new("/other")), &map(json!({}))).is_err());
        // Without a project, as when testing a provider, it doesn't run in one.
        assert!(may_run_in(&command, None, &map(json!({}))).is_ok());
        // A server is only sent text, so it needs no trust.
        let server = provider(ProviderKind::OpenAi, "http://127.0.0.1:1");
        assert!(may_run_in(&server, Some(Path::new("/other")), &map(json!({}))).is_ok());
    }

    #[test]
    fn a_remote_browser_sees_only_each_providers_name_and_models() {
        let mut stored = command_provider("my-ai --token abc --model {model}");
        stored.base_url = "https://ai.example/?key=abc".into();
        stored.last_error = Some("https://ai.example/?key=abc can't be reached".into());
        let shown = for_browser(view(&AiStore {
            providers: vec![stored],
            ..Default::default()
        }));
        let provider = &shown.providers[0];
        assert_eq!(provider.name, "Test");
        assert_eq!(provider.models.len(), 1);
        assert!(provider.command.is_empty());
        assert!(provider.base_url.is_empty());
        assert_eq!(provider.last_error, None);
        assert!(!serde_json::to_string(&shown).unwrap().contains("abc"));
    }

    #[test]
    fn a_command_reads_the_model_from_its_variable_never_from_the_command_line() {
        assert_eq!(
            command_line("claude -p --model {model}"),
            "claude -p --model ${env:TASKPROXY_AI_MODEL}"
        );
        // Text right after it can't become part of the variable's name.
        assert_eq!(
            command_line("run --model={model}x"),
            "run --model=${env:TASKPROXY_AI_MODEL}x"
        );
        assert_eq!(command_line("llm"), "llm");
    }

    #[tokio::test]
    async fn a_command_refuses_a_model_that_isnt_one_of_its_own() {
        let mut command = provider(ProviderKind::Command, "");
        command.command = "claude -p --model {model}".into();
        command.models = vec![AiModel {
            id: "opus".into(),
            name: String::new(),
        }];
        // PowerShell reads these as single quotes too, so they once ended the quote around the model.
        for model in [
            "x\u{2019}; Remove-Item ~ -Recurse; \u{2019}",
            "x'; whoami; '",
            "opus ",
        ] {
            let error = complete(&command, model, "s", "u", None, Duration::from_secs(60))
                .await
                .unwrap_err();
            assert!(error.contains("has no model"), "{}", error);
        }
    }

    fn command_provider(command: &str) -> StoredProvider {
        let mut provider = provider(ProviderKind::Command, "");
        provider.command = command.into();
        provider.models = vec![AiModel {
            id: "opus".into(),
            name: String::new(),
        }];
        provider
    }

    #[tokio::test]
    async fn a_command_can_write_much_output_before_reading_a_large_prompt() {
        assert!(
            crate::services::terminal_controller::resolve_pwsh().0,
            "pwsh is required"
        );
        // Each side fills its pipe before the other reads, which once stopped both for good.
        let command = command_provider(
            "[Console]::Out.Write('x' * 200000); [Console]::Out.Flush(); $text = [Console]::In.ReadToEnd(); \
             [Console]::Out.Write(' ' + $text.Length)",
        );
        let user = "y".repeat(300_000);
        let reply = complete(
            &command,
            "opus",
            "System",
            &user,
            None,
            Duration::from_secs(120),
        )
        .await
        .unwrap();
        assert!(reply.starts_with("xxxx"));
        assert!(
            reply.ends_with(&format!(" {}", "System".len() + 2 + user.len())),
            "{}",
            &reply[reply.len() - 20..]
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ending_a_command_early_ends_every_process_it_started() {
        use tokio::io::AsyncBufReadExt;
        let mut command = tokio::process::Command::new("sh");
        command
            .args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(std::process::Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        assert!(line.trim().parse::<u32>().is_ok());
        drop(ProcessTree::new(child));
        // The sleep holds the output open while it runs, so the output ends only once both processes have.
        let mut rest = String::new();
        tokio::time::timeout(Duration::from_secs(30), stdout.read_to_string(&mut rest))
            .await
            .expect("A process the command started is still running")
            .unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_ended_well_still_ends_what_it_left_running() {
        use tokio::io::AsyncBufReadExt;
        let mut command = tokio::process::Command::new("sh");
        // The sleep keeps the error output open, and its own output goes nowhere, so the command itself ends.
        command
            .args(["-c", "sleep 60 >/dev/null & echo $!"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap());
        let mut stderr = child.stderr.take().unwrap();
        let mut line = String::new();
        stdout.read_line(&mut line).await.unwrap();
        assert!(line.trim().parse::<u32>().is_ok());
        let mut tree = ProcessTree::new(child);
        assert!(tree.wait().await.unwrap().success());
        // Ended before the command was waited for, while its group's id was still its own, not once it is dropped.
        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(30), stderr.read_to_end(&mut rest))
            .await
            .expect("A process the command left running is still running")
            .unwrap();
        drop(tree);
    }

    #[tokio::test]
    async fn a_servers_answer_is_read_only_up_to_the_limit() {
        let (address, _sent) = serve_once(
            200,
            r#"{"padding":"0123456789012345678901234567890123456789"}"#,
        )
        .await;
        let response = client().unwrap().get(&address).send().await.unwrap();
        let (body, more) = read_capped(response, 10).await.unwrap();
        assert_eq!(body, br#"{"padding""#);
        assert!(more);
        let (address, _sent) = serve_once(200, r#"{"a":1}"#).await;
        let response = client().unwrap().get(&address).send().await.unwrap();
        assert_eq!(
            read_capped(response, 10).await.unwrap(),
            (br#"{"a":1}"#.to_vec(), false)
        );
    }

    #[tokio::test]
    async fn an_openai_compatible_server_gets_the_messages_and_key_and_its_reply_is_read() {
        let (address, sent) = serve_once(
            200,
            r#"{"choices":[{"message":{"content":"Feature: Draft"}}]}"#,
        )
        .await;
        let reply = complete(
            &provider(ProviderKind::OpenAi, &address),
            "qwen",
            "System text",
            "User text",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(reply, "Feature: Draft");
        let sent = sent.await.unwrap();
        assert!(sent.starts_with("POST /chat/completions"));
        assert!(
            sent.to_lowercase()
                .contains("authorization: bearer secret-key")
        );
        assert!(sent.contains(r#""model":"qwen""#));
        assert!(
            sent.contains(r#"{"content":"System text","role":"system"}"#)
                || sent.contains(r#""role":"system","content":"System text""#)
        );
    }

    #[tokio::test]
    async fn the_anthropic_api_gets_its_headers_and_its_text_parts_are_joined() {
        let (address, sent) = serve_once(
            200,
            r#"{"content":[{"type":"text","text":"Bug: "},{"type":"text","text":"Fixed"}]}"#,
        )
        .await;
        let reply = complete(
            &provider(ProviderKind::Anthropic, &address),
            "claude-x",
            "Sys",
            "Usr",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap();
        assert_eq!(reply, "Bug: Fixed");
        let sent = sent.await.unwrap().to_lowercase();
        assert!(sent.starts_with("post /v1/messages"));
        assert!(sent.contains("x-api-key: secret-key"));
        assert!(sent.contains("anthropic-version: 2023-06-01"));
        assert!(sent.contains(r#""system":"sys""#));
    }

    #[tokio::test]
    async fn a_refused_key_says_so_with_the_servers_reason() {
        let (address, _sent) = serve_once(401, r#"{"error":{"message":"Invalid API key"}}"#).await;
        let error = complete(
            &provider(ProviderKind::OpenAi, &address),
            "m",
            "s",
            "u",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert!(error.contains("refused the API key"), "{}", error);
        assert!(error.contains("Invalid API key"), "{}", error);
    }

    #[tokio::test]
    async fn a_refusal_without_an_error_message_shows_the_servers_message() {
        let (address, _sent) = serve_once(
            503,
            r#"{"error":{"type":"overloaded"},"message":"Try again soon"}"#,
        )
        .await;
        let error = complete(
            &provider(ProviderKind::OpenAi, &address),
            "m",
            "s",
            "u",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert!(error.ends_with("Try again soon"), "{}", error);
    }

    #[tokio::test]
    async fn a_command_printing_more_than_the_limit_fails_and_ends() {
        assert!(
            crate::services::terminal_controller::resolve_pwsh().0,
            "pwsh is required"
        );
        // It never stops printing, so only reaching the limit ends it.
        let command = command_provider("while ($true) { [Console]::Out.Write('x' * 1000) }");
        let error = tokio::time::timeout(
            Duration::from_secs(60),
            run_command_capped(&command, "opus", "prompt", None, 64 * 1024),
        )
        .await
        .expect("The command kept running past the limit")
        .unwrap_err();
        assert_eq!(error, "Test printed more than 64 KB.");
        assert_eq!(size_text(BODY_LIMIT), "16 MB");
    }

    #[tokio::test]
    async fn a_commands_errors_are_read_only_up_to_their_limit() {
        assert!(
            crate::services::terminal_controller::resolve_pwsh().0,
            "pwsh is required"
        );
        let command = command_provider(&format!(
            "[Console]::Error.Write('e' * {}); [Console]::Out.Write('done'); exit 3",
            REFUSAL_LIMIT * 4
        ));
        let error = run_command_capped(&command, "opus", "prompt", None, 64 * 1024)
            .await
            .unwrap_err();
        assert!(
            error.starts_with("Test failed (exit code 3): eee"),
            "{}",
            error
        );
    }

    #[tokio::test]
    async fn models_are_listed_from_each_kind_of_server() {
        let (address, sent) = serve_once(
            200,
            r#"{"data":[{"id":"llama3"},{"id":"qwen"},{"id":"llama3"}]}"#,
        )
        .await;
        let models = list_models(&provider(ProviderKind::OpenAi, &address))
            .await
            .unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["llama3", "qwen"]
        );
        assert!(sent.await.unwrap().starts_with("GET /models"));
        let (address, sent) = serve_once(
            200,
            r#"{"data":[{"id":"claude-opus","display_name":"Claude Opus"}]}"#,
        )
        .await;
        let models = list_models(&provider(ProviderKind::Anthropic, &address))
            .await
            .unwrap();
        assert_eq!(
            models,
            vec![AiModel {
                id: "claude-opus".into(),
                name: "Claude Opus".into()
            }]
        );
        assert!(sent.await.unwrap().starts_with("GET /v1/models"));
    }

    #[tokio::test]
    async fn every_page_of_anthropic_models_is_listed() {
        let (address, sent) = serve_each(
            200,
            vec![
                r#"{"data":[{"id":"b","display_name":"B"}],"has_more":true,"last_id":"b"}"#,
                r#"{"data":[{"id":"a","display_name":"A"}],"has_more":false,"last_id":"a"}"#,
            ],
        )
        .await;
        let models = list_models(&provider(ProviderKind::Anthropic, &address))
            .await
            .unwrap();
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        let sent = sent.await.unwrap();
        assert!(
            sent[0].starts_with("GET /v1/models?limit=100 "),
            "{}",
            sent[0]
        );
        assert!(
            sent[1].starts_with("GET /v1/models?limit=100&after_id=b "),
            "{}",
            sent[1]
        );
    }

    #[tokio::test]
    async fn a_reply_cut_off_at_the_length_limit_is_refused() {
        let (address, _sent) = serve_once(
            200,
            r#"{"choices":[{"message":{"content":"Feature: Half"},"finish_reason":"length"}]}"#,
        )
        .await;
        let error = complete(
            &provider(ProviderKind::OpenAi, &address),
            "m",
            "s",
            "u",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert!(error.contains("cut off"), "{}", error);
        let (address, _sent) = serve_once(
            200,
            r#"{"content":[{"type":"text","text":"Bug: Half"}],"stop_reason":"max_tokens"}"#,
        )
        .await;
        let error = complete(
            &provider(ProviderKind::Anthropic, &address),
            "m",
            "s",
            "u",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert!(error.contains("cut off"), "{}", error);
    }

    #[tokio::test]
    async fn a_server_that_cant_be_reached_is_named_without_its_address() {
        // Nothing listens on a port bound and let go.
        let free = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/v1?key=abc123", free.local_addr().unwrap());
        drop(free);
        let error = complete(
            &provider(ProviderKind::OpenAi, &address),
            "m",
            "s",
            "u",
            None,
            Duration::from_secs(10),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("Test can't be reached"), "{}", error);
        assert!(!error.contains("abc123"), "{}", error);
        assert!(!error.contains("127.0.0.1"), "{}", error);
    }

    #[test]
    fn settings_reach_remote_browsers_only_through_the_redacted_event() {
        let source = include_str!("ai.rs");
        let code = &source[..source.find("#[cfg(test)]").unwrap()];
        // Only `settings_changed` sends the event, with what remote browsers may see.
        assert_eq!(code.matches("\"ai-settings-changed\"").count(), 1);
        assert!(code.contains("broadcast_redacted(app, \"ai-settings-changed\""));
    }

    #[tokio::test]
    async fn a_command_reads_the_prompt_from_stdin_and_its_output_is_the_reply() {
        assert!(
            crate::services::terminal_controller::resolve_pwsh().0,
            "pwsh is required"
        );
        // Echoes the model it was given and how the prompt starts.
        let mut command = command_provider(
            "$model = {model}; $text = [Console]::In.ReadToEnd(); $model + ':' + $text.Substring(0, 6)",
        );
        let reply = complete(
            &command,
            "opus",
            "System",
            "User",
            None,
            Duration::from_secs(60),
        )
        .await
        .unwrap();
        assert_eq!(reply, "opus:System");
        command.command = "Write-Error 'no sign-in'; exit 3".into();
        let error = complete(&command, "opus", "s", "u", None, Duration::from_secs(60))
            .await
            .unwrap_err();
        assert!(
            error.contains("exit code 3") && error.contains("no sign-in"),
            "{}",
            error
        );
    }

    /// Runs `work` as a request listed under `id`, as the commands do.
    async fn cancellable<T>(
        id: &str,
        work: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        let request = Request::register(id)?;
        request
            .run(async { work.await.map_err(Failure::Local) })
            .await
            .map_err(String::from)
    }

    #[tokio::test]
    async fn a_cancel_sent_before_the_work_starts_stops_it_before_the_provider_is_asked() {
        let id = Uuid::new_v4().to_string();
        // Listed as the command starts, then cancelled while it reads files, before it asks the provider.
        let request = Request::register(&id).unwrap();
        assert!(ai_cancel(id.clone()).await.unwrap());
        let asked = std::sync::atomic::AtomicBool::new(false);
        let result = request
            .run(async {
                asked.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok::<_, Failure>(1)
            })
            .await;
        assert_eq!(result, Err(Failure::Local(String::from(CANCELLED))));
        assert!(!asked.load(std::sync::atomic::Ordering::SeqCst));
        drop(request);
        assert!(!is_running(&id));
    }

    #[test]
    fn only_the_providers_own_failures_are_noted_as_its_last_error() {
        let command = command_provider("llm");
        // Task Proxy's own checks and cancels say nothing about the provider.
        let no_model = check_model(&command, " ").unwrap_err();
        assert_eq!(no_model, "Choose a model to write with.");
        assert_eq!(
            provider_outcome::<String>(&Err(Failure::Local(no_model))),
            None
        );
        assert!(check_model(&command, "other").is_err());
        assert!(check_model(&command, "opus").is_ok());
        assert_eq!(
            provider_outcome::<String>(&Err(Failure::Local(String::from(CANCELLED)))),
            None
        );
        // What the provider did is noted, and a success clears what failed before.
        assert_eq!(
            provider_outcome::<String>(&Err(Failure::Provider(String::from("Test answered 500.")))),
            Some(Some(String::from("Test answered 500.")))
        );
        assert_eq!(provider_outcome(&Ok(String::from("Draft"))), Some(None));
    }

    #[test]
    fn the_request_shares_the_size_limit_with_what_it_is_about() {
        let context = "c".repeat(3000);
        let request = "r".repeat(5000);
        let message = user_message(&request, &context, 2000);
        assert!(
            message.chars().count() <= 2000,
            "{}",
            message.chars().count()
        );
        assert!(message.starts_with("ccc"));
        assert!(message.contains("rrr"));
        // A short request is kept whole, after what it is about.
        let message = user_message("Add a step", &context, 2000);
        assert!(message.chars().count() <= 2000);
        assert!(message.ends_with("\n\nAdd a step"));
        assert_eq!(user_message("  ", "", 2000), "Write it.");
    }

    #[test]
    fn blocks_joined_with_their_separators_fit_the_limit() {
        let blocks: Vec<Block> = (0..100)
            .map(|index| Block {
                path: index.to_string(),
                text: "z".repeat(250),
            })
            .collect();
        let joined = fit_blocks(blocks.clone(), 20_000).join(SEPARATOR);
        assert!(
            joined.chars().count() <= 20_000,
            "{}",
            joined.chars().count()
        );
        let message = commit_message(blocks, 20_000);
        assert!(message.starts_with(CHANGES_HEADING));
        assert!(
            message.chars().count() <= 20_000,
            "{}",
            message.chars().count()
        );
    }

    #[test]
    fn a_review_fits_each_request_and_its_join_and_too_many_requests_are_refused() {
        let block = |size: usize| Block {
            path: "f".into(),
            text: "w".repeat(size),
        };
        // Files that only fit a batch without their separators and its heading.
        let parts =
            review_parts(vec![block(990), block(990), block(10)], "The changes", 2000).unwrap();
        assert_eq!(parts.len(), 2);
        assert!(parts[0].starts_with("The changes (part 1 of 2):\n\nwww"));
        assert!(parts.iter().all(|part| part.chars().count() <= 2000));
        let one = review_parts(vec![block(10)], "The changes", 2000).unwrap();
        assert_eq!(one, vec![format!("The changes:\n\n{}", "w".repeat(10))]);
        // Each file needs its own request here, more than one review may make.
        let many = (0..MAX_REVIEW_PARTS + 1).map(|_| block(1500)).collect();
        let error = review_parts(many, "The project's files", 2000).unwrap_err();
        assert!(
            error.starts_with(&format!(
                "This review would take {} requests to the model, and one review makes at most {}.",
                MAX_REVIEW_PARTS + 2,
                MAX_REVIEW_PARTS + 1
            )),
            "{}",
            error
        );
        let most = (0..MAX_REVIEW_PARTS).map(|_| block(1500)).collect();
        assert_eq!(
            review_parts(most, "The changes", 2000).unwrap().len(),
            MAX_REVIEW_PARTS
        );
        // The reviews are joined within the limit too.
        let reports: Vec<String> = (0..MAX_REVIEW_PARTS).map(|_| "v".repeat(1900)).collect();
        let joined = join_message(&reports, 2000);
        assert!(joined.chars().count() <= 2000, "{}", joined.chars().count());
        assert!(joined.starts_with("## Part "));
        assert!(joined.ends_with("more reviews left out to fit the size limit."));
    }

    #[tokio::test]
    async fn an_address_with_a_query_keeps_it_after_the_path() {
        let (address, sent) = serve_once(
            200,
            r#"{"choices":[{"message":{"content":"Feature: Draft"}}]}"#,
        )
        .await;
        let server = provider(
            ProviderKind::OpenAi,
            &format!("{}/v1?api-version=2", address),
        );
        complete(&server, "m", "s", "u", None, Duration::from_secs(10))
            .await
            .unwrap();
        let sent = sent.await.unwrap();
        assert!(
            sent.starts_with("POST /v1/chat/completions?api-version=2 "),
            "{}",
            sent
        );
        let (address, sent) = serve_once(200, r#"{"data":[{"id":"m"}]}"#).await;
        let server = provider(
            ProviderKind::OpenAi,
            &format!("{}/v1/?api-version=2", address),
        );
        list_models(&server).await.unwrap();
        let sent = sent.await.unwrap();
        assert!(
            sent.starts_with("GET /v1/models?api-version=2 "),
            "{}",
            sent
        );
        let (address, sent) =
            serve_once(200, r#"{"content":[{"type":"text","text":"Bug: Fixed"}]}"#).await;
        let server = provider(ProviderKind::Anthropic, &format!("{}?beta=1", address));
        complete(&server, "m", "s", "u", None, Duration::from_secs(10))
            .await
            .unwrap();
        let sent = sent.await.unwrap();
        assert!(sent.starts_with("POST /v1/messages?beta=1 "), "{}", sent);
    }

    fn is_running(id: &str) -> bool {
        REQUESTS.lock().unwrap().contains_key(id)
    }

    /// A request that runs until it is cancelled, started once it is listed under its id.
    async fn start_request(id: &str) -> tokio::task::JoinHandle<Result<u8, String>> {
        let owned = id.to_string();
        let handle = tokio::spawn(async move {
            cancellable(&owned, std::future::pending::<Result<u8, String>>()).await
        });
        while !is_running(id) {
            tokio::task::yield_now().await;
        }
        handle
    }

    #[tokio::test]
    async fn a_cancelled_request_stops_with_cancelled() {
        let id = Uuid::new_v4().to_string();
        let request = start_request(&id).await;
        assert!(ai_cancel(id.clone()).await.unwrap());
        assert_eq!(request.await.unwrap(), Err(String::from(CANCELLED)));
        assert!(!is_running(&id));
        assert!(!ai_cancel(id).await.unwrap());
    }

    #[tokio::test]
    async fn a_request_id_already_running_is_refused_and_leaves_the_first_cancellable() {
        let id = Uuid::new_v4().to_string();
        let first = start_request(&id).await;
        assert_eq!(
            cancellable(&id, async { Ok::<_, String>(2) }).await,
            Err(String::from(REQUEST_IN_USE))
        );
        // The refused request didn't take the first one's place away.
        assert!(ai_cancel(id.clone()).await.unwrap());
        assert_eq!(first.await.unwrap(), Err(String::from(CANCELLED)));
        // A request dropped before it ends leaves the list too.
        let dropped = start_request(&id).await;
        dropped.abort();
        assert!(dropped.await.unwrap_err().is_cancelled());
        assert!(!is_running(&id));
        assert_eq!(cancellable(&id, async { Ok::<_, String>(3) }).await, Ok(3));
    }

    fn commit_all(repository: &Repository) {
        let mut index = repository.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let parents: Vec<git2::Commit> = repository
            .head()
            .ok()
            .and_then(|h| h.peel_to_commit().ok())
            .into_iter()
            .collect();
        let parents: Vec<&git2::Commit> = parents.iter().collect();
        repository
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "commit",
                &tree,
                &parents,
            )
            .unwrap();
    }

    #[test]
    fn changes_are_sent_as_diffs_new_files_whole_and_binary_files_by_size() {
        let folder = tempfile::tempdir().unwrap();
        let repository = Repository::init(folder.path()).unwrap();
        fs::write(folder.path().join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(folder.path().join("logo.png"), [0u8, 1, 2, 3]).unwrap();
        commit_all(&repository);
        fs::write(folder.path().join("a.txt"), "one\nthree\n").unwrap();
        fs::write(folder.path().join("logo.png"), [0u8, 1, 2, 3, 4, 5]).unwrap();
        fs::write(folder.path().join("new.txt"), "fresh\n").unwrap();
        let blocks = change_blocks(
            &repository,
            &["a.txt".into(), "logo.png".into(), "new.txt".into()],
        )
        .unwrap();
        assert!(blocks[0].text.contains("-two") && blocks[0].text.contains("+three"));
        assert!(
            blocks[1].text.contains("(binary)")
                && blocks[1].text.contains("4 bytes")
                && blocks[1].text.contains("6 bytes")
        );
        assert!(blocks[2].text.contains("+fresh"));
        // Only the files asked for.
        assert_eq!(
            change_blocks(&repository, &["a.txt".into()]).unwrap().len(),
            1
        );
    }

    #[test]
    fn changes_refuse_paths_out_of_the_repo_or_into_its_git_folder() {
        let folder = tempfile::tempdir().unwrap();
        let repository = Repository::init(folder.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "the secret").unwrap();
        let absolute = secret.to_string_lossy().to_string();
        for file in [
            "../secret.txt",
            absolute.as_str(),
            ".git/config",
            "a/../../secret.txt",
        ] {
            assert!(
                change_blocks(&repository, &[file.to_string()]).is_err(),
                "{}",
                file
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn changes_and_project_reviews_never_follow_symbolic_links() {
        let folder = tempfile::tempdir().unwrap();
        let repository = Repository::init(folder.path()).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("credentials"), "the secret").unwrap();
        fs::write(folder.path().join("main.rs"), "fn main() {}\n").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("credentials"),
            folder.path().join("committed-link"),
        )
        .unwrap();
        commit_all(&repository);
        std::os::unix::fs::symlink(
            outside.path().join("credentials"),
            folder.path().join("new-link"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), folder.path().join("linked-folder")).unwrap();
        let files = [
            "new-link".into(),
            "linked-folder/credentials".into(),
            "committed-link".into(),
        ];
        let blocks = change_blocks(&repository, &files).unwrap();
        assert!(
            blocks
                .iter()
                .all(|block| !block.text.contains("the secret")),
            "{:?}",
            blocks
        );
        let reviewed = project_blocks(&repository).unwrap();
        assert!(
            reviewed
                .iter()
                .all(|block| !block.text.contains("the secret")),
            "{:?}",
            reviewed
        );
        assert_eq!(
            reviewed.iter().map(|b| b.path.as_str()).collect::<Vec<_>>(),
            vec!["main.rs"]
        );
    }

    #[test]
    fn a_file_without_changes_is_not_sent_whole() {
        let folder = tempfile::tempdir().unwrap();
        let repository = Repository::init(folder.path()).unwrap();
        fs::write(folder.path().join("same.txt"), "unchanged content\n").unwrap();
        commit_all(&repository);
        let blocks = change_blocks(&repository, &["same.txt".into()]).unwrap();
        assert!(
            !blocks[0].text.contains("unchanged content"),
            "{}",
            blocks[0].text
        );
        assert!(blocks[0].text.contains("(no line changes)"));
    }

    /// With `core.ignorecase` on a case-sensitive file system, libgit2 looks for a renamed file by its old name.
    /// That file says its changes could not be read, and the other files are still sent.
    #[test]
    fn a_file_whose_changes_cannot_be_read_is_named_and_the_others_still_go() {
        let folder = tempfile::tempdir().unwrap();
        let repository = Repository::init(folder.path()).unwrap();
        fs::write(folder.path().join("cargo.toml"), "[package]\n").unwrap();
        fs::write(folder.path().join("a.txt"), "one\n").unwrap();
        commit_all(&repository);
        repository
            .config()
            .unwrap()
            .set_bool("core.ignorecase", true)
            .unwrap();
        let repository = Repository::open(folder.path()).unwrap();
        fs::remove_file(folder.path().join("cargo.toml")).unwrap();
        fs::write(
            folder.path().join("Cargo.toml"),
            "[package]\nname = \"renamed\"\n",
        )
        .unwrap();
        fs::write(folder.path().join("a.txt"), "two\n").unwrap();
        let blocks = change_blocks(&repository, &["cargo.toml".into(), "a.txt".into()]).unwrap();
        assert!(
            blocks[0].text.contains("could not be read"),
            "{}",
            blocks[0].text
        );
        assert!(blocks[1].text.contains("+two"), "{}", blocks[1].text);
    }

    #[test]
    fn a_project_review_reads_text_files_and_leaves_out_binary_large_and_ignored_ones() {
        let folder = tempfile::tempdir().unwrap();
        let repository = Repository::init(folder.path()).unwrap();
        fs::write(folder.path().join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(folder.path().join("main.rs"), "fn main() {}\n").unwrap();
        fs::write(folder.path().join("image.bin"), [0u8, 9, 9]).unwrap();
        fs::write(
            folder.path().join("huge.txt"),
            "z".repeat(REVIEW_FILE_LIMIT as usize + 1),
        )
        .unwrap();
        commit_all(&repository);
        fs::write(folder.path().join("ignored.txt"), "secret notes").unwrap();
        fs::write(folder.path().join("untracked.md"), "# New").unwrap();
        let paths: Vec<String> = project_blocks(&repository)
            .unwrap()
            .into_iter()
            .map(|b| b.path)
            .collect();
        assert_eq!(paths, vec![".gitignore", "main.rs", "untracked.md"]);
    }
}
