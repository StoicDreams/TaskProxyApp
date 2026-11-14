//! Runs plugins with Extism, and answers what they ask of Task Proxy.
//!
//! A plugin has no WASI and no Extism HTTP or file access. Its only way out is the `taskproxy_host` import, which
//! takes one JSON request and returns `{"ok": ...}` or `{"error": "..."}`. [`CallContext::handle`] checks each request
//! against the plugin's manifest, so a plugin only reaches the hosts, variables, and files it declared.
use super::manifest::PluginManifest;
use crate::prelude::*;
use extism::{CompiledPlugin, Function, PTR, Plugin, PluginBuilder, UserData, Wasm};

/// The longest a single call into a plugin may run, not counting time spent waiting on its HTTP requests.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// 64 KiB pages, so 64 MiB.
const MEMORY_PAGES: u32 = 1024;
/// The largest response body a plugin's HTTP request may receive.
pub(crate) const HTTP_MAX_BYTES: usize = 10 * 1024 * 1024;
/// The largest file a plugin may write to the project.
const FILE_MAX_BYTES: usize = 1024 * 1024;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HttpResponse {
    pub status: u16,
    pub body: String,
}

/// Sends a plugin's HTTP requests, so tests can answer them without a network.
pub(crate) trait HttpSend: Send + Sync {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, String>;
}

/// What a plugin asks of Task Proxy, by `op`. The SDK's `HostRequest` is the other side of this.
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "camelCase")]
enum HostRequest {
    Var {
        key: String,
    },
    StoreGet {
        key: String,
    },
    StoreSet {
        key: String,
        value: Option<Value>,
    },
    ProjectFileRead {
        path: String,
    },
    ProjectFileWrite {
        path: String,
        text: String,
    },
    CurrentBranch,
    Now,
    Http {
        request: HttpRequest,
    },
    /// Since spec 0.1.1.
    HostInfo,
}

/// A plugin's own storage, kept in memory and saved encrypted after a call changes it.
#[derive(Default, Debug)]
pub(crate) struct PluginStore {
    pub values: HashMap<String, Value>,
    pub changed: bool,
}

/// Everything one call into a plugin may use.
pub(crate) struct CallContext {
    pub manifest: PluginManifest,
    /// The declared variables that have values, already looked up project first, then global.
    pub variables: HashMap<String, String>,
    pub store: Arc<Mutex<PluginStore>>,
    /// The open project's root, when one is open.
    pub project_root: Option<PathBuf>,
    /// The repo whose branch `currentBranch` reports.
    pub repo_path: Option<PathBuf>,
    pub http: Arc<dyn HttpSend>,
}

/// The folder in the project a plugin may read and write: `.taskproxy/plugins/<id>`.
pub(crate) fn plugin_project_folder(id: &str) -> String {
    format!(".taskproxy/plugins/{}", id)
}

impl CallContext {
    /// Answers one host request, as `{"ok": ...}` or `{"error": "..."}`.
    pub fn handle(&self, request: &[u8]) -> Vec<u8> {
        let answer = serde_json::from_slice::<HostRequest>(request)
            .map_err(|err| format!("Task Proxy did not understand the request: {}", err))
            .and_then(|request| self.answer(request));
        let value = match answer {
            Ok(value) => serde_json::json!({ "ok": value }),
            Err(error) => serde_json::json!({ "error": error }),
        };
        serde_json::to_vec(&value).unwrap_or_default()
    }

