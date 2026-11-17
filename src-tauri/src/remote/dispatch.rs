//! The commands a remote device may send, the level each needs, and how each runs.
//!
//! Each entry in `remote_commands!` calls the window's command of the same name with the app's state, reading the
//! camelCase arguments the window would send. Some add what a device needs and the window does not:
//! - what they return has secrets replaced by the marker (`secrets.rs`)
//! - scripts and commit scripts run only in trusted projects, and trusting a project is for the desktop alone
//! - a change can't make a secret variable readable, or trust a project
//!
//! Every command registered in `lib.rs` is here or in `DESKTOP_ONLY`, which a test checks.

use super::devices::Level;
use crate::prelude::*;
use crate::services::secrets::{keeps_secrets, redact_app_data, redact_project_data, secret_keys};
use crate::services::shared_data::DataPatch;
use crate::services::{
    ci_status, commit_queue, emojis, git_controller, myfi, page_scripts, projects, runs,
    script_controller, shared_data, task_manager, terminal_controller,
};
use serde_json::Map;

/// The device sending a command.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Caller {
    pub device_id: String,
    pub name: String,
    pub level: Level,
}

/// Commands only the desktop's own window may use: they change security, install things, pair devices, sign in,
/// or need the desktop's screen, such as choosing a folder. Opening and closing projects are here until the
/// desktop's window can follow a project changed elsewhere.
pub(crate) const DESKTOP_ONLY: &[&str] = &[
    "has_securitykey",
    "set_securitykey",
    "delete_securitykey",
    "save_app_data",
    "save_project_data",
    "add_project",
    "add_projects_multi",
    "remove_project",
    "clear_current_project",
    "greet",
    // Previews stream from 127.0.0.1, which a device can't reach. Phase 2 sends files over the connection.
    "get_file_server_base",
    "auto_install_powershell",
    "get_version",
    "check_update",
    "install_update",
    "myfi_sign_in_start",
    "myfi_sign_in_wait",
    // Pairing devices and changing what they may do. A device will get its own remote_continue, capped at its level.
    "remote_status",
    "remote_set_enabled",
    "remote_invite",
    "remote_invite_cancel",
    "remote_device_update",
    "remote_device_remove",
    "remote_device_disconnect",
    "remote_log",
    "remote_settings",
    "myfi_sign_in_cancel",
    "myfi_sign_out",
    "plugin_install_catalog",
    "plugin_install_folder",
    "plugin_inspect_folder",
    "plugin_remove",
    "plugin_set_enabled",
];

/// App data a device may never change: which projects may run scripts.
const DESKTOP_ONLY_KEYS: &[&str] = &[page_scripts::TRUSTED_PROJECTS];

/// A command's arguments, as the window sends them: an object with camelCase names.
pub(crate) struct Args(Map<String, Value>);

impl Args {
    pub(crate) fn new(value: Value) -> Result<Self, String> {
        match value {
            Value::Null => Ok(Self(Map::new())),
            Value::Object(map) => Ok(Self(map)),
            _ => Err(String::from("A command's arguments must be an object.")),
        }
    }

    /// An argument. One that is missing reads as null, so an optional one is None.
    fn get<T: DeserializeOwned>(&self, name: &str) -> Result<T, String> {
        let value = self.0.get(name).cloned().unwrap_or(Value::Null);
        serde_json::from_value(value)
            .map_err(|err| format!("The argument '{}' is not right: {}", name, err))
    }
}

fn reply<T: Serialize>(result: Result<T, String>) -> Result<Value, String> {
    result.and_then(|value| serde_json::to_value(value).map_err(|err| err.to_string()))
}

