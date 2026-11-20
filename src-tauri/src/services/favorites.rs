//! Favorite scripts, the icons in the bottom drawer. A favorite is a script on a project's page, linked to that page's
//! block, or one of a project's script files. It runs in the project it came from, with parameters that are fixed or
//! come from data, page then project then global, limited to the scopes the favorite allows. The window keeps the
//! list of favorites with the app's data, and Rust reads the script and fills it, so secret values never reach the
//! window.

use crate::appdata::get_data_from_local_storage;
use crate::prelude::*;
use crate::services::page_scripts::{Values, fill_script, is_trusted};
use crate::services::projects::read_project_file;
use crate::services::runs::{self, RunInfo, RunRequest};
use crate::services::script_controller::collect_scripts;
use regex::Regex;
use serde_json::Map;

const PAGES_FOLDER: &str = ".taskproxy/pages";
/// The app-wide switches for each scope, which a favorite's own scopes can only narrow.
const SCOPE_SWITCHES: [&str; 3] = [
    "app-env-page-enabled",
    "app-env-project-enabled",
    "app-env-global-enabled",
];

/// Where a favorite's script is.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum FavoriteSource {
    /// A block on one of the project's pages: the page's id, the block's place among the page's scripts, its text
    /// when it was chosen, and how many scripts the page had then, to find it again after the page changes.
    #[serde(rename = "page")]
    Page {
        page: String,
        index: usize,
        #[serde(default)]
        text: String,
        #[serde(default)]
        count: Option<usize>,
    },
    /// One of the project's script files.
    #[serde(rename = "file")]
    File { path: String },
}

/// A parameter of a favorite: a fixed value, or a value from data, by `key` or the parameter's own name.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteParam {
    pub name: String,
    #[serde(default)]
    pub from_data: bool,
    #[serde(default)]
    pub value: Value,
    #[serde(default)]
    pub key: Option<String>,
    /// A switch parameter of a script file, passed by name alone when it is on.
    #[serde(default)]
    pub switch: bool,
}

/// Which scopes a favorite's data may come from. Each is on unless turned off.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteScopes {
    #[serde(default = "on")]
    pub page: bool,
    #[serde(default = "on")]
    pub project: bool,
    #[serde(default = "on")]
    pub global: bool,
}

fn on() -> bool {
    true
}

impl Default for FavoriteScopes {
    fn default() -> Self {
        Self {
            page: true,
            project: true,
            global: true,
        }
    }
}

/// What the window sends to run a favorite.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FavoriteRun {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// The saved project the script came from, which it runs in.
    pub project: String,
    pub source: FavoriteSource,
    #[serde(default)]
    pub params: Vec<FavoriteParam>,
    #[serde(default)]
    pub scopes: FavoriteScopes,
    /// The values on the page shown now, for the page scope.
    #[serde(default)]
    pub page_values: Map<String, Value>,
}

/// A script on a page, as the page shows it: its text, and the words above it that name it.
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PageBlock {
    pub text: String,
    pub label: String,
}

/// The PowerShell blocks on a page, in order, each named by the last line of text above it, as the page's run buttons
/// are (wc/page-handler.js).
pub(crate) fn page_blocks(markdown: &str) -> Vec<PageBlock> {
    static BLOCK: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    static TAG: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let block = BLOCK.get_or_init(|| {
        Regex::new(r"(?i)```(?:powershell|pwsh|ps1)\b[^\n]*\n([\s\S]*?)```").unwrap()
    });
    let tag = TAG.get_or_init(|| Regex::new(r"<[^>]+>").unwrap());
    let mut blocks = Vec::new();
    let mut last = 0;
    for found in block.captures_iter(markdown) {
        let whole = found.get(0).unwrap();
        let before = tag.replace_all(&markdown[last..whole.start()], "");
        let cleaned: String = before.chars().filter(|c| !"#*`_>".contains(*c)).collect();
        let label = cleaned
            .lines()
            .map(str::trim)
            .rfind(|line| !line.is_empty())
            .unwrap_or("")
            .to_string();
        blocks.push(PageBlock {
            text: found[1].to_string(),
            label,
        });
        last = whole.end();
    }
    blocks
}