    fn answer(&self, request: HostRequest) -> Result<Value, String> {
        match request {
            HostRequest::Var { key } => {
                if !self.manifest.declares_variable(&key) {
                    return Err(format!(
                        "{} did not declare the variable {}.",
                        self.manifest.name, key
                    ));
                }
                Ok(self
                    .variables
                    .get(&key)
                    .cloned()
                    .map(Value::String)
                    .unwrap_or(Value::Null))
            }
            HostRequest::StoreGet { key } => {
                let store = self.store.lock().map_err(|err| err.to_string())?;
                Ok(store.values.get(&key).cloned().unwrap_or(Value::Null))
            }
            HostRequest::StoreSet { key, value } => {
                let mut store = self.store.lock().map_err(|err| err.to_string())?;
                match value {
                    Some(Value::Null) | None => store.values.remove(&key),
                    Some(value) => store.values.insert(key, value),
                };
                store.changed = true;
                Ok(Value::Null)
            }
            HostRequest::ProjectFileRead { path } => {
                let file = self.project_file(&path)?;
                if !file.is_file() {
                    return Ok(Value::Null);
                }
                ensure_inside_root(self.project_root.as_deref().unwrap_or(Path::new("")), &file)?;
                fs::read_to_string(&file)
                    .map(Value::String)
                    .map_err(|err| format!("Could not read {}: {}", path, err))
            }
            HostRequest::ProjectFileWrite { path, text } => {
                if text.len() > FILE_MAX_BYTES {
                    return Err(format!("{} is larger than 1 MB.", path));
                }
                let file = self.project_file(&path)?;
                ensure_inside_root(self.project_root.as_deref().unwrap_or(Path::new("")), &file)?;
                write_atomic(&file, text.as_bytes())
                    .map_err(|err| format!("Could not write {}: {}", path, err))?;
                Ok(Value::Null)
            }
            HostRequest::CurrentBranch => {
                if !self.manifest.allows_git("currentBranch") {
                    return Err(format!(
                        "{} did not ask to read the current branch.",
                        self.manifest.name
                    ));
                }
                Ok(self
                    .repo_path
                    .as_deref()
                    .and_then(current_branch)
                    .map(Value::String)
                    .unwrap_or(Value::Null))
            }
            HostRequest::Now => Ok(Value::from(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|elapsed| elapsed.as_millis() as u64)
                    .unwrap_or(0),
            )),
            HostRequest::HostInfo => Ok(serde_json::json!({
                "app": env!("CARGO_PKG_VERSION"),
                "spec": self.manifest.spec_version()?.to_string(),
                "platform": std::env::consts::OS,
            })),
            HostRequest::Http { request } => {
                self.check_url(&request.url)?;
                let response = self.http.send(&request)?;
                serde_json::to_value(response).map_err(|err| err.to_string())
            }
        }
    }

    /// A path inside the plugin's own project folder.
    fn project_file(&self, path: &str) -> Result<PathBuf, String> {
        let root = self
            .project_root
            .as_ref()
            .ok_or_else(|| String::from("No project is open."))?;
        let relative = safe_relative_path(path)?;
        if relative.as_os_str().is_empty() {
            return Err(format!("Invalid path: {}", path));
        }
        Ok(root
            .join(plugin_project_folder(&self.manifest.id))
            .join(relative))
    }

    fn check_url(&self, url: &str) -> Result<(), String> {
        let parsed = reqwest::Url::parse(url).map_err(|_| format!("Invalid address: {}", url))?;
        if parsed.scheme() != "https" {
            return Err(format!(
                "Plugins can only use https addresses, not {}.",
                url
            ));
        }
        let host = parsed.host_str().unwrap_or("");
        if !parsed.username().is_empty() || parsed.password().is_some() {
            return Err(String::from(
                "Send credentials in a header, not in the address.",
            ));
        }
        if !self.manifest.allows_host(host) {
            return Err(format!(
                "{} is not allowed to reach {}.",
                self.manifest.name, host
            ));
        }
        Ok(())
    }
}

/// The branch HEAD points at, even before its first commit. `None` when HEAD is detached.
pub(crate) fn current_branch(repo: &Path) -> Option<String> {
    let repository = git2::Repository::open(repo).ok()?;
    let head = repository.find_reference("HEAD").ok()?;
    head.symbolic_target()?
        .strip_prefix("refs/heads/")
        .map(String::from)
}

/// Compiles a plugin once, so each call only creates a fresh instance.
pub(crate) fn compile(wasm: &[u8]) -> Result<CompiledPlugin, String> {
    compile_with_timeout(wasm, CALL_TIMEOUT)
}