macro_rules! remote_commands {
    (|$app:ident, $caller:ident, $a:ident| $($level:ident $name:ident => $body:expr;)*) => {
        /// Every command a device may send, and the level it needs.
        pub(crate) const COMMANDS: &[(&str, Level)] = &[$((stringify!($name), Level::$level)),*];

        /// Runs a command that `allowed` let through.
        #[allow(unused_variables)]
        async fn run($app: &AppHandle, $caller: &Caller, name: &str, $a: &Args) -> Result<Value, String> {
            match name {
                $(stringify!($name) => reply($body),)*
                _ => Err(format!("Task Proxy has no command '{}'.", name)),
            }
        }
    };
}

remote_commands! {
    |app, caller, a|
    // View: look, without changing anything.
    View get_app_data => crate::appdata::get_app_data(app.clone(), app.state()).await.map(|data| redact_app_data(&data));
    View get_projects => projects::get_projects(app.state());
    View load_projects => projects::load_projects(app.state(), app.clone()).await;
    View get_project_data => current_project(app, a.get::<Project>("project")?);
    View reload_project_files => match projects::reload_project_files(app.state()).await {
        Ok(project) => Ok(redact_project_data(&project, &global_definitions(app)?)),
        Err(err) => Err(err),
    };
    View get_project_file => projects::get_project_file(app.state(), a.get("filePath")?).await;
    View get_project_file_size => projects::get_project_file_size(app.state(), a.get("filePath")?).await;
    View search_project_files => projects::search_project_files(app.state(), a.get("filter")?, a.get("display")?).await;
    View get_scripts => script_controller::get_scripts(app.state()).await;
    View get_runs => runs::get_runs(app.state());
    View get_run_output => runs::get_run_output(
        app.state(), app.state(), a.get("terminalId")?, a.get("projectId")?, a.get("run")?, a.get("since")?,
    );
    View commit_jobs => commit_queue::commit_jobs(app.state());
    View page_script_preview => page_scripts::page_script_preview(app.state(), app.state(), a.get("script")?, a.get("pageValues")?);
    View get_git_changes => git_controller::get_git_changes(a.get("path")?, a.get("project")?, app.state(), app.state()).await;
    View get_project_git_status => git_controller::get_project_git_status(a.get("currentRepo")?, app.clone(), app.state(), app.state()).await;
    View get_git_repo_status => git_controller::get_git_repo_status(app.state()).await;
    View get_project_ci_status => ci_status::get_project_ci_status(a.get("currentRepo")?, app.clone(), app.state(), app.state()).await;
    View get_git_repo_ci_status => ci_status::get_git_repo_ci_status(app.clone(), app.state()).await;
    View fetch_project_remotes => git_controller::fetch_project_remotes(app.clone(), app.state(), app.state()).await;
    View get_git_change_stats => git_controller::get_git_change_stats(a.get("repo")?, app.state()).await;
    View get_git_file_diff => git_controller::get_git_file_diff(a.get("repo")?, a.get("file")?, app.state()).await;
    View get_git_repos => git_controller::get_git_repos(app.state()).await;
    View get_git_branches => git_controller::get_git_branches(a.get("repo")?, app.state()).await;
    View get_git_remote_status => git_controller::get_git_remote_status(a.get("repo")?, app.state()).await;
    View git_fetch => git_controller::git_fetch(a.get("repo")?, app.state(), app.clone()).await;
    View list_processes => task_manager::list_processes(app.state(), app.state(), a.get("ports")?).await;
    View close_task_manager => task_manager::close_task_manager(app.state());
    View plugin_list => crate::plugins::commands::plugin_list(app.clone()).await;
    View plugin_catalog => crate::plugins::commands::plugin_catalog().await;
    View plugin_render => crate::plugins::commands::plugin_render(app.clone(), a.get("id")?, a.get("page")?, a.get("params")?).await;
    View plugin_branch_info => crate::plugins::commands::plugin_branch_info(app.clone()).await;
    View plugin_notifications => crate::plugins::commands::plugin_notifications(app.clone()).await;
    View plugin_settings => crate::plugins::commands::plugin_settings(app.clone(), a.get("id")?).await;
    View myfi_account => myfi::myfi_account().await;
    View get_powershell_status => terminal_controller::get_powershell_status().await;
    View init_emoji_search => emojis::init_emoji_search(app.clone(), a.get("supportedEmojis")?, app.state()).await;
    View search_emojis => emojis::search_emojis(app.clone(), a.get("query")?, app.state()).await;

    // Work: edit, set variables, run trusted scripts, type into and stop what runs.
    Work patch_app_data => {
        let patch: DataPatch = a.get("patch")?;
        check_app_patch(app, &patch)?;
        shared_data::patch_app_data(app.clone(), app.state(), app.state(), patch, screen(caller, a)?)
    };
    Work patch_project_data => {
        let patch: DataPatch = a.get("patch")?;
        check_project_patch(app, &patch)?;
        shared_data::patch_project_data(app.clone(), app.state(), app.state(), a.get("id")?, patch, screen(caller, a)?)
    };
    Work save_project_file => projects::save_project_file(app.state(), a.get("filePath")?, a.get("contents")?).await;
    Work rename_project => projects::rename_project(
        app.clone(), app.state(), &a.get::<String>("path")?, &a.get::<String>("newName")?,
    ).await;
    Work run_script => {
        let project: Option<String> = a.get("project")?;
        require_trusted(app, project.as_deref())?;
        runs::run_script(
            app.clone(), app.state(), app.state(), app.state(),
            a.get("terminalId")?, a.get("scriptContent")?, a.get::<Option<Vec<String>>>("args")?.unwrap_or_default(),
            false, a.get("cols")?, a.get("rows")?, project, a.get("queue")?, a.get("isPageScript")?, a.get("displayScript")?,
        ).await
    };
    Work run_page_script => page_scripts::run_page_script(
        app.clone(), app.state(), app.state(), app.state(), a.get("terminalId")?, a.get("script")?, a.get("pageValues")?,
    ).await;
    Work stop_run => runs::stop_run(app.clone(), app.state(), app.state(), app.state(), a.get("terminalId")?, a.get("projectId")?);
    Work kill_all_scripts => runs::kill_all_scripts(app.clone(), app.state(), app.state(), app.state()).await;
    Work clear_run_output => runs::clear_run_output(app.clone(), app.state(), app.state(), a.get("terminalId")?, a.get("projectId")?);
    Work remove_run => runs::remove_run(app.clone(), app.state(), app.state(), a.get("terminalId")?, a.get("projectId")?);
    Work remove_finished_page_scripts => runs::remove_finished_page_scripts(app.clone(), app.state(), app.state());
    Work write_terminal_input => terminal_controller::write_terminal_input(
        app.clone(), a.get("terminalId")?, a.get("data")?, a.get("projectId")?, app.state(), app.state(),
    ).await;
    Work resize_terminal => terminal_controller::resize_terminal(
        a.get("terminalId")?, a.get("cols")?, a.get("rows")?, a.get("projectId")?, app.state(), app.state(),
    ).await;
    Work stop_process => task_manager::stop_process(
        app.state(), a.get("pid")?, a.get("started")?, a.get("children")?, a.get("force")?,
    ).await;
    Work plugin_action => crate::plugins::commands::plugin_action(app.clone(), a.get("id")?, a.get("request")?).await;
    Work plugin_host_action => {
        let action: Value = a.get("action")?;
        check_host_action(caller, &action)?;
        crate::plugins::commands::plugin_host_action(app.clone(), a.get("id")?, action).await
    };
    Work plugin_notification_read => crate::plugins::commands::plugin_notification_read(
        app.clone(), a.get("id")?, a.get("notification")?,
    ).await;
    Work plugin_save_settings => crate::plugins::commands::plugin_save_settings(app.clone(), a.get("id")?, a.get("values")?).await;
    Work plugin_use_sign_in => crate::plugins::commands::plugin_use_sign_in(app.clone(), a.get("id")?, a.get("signIn")?).await;
    Work plugin_use_in_project => crate::plugins::commands::plugin_use_in_project(app.clone(), a.get("id")?, a.get("used")?).await;

    // Commit: change git, the repository's files, and branches.
    Commit commit_enqueue => {
        let project: Option<String> = a.get("project")?;
        let script: Option<commit_queue::JobScript> = a.get("script")?;
        if script.as_ref().is_some_and(|script| !script.content.trim().is_empty()) {
            require_trusted(app, project.as_deref())?;
        }
        commit_queue::commit_enqueue(
            app.clone(), app.state(), app.state(), app.state(), project, a.get("repo")?, a.get("message")?,
            a.get("files")?, a.get::<Option<Vec<String>>>("excluded")?.unwrap_or_default(),
            a.get::<Option<Vec<String>>>("ignored")?.unwrap_or_default(),
            a.get::<Option<bool>>("syncAfter")?.unwrap_or(false), script, a.get::<Option<bool>>("queue")?.unwrap_or(false),
        )
    };
    Commit commit_cancel => commit_queue::commit_cancel(app.clone(), app.state(), app.state(), app.state(), a.get("id")?);
    Commit git_push => git_controller::git_push(a.get("repo")?, a.get("project")?, app.state(), app.state(), app.clone()).await;
    Commit git_pull => git_controller::git_pull(a.get("repo")?, a.get("project")?, app.state(), app.state(), app.clone()).await;
    Commit git_pull_overwrite => git_controller::git_pull_overwrite(a.get("repo")?, app.state(), app.clone()).await;
    Commit git_sync => git_controller::git_sync(a.get("repo")?, a.get("project")?, app.state(), app.state(), app.clone()).await;
    Commit git_switch_branch => git_controller::git_switch_branch(a.get("repo")?, a.get("branch")?, app.state()).await;
    Commit git_create_branch => git_controller::git_create_branch(
        a.get("repo")?, a.get("branch")?, a.get::<Option<String>>("baseBranch")?.unwrap_or_default(), app.state(),
    ).await;
    Commit git_delete_branch => git_controller::git_delete_branch(a.get("repo")?, a.get("branch")?, app.state(), app.clone()).await;
    Commit git_merge_branch => git_controller::git_merge_branch(a.get("repo")?, a.get("branch")?, app.state()).await;
    Commit git_stash => git_controller::git_stash(a.get("repo")?, a.get::<Option<String>>("message")?.unwrap_or_default(), app.state()).await;
    Commit git_stash_pop => git_controller::git_stash_pop(a.get("repo")?, app.state()).await;
    Commit git_restore_file => git_controller::git_restore_file(a.get("repo")?, a.get("file")?, app.state()).await;
    Commit git_delete_file => git_controller::git_delete_file(a.get("repo")?, a.get("file")?, app.state()).await;
    Commit git_restore_all => git_controller::git_restore_all(a.get("repo")?, app.state()).await;
}

