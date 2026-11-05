use crate::prelude::*;
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command as AsyncCommand;
use tokio::sync::{mpsc, oneshot};

/// Output lines are sent to the UI in batches, so chatty scripts do not flood it with events.
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(33);
const OUTPUT_BATCH_LIMIT: usize = 1000;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const SEPARATE_WINDOW_CLEANUP_DELAY: Duration = Duration::from_secs(30);
const TEMP_SCRIPT_DIR: &str = "script-tmp";

static PWSH_EXECUTABLE: Mutex<Option<String>> = Mutex::new(None);

pub(crate) struct RunningScript {
    kill: Option<oneshot::Sender<()>>,
    handle: tokio::task::JoinHandle<()>,
}

pub(crate) type ProcessMap = Arc<tokio::sync::Mutex<HashMap<String, RunningScript>>>;

pub(crate) struct TerminalManager {
    pub processes: ProcessMap,
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
struct TerminalLine {
    content: String,
    is_error: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutput {
    project_id: String,
    terminal_id: String,
    lines: Vec<TerminalLine>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalFinished {
    project_id: String,
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

/// Find PowerShell, remembering a positive result because each check starts a new process.
fn resolve_pwsh() -> (bool, String) {
    if let Ok(cached) = PWSH_EXECUTABLE.lock() {
        if let Some(executable) = cached.as_ref() {
            return (true, executable.clone());
        }
    }
    let result = is_pwsh_installed();
    if result.0 {
        if let Ok(mut cached) = PWSH_EXECUTABLE.lock() {
            *cached = Some(result.1.clone());
        }
    }
    result
}

pub(crate) fn is_pwsh_installed() -> (bool, String) {
    let mut candidates = vec!["pwsh"];
    #[cfg(not(target_os = "windows"))]
    {
        candidates.extend(vec![
            "/opt/homebrew/bin/pwsh",
            "/usr/local/bin/pwsh",
            "/usr/bin/pwsh",
            "/snap/bin/pwsh",
        ]);
    }
    candidates.extend(vec!["powershell"]);
    for cmd in candidates {
        if create_command(cmd)
            .arg("-v")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok()
        {
            return (true, cmd.to_string());
        }
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
        .stdin(Stdio::null())
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
    let ((installed, executable), (can_auto_install, install_command, instructions)) =
        task::spawn_blocking(|| (resolve_pwsh(), get_install_info()))
            .await
            .map_err(|e| e.to_string())?;
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
    let (can_auto_install, command, _) = task::spawn_blocking(get_install_info)
        .await
        .map_err(|e| e.to_string())?;
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
            .stdin(Stdio::null())
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

fn script_key(project_id: &str, terminal_id: &str) -> String {
    format!("{}\0{}", project_id, terminal_id)
}

fn current_project_id(project_state: &State<'_, CurrentProject>) -> Result<String, String> {
    let project = project_state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    Ok(project.id.clone())
}

fn decode_line(bytes: &[u8]) -> String {
    let line = bytes.strip_suffix(b"\n").unwrap_or(bytes);
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    String::from_utf8_lossy(line).into_owned()
}

/// Read output by raw bytes, because native tools do not always write valid UTF-8.
async fn pump_lines<R: AsyncRead + Unpin>(
    stream: R,
    is_error: bool,
    lines: mpsc::UnboundedSender<TerminalLine>,
) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = TerminalLine {
                    content: decode_line(&buffer),
                    is_error,
                };
                if lines.send(line).is_err() {
                    break;
                }
            }
        }
    }
}

async fn emit_lines(
    app: AppHandle,
    project_id: String,
    terminal_id: String,
    mut lines: mpsc::UnboundedReceiver<TerminalLine>,
) {
    let mut batch = Vec::new();
    while lines.recv_many(&mut batch, OUTPUT_BATCH_LIMIT).await > 0 {
        let _ = app.emit(
            "terminal-output",
            TerminalOutput {
                project_id: project_id.clone(),
                terminal_id: terminal_id.clone(),
                lines: std::mem::take(&mut batch),
            },
        );
        sleep(OUTPUT_FLUSH_INTERVAL).await;
    }
}

fn temp_script_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(TEMP_SCRIPT_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp script folder: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dir, fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Temp scripts can contain injected secrets, so only the current user may read them.
fn write_private_file(path: &Path, contents: &str) -> io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    io::Write::write_all(&mut options.open(path)?, contents.as_bytes())
}

/// Remove temp scripts left behind if the app did not shut down cleanly.
pub(crate) fn remove_stale_temp_scripts(app_handle: &AppHandle) {
    if let Ok(dir) = temp_script_dir(app_handle) {
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn start_script(
    app_handle: AppHandle,
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    script_content: String,
    args: Vec<String>,
    in_separate_window: bool,
) -> Result<String, String> {
    // Dynamic PowerShell Resolution
    let (installed, executable) = task::spawn_blocking(resolve_pwsh)
        .await
        .map_err(|e| e.to_string())?;
    if !installed {
        return Err("PowerShell is not installed on this system.".into());
    }
    let (project_id, project_path) = {
        let p_state = project_state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if p_state.path.is_empty() {
            return Err("Project not loaded.".into());
        }
        (p_state.id.clone(), p_state.path.clone())
    };
    let key = script_key(&project_id, &terminal_id);
    let mut processes = state.processes.lock().await;
    if processes.contains_key(&key) {
        return Err("Script is already running in this terminal.".into());
    }
    let working_dir = PathBuf::from(&project_path);
    let candidate_path = working_dir.join(&terminal_id);
    let is_existing_file = terminal_id != "live"
        && safe_relative_path(&terminal_id).is_ok()
        && candidate_path.is_file()
        && ensure_inside_root(&working_dir, &candidate_path).is_ok();

    let (script_path, is_temp_file) = if is_existing_file {
        (candidate_path, false)
    } else {
        let temp_dir = temp_script_dir(&app_handle)?;
        let temp_path = if terminal_id == "live" {
            temp_dir.join(format!("taskproxy_live_{}.ps1", Uuid::now_v7().simple()))
        } else {
            let safe_name: String = terminal_id
                .chars()
                .map(|c| {
                    if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let file_name = if safe_name.to_lowercase().ends_with(".ps1") {
                safe_name
            } else {
                format!("{}.ps1", safe_name)
            };
            temp_dir.join(format!(
                "taskproxy_tmp_{}_{}",
                Uuid::now_v7().simple(),
                file_name
            ))
        };
        write_private_file(&temp_path, &script_content)
            .map_err(|e| format!("Failed to write temp script: {}", e))?;
        (temp_path, true)
    };
    if in_separate_window {
        let mut child_opt = None;
        #[cfg(target_os = "windows")]
        {
            let mut cmd = AsyncCommand::new("cmd.exe");
            cmd.arg("/c")
                .arg("start")
                .arg("")
                .arg(&executable)
                .arg("-NoExit")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(&script_path)
                .args(&args)
                .current_dir(&working_dir);
            child_opt = Some(
                cmd.spawn()
                    .map_err(|e| format!("Failed to launch terminal window: {}", e))?,
            );
        }
        #[cfg(target_os = "linux")]
        {
            let terminal_emulators = [
                "konsole",
                "x-terminal-emulator",
                "gnome-terminal",
                "alacritty",
                "kitty",
                "xterm",
            ];
            for term in terminal_emulators {
                let mut cmd = AsyncCommand::new(term);
                cmd.env_remove("LD_LIBRARY_PATH");
                match term {
                    "konsole" => {
                        cmd.arg("-e")
                            .arg(&executable)
                            .arg("-NoExit")
                            .arg("-ExecutionPolicy")
                            .arg("Bypass")
                            .arg("-File")
                            .arg(&script_path)
                            .args(&args);
                    }
                    "gnome-terminal" => {
                        cmd.arg("--")
                            .arg(&executable)
                            .arg("-NoExit")
                            .arg("-ExecutionPolicy")
                            .arg("Bypass")
                            .arg("-File")
                            .arg(&script_path)
                            .args(&args);
                    }
                    _ => {
                        cmd.arg("-e")
                            .arg(&executable)
                            .arg("-NoExit")
                            .arg("-ExecutionPolicy")
                            .arg("Bypass")
                            .arg("-File")
                            .arg(&script_path)
                            .args(&args);
                    }
                }
                cmd.current_dir(&working_dir);
                if let Ok(child) = cmd.spawn() {
                    child_opt = Some(child);
                    break;
                }
            }
            if child_opt.is_none() {
                return Err("Failed to find a supported terminal emulator on Linux (tried konsole, gnome-terminal, etc.).".into());
            }
        }
        #[cfg(target_os = "macos")]
        {
            let work_dir_str = working_dir.to_string_lossy().replace("'", "'\\''");
            let script_str = script_path.to_string_lossy().replace("'", "'\\''");
            let mut escaped_args = String::new();
            for arg in &args {
                escaped_args.push_str(&format!(" \\\"{}\\\"", arg.replace("\"", "\\\"")));
            }
            let apple_script = format!(
                "tell application \"Terminal\"\n\tactivate\n\tdo script \"cd '{}' && '{}' -NoExit -ExecutionPolicy Bypass -File '{}'{}\"\nend tell",
                work_dir_str, executable, script_str, escaped_args
            );
            let mut cmd = AsyncCommand::new("osascript");
            cmd.arg("-e").arg(&apple_script);
            cmd.current_dir(&working_dir);
            child_opt = Some(
                cmd.spawn()
                    .map_err(|e| format!("Failed to launch macOS terminal: {}", e))?,
            );
        }
        if let Some(mut child) = child_opt {
            if is_temp_file {
                let cleanup_path = script_path.clone();
                tokio::spawn(async move {
                    let _ = child.wait().await;
                    sleep(SEPARATE_WINDOW_CLEANUP_DELAY).await;
                    let _ = fs::remove_file(&cleanup_path);
                });
            }
        }
        return Ok("Script launched in separate OS window.".into());
    }
    let std_cmd = create_command(&executable);
    let mut cmd = AsyncCommand::from(std_cmd);
    cmd.arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-File")
        .arg(&script_path)
        .args(&args)
        .current_dir(&working_dir)
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn script: {}", e))?;
    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let (line_tx, line_rx) = mpsc::unbounded_channel();
    let stdout_reader = tokio::spawn(pump_lines(stdout, false, line_tx.clone()));
    let stderr_reader = tokio::spawn(pump_lines(stderr, true, line_tx));
    let mut flusher = tokio::spawn(emit_lines(
        app_handle.clone(),
        project_id.clone(),
        terminal_id.clone(),
        line_rx,
    ));
    let app_wait = app_handle.clone();
    let state_arc = state.processes.clone();
    let path_to_remove = is_temp_file.then(|| script_path.clone());
    let key_wait = key.clone();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let handle = tokio::spawn(async move {
        let _cleanup = path_to_remove.map(TempFileCleanup);
        let status = tokio::select! {
            status = child.wait() => status.ok(),
            _ = kill_rx => {
                let _ = child.kill().await;
                child.wait().await.ok()
            }
        };
        // Let remaining output arrive first. A leftover child process can hold the pipes open.
        if tokio::time::timeout(OUTPUT_DRAIN_TIMEOUT, &mut flusher)
            .await
            .is_err()
        {
            stdout_reader.abort();
            stderr_reader.abort();
            flusher.abort();
        }
        state_arc.lock().await.remove(&key_wait);
        let _ = app_wait.emit(
            "terminal-finished",
            TerminalFinished {
                project_id,
                terminal_id,
                code: status.and_then(|s| s.code()),
            },
        );
    });
    processes.insert(
        key,
        RunningScript {
            kill: Some(kill_tx),
            handle,
        },
    );
    Ok("Script started".into())
}

fn request_kill(script: &mut RunningScript) {
    if let Some(kill) = script.kill.take() {
        let _ = kill.send(());
    }
}

#[tauri::command]
pub(crate) async fn kill_script(
    terminal_id: String,
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let key = script_key(&current_project_id(&project_state)?, &terminal_id);
    let mut processes = state.processes.lock().await;
    if let Some(script) = processes.get_mut(&key) {
        request_kill(script);
        Ok("Process killed".into())
    } else {
        Err("No running process found for this terminal".into())
    }
}

#[tauri::command]
pub(crate) async fn kill_all_scripts(
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let prefix = script_key(&current_project_id(&project_state)?, "");
    let mut processes = state.processes.lock().await;
    for (key, script) in processes.iter_mut() {
        if key.starts_with(&prefix) {
            request_kill(script);
        }
    }
    Ok("All processes killed".into())
}

/// Stop every script and wait for each to clean up its temp file.
pub(crate) async fn shutdown(processes: ProcessMap) {
    let handles: Vec<tokio::task::JoinHandle<()>> = {
        let mut processes = processes.lock().await;
        processes
            .drain()
            .map(|(_, mut script)| {
                request_kill(&mut script);
                script.handle
            })
            .collect()
    };
    for handle in handles {
        let _ = tokio::time::timeout(SHUTDOWN_TIMEOUT, handle).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn output_keeps_flowing_after_invalid_utf8() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let input: &[u8] = b"first\r\nbad \xFF byte\nlast";
        pump_lines(input, true, tx).await;
        let mut lines = Vec::new();
        while let Some(line) = rx.recv().await {
            assert!(line.is_error);
            lines.push(line.content);
        }
        assert_eq!(lines, ["first", "bad \u{FFFD} byte", "last"]);
    }

    #[test]
    fn script_keys_are_separate_per_project() {
        assert_ne!(script_key("a", "build.ps1"), script_key("b", "build.ps1"));
        assert!(script_key("a", "build.ps1").starts_with(&script_key("a", "")));
    }

    #[cfg(unix)]
    #[test]
    fn temp_scripts_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.ps1");
        write_private_file(&path, "secret").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}
