use crate::prelude::*;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command as AsyncCommand;

pub(crate) struct TerminalManager {
    pub processes: Arc<tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self {
            processes: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

struct TempFileCleanup(PathBuf);
impl Drop for TempFileCleanup {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    terminal_id: String,
    content: String,
    is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalFinished {
    terminal_id: String,
    code: Option<i32>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PowerShellStatus {
    pub installed: bool,
    pub executable: String,
    pub can_auto_install: bool,
    pub install_command: String,
    pub instructions: String,
}

pub(crate) fn is_pwsh_installed() -> (bool, String) {
    if create_command("pwsh")
        .arg("-v")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return (true, "pwsh".to_string());
    }
    if create_command("powershell")
        .arg("-v")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
    {
        return (true, "powershell".to_string());
    }
    (false, "".to_string())
}

fn is_command_available(cmd: &str) -> bool {
    #[cfg(target_os = "windows")]
    let program = "where";
    #[cfg(not(target_os = "windows"))]
    let program = "which";
    create_command(program)
        .arg(cmd)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn get_install_info() -> (bool, String, String) {
    #[cfg(target_os = "windows")]
    {
        if is_command_available("winget") {
            (true, "winget install --id Microsoft.PowerShell --source winget".to_string(), "We recommend installing PowerShell Core using Winget.\n\nClick the **Install PowerShell** button below to install it automatically.".to_string())
        } else {
            (false, "".to_string(), "Please download and install PowerShell from the [official GitHub releases page](https://github.com/PowerShell/PowerShell/releases).".to_string())
        }
    }
    #[cfg(target_os = "macos")]
    {
        if is_command_available("brew") {
            (true, "brew install --cask powershell".to_string(), "We recommend installing PowerShell using Homebrew.\n\nClick the **Install PowerShell** button below to install it automatically.".to_string())
        } else {
            (false, "".to_string(), "Please download and install the macOS PKG from the [official GitHub releases page](https://github.com/PowerShell/PowerShell/releases) or install Homebrew first.".to_string())
        }
    }
    #[cfg(target_os = "linux")]
    {
        if is_command_available("yay") {
            (true, "yay -S powershell-bin --noconfirm".to_string(), "Since you are on an Arch-based system with `yay`, we can install PowerShell from the AUR.\n\nClick the **Install PowerShell** button below to install it automatically.".to_string())
        } else if is_command_available("paru") {
            (true, "paru -S powershell-bin --noconfirm".to_string(), "Since you are on an Arch-based system with `paru`, we can install PowerShell from the AUR.\n\nClick the **Install PowerShell** button below to install it automatically.".to_string())
        } else if is_command_available("pacman") {
            (false, "".to_string(), "You are on an Arch-based system. Please install an AUR helper like `yay` or `paru`, and then run `yay -S powershell-bin` in your terminal.".to_string())
        } else if is_command_available("apt-get") {
            (false, "".to_string(), "You are on a Debian/Ubuntu-based system. Please run the following command in your terminal manually:\n\n```bash\nsudo apt-get update && sudo apt-get install -y powershell\n```".to_string())
        } else if is_command_available("dnf") {
            (false, "".to_string(), "You are on a Fedora/RHEL-based system. Please run the following command in your terminal manually:\n\n```bash\nsudo dnf install -y powershell\n```".to_string())
        } else {
            (false, "".to_string(), "Please see the [official Microsoft documentation](https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux) for instructions on how to install PowerShell for your specific Linux distribution.".to_string())
        }
    }
}

#[tauri::command]
pub(crate) async fn get_powershell_status() -> Result<PowerShellStatus, String> {
    let (installed, executable) = is_pwsh_installed();
    let (can_auto_install, install_command, instructions) = get_install_info();
    Ok(PowerShellStatus {
        installed,
        executable,
        can_auto_install,
        install_command,
        instructions,
    })
}

#[tauri::command]
pub(crate) async fn auto_install_powershell() -> Result<String, String> {
    let (can_auto_install, command, _) = get_install_info();
    if !can_auto_install || command.is_empty() {
        return Err("Auto-installation is not supported on this system.".into());
    }
    let result = task::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        let (prog, args) = ("cmd", vec!["/c", &command]);
        #[cfg(not(target_os = "windows"))]
        let (prog, args) = ("sh", vec!["-c", &command]);
        create_command(prog)
            .args(args)
            .output()
            .map_err(|e| format!("Failed to run install command: {}", e))
    })
    .await
    .map_err(|e| e.to_string())??;
    if result.status.success() {
        Ok("PowerShell installed successfully. Please refresh the Terminal Manager.".to_string())
    } else {
        Err(format!(
            "Installation failed:\n{}",
            String::from_utf8_lossy(&result.stderr)
        ))
    }
}

#[tauri::command]
pub(crate) async fn start_script(
    app_handle: AppHandle,
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    script_content: String,
) -> Result<String, String> {
    let mut processes = state.processes.lock().await;
    if processes.contains_key(&terminal_id) {
        return Err("Script is already running in this terminal.".into());
    }
    // Dynamic PowerShell Resolution
    let (installed, executable) = is_pwsh_installed();
    if !installed {
        return Err("PowerShell is not installed on this system.".into());
    }
    let project_path = {
        let p_state = project_state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if p_state.path.is_empty() {
            return Err("Project not loaded.".into());
        }
        p_state.path.clone()
    };
    let (script_path, working_dir) = if terminal_id == "live" {
        let mut path = PathBuf::from(&project_path);
        path.push(".taskproxy");
        if !path.exists() {
            let _ = fs::create_dir_all(&path);
        }
        (
            path.join(format!("taskproxy_live_{}.ps1", Uuid::now_v7().simple())),
            PathBuf::from(&project_path),
        )
    } else {
        let mut path = PathBuf::from(&project_path);
        path.push(&terminal_id);
        let parent = path
            .parent()
            .unwrap_or(Path::new(&project_path))
            .to_path_buf();
        if !parent.exists() {
            let _ = fs::create_dir_all(&parent);
        }
        let file_name = path.file_name().unwrap_or_default().to_string_lossy();
        (
            parent.join(format!(
                "taskproxy_tmp_{}_{}",
                Uuid::now_v7().simple(),
                file_name
            )),
            parent,
        )
    };
    fs::write(&script_path, script_content)
        .map_err(|e| format!("Failed to write temp script: {}", e))?;
    let std_cmd = create_command(&executable);
    let mut cmd = AsyncCommand::from(std_cmd);
    cmd.arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-File")
        .arg(&script_path)
        .current_dir(&working_dir)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn script: {}", e))?;
    let stdout = child.stdout.take().expect("Failed to capture stdout");
    let stderr = child.stderr.take().expect("Failed to capture stderr");
    let t_id = terminal_id.clone();
    let app = app_handle.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app.emit(
                "terminal-output",
                TerminalOutput {
                    terminal_id: t_id.clone(),
                    content: line,
                    is_error: false,
                },
            );
        }
    });
    let t_id_err = terminal_id.clone();
    let app_err = app_handle.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = reader.next_line().await {
            let _ = app_err.emit(
                "terminal-output",
                TerminalOutput {
                    terminal_id: t_id_err.clone(),
                    content: line,
                    is_error: true,
                },
            );
        }
    });
    let t_id_wait = terminal_id.clone();
    let app_wait = app_handle.clone();
    let state_arc = state.processes.clone();
    let path_to_remove = script_path.clone();
    let handle = tokio::spawn(async move {
        let _cleanup = TempFileCleanup(path_to_remove);
        let status = child.wait().await.ok();
        let _ = app_wait.emit(
            "terminal-finished",
            TerminalFinished {
                terminal_id: t_id_wait.clone(),
                code: status.and_then(|s| s.code()),
            },
        );
        let mut p = state_arc.lock().await;
        p.remove(&t_id_wait);
    });
    processes.insert(terminal_id, handle);
    Ok("Script started".into())
}

#[tauri::command]
pub(crate) async fn kill_script(
    terminal_id: String,
    state: State<'_, TerminalManager>,
) -> Result<String, String> {
    let mut processes = state.processes.lock().await;
    if let Some(handle) = processes.remove(&terminal_id) {
        handle.abort();
        Ok("Process killed".into())
    } else {
        Err("No running process found for this terminal".into())
    }
}

#[tauri::command]
pub(crate) async fn kill_all_scripts(state: State<'_, TerminalManager>) -> Result<String, String> {
    let mut processes = state.processes.lock().await;
    for (_, handle) in processes.drain() {
        handle.abort();
    }
    Ok("All processes killed".into())
}