/// Whether a device at `level` may send `cmd`, and the level it needs.
pub(crate) fn allowed(level: Level, cmd: &str) -> Result<Level, String> {
    if DESKTOP_ONLY.contains(&cmd) {
        return Err(String::from("Only the desktop can do that."));
    }
    let needed = COMMANDS
        .iter()
        .find(|(name, _)| *name == cmd)
        .map(|(_, needed)| *needed)
        .ok_or_else(|| format!("Task Proxy has no command '{}'.", cmd))?;
    if level < needed {
        return Err(format!(
            "This device can't do that. Raise it to {:?} on the desktop.",
            needed
        ));
    }
    Ok(needed)
}

/// Runs a device's command, if its level allows it.
pub(crate) async fn dispatch(
    app: &AppHandle,
    caller: &Caller,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    allowed(caller.level, cmd)?;
    run(app, caller, cmd, &Args::new(args)?).await
}

/// The screen a device's change comes from, kept apart from the window's, which ignores only its own changes.
fn screen(caller: &Caller, a: &Args) -> Result<String, String> {
    let screen: Option<String> = a.get("screen")?;
    Ok(format!(
        "remote:{}:{}",
        caller.device_id,
        screen.unwrap_or_default()
    ))
}

fn lock<T>(state: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    state
        .lock()
        .map_err(|err| format!("State failure: {}", err))
}

