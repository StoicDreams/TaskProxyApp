//! Filling a page's PowerShell block with variable values, and running it.
//!
//! A page's script is filled with the values of its variables: `$name = 'default'` becomes `$name = 'value'`. The
//! values come from the page (values typed or set on it, which the window sends), then the open project, then the
//! global variables, as each scope is switched on. Rust does the filling, so the window, and later a phone, only
//! ever sees the masked copy, with values longer than 6 characters shown as `abc***xyz`. Tokens are never filled in,
//! and neither are names that are app state rather than variables.

use crate::prelude::*;
use crate::services::runs::{self, RunInfo, RunRequest};
use crate::services::secrets;
use regex::Regex;
use serde_json::Map;

/// Variables that hold git tokens, which scripts never get.
const TOKEN_KEYS: [&str; 2] = ["git_pat", "github_pat"];
/// `$null`, `$true`, `$false` and `$_` are PowerShell's own.
const POWERSHELL_VARIABLES: [&str; 4] = ["null", "true", "false", "_"];
pub(crate) const TRUSTED_PROJECTS: &str = "app-trusted-projects";
const PAGE_ENABLED: &str = "app-env-page-enabled";
const PROJECT_ENABLED: &str = "app-env-project-enabled";
const GLOBAL_ENABLED: &str = "app-env-global-enabled";