fn compile_with_timeout(wasm: &[u8], timeout: Duration) -> Result<CompiledPlugin, String> {
    let manifest = extism::Manifest::new([Wasm::data(wasm.to_vec())])
        .with_timeout(timeout)
        .with_memory_max(MEMORY_PAGES);
    let host = Function::new(
        "taskproxy_host",
        [PTR],
        [PTR],
        UserData::new(()),
        |plugin, inputs, outputs, _| {
            let request: Vec<u8> = plugin.memory_get_val(&inputs[0])?;
            let context = plugin.host_context::<Arc<CallContext>>()?.clone();
            let answer = context.handle(&request);
            plugin.memory_set_val(&mut outputs[0], answer)?;
            Ok(())
        },
    );
    let builder = PluginBuilder::new(manifest)
        .with_wasi(false)
        .with_cache_disabled()
        .with_functions([host]);
    CompiledPlugin::new(builder).map_err(|err| format!("The plugin could not be loaded: {}", err))
}

/// Calls one of a plugin's exports with JSON input, and returns what it answered.
/// Blocks, so run it on a blocking thread.
pub(crate) fn call(
    compiled: &CompiledPlugin,
    export: &str,
    input: &Value,
    context: Arc<CallContext>,
) -> Result<Value, String> {
    let name = context.manifest.name.clone();
    let mut plugin = Plugin::new_from_compiled(compiled)
        .map_err(|err| format!("{} could not start: {}", name, err))?;
    if !plugin.function_exists(export) {
        return Err(format!("{} has no {} function.", name, export));
    }
    let input = serde_json::to_vec(input).map_err(|err| err.to_string())?;
    let output: Vec<u8> = plugin
        .call_with_host_context(export, input, context)
        .map_err(|err| format!("{} stopped with an error: {}", name, describe(&err)))?;
    let mut answer: Value = serde_json::from_slice(&output)
        .map_err(|err| format!("{} answered with something that is not JSON: {}", name, err))?;
    if let Some(error) = answer.get("error") {
        return Err(error.as_str().unwrap_or("The plugin failed.").to_string());
    }
    Ok(answer.get_mut("ok").map(Value::take).unwrap_or(Value::Null))
}

fn describe(err: &extism::Error) -> String {
    let text = format!("{:#}", err);
    if text.contains("timeout") || text.contains("interrupt") {
        String::from("it took too long and was stopped")
    } else {
        text.lines().next().unwrap_or("unknown error").to_string()
    }
}

/// Sends plugin HTTP requests with the shared client, which follows no redirects, since a redirect could lead to
/// a host the plugin is not allowed to reach.
pub(crate) struct NetworkHttp;