fn global_definitions(app: &AppHandle) -> Result<Vec<String>, String> {
    Ok(lock(&app.state::<SharedAppData>())?.variables.clone())
}

/// The open project's data, redacted. A device can't open another project yet: the desktop's window would not
/// know the project changed.
fn current_project(app: &AppHandle, project: Project) -> Result<ProjectData, String> {
    let current = lock(&app.state::<CurrentProject>())?.clone();
    if current.id.is_empty() || get_hash_code(&project.path.replace('\\', "/")) != current.id {
        return Err(String::from("Open that project on the desktop first."));
    }
    Ok(redact_project_data(&current, &global_definitions(app)?))
}

/// Refuses to run a script in a project the desktop has not trusted.
fn require_trusted(app: &AppHandle, project: Option<&str>) -> Result<(), String> {
    let target = runs::run_target(
        &app.state::<CurrentProject>(),
        &app.state::<SharedProjects>(),
        project,
    )?;
    let state = app.state::<SharedAppData>();
    let app_data = lock(&state)?;
    if page_scripts::is_trusted(&app_data.data, &target.project_path) {
        Ok(())
    } else {
        Err(format!(
            "Trust {} on the desktop before running its scripts from here.",
            target.project_name
        ))
    }
}

fn names_desktop_only_key(patch: &DataPatch) -> bool {
    DESKTOP_ONLY_KEYS.iter().any(|key| {
        patch.set.contains_key(*key) || patch.remove.iter().any(|removed| removed == key)
    })
}