/// The block a favorite stands for, after the page may have changed: the one at its place with the same text, or the
/// only block with that text, which has moved, or, with as many blocks as before, the one at its place, which was
/// edited. Otherwise it is gone, and the favorite says so rather than run another script.
pub(crate) fn pick_block<'a>(
    blocks: &'a [PageBlock],
    index: usize,
    text: &str,
    count_before: Option<usize>,
) -> Result<&'a PageBlock, String> {
    if let Some(block) = blocks.get(index)
        && block.text == text
    {
        return Ok(block);
    }
    let same: Vec<&PageBlock> = blocks.iter().filter(|block| block.text == text).collect();
    if same.len() == 1 {
        return Ok(same[0]);
    }
    if count_before.is_none_or(|count| count == blocks.len())
        && let Some(block) = blocks.get(index)
    {
        return Ok(block);
    }
    Err(String::from(
        "This favorite's script is no longer on its page. Open the page, and choose the script again.",
    ))
}

/// The page, project, and global values a favorite's data may come from.
type Scopes<'a> = (
    &'a Map<String, Value>,
    &'a HashMap<String, Value>,
    &'a HashMap<String, Value>,
);

/// The scopes a favorite's data comes from: those it allows, as the app's own switches leave them.
fn scoped<'a>(
    allowed: FavoriteScopes,
    page: &'a Map<String, Value>,
    project: &'a HashMap<String, Value>,
    global: &'a HashMap<String, Value>,
    empty_page: &'a Map<String, Value>,
    empty_project: &'a HashMap<String, Value>,
    switches_only: &'a HashMap<String, Value>,
) -> Scopes<'a> {
    (
        if allowed.page { page } else { empty_page },
        if allowed.project {
            project
        } else {
            empty_project
        },
        // The app's scope switches are read from the global values, so they stay when global values are left out.
        if allowed.global {
            global
        } else {
            switches_only
        },
    )
}

/// A parameter's value as text: its fixed value, or the value its data key has in the scopes allowed.
fn param_value(param: &FavoriteParam, values: &Values) -> Option<Value> {
    if !param.from_data {
        return match &param.value {
            Value::Null => None,
            value => Some(value.clone()),
        };
    }
    let key = param
        .key
        .as_deref()
        .filter(|key| !key.trim().is_empty())
        .unwrap_or(&param.name);
    values.lookup(key).cloned()
}

fn as_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn is_on(value: &Value) -> bool {
    match value {
        Value::Bool(on) => *on,
        Value::String(text) => text.eq_ignore_ascii_case("true"),
        Value::Number(number) => number.as_f64().is_some_and(|n| n != 0.0),
        _ => false,
    }
}

/// The arguments for a script file, `-Name value`, or `-Name` alone for a switch that is on. Parameters with no value
/// are left out, so the script's own defaults apply.
pub(crate) fn file_args(params: &[FavoriteParam], values: &Values) -> Vec<String> {
    let mut args = Vec::new();
    for param in params {
        let Some(value) = param_value(param, values) else {
            continue;
        };
        if param.switch {
            if is_on(&value) {
                args.push(format!("-{}", param.name));
            }
            continue;
        }
        let text = as_text(&value);
        if text.is_empty() {
            continue;
        }
        args.push(format!("-{}", param.name));
        args.push(text);
    }
    args
}

/// The values a page script's parameters are set to for this run, which come before every scope.
pub(crate) fn page_overrides(params: &[FavoriteParam], values: &Values) -> Map<String, Value> {
    let mut overrides = Map::new();
    for param in params {
        if let Some(value) = param_value(param, values) {
            overrides.insert(param.name.clone(), value);
        }
    }
    overrides
}

/// The saved project a favorite belongs to, by its path, with either slash and any case.
fn saved_project(known: &[Project], wanted: &str) -> Result<Project, String> {
    let normalize = |path: &str| path.replace('\\', "/").to_lowercase();
    known
        .iter()
        .find(|project| normalize(&project.path) == normalize(wanted))
        .cloned()
        .ok_or_else(|| format!("{} is not one of your projects any more.", wanted))
}

/// A project's own values: the open project's as the window has them, or another's as last saved.
async fn project_values(
    app: &AppHandle,
    project_state: &State<'_, CurrentProject>,
    path: &str,
) -> HashMap<String, Value> {
    let normalized = path.replace('\\', "/");
    if let Ok(open) = project_state.lock()
        && open
            .path
            .replace('\\', "/")
            .eq_ignore_ascii_case(&normalized)
    {
        return open.data.clone();
    }
    let hash = get_hash_code(&normalized);
    match get_data_from_local_storage(app, &format!("{}.enc", hash)).await {
        Ok(bytes) if !bytes.is_empty() => serde_json::from_slice(&bytes).unwrap_or_default(),
        _ => HashMap::new(),
    }
}