static PLUGIN_CLIENT: std::sync::LazyLock<Option<reqwest::Client>> =
    std::sync::LazyLock::new(|| {
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        reqwest::Client::builder()
            .user_agent("TaskProxy")
            .timeout(Duration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .ok()
    });

impl HttpSend for NetworkHttp {
    fn send(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
        let client = PLUGIN_CLIENT
            .as_ref()
            .ok_or_else(|| String::from("HTTP is not available."))?;
        let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| format!("Unknown HTTP method {}", request.method))?;
        let mut builder = client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        tauri::async_runtime::block_on(async move {
            let mut response = builder.send().await.map_err(|err| {
                if err.is_timeout() {
                    String::from("The server took too long to answer.")
                } else {
                    format!("Could not reach the server: {}", err)
                }
            })?;
            let status = response.status().as_u16();
            let mut body = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|err| err.to_string())? {
                if body.len() + chunk.len() > HTTP_MAX_BYTES {
                    return Err(String::from("The server's answer was larger than 10 MB."));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(HttpResponse {
                status,
                body: String::from_utf8_lossy(&body).into_owned(),
            })
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    /// The test plugin built from TaskProxyPlugins/test-plugin. Rebuild it with scripts/build.ps1 there.
    pub(crate) const TEST_WASM: &[u8] =
        include_bytes!("../../tests/fixtures/plugins/test/plugin.wasm");
    pub(crate) const TEST_MANIFEST: &str =
        include_str!("../../tests/fixtures/plugins/test/plugin.json");

    pub(crate) struct FakeHttp(pub Mutex<Vec<HttpRequest>>);

    impl HttpSend for FakeHttp {
        fn send(&self, request: &HttpRequest) -> Result<HttpResponse, String> {
            self.0.lock().unwrap().push(request.clone());
            Ok(HttpResponse {
                status: 200,
                body: format!("answer from {}", request.url),
            })
        }
    }

    struct Setup {
        compiled: CompiledPlugin,
        context: Arc<CallContext>,
        http: Arc<FakeHttp>,
        _dir: tempfile::TempDir,
    }

    fn setup() -> Setup {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        fs::create_dir_all(&project).unwrap();
        let repository = git2::Repository::init(&project).unwrap();
        repository.set_head("refs/heads/TEST-7-login").unwrap();
        let http = Arc::new(FakeHttp(Mutex::new(Vec::new())));
        let context = Arc::new(CallContext {
            manifest: PluginManifest::parse(TEST_MANIFEST).unwrap(),
            variables: HashMap::from([
                ("test_site".to_string(), "https://a.example.com".to_string()),
                ("git_pat".to_string(), "never sent".to_string()),
            ]),
            store: Arc::new(Mutex::new(PluginStore::default())),
            project_root: Some(project.clone()),
            repo_path: Some(project),
            http: http.clone(),
        });
        Setup {
            compiled: compile(TEST_WASM).unwrap(),
            context,
            http,
            _dir: dir,
        }
    }

    /// Runs the test plugin's `call` action, which makes one host call and returns its answer as text.
    fn host_call(setup: &Setup, params: Value) -> String {
        let request = json!({ "page": "home", "action": "call", "params": params });
        let answer = call(&setup.compiled, "action", &request, setup.context.clone()).unwrap();
        answer["ui"]["text"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_page_renders_with_its_params() {
        let setup = setup();
        let answer = call(
            &setup.compiled,
            "render",
            &json!({ "page": "home", "params": { "key": "P-1" } }),
            setup.context.clone(),
        )
        .unwrap();
        assert_eq!(answer["type"], "stack");
        assert_eq!(answer["children"][1]["text"], r#"params: {"key":"P-1"}"#);
    }

    #[test]
    fn plugin_errors_come_back_as_messages() {
        let setup = setup();
        let err = call(
            &setup.compiled,
            "render",
            &json!({ "page": "nope" }),
            setup.context.clone(),
        )
        .unwrap_err();
        assert_eq!(err, "No page named nope");
        let err = call(
            &setup.compiled,
            "missing",
            &json!({}),
            setup.context.clone(),
        )
        .unwrap_err();
        assert!(err.contains("has no missing function"), "{}", err);
    }

    #[test]
    fn a_plugin_that_crashes_is_reported_and_the_next_call_still_works() {
        let setup = setup();
        let err = call(
            &setup.compiled,
            "render",
            &json!({ "page": "panic" }),
            setup.context.clone(),
        )
        .unwrap_err();
        assert!(err.contains("stopped with an error"), "{}", err);
        assert!(
            call(
                &setup.compiled,
                "render",
                &json!({ "page": "home" }),
                setup.context.clone()
            )
            .is_ok()
        );
    }

    #[test]
    fn only_declared_variables_are_readable() {
        let setup = setup();
        assert_eq!(
            host_call(&setup, json!({ "op": "var", "key": "test_site" })),
            r#"ok: "https://a.example.com""#
        );
        assert_eq!(
            host_call(&setup, json!({ "op": "var", "key": "test_token" })),
            "ok: null"
        );
        assert_eq!(
            host_call(&setup, json!({ "op": "var", "key": "git_pat" })),
            "error: Test Plugin did not declare the variable git_pat."
        );
    }

    #[test]
    fn storage_keeps_values_and_marks_itself_changed() {
        let setup = setup();
        assert_eq!(
            host_call(
                &setup,
                json!({ "op": "storeSet", "key": "views", "value": [1, 2] })
            ),
            r#"ok: "saved""#
        );
        assert_eq!(
            host_call(&setup, json!({ "op": "storeGet", "key": "views" })),
            "ok: [1,2]"
        );
        assert!(setup.context.store.lock().unwrap().changed);
        host_call(&setup, json!({ "op": "storeSet", "key": "views" }));
        assert_eq!(
            host_call(&setup, json!({ "op": "storeGet", "key": "views" })),
            "ok: null"
        );
    }

    #[test]
    fn project_files_stay_in_the_plugins_own_folder() {
        let setup = setup();
        assert_eq!(
            host_call(
                &setup,
                json!({ "op": "fileWrite", "key": "views.json", "text": "[]" })
            ),
            r#"ok: "written""#
        );
        let root = setup.context.project_root.clone().unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".taskproxy/plugins/test/views.json")).unwrap(),
            "[]"
        );
        assert_eq!(
            host_call(&setup, json!({ "op": "fileRead", "key": "views.json" })),
            r#"ok: "[]""#
        );
        assert_eq!(
            host_call(&setup, json!({ "op": "fileRead", "key": "none.json" })),
            "ok: null"
        );
        for path in ["../Navigation.json", "../../.git/config", "/etc/passwd", ""] {
            let answer = host_call(
                &setup,
                json!({ "op": "fileWrite", "key": path, "text": "x" }),
            );
            assert!(answer.starts_with("error: "), "{} -> {}", path, answer);
        }
        assert!(!root.join(".taskproxy/Navigation.json").exists());
    }

    #[test]
    fn http_reaches_only_allowed_https_hosts() {
        let setup = setup();
        assert_eq!(
            host_call(
                &setup,
                json!({ "op": "http", "key": "https://a.example.com/rest" })
            ),
            r#"ok: {"body":"answer from https://a.example.com/rest","status":200}"#
        );
        for (url, error) in [
            ("http://a.example.com/rest", "only use https"),
            (
                "https://example.com/rest",
                "not allowed to reach example.com",
            ),
            ("https://a.example.com.evil.net/", "not allowed to reach"),
            ("https://user:pw@a.example.com/", "in a header"),
            ("not a url", "Invalid address"),
        ] {
            let answer = host_call(&setup, json!({ "op": "http", "key": url }));
            assert!(answer.contains(error), "{} -> {}", url, answer);
        }
        assert_eq!(setup.http.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn the_current_branch_and_clock_are_available() {
        let setup = setup();
        assert_eq!(
            host_call(&setup, json!({ "op": "branch" })),
            r#"ok: "TEST-7-login""#
        );
        assert_eq!(host_call(&setup, json!({ "op": "now" })), "ok: true");
    }

    #[test]
    fn host_info_names_the_app_spec_and_platform() {
        let setup = setup();
        let answer: Value =
            serde_json::from_slice(&setup.context.handle(br#"{"op":"hostInfo"}"#)).unwrap();
        assert_eq!(answer["ok"]["app"], env!("CARGO_PKG_VERSION"));
        // The test plugin names only apiVersion 1, which runs as the newest 0.1 patch.
        assert_eq!(answer["ok"]["spec"], crate::plugins::spec::SPEC_VERSIONS[0]);
        assert_eq!(answer["ok"]["platform"], std::env::consts::OS);
        let unknown: Value =
            serde_json::from_slice(&setup.context.handle(br#"{"op":"processes"}"#)).unwrap();
        assert!(
            unknown["error"]
                .as_str()
                .unwrap()
                .contains("did not understand")
        );
    }

    #[test]
    fn branch_info_is_a_card_or_nothing() {
        let setup = setup();
        let card = call(
            &setup.compiled,
            "branch_info",
            &json!({ "branch": "TEST-7-login" }),
            setup.context.clone(),
        )
        .unwrap();
        assert_eq!(card["text"], "Branch TEST-7-login");
        let none = call(
            &setup.compiled,
            "branch_info",
            &json!({ "branch": "main" }),
            setup.context.clone(),
        )
        .unwrap();
        assert_eq!(none, Value::Null);
    }

    #[test]
    fn a_plugin_that_never_finishes_is_stopped() {
        let setup = setup();
        let compiled = compile_with_timeout(TEST_WASM, Duration::from_secs(1)).unwrap();
        let started = std::time::Instant::now();
        let err = call(
            &compiled,
            "render",
            &json!({ "page": "spin" }),
            setup.context.clone(),
        )
        .unwrap_err();
        assert!(err.contains("took too long"), "{}", err);
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