fn check_app_patch(app: &AppHandle, patch: &DataPatch) -> Result<(), String> {
    if names_desktop_only_key(patch) {
        return Err(String::from("Only the desktop can trust a project."));
    }
    if let Some(variables) = patch.fields.get("variables") {
        let after: Vec<String> =
            serde_json::from_value(variables.clone()).map_err(|err| err.to_string())?;
        let project = lock(&app.state::<CurrentProject>())?.variables.clone();
        let before = global_definitions(app)?;
        keeps_secrets(
            &secret_keys(&project, &before),
            &secret_keys(&project, &after),
        )?;
    }
    Ok(())
}

fn check_project_patch(app: &AppHandle, patch: &DataPatch) -> Result<(), String> {
    if let Some(variables) = patch.fields.get("variables") {
        let after: Vec<String> =
            serde_json::from_value(variables.clone()).map_err(|err| err.to_string())?;
        let before = lock(&app.state::<CurrentProject>())?.variables.clone();
        let globals = global_definitions(app)?;
        keeps_secrets(
            &secret_keys(&before, &globals),
            &secret_keys(&after, &globals),
        )?;
    }
    Ok(())
}

/// A plugin's git actions need the Commit level, and links open on the device rather than the desktop.
fn check_host_action(caller: &Caller, action: &Value) -> Result<(), String> {
    let kind = action.get("type").and_then(Value::as_str).unwrap_or("");
    if kind == "openUrl" {
        return Err(String::from("Open the link on this device."));
    }
    if kind.starts_with("git.") && caller.level < Level::Commit {
        return Err(String::from(
            "This device can't change git. Raise it to Commit on the desktop.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// The commands `lib.rs` registers for the window.
    fn registered() -> Vec<String> {
        let source = include_str!("../lib.rs");
        let start = source
            .find("generate_handler![")
            .expect("lib.rs registers its commands");
        let list = &source[start..];
        let list = &list[..list.find(']').unwrap()];
        list.split(',')
            .filter_map(|entry| entry.trim().rsplit("::").next())
            .map(str::trim)
            .filter(|name| !name.is_empty() && !name.contains('['))
            .map(String::from)
            .collect()
    }

    #[test]
    fn every_command_is_remote_or_desktop_only() {
        let registered = registered();
        assert!(registered.len() > 80, "found {} commands", registered.len());
        let remote: HashSet<&str> = COMMANDS.iter().map(|(name, _)| *name).collect();
        let desktop: HashSet<&str> = DESKTOP_ONLY.iter().copied().collect();
        let unplaced: Vec<_> = registered
            .iter()
            .filter(|name| !remote.contains(name.as_str()) && !desktop.contains(name.as_str()))
            .collect();
        assert!(
            unplaced.is_empty(),
            "add these to remote_commands! or DESKTOP_ONLY: {:?}",
            unplaced
        );
        let unknown: Vec<_> = remote
            .union(&desktop)
            .filter(|name| !registered.iter().any(|registered| registered == *name))
            .collect();
        assert!(unknown.is_empty(), "not commands in lib.rs: {:?}", unknown);
        assert!(remote.is_disjoint(&desktop));
        assert_eq!(remote.len(), COMMANDS.len(), "a command is listed twice");
    }

    #[test]
    fn every_command_at_every_level() {
        for (name, needed) in COMMANDS {
            for level in [Level::View, Level::Work, Level::Commit] {
                assert_eq!(
                    allowed(level, name).is_ok(),
                    level >= *needed,
                    "{} at {:?}",
                    name,
                    level
                );
            }
        }
        for name in DESKTOP_ONLY {
            for level in [Level::View, Level::Work, Level::Commit] {
                assert!(
                    allowed(level, name)
                        .unwrap_err()
                        .contains("Only the desktop"),
                    "{}",
                    name
                );
            }
        }
        assert!(allowed(Level::Commit, "no_such_command").is_err());
    }

    #[test]
    fn levels_are_what_the_plan_says() {
        let level = |name: &str| {
            COMMANDS
                .iter()
                .find(|(command, _)| *command == name)
                .unwrap()
                .1
        };
        for name in [
            "get_runs",
            "get_git_file_diff",
            "plugin_render",
            "get_run_output",
            "list_processes",
        ] {
            assert_eq!(level(name), Level::View, "{}", name);
        }
        for name in [
            "patch_project_data",
            "run_page_script",
            "write_terminal_input",
            "stop_process",
            "plugin_action",
        ] {
            assert_eq!(level(name), Level::Work, "{}", name);
        }
        for name in [
            "commit_enqueue",
            "git_push",
            "git_switch_branch",
            "git_stash",
            "git_restore_all",
        ] {
            assert_eq!(level(name), Level::Commit, "{}", name);
        }
        for name in [
            "set_securitykey",
            "install_update",
            "add_project",
            "plugin_install_folder",
            "myfi_sign_out",
        ] {
            assert!(DESKTOP_ONLY.contains(&name), "{}", name);
        }
    }

    /// Commands that return app or project data, which carries variable values, and redact it.
    const REDACTED: &[&str] = &["get_app_data", "get_project_data", "reload_project_files"];
    /// Commands that never return a variable's value. Page script previews and runs show the masked copy. Plugin
    /// settings never send their secrets. A script's output is what the script printed, as on the desktop.
    const NO_VALUES: &[&str] = &[
        "get_projects",
        "load_projects",
        "get_project_file",
        "get_project_file_size",
        "search_project_files",
        "get_scripts",
        "get_runs",
        "get_run_output",
        "commit_jobs",
        "page_script_preview",
        "get_git_changes",
        "get_project_git_status",
        "get_git_repo_status",
        "get_project_ci_status",
        "get_git_repo_ci_status",
        "fetch_project_remotes",
        "get_git_change_stats",
        "get_git_file_diff",
        "get_git_repos",
        "get_git_branches",
        "get_git_remote_status",
        "git_fetch",
        "list_processes",
        "close_task_manager",
        "plugin_list",
        "plugin_catalog",
        "plugin_render",
        "plugin_branch_info",
        "plugin_notifications",
        "plugin_settings",
        "myfi_account",
        "get_powershell_status",
        "init_emoji_search",
        "search_emojis",
        "patch_app_data",
        "patch_project_data",
        "save_project_file",
        "rename_project",
        "run_script",
        "run_page_script",
        "stop_run",
        "kill_all_scripts",
        "clear_run_output",
        "remove_run",
        "remove_finished_page_scripts",
        "write_terminal_input",
        "resize_terminal",
        "stop_process",
        "plugin_action",
        "plugin_host_action",
        "plugin_notification_read",
        "plugin_save_settings",
        "plugin_use_sign_in",
        "plugin_use_in_project",
        "commit_enqueue",
        "commit_cancel",
        "git_push",
        "git_pull",
        "git_pull_overwrite",
        "git_sync",
        "git_switch_branch",
        "git_create_branch",
        "git_delete_branch",
        "git_merge_branch",
        "git_stash",
        "git_stash_pop",
        "git_restore_file",
        "git_delete_file",
        "git_restore_all",
    ];

    #[test]
    fn every_remote_command_redacts_or_never_returns_a_secret() {
        // A new command must be placed in one list, after checking what it returns.
        for (name, _) in COMMANDS {
            let placed = REDACTED.contains(name) as u8 + NO_VALUES.contains(name) as u8;
            assert_eq!(
                placed, 1,
                "{} must be in exactly one of REDACTED and NO_VALUES",
                name
            );
        }
        let source = include_str!("dispatch.rs");
        for name in REDACTED {
            let at = source.find(&format!("View {} =>", name)).unwrap();
            let handler = &source[at..at + source[at..].find(";\n").unwrap()];
            assert!(
                handler.contains("redact") || handler.contains("current_project("),
                "{} must redact",
                name
            );
        }
    }

    #[test]
    fn arguments_are_read_by_name_and_missing_ones_are_none() {
        let args = Args::new(serde_json::json!({ "terminalId": "t", "run": 3 })).unwrap();
        assert_eq!(args.get::<String>("terminalId").unwrap(), "t");
        assert_eq!(args.get::<Option<u64>>("run").unwrap(), Some(3));
        assert_eq!(args.get::<Option<u64>>("since").unwrap(), None);
        assert!(
            args.get::<String>("missing")
                .unwrap_err()
                .contains("missing")
        );
        assert!(Args::new(Value::Null).is_ok());
        assert!(Args::new(serde_json::json!([1])).is_err());
    }

    #[test]
    fn plugin_actions_that_change_git_need_commit_and_links_stay_on_the_device() {
        let caller = |level| Caller {
            device_id: "d".into(),
            name: "Pixel".into(),
            level,
        };
        let branch = serde_json::json!({ "type": "git.createBranch", "name": "x" });
        assert!(check_host_action(&caller(Level::Work), &branch).is_err());
        assert!(check_host_action(&caller(Level::Commit), &branch).is_ok());
        let link = serde_json::json!({ "type": "openUrl", "url": "https://example.com" });
        assert!(check_host_action(&caller(Level::Commit), &link).is_err());
    }

    #[test]
    fn a_patch_cannot_trust_a_project() {
        let patch: DataPatch = serde_json::from_value(
            serde_json::json!({ "set": { "app-trusted-projects": ["/x"] } }),
        )
        .unwrap();
        assert!(names_desktop_only_key(&patch));
        let patch: DataPatch =
            serde_json::from_value(serde_json::json!({ "remove": ["app-trusted-projects"] }))
                .unwrap();
        assert!(names_desktop_only_key(&patch));
        let patch: DataPatch =
            serde_json::from_value(serde_json::json!({ "set": { "region": "eu" } })).unwrap();
        assert!(!names_desktop_only_key(&patch));
    }
}
