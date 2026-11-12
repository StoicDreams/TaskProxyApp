use crate::prelude::*;
use background::background_tasks;
use std::sync::{LazyLock, Mutex};
use std::time::Instant;
use tauri::{Emitter, Manager, WindowEvent};
use tracing_subscriber::EnvFilter;

pub mod appdata;
pub mod background;
pub mod common;
pub mod datatypes;
pub mod errors;
pub mod plugins;
pub mod prelude;
pub mod services;

pub(crate) static PROJECT_LAST_SYNC: LazyLock<Mutex<Option<Instant>>> =
    LazyLock::new(|| Mutex::new(None));
pub(crate) static APP_LAST_SYNC: LazyLock<Mutex<Option<Instant>>> =
    LazyLock::new(|| Mutex::new(None));
const MAIN_WINDOW_LABEL: &str = "taskproxy";
static DID_SAVE_ON_CLOSE: LazyLock<AtomicBool> = LazyLock::new(|| AtomicBool::new(false));

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::new("info").add_directive("keyring=off".parse().unwrap()))
        .init();

    // Setup plugins
    let mut builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_updater::Builder::new()
                .header("Accept", "*/*")
                .unwrap()
                .header("User-Agent", "TauriUpdater/1.0")
                .unwrap()
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init());

    // Setup states
    builder = builder
        .manage(Arc::new(Mutex::new(Vec::<Project>::new())))
        .manage(Arc::new(Mutex::new(TaskProxyData::new())))
        .manage(Arc::new(Mutex::new(ProjectData::new())))
        .manage(Arc::new(Mutex::new(crate::services::EmojiState::default())))
        .manage(crate::services::terminal_controller::TerminalManager::default());

    // Save data on close
    builder = builder.on_window_event(|window, event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let can_close = DID_SAVE_ON_CLOSE.load(Ordering::SeqCst);
            if can_close {
                return;
            }
            DID_SAVE_ON_CLOSE.store(true, Ordering::SeqCst);
            api.prevent_close();
            let window = window.clone();
            println!("Saving data from window close");
            let app_handle = window.app_handle().clone();
            let _ = window.emit(
                "webui-isclosing",
                "Closing, please wait while we save your data!",
            );
            #[cfg(desktop)]
            {
                use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                let _ = app_handle.save_window_state(StateFlags::all());
            }
            let app_data = {
                match app_handle.try_state::<SharedAppData>() {
                    Some(state) => match state.lock() {
                        Ok(data) => Some(data.to_owned()),
                        Err(_) => None,
                    },
                    None => None,
                }
            };
            let project_data = {
                match app_handle.try_state::<CurrentProject>() {
                    Some(state) => match state.lock() {
                        Ok(data) => Some(data.to_owned()),
                        Err(_) => None,
                    },
                    None => None,
                }
            };
            tauri::async_runtime::spawn(async move {
                let save_app_data = async {
                    if let Some(app_data) = app_data {
                        let result = save_app_data_to_local_storage(&app_handle, &app_data).await;
                        println!("{:?}", result);
                    }
                };
                let save_project_data = async {
                    if let Some(project_data) = project_data.filter(|data| !data.id.is_empty()) {
                        let result = persist_project_data(project_data, &app_handle).await;
                        println!("{:?}", result);
                    }
                };
                let (_save_app_result, _save_project_result) =
                    join!(save_app_data, save_project_data);
                println!("Saves complete - Closing window.");
                let _ = window.close();
            });
        }
        _ => {}
    });

    // App setup. Tauri keeps only the last setup hook, so all setup belongs here.
    builder = builder.setup(|app| {
        // Opt-in, because attaching the inspector during startup can hang the page in WebKitGTK.
        // Devtools can still be opened at any time from the page's context menu.
        #[cfg(debug_assertions)]
        if std::env::var_os("TASKPROXY_DEVTOOLS").is_some() {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                window.open_devtools();
            }
        }
        services::terminal_controller::remove_stale_temp_scripts(app.handle());
        // Spawn background task
        let app_handle = app.handle().clone();
        tauri::async_runtime::spawn(background_tasks(app_handle));
        Ok(())
    });

    // Set commands accessible from JavaScript
    builder
        .invoke_handler(tauri::generate_handler![
            plugins::commands::plugin_action,
            plugins::commands::plugin_branch_info,
            plugins::commands::plugin_catalog,
            plugins::commands::plugin_host_action,
            plugins::commands::plugin_inspect_folder,
            plugins::commands::plugin_install_catalog,
            plugins::commands::plugin_install_folder,
            plugins::commands::plugin_list,
            plugins::commands::plugin_remove,
            plugins::commands::plugin_render,
            plugins::commands::plugin_save_settings,
            plugins::commands::plugin_settings,
            plugins::commands::plugin_set_enabled,
            appdata::delete_securitykey,
            appdata::get_app_data,
            appdata::has_securitykey,
            appdata::save_app_data,
            appdata::set_securitykey,
            appdata::sync_app_data,
            services::emojis::init_emoji_search,
            services::emojis::search_emojis,
            services::git_controller::get_git_changes,
            services::git_controller::get_project_git_status,
            services::git_controller::get_git_repo_status,
            services::ci_status::get_project_ci_status,
            services::ci_status::get_git_repo_ci_status,
            services::git_controller::fetch_project_remotes,
            services::git_controller::get_git_change_stats,
            services::git_controller::get_git_file_diff,
            services::git_controller::get_git_repos,
            services::git_controller::git_commit,
            services::git_controller::git_pull,
            services::git_controller::git_pull_overwrite,
            services::git_controller::git_push,
            services::git_controller::git_sync,
            services::git_controller::get_git_branches,
            services::git_controller::git_switch_branch,
            services::git_controller::git_create_branch,
            services::git_controller::git_delete_branch,
            services::git_controller::git_merge_branch,
            services::git_controller::get_git_remote_status,
            services::git_controller::git_fetch,
            services::git_controller::git_stash,
            services::git_controller::git_stash_pop,
            services::git_controller::git_delete_file,
            services::git_controller::git_restore_file,
            services::git_controller::git_restore_all,
            services::projects::greet,
            services::projects::add_project,
            services::projects::add_projects_multi,
            services::projects::get_project_data,
            services::projects::get_project_file,
            services::projects::get_project_file_base64,
            services::projects::get_projects,
            services::projects::load_projects,
            services::projects::rename_project,
            services::projects::remove_project,
            services::projects::save_project_data,
            services::projects::clear_current_project,
            services::projects::reload_project_files,
            services::projects::save_project_file,
            services::projects::search_project_files,
            services::projects::sync_project_data,
            services::script_controller::get_scripts,
            services::terminal_controller::start_script,
            services::terminal_controller::kill_script,
            services::terminal_controller::write_terminal_input,
            services::terminal_controller::resize_terminal,
            services::terminal_controller::kill_all_scripts,
            services::terminal_controller::get_powershell_status,
            services::terminal_controller::auto_install_powershell,
            services::updates::get_version,
            services::updates::check_update,
            services::updates::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Exiting skips destructors, which would leave scripts and temp files behind.
                let manager = app_handle
                    .state::<services::terminal_controller::TerminalManager>()
                    .processes
                    .clone();
                tauri::async_runtime::block_on(services::terminal_controller::shutdown(manager));
            }
        });
}