/// The script a favorite runs, read from its project: the page's block, or the script file.
pub(crate) fn read_source(root: &Path, source: &FavoriteSource) -> Result<String, String> {
    match source {
        FavoriteSource::Page {
            page,
            index,
            text,
            count,
        } => {
            let file = format!("{}/{}.md", PAGES_FOLDER, page);
            let markdown = read_project_file(root, &file).map_err(|_| {
                String::from(
                    "This favorite's page is gone. Choose the script again from another page.",
                )
            })?;
            let blocks = page_blocks(&markdown);
            Ok(pick_block(&blocks, *index, text, *count)?.text.clone())
        }
        FavoriteSource::File { path } => read_project_file(root, path),
    }
}

/// The scripts a favorite can be made from in the open project: the PowerShell blocks on the page shown, when it is
/// one of the project's pages, and the project's script files.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Candidates {
    pub project: String,
    pub page: Option<String>,
    pub blocks: Vec<PageBlock>,
    pub files: Vec<String>,
}

#[tauri::command]
pub(crate) async fn favorite_candidates(
    project_state: State<'_, CurrentProject>,
    page: Option<String>,
) -> Result<Candidates, String> {
    let path = {
        let open = project_state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if open.path.is_empty() {
            return Err(String::from("Open a project to add its scripts."));
        }
        open.path.clone()
    };
    let page = page.filter(|id| safe_relative_path(id).is_ok() && !id.contains('/'));
    let root = PathBuf::from(&path);
    let page_id = page.clone();
    task::spawn_blocking(move || {
        let blocks = page_id
            .as_ref()
            .and_then(|id| read_project_file(&root, &format!("{}/{}.md", PAGES_FOLDER, id)).ok())
            .map(|markdown| page_blocks(&markdown))
            .unwrap_or_default();
        let mut files = Vec::new();
        collect_scripts(&root, &mut files);
        files.sort_by_key(|file| file.to_lowercase());
        Candidates {
            project: path,
            page,
            blocks,
            files,
        }
    })
    .await
    .map_err(|err| format!("{}", err))
}

/// A favorite's script as it is now, for its tooltip and its parameters.
#[tauri::command]
pub(crate) async fn favorite_script(
    projects: State<'_, SharedProjects>,
    project: String,
    source: FavoriteSource,
) -> Result<String, String> {
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .clone();
    let root = PathBuf::from(saved_project(&known, &project)?.path);
    task::spawn_blocking(move || read_source(&root, &source))
        .await
        .map_err(|err| format!("{}", err))?
}