/// Web UI's `toSnake`: each capital becomes `sep` and its lower case letter, then runs of `-`, `_` and spaces
/// become one `sep`, so `appName` is `app-name` and `AppName` is `-app-name`.
pub(crate) fn to_snake(text: &str, sep: &str) -> String {
    let mut spaced = String::new();
    for c in text.trim().chars() {
        if c.is_ascii_uppercase() {
            spaced.push_str(sep);
            spaced.push(c.to_ascii_lowercase());
        } else {
            spaced.push(c);
        }
    }
    let mut out = String::new();
    let mut in_run = false;
    for c in spaced.chars() {
        if c == '-' || c == '_' || c == ' ' {
            if !in_run {
                out.push_str(sep);
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

/// Names a script cannot be given a value for: tokens, and app state such as `app-name`.
fn never_filled(name: &str) -> bool {
    if TOKEN_KEYS.contains(&name) {
        return true;
    }
    let snake = to_snake(name, "-");
    ["app-", "session-", "page-"]
        .iter()
        .any(|prefix| snake.starts_with(prefix))
}

/// The variables a script uses, in the order they first appear.
pub(crate) fn script_variables(script: &str) -> Vec<String> {
    static VARIABLE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let pattern = VARIABLE.get_or_init(|| Regex::new(r"\$([a-zA-Z_][a-zA-Z0-9_]*)").unwrap());
    let mut names: Vec<String> = Vec::new();
    for found in pattern.captures_iter(script) {
        let name = &found[1];
        if POWERSHELL_VARIABLES.contains(&name.to_lowercase().as_str()) {
            continue;
        }
        if !names.iter().any(|known| known == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// A number written as JavaScript's `Number` reads it, formatted as JavaScript writes it, or None when it is not a
/// finite number, as `'5'`, `' 5 '`, `'1.50'` and `'0x10'` are, and `'abc'` and `'Infinity'` are not.
fn js_number(text: &str) -> Option<String> {
    static DECIMAL: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let decimal = DECIMAL.get_or_init(|| {
        Regex::new(r"^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)$").unwrap()
    });
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let radix = [("0x", 16), ("0o", 8), ("0b", 2)]
        .into_iter()
        .find(|(prefix, _)| lower.starts_with(prefix));
    let number = if let Some((prefix, radix)) = radix {
        let digits = &lower[prefix.len()..];
        if digits.is_empty() {
            return None;
        }
        u128::from_str_radix(digits, radix).ok()? as f64
    } else if decimal.is_match(text) {
        text.parse::<f64>().ok()?
    } else {
        return None;
    };
    if !number.is_finite() {
        return None;
    }
    Some(js_format(number))
}

/// How JavaScript writes a number: whole numbers without a decimal point.
fn js_format(number: f64) -> String {
    if number == 0.0 {
        String::from("0")
    } else if number.fract() == 0.0 && number.abs() < 1e21 {
        format!("{:.0}", number)
    } else {
        format!("{}", number)
    }
}

/// A value as JavaScript's `String` writes it, or None for one that is never filled in: missing, null, empty, or
/// an object or list.
fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(match (number.as_i64(), number.as_u64(), number.as_f64()) {
            (Some(whole), _, _) => whole.to_string(),
            (_, Some(whole), _) => whole.to_string(),
            (_, _, Some(real)) => js_format(real),
            _ => number.to_string(),
        }),
        _ => None,
    }
}

/// Whether a scope is switched on. One never set is on, as the app sets each when it starts.
fn scope_enabled(app: &HashMap<String, Value>, key: &str) -> bool {
    match app.get(key) {
        None => true,
        Some(Value::Bool(on)) => *on,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::Null) => false,
        Some(_) => true,
    }
}

/// Where a script's values come from.
pub(crate) struct Values<'a> {
    /// Values set for this run alone, such as a favorite script's fixed parameters, which come before every scope.
    pub overrides: Option<&'a Map<String, Value>>,
    /// Values typed or set on the page, as the window has them.
    pub page: &'a Map<String, Value>,
    pub project: &'a HashMap<String, Value>,
    /// The global variables and app state.
    pub global: &'a HashMap<String, Value>,
}

impl Values<'_> {
    /// A variable's value, from the first scope that has it: the page, then the project, then global, as each is
    /// switched on. A scope that has it, even as empty, hides the scopes after it.
    pub(crate) fn lookup(&self, name: &str) -> Option<&Value> {
        if never_filled(name) {
            return None;
        }
        if let Some(value) = self.overrides.and_then(|overrides| overrides.get(name)) {
            return Some(value);
        }
        // A page value that is a secret's marker stands for the project or global value it was copied from.
        if scope_enabled(self.global, PAGE_ENABLED)
            && let Some(value) = self
                .page
                .get(name)
                .filter(|value| !secrets::is_marker(value))
        {
            return Some(value);
        }
        if scope_enabled(self.global, PROJECT_ENABLED)
            && let Some(value) = self.project.get(name)
        {
            return Some(value);
        }
        if scope_enabled(self.global, GLOBAL_ENABLED) {
            return self.global.get(name);
        }
        None
    }
}

/// `abc***xyz` for a value longer than 6 characters, so the masked copy hints at it without showing it.
fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= 6 {
        return value.to_string();
    }
    let start: String = chars[..3].iter().collect();
    let end: String = chars[chars.len() - 3..].iter().collect();
    format!("{}***{}", start, end)
}

/// Fills `$name = ...` assignments in a script with the value of `name`. With `masked`, values longer than 6
/// characters are masked, and a value that cannot replace an unquoted one shows as `[INVALID TYPE]`.
///
/// A quoted default is replaced whole, escaped so the value stays literal: `'` and typographic single quotes are
/// doubled inside single quotes, and `` ` ``, `$`, `"` and typographic double quotes get a backtick inside double
/// quotes. An unquoted default is replaced only by a number or `$true`/`$false`.
pub(crate) fn fill_script(script: &str, values: &Values, masked: bool) -> String {
    let mut filled = script.to_string();
    for name in script_variables(script) {
        let Some(value) = values.lookup(&name).and_then(value_text) else {
            continue;
        };
        let name = regex::escape(&name);
        let quoted = Regex::new(&format!(
            r#"(?i)(\${}\s*=\s*)('(?:[^']|'')*'|"(?:[^"`]|`[\s\S]|"")*")"#,
            name
        ))
        .unwrap();
        let unquoted = Regex::new(&format!(r#"(?i)(\${}\s*=\s*)([^'"\s][^\n\r]*)"#, name)).unwrap();
        filled = quoted
            .replace_all(&filled, |found: &regex::Captures| {
                let prefix = &found[1];
                let quote = &found[2][..1];
                let text = if masked {
                    mask(&value)
                } else if quote == "'" {
                    value
                        .chars()
                        .flat_map(|c| {
                            if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}')
                            {
                                vec![c, c]
                            } else {
                                vec![c]
                            }
                        })
                        .collect()
                } else {
                    value
                        .chars()
                        .flat_map(|c| {
                            if matches!(c, '`' | '$' | '"' | '\u{201C}' | '\u{201D}' | '\u{201E}') {
                                vec!['`', c]
                            } else {
                                vec![c]
                            }
                        })
                        .collect()
                };
                format!("{}{}{}{}", prefix, quote, text, quote)
            })
            .into_owned();
        filled = unquoted
            .replace_all(&filled, |found: &regex::Captures| {
                let prefix = &found[1];
                if let Some(number) = js_number(&value) {
                    format!("{}{}", prefix, number)
                } else if value.eq_ignore_ascii_case("true") || value.eq_ignore_ascii_case("false")
                {
                    format!("{}${}", prefix, value.to_lowercase())
                } else if masked {
                    format!("{}[INVALID TYPE]", prefix)
                } else {
                    found[0].to_string()
                }
            })
            .into_owned();
    }
    filled
}

/// Whether the project at `path` is trusted to run its own scripts.
pub(crate) fn is_trusted(global: &HashMap<String, Value>, path: &str) -> bool {
    let normalize = |path: &str| path.replace('\\', "/");
    global
        .get(TRUSTED_PROJECTS)
        .and_then(Value::as_array)
        .is_some_and(|trusted| {
            trusted
                .iter()
                .filter_map(Value::as_str)
                .any(|trusted| normalize(trusted) == normalize(path))
        })
}

/// What a script is filled from: the open project's path and values, and the global values.
struct Current {
    path: String,
    project: HashMap<String, Value>,
    global: HashMap<String, Value>,
}

fn current_values(
    project_state: &CurrentProject,
    app_state: &SharedAppData,
) -> Result<Current, String> {
    let project = project_state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    let app = app_state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    Ok(Current {
        path: project.path.clone(),
        project: project.data.clone(),
        global: app.data.clone(),
    })
}

/// A page's script with the values it would run with, masked, for showing.
#[tauri::command]
pub(crate) fn page_script_preview(
    project_state: State<'_, CurrentProject>,
    app_state: State<'_, SharedAppData>,
    script: String,
    page_values: Option<Map<String, Value>>,
) -> Result<String, String> {
    let Current {
        project, global, ..
    } = current_values(&project_state, &app_state)?;
    let page = page_values.unwrap_or_default();
    Ok(fill_script(
        &script,
        &Values {
            overrides: None,
            page: &page,
            project: &project,
            global: &global,
        },
        true,
    ))
}

/// Runs a page's script in the open project, filled with its values, once the project is trusted to run its own
/// scripts. The Terminal Manager shows the masked copy.
#[tauri::command]
pub(crate) async fn run_page_script(
    app_handle: AppHandle,
    project_state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    app_state: State<'_, SharedAppData>,
    terminal_id: String,
    script: String,
    page_values: Option<Map<String, Value>>,
) -> Result<RunInfo, String> {
    let terminal_id = terminal_id.trim().to_string();
    if terminal_id.is_empty() || terminal_id == "live" {
        return Err(String::from(
            "A page script needs a terminal name of its own.",
        ));
    }
    let Current {
        path,
        project,
        global,
    } = current_values(&project_state, &app_state)?;
    if path.is_empty() {
        return Err(String::from("Project not loaded."));
    }
    if !is_trusted(&global, &path) {
        return Err(String::from(
            "This project is not trusted to run its scripts yet.",
        ));
    }
    let page = page_values.unwrap_or_default();
    let values = Values {
        overrides: None,
        page: &page,
        project: &project,
        global: &global,
    };
    let request = RunRequest {
        terminal_id,
        script_content: fill_script(&script, &values, false),
        args: Vec::new(),
        in_separate_window: false,
        is_page_script: true,
        display_script: Some(fill_script(&script, &values, true)),
        cols: None,
        rows: None,
        content_only: true,
    };
    let target = runs::run_target(&project_state, &projects, None)?;
    runs::start_now(&app_handle, &target, &request).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> HashMap<String, Value> {
        serde_json::from_value(value).unwrap()
    }

    /// Fills `script` with project values, as the page handler's tests set them.
    fn run_with(script: &str, project: Value) -> String {
        filled(script, json!({}), project, json!({}), false)
    }

    fn filled(script: &str, page: Value, project: Value, global: Value, masked: bool) -> String {
        let page: Map<String, Value> = serde_json::from_value(page).unwrap();
        let (project, global) = (map(project), map(global));
        fill_script(
            script,
            &Values {
                overrides: None,
                page: &page,
                project: &project,
                global: &global,
            },
            masked,
        )
    }

    #[test]
    fn to_snake_matches_web_ui() {
        // What webui.toSnake(key, '-') gave for each, read from the live framework.
        for (key, snake) in [
            ("appName", "app-name"),
            ("AppName", "-app-name"),
            ("app_name", "app-name"),
            ("pageTitle", "page-title"),
            ("sessionX", "session-x"),
            ("APPName", "-a-p-p-name"),
            ("appnameX", "appname-x"),
            ("MyVar", "-my-var"),
            ("my_var", "my-var"),
            ("page", "page"),
            ("apple", "apple"),
            ("Session1", "-session1"),
            ("x-app", "x-app"),
            ("App-Name", "-app-name"),
            ("__app", "-app"),
        ] {
            assert_eq!(to_snake(key, "-"), snake, "{}", key);
        }
    }

    #[test]
    fn variables_are_injected_and_others_kept() {
        let script = run_with(
            "$my_var = 'default'\n$other = 'kept'",
            json!({ "my_var": "abcdefghijkl" }),
        );
        assert!(script.contains("$my_var = 'abcdefghijkl'"));
        assert!(script.contains("$other = 'kept'"));
    }

    #[test]
    fn the_masked_copy_shows_long_values_by_their_ends() {
        let masked = filled(
            "$my_var = 'default'",
            json!({}),
            json!({ "my_var": "abcdefghijkl" }),
            json!({}),
            true,
        );
        assert_eq!(masked, "$my_var = 'abc***jkl'");
        // Six characters or fewer are shown as they are.
        let short = filled(
            "$v = 'x'",
            json!({}),
            json!({ "v": "abcdef" }),
            json!({}),
            true,
        );
        assert_eq!(short, "$v = 'abcdef'");
    }

    #[test]
    fn tokens_are_never_injected() {
        for key in ["git_pat", "github_pat"] {
            let script = format!("${} = 'placeholder'", key);
            assert_eq!(run_with(&script, json!({ key: "SECRETTOKEN" })), script);
            assert_eq!(
                filled(
                    &script,
                    json!({ key: "SECRET" }),
                    json!({}),
                    json!({ key: "SECRET" }),
                    false
                ),
                script
            );
        }
    }

    #[test]
    fn app_state_is_never_injected() {
        let script = "$appName = 'mine'\n$pageTitle = 'mine'\n$sessionId = 'mine'";
        let global = json!({ "appName": "Task Proxy", "pageTitle": "Home", "sessionId": "abc" });
        assert_eq!(filled(script, json!({}), json!({}), global, false), script);
        // A name that only looks like app state when written another way still applies.
        assert_eq!(
            run_with("$AppName = 'mine'", json!({ "AppName": "set" })),
            "$AppName = 'set'"
        );
    }

    #[test]
    fn names_shared_with_project_fields_keep_their_value_unless_a_variable_is_set() {
        for name in [
            "name",
            "version",
            "path",
            "id",
            "data",
            "docs",
            "navigation",
            "variables",
            "domain",
            "api",
        ] {
            let script = format!("${} = 'mine'", name);
            assert_eq!(run_with(&script, json!({})), script);
        }
        assert_eq!(
            run_with("$path = 'mine'", json!({ "path": "from-variable" })),
            "$path = 'from-variable'"
        );
    }

    #[test]
    fn values_cannot_break_out_of_single_quoted_strings() {
        let script = run_with("$v = 'x'", json!({ "v": "a'b\u{2019}c; Remove-Item" }));
        assert_eq!(script, "$v = 'a''b\u{2019}\u{2019}c; Remove-Item'");
    }

    #[test]
    fn values_are_literal_inside_double_quoted_strings() {
        let script = run_with(
            "$v = \"x\"",
            json!({ "v": "pa$$word `n $(Get-Date) \"q\u{201D}" }),
        );
        assert_eq!(script, "$v = \"pa`$`$word ``n `$(Get-Date) `\"q`\u{201D}\"");
    }

    #[test]
    fn strings_with_escaped_quotes_are_fully_replaced() {
        let script = run_with(
            "$a = 'it''s old'\n$b = \"say `\"old`\" now\"",
            json!({ "a": "new", "b": "new" }),
        );
        assert_eq!(script, "$a = 'new'\n$b = \"new\"");
    }

    #[test]
    fn numbers_and_booleans_replace_unquoted_values() {
        let script = run_with(
            "$count = 1\n$flag = $false\n$text = 5",
            json!({ "count": "42", "flag": "true", "text": "not a number" }),
        );
        assert_eq!(script, "$count = 42\n$flag = $true\n$text = 5");
        let masked = filled(
            "$text = 5",
            json!({}),
            json!({ "text": "not a number" }),
            json!({}),
            true,
        );
        assert_eq!(masked, "$text = [INVALID TYPE]");
    }

    #[test]
    fn numbers_are_written_as_javascript_writes_them() {
        for (text, number) in [
            ("42", Some("42")),
            (" 7 ", Some("7")),
            ("007", Some("7")),
            ("1.50", Some("1.5")),
            ("-3", Some("-3")),
            ("+5", Some("5")),
            (".5", Some("0.5")),
            ("5.", Some("5")),
            ("1e3", Some("1000")),
            ("0x10", Some("16")),
            ("0b101", Some("5")),
            ("-0", Some("0")),
            ("", None),
            ("   ", None),
            ("abc", None),
            ("1_000", None),
            ("Infinity", None),
            ("inf", None),
            ("NaN", None),
            ("0x", None),
            ("1.2.3", None),
        ] {
            assert_eq!(js_number(text).as_deref(), number, "{:?}", text);
        }
    }

    #[test]
    fn non_string_values_are_written_as_javascript_writes_them() {
        let script = run_with(
            "$a = 0\n$b = 0\n$c = 'x'",
            json!({ "a": 3, "b": true, "c": 2.5 }),
        );
        assert_eq!(script, "$a = 3\n$b = $true\n$c = '2.5'");
        // Objects, lists, null, and empty values leave the default.
        let kept = "$a = 'x'\n$b = 'x'\n$c = 'x'\n$d = 'x'";
        assert_eq!(
            run_with(kept, json!({ "a": {}, "b": [1], "c": null, "d": "" })),
            kept
        );
    }

    #[test]
    fn the_page_then_the_project_then_global_supplies_a_value() {
        let script = "$v = 'x'";
        assert_eq!(
            filled(
                script,
                json!({ "v": "page" }),
                json!({ "v": "project" }),
                json!({ "v": "global" }),
                false
            ),
            "$v = 'page'"
        );
        assert_eq!(
            filled(
                script,
                json!({}),
                json!({ "v": "project" }),
                json!({ "v": "global" }),
                false
            ),
            "$v = 'project'"
        );
        assert_eq!(
            filled(
                script,
                json!({}),
                json!({}),
                json!({ "v": "global" }),
                false
            ),
            "$v = 'global'"
        );
        // A scope that has the value, even empty, hides those after it, as on the page.
        assert_eq!(
            filled(
                script,
                json!({ "v": "" }),
                json!({ "v": "project" }),
                json!({}),
                false
            ),
            script
        );
    }

    #[test]
    fn a_secrets_marker_on_the_page_lets_the_real_value_through() {
        let page = json!({ "token": secrets::marker() });
        assert_eq!(
            filled(
                "$token = 'x'",
                page,
                json!({ "token": "real-value" }),
                json!({}),
                false
            ),
            "$token = 'real-value'"
        );
    }

    #[test]
    fn a_scope_that_is_switched_off_is_skipped() {
        let script = "$v = 'x'";
        let off = |key: &str| json!({ key: false, "v": "global" });
        assert_eq!(
            filled(
                script,
                json!({ "v": "page" }),
                json!({ "v": "project" }),
                off(PAGE_ENABLED),
                false
            ),
            "$v = 'project'"
        );
        assert_eq!(
            filled(
                script,
                json!({}),
                json!({ "v": "project" }),
                off(PROJECT_ENABLED),
                false
            ),
            "$v = 'global'"
        );
        assert_eq!(
            filled(script, json!({}), json!({}), off(GLOBAL_ENABLED), false),
            script
        );
    }

    #[test]
    fn variable_names_are_matched_whatever_their_case() {
        assert_eq!(
            run_with("$Version = '1.0.0'", json!({ "Version": "2.1.0" })),
            "$Version = '2.1.0'"
        );
        // The value is looked up by the name as written, and fills every spelling of it, as PowerShell reads them alike.
        assert_eq!(
            run_with(
                "$VERSION = '1.0.0'\n$version = '1'",
                json!({ "version": "2" })
            ),
            "$VERSION = '2'\n$version = '2'"
        );
    }

    #[test]
    fn a_script_lists_its_own_variables_once() {
        assert_eq!(
            script_variables(
                "$a = 1\n$b = $a + $null\nforeach ($_ in $list) { $true; $FALSE }\n$a"
            ),
            ["a", "b", "list"]
        );
    }

    #[test]
    fn only_a_trusted_project_runs_its_scripts() {
        let global = map(json!({ TRUSTED_PROJECTS: ["/repo", "C:\\work\\app"] }));
        assert!(is_trusted(&global, "/repo"));
        assert!(is_trusted(&global, "C:/work/app"));
        assert!(!is_trusted(&global, "/other"));
        assert!(!is_trusted(&map(json!({})), "/repo"));
    }
}