/// Runs a favorite in the project it came from, once that project is trusted to run its scripts.
#[tauri::command]
pub(crate) async fn run_favorite(
    app_handle: AppHandle,
    project_state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    app_state: State<'_, SharedAppData>,
    favorite: FavoriteRun,
) -> Result<RunInfo, String> {
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .clone();
    let project = saved_project(&known, &favorite.project)?;
    let global = app_state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .data
        .clone();
    if !is_trusted(&global, &project.path) {
        return Err(format!(
            "{} is not trusted to run its scripts yet. Open it and run one of its scripts to trust it.",
            project.name
        ));
    }
    let root = PathBuf::from(&project.path);
    let source = favorite.source.clone();
    let script = task::spawn_blocking(move || read_source(&root, &source))
        .await
        .map_err(|err| format!("{}", err))??;
    let project_data = project_values(&app_handle, &project_state, &project.path).await;
    let switches: HashMap<String, Value> = SCOPE_SWITCHES
        .iter()
        .filter_map(|key| {
            global
                .get(*key)
                .map(|value| (key.to_string(), value.clone()))
        })
        .collect();
    let (empty_page, empty_project) = (Map::new(), HashMap::new());
    let (page, project_scope, global_scope) = scoped(
        favorite.scopes,
        &favorite.page_values,
        &project_data,
        &global,
        &empty_page,
        &empty_project,
        &switches,
    );
    let data = Values {
        overrides: None,
        page,
        project: project_scope,
        global: global_scope,
    };
    let terminal = match &favorite.source {
        FavoriteSource::File { path } => path.clone(),
        FavoriteSource::Page { .. } => {
            let name = favorite.name.trim();
            if name.is_empty() {
                format!("Favorite {}", favorite.id)
            } else {
                format!("Favorite: {}", name)
            }
        }
    };
    let request = match &favorite.source {
        FavoriteSource::File { .. } => RunRequest {
            terminal_id: terminal,
            script_content: script,
            args: file_args(&favorite.params, &data),
            in_separate_window: false,
            is_page_script: false,
            display_script: None,
            cols: None,
            rows: None,
            content_only: false,
        },
        FavoriteSource::Page { .. } => {
            let overrides = page_overrides(&favorite.params, &data);
            let values = Values {
                overrides: Some(&overrides),
                ..data
            };
            RunRequest {
                terminal_id: terminal,
                script_content: fill_script(&script, &values, false),
                args: Vec::new(),
                in_separate_window: false,
                is_page_script: true,
                display_script: Some(fill_script(&script, &values, true)),
                cols: None,
                rows: None,
                content_only: true,
            }
        }
    };
    let target = runs::run_target(&project_state, &projects, Some(&project.path))?;
    runs::start_now(&app_handle, &target, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const PAGE: &str = "# Setup\n\nInstall the tools\n\n```pwsh\nnpm install\n```\n\n## Build\n\n<webui-page-segment>\n\nBuild it **all**\n\n```powershell\n$target = 'debug'\ncargo build --$target\n```\n\n</webui-page-segment>\n\n```js\nnot a script\n```\n";

    fn map(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn a_pages_powershell_blocks_are_found_in_order_and_named_by_the_text_above_them() {
        let blocks = page_blocks(PAGE);
        assert_eq!(
            blocks,
            vec![
                PageBlock {
                    text: "npm install\n".into(),
                    label: "Install the tools".into()
                },
                PageBlock {
                    text: "$target = 'debug'\ncargo build --$target\n".into(),
                    label: "Build it all".into()
                },
            ]
        );
    }

    #[test]
    fn a_block_is_found_where_it_was_where_it_moved_or_where_it_was_edited() {
        let blocks = |texts: &[&str]| {
            texts
                .iter()
                .map(|text| PageBlock {
                    text: text.to_string(),
                    label: String::new(),
                })
                .collect::<Vec<_>>()
        };
        // Unchanged.
        assert_eq!(
            pick_block(&blocks(&["a", "b"]), 1, "b", None).unwrap().text,
            "b"
        );
        // Moved: a block was added before it, so it is found by its text.
        assert_eq!(
            pick_block(&blocks(&["new", "a", "b"]), 1, "b", None)
                .unwrap()
                .text,
            "b"
        );
        // Edited in place, with as many blocks as before.
        assert_eq!(
            pick_block(&blocks(&["a", "b2"]), 1, "b", Some(2))
                .unwrap()
                .text,
            "b2"
        );
        // Removed: no block has its place any more.
        assert!(pick_block(&blocks(&["a"]), 1, "b", None).is_err());
        // Edited, and blocks were added or removed too, so its place may now be another script.
        assert!(pick_block(&blocks(&["x", "a", "b2"]), 1, "b", Some(2)).is_err());
        // Two blocks with its text cannot tell which it was, unless one is at its place.
        assert!(pick_block(&blocks(&["b", "x", "b"]), 1, "b", Some(2)).is_err());
        assert_eq!(
            pick_block(&blocks(&["x", "b", "b"]), 1, "b", None)
                .unwrap()
                .text,
            "b"
        );
    }

    fn param(
        name: &str,
        from_data: bool,
        value: Value,
        key: Option<&str>,
        switch: bool,
    ) -> FavoriteParam {
        FavoriteParam {
            name: name.into(),
            from_data,
            value,
            key: key.map(String::from),
            switch,
        }
    }

    #[test]
    fn file_parameters_become_arguments_from_fixed_values_or_data() {
        let page = Map::new();
        let project = map(json!({ "env": "staging", "count": 3 }));
        let global = map(json!({ "region": "us-east" }));
        let values = Values {
            overrides: None,
            page: &page,
            project: &project,
            global: &global,
        };
        let params = vec![
            param("Name", false, json!("web"), None, false),
            param("Env", true, Value::Null, Some("env"), false),
            param("Region", true, Value::Null, None, false),
            param("Count", true, Value::Null, Some("count"), false),
            param("Missing", true, Value::Null, Some("nothing"), false),
            param("Empty", false, json!(""), None, false),
            param("Force", false, json!(true), None, true),
            param("Quiet", false, json!(false), None, true),
        ];
        assert_eq!(
            file_args(&params, &values),
            ["-Name", "web", "-Env", "staging", "-Count", "3", "-Force"]
                .map(String::from)
                .to_vec()
        );
    }

    #[test]
    fn a_favorites_scopes_leave_out_the_data_it_does_not_allow_but_keep_the_apps_switches() {
        let page_values = json!({ "who": "page" }).as_object().unwrap().clone();
        let project = map(json!({ "who": "project" }));
        let global = map(json!({ "who": "global", "app-env-project-enabled": false }));
        let switches = map(json!({ "app-env-project-enabled": false }));
        let (empty_page, empty_project) = (Map::new(), HashMap::new());
        let lookup = |allowed: FavoriteScopes| {
            let (page, project, global) = scoped(
                allowed,
                &page_values,
                &project,
                &global,
                &empty_page,
                &empty_project,
                &switches,
            );
            Values {
                overrides: None,
                page,
                project,
                global,
            }
            .lookup("who")
            .cloned()
        };
        assert_eq!(lookup(FavoriteScopes::default()), Some(json!("page")));
        // The app has the project scope switched off, so global comes next.
        assert_eq!(
            lookup(FavoriteScopes {
                page: false,
                ..Default::default()
            }),
            Some(json!("global"))
        );
        assert_eq!(
            lookup(FavoriteScopes {
                page: false,
                project: true,
                global: false
            }),
            None
        );
    }

    #[test]
    fn a_page_scripts_fixed_parameters_come_before_every_scope() {
        let page = json!({ "target": "from-page" })
            .as_object()
            .unwrap()
            .clone();
        let (project, global) = (map(json!({ "other": "project" })), HashMap::new());
        let data = Values {
            overrides: None,
            page: &page,
            project: &project,
            global: &global,
        };
        let params = vec![
            param("target", false, json!("release"), None, false),
            param("other", true, Value::Null, None, false),
        ];
        let overrides = page_overrides(&params, &data);
        let values = Values {
            overrides: Some(&overrides),
            ..data
        };
        let script = "$target = 'debug'\n$other = 'x'\ncargo build --$target";
        assert_eq!(
            fill_script(script, &values, false),
            "$target = 'release'\n$other = 'project'\ncargo build --$target"
        );
    }

    #[test]
    fn a_favorite_reads_its_pages_block_or_its_file_and_says_when_either_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(PAGES_FOLDER)).unwrap();
        fs::write(dir.path().join(PAGES_FOLDER).join("p1.md"), PAGE).unwrap();
        fs::write(
            dir.path().join("deploy.ps1"),
            "param($Env)\nWrite-Host $Env\n",
        )
        .unwrap();
        let page = |index: usize, text: &str| FavoriteSource::Page {
            page: "p1".into(),
            index,
            text: text.into(),
            count: Some(2),
        };
        assert_eq!(
            read_source(dir.path(), &page(0, "npm install\n")).unwrap(),
            "npm install\n"
        );
        // Edited in place, with as many scripts on the page as before.
        assert_eq!(
            read_source(dir.path(), &page(0, "npm ci\n")).unwrap(),
            "npm install\n"
        );
        assert!(
            read_source(dir.path(), &page(5, "gone\n"))
                .unwrap_err()
                .contains("no longer on its page")
        );
        let missing = FavoriteSource::Page {
            page: "nope".into(),
            index: 0,
            text: String::new(),
            count: None,
        };
        assert!(
            read_source(dir.path(), &missing)
                .unwrap_err()
                .contains("page is gone")
        );
        assert_eq!(
            read_source(
                dir.path(),
                &FavoriteSource::File {
                    path: "deploy.ps1".into()
                }
            )
            .unwrap(),
            "param($Env)\nWrite-Host $Env\n"
        );
        assert!(
            read_source(
                dir.path(),
                &FavoriteSource::File {
                    path: "../outside.ps1".into()
                }
            )
            .is_err()
        );
    }

    #[test]
    fn a_favorite_belongs_to_a_saved_project_named_with_either_slash_and_any_case() {
        let known = vec![Project::new("Api", "C:/Work/Api")];
        assert_eq!(saved_project(&known, "c:\\work\\api").unwrap().name, "Api");
        assert!(saved_project(&known, "C:/Work/Other").is_err());
    }

    #[test]
    fn sources_are_read_from_the_windows_shapes() {
        let page: FavoriteSource = serde_json::from_value(
            json!({ "kind": "page", "page": "p1", "index": 2, "text": "x" }),
        )
        .unwrap();
        assert_eq!(
            page,
            FavoriteSource::Page {
                page: "p1".into(),
                index: 2,
                text: "x".into(),
                count: None
            }
        );
        let file: FavoriteSource =
            serde_json::from_value(json!({ "kind": "file", "path": "a.ps1" })).unwrap();
        assert_eq!(
            file,
            FavoriteSource::File {
                path: "a.ps1".into()
            }
        );
        let scopes: FavoriteScopes = serde_json::from_value(json!({ "page": false })).unwrap();
        assert_eq!(
            scopes,
            FavoriteScopes {
                page: false,
                project: true,
                global: true
            }
        );
    }
}
