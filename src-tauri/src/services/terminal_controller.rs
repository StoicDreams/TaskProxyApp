use crate::prelude::*;
use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};
use std::io::{Read, Write};
use std::process::Stdio;
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Command as AsyncCommand;
use tokio::sync::{mpsc, oneshot};

/// Output is sent to the UI in batches, so chatty scripts do not flood it with events.
const OUTPUT_FLUSH_INTERVAL: Duration = Duration::from_millis(33);
const OUTPUT_BATCH_LIMIT: usize = 256;
const OUTPUT_READ_SIZE: usize = 16 * 1024;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
/// Used until the Terminal Manager reports the size of its view.
const DEFAULT_COLUMNS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
/// Piped output has no colors of its own, so error lines are colored the way a terminal shows them.
const PIPED_ERROR_START: &str = "\x1b[31m";
const PIPED_ERROR_END: &str = "\x1b[0m";
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
const SEPARATE_WINDOW_CLEANUP_DELAY: Duration = Duration::from_secs(30);
const TEMP_SCRIPT_DIR: &str = "script-tmp";

static PWSH_EXECUTABLE: Mutex<Option<String>> = Mutex::new(None);

pub(crate) struct RunningScript {
    kill: Option<oneshot::Sender<()>>,
    handle: tokio::task::JoinHandle<()>,
    /// Only scripts running in a pseudo-terminal take input and resize.
    pty: Option<Arc<PtyControl>>,
}

/// The pseudo-terminal's side of a running script. Both are dropped when the script ends, which on
/// Windows is what lets the last of its output be read.
struct PtyControl {
    master: std::sync::Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: std::sync::Mutex<Option<Box<dyn Write + Send>>>,
}

impl PtyControl {
    fn close(&self) {
        if let Ok(mut writer) = self.writer.lock() {
            writer.take();
        }
        if let Ok(mut master) = self.master.lock() {
            master.take();
        }
    }
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
struct TerminalData {
    project_id: String,
    terminal_id: String,
    data: String,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScriptStarted {
    message: String,
    /// Whether the script runs in a pseudo-terminal, so it can take input and redraw its output.
    interactive: bool,
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

/// Turns one piped output line into terminal text, coloring error lines red.
fn piped_line_text(bytes: &[u8], is_error: bool) -> String {
    let line = decode_line(bytes);
    if is_error {
        format!("{}{}{}\r\n", PIPED_ERROR_START, line, PIPED_ERROR_END)
    } else {
        format!("{}\r\n", line)
    }
}

/// Read piped output by raw bytes, because native tools do not always write valid UTF-8.
async fn pump_piped<R: AsyncRead + Unpin>(
    stream: R,
    is_error: bool,
    output: mpsc::UnboundedSender<Vec<u8>>,
) {
    let mut reader = BufReader::new(stream);
    let mut buffer = Vec::new();
    loop {
        buffer.clear();
        match reader.read_until(b'\n', &mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if output
                    .send(piped_line_text(&buffer, is_error).into_bytes())
                    .is_err()
                {
                    break;
                }
            }
        }
    }
}

/// Reads a pseudo-terminal on its own thread, since its reader blocks.
fn pump_pty(mut reader: Box<dyn Read + Send>, output: mpsc::UnboundedSender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; OUTPUT_READ_SIZE];
        loop {
            match reader.read(&mut buffer) {
                // Linux reports an error rather than end of file once the script and its children exit.
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    if output.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
}

/// Decodes output that can stop partway through a character. The unfinished end is kept for the next
/// chunk, and bytes that are not UTF-8 become replacement characters.
fn decode_chunk(carry: &mut Vec<u8>, bytes: &[u8]) -> String {
    carry.extend_from_slice(bytes);
    let mut text = String::new();
    loop {
        match std::str::from_utf8(carry) {
            Ok(valid) => {
                text.push_str(valid);
                carry.clear();
                return text;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                text.push_str(std::str::from_utf8(&carry[..valid]).unwrap_or_default());
                match error.error_len() {
                    Some(length) => {
                        text.push('\u{FFFD}');
                        carry.drain(..valid + length);
                    }
                    None => {
                        carry.drain(..valid);
                        return text;
                    }
                }
            }
        }
    }
}

/// Collects output into batches of text, calling `emit` for each.
async fn batch_output<F: Fn(String)>(mut chunks: mpsc::UnboundedReceiver<Vec<u8>>, emit: F) {
    let mut carry = Vec::new();
    let mut batch = Vec::new();
    while chunks.recv_many(&mut batch, OUTPUT_BATCH_LIMIT).await > 0 {
        let mut text = String::new();
        for chunk in batch.drain(..) {
            text.push_str(&decode_chunk(&mut carry, &chunk));
        }
        if !text.is_empty() {
            emit(text);
        }
        sleep(OUTPUT_FLUSH_INTERVAL).await;
    }
    if !carry.is_empty() {
        emit(String::from_utf8_lossy(&carry).into_owned());
    }
}

async fn emit_output(
    app: AppHandle,
    project_id: String,
    terminal_id: String,
    chunks: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    batch_output(chunks, |data| {
        let _ = app.emit(
            "terminal-data",
            TerminalData {
                project_id: project_id.clone(),
                terminal_id: terminal_id.clone(),
                data,
            },
        );
    })
    .await;
}

fn pty_size(cols: Option<u16>, rows: Option<u16>) -> PtySize {
    PtySize {
        cols: cols.filter(|c| *c > 0).unwrap_or(DEFAULT_COLUMNS),
        rows: rows.filter(|r| *r > 0).unwrap_or(DEFAULT_ROWS),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// The pseudo-terminal pieces of a newly started script.
struct PtyProcess {
    child: Box<dyn portable_pty::Child + Send + Sync>,
    reader: Box<dyn Read + Send>,
    control: Arc<PtyControl>,
}

/// Starts a program in a pseudo-terminal, so it behaves as it would in a terminal window.
fn spawn_in_pty(
    program: &str,
    args: &[String],
    working_dir: &Path,
    size: PtySize,
) -> Result<PtyProcess, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|e| format!("Failed to open a terminal: {}", e))?;
    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    cmd.cwd(working_dir);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    #[cfg(target_os = "linux")]
    cmd.env_remove("LD_LIBRARY_PATH");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to start in a terminal: {}", e))?;
    // The script holds its own end now. Keeping this one would stop the output from ever ending.
    drop(pair.slave);
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("Failed to read the terminal: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("Failed to write to the terminal: {}", e))?;
    Ok(PtyProcess {
        child,
        reader,
        control: Arc::new(PtyControl {
            master: std::sync::Mutex::new(Some(pair.master)),
            writer: std::sync::Mutex::new(Some(writer)),
        }),
    })
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

// Tauri fills these in from the frontend and from app state, so they cannot be grouped.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn start_script(
    app_handle: AppHandle,
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    script_content: String,
    args: Vec<String>,
    in_separate_window: bool,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<ScriptStarted, String> {
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

    // Temp scripts can hold secrets, so every way out of here must remove them.
    let mut temp_cleanup = None;
    let script_path = if is_existing_file {
        candidate_path
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
        temp_cleanup = Some(TempFileCleanup(temp_path.clone()));
        temp_path
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
            if let Some(cleanup) = temp_cleanup.take() {
                tokio::spawn(async move {
                    let _ = child.wait().await;
                    sleep(SEPARATE_WINDOW_CLEANUP_DELAY).await;
                    drop(cleanup);
                });
            }
        }
        return Ok(ScriptStarted {
            message: "Script launched in separate OS window.".into(),
            interactive: false,
        });
    }
    let (chunk_tx, chunk_rx) = mpsc::unbounded_channel();
    let mut pwsh_args: Vec<String> = vec![
        "-ExecutionPolicy".into(),
        "Bypass".into(),
        "-NoProfile".into(),
        "-File".into(),
        script_path.to_string_lossy().into_owned(),
    ];
    pwsh_args.extend(args.iter().cloned());
    // A pseudo-terminal lets scripts redraw progress, show colors, and take input. Scripts still run
    // with piped output if one cannot be opened.
    let pty = match spawn_in_pty(&executable, &pwsh_args, &working_dir, pty_size(cols, rows)) {
        Ok(process) => Some(process),
        Err(err) => {
            eprintln!("Running {} without a terminal: {}", terminal_id, err);
            None
        }
    };
    let interactive = pty.is_some();
    let app_wait = app_handle.clone();
    let state_arc = state.processes.clone();
    let key_wait = key.clone();
    let (kill_tx, kill_rx) = oneshot::channel::<()>();
    let mut flusher = tokio::spawn(emit_output(
        app_handle.clone(),
        project_id.clone(),
        terminal_id.clone(),
        chunk_rx,
    ));
    let (handle, control) = if let Some(PtyProcess {
        mut child,
        reader,
        control,
    }) = pty
    {
        pump_pty(reader, chunk_tx);
        let child_id = child.process_id();
        let mut killer = child.clone_killer();
        let control_wait = control.clone();
        let handle = tokio::spawn(async move {
            let _cleanup = temp_cleanup;
            let mut wait = task::spawn_blocking(move || child.wait().ok());
            let status = tokio::select! {
                status = &mut wait => status.ok().flatten(),
                _ = kill_rx => {
                    kill_process_tree(child_id);
                    let _ = killer.kill();
                    wait.await.ok().flatten()
                }
            };
            // Closing the terminal lets the last output be read, and ends it if children still hold it.
            control_wait.close();
            if tokio::time::timeout(OUTPUT_DRAIN_TIMEOUT, &mut flusher)
                .await
                .is_err()
            {
                flusher.abort();
            }
            state_arc.lock().await.remove(&key_wait);
            let code = status.and_then(|s| s.signal().is_none().then(|| s.exit_code() as i32));
            let _ = app_wait.emit(
                "terminal-finished",
                TerminalFinished {
                    project_id,
                    terminal_id,
                    code,
                },
            );
        });
        (handle, Some(control))
    } else {
        let std_cmd = create_command(&executable);
        let mut cmd = AsyncCommand::from(std_cmd);
        cmd.args(&pwsh_args)
            // Nothing can answer a prompt without a terminal, so fail instead of waiting forever.
            .arg("-NonInteractive")
            .current_dir(&working_dir)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(unix)]
        cmd.process_group(0);
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to spawn script: {}", e))?;
        let child_id = child.id();
        let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
        let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
        let stdout_reader = tokio::spawn(pump_piped(stdout, false, chunk_tx.clone()));
        let stderr_reader = tokio::spawn(pump_piped(stderr, true, chunk_tx));
        let handle = tokio::spawn(async move {
            let _cleanup = temp_cleanup;
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                _ = kill_rx => {
                    kill_process_tree(child_id);
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
        (handle, None)
    };
    processes.insert(
        key,
        RunningScript {
            kill: Some(kill_tx),
            handle,
            pty: control,
        },
    );
    Ok(ScriptStarted {
        message: "Script started".into(),
        interactive,
    })
}

async fn running_pty(
    state: &State<'_, TerminalManager>,
    project_state: &State<'_, CurrentProject>,
    terminal_id: &str,
) -> Result<Arc<PtyControl>, String> {
    let key = script_key(&current_project_id(project_state)?, terminal_id);
    let processes = state.processes.lock().await;
    let script = processes
        .get(&key)
        .ok_or("No running process found for this terminal")?;
    script
        .pty
        .clone()
        .ok_or_else(|| "This script is not running in a terminal, so it cannot take input.".into())
}

/// Sends typed input, including control keys such as Ctrl+C, to a running script.
#[tauri::command]
pub(crate) async fn write_terminal_input(
    terminal_id: String,
    data: String,
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
) -> Result<(), String> {
    let control = running_pty(&state, &project_state, &terminal_id).await?;
    task::spawn_blocking(move || {
        let mut writer = control.writer.lock().map_err(|e| e.to_string())?;
        let writer = writer.as_mut().ok_or("The script has finished.")?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|e| format!("Failed to send input: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Tells a running script the terminal's new size, so its output wraps and redraws to fit.
#[tauri::command]
pub(crate) async fn resize_terminal(
    terminal_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
) -> Result<(), String> {
    if cols == 0 || rows == 0 {
        return Ok(());
    }
    let control = running_pty(&state, &project_state, &terminal_id).await?;
    let master = control.master.lock().map_err(|e| e.to_string())?;
    if let Some(master) = master.as_ref() {
        master
            .resize(pty_size(Some(cols), Some(rows)))
            .map_err(|e| format!("Failed to resize the terminal: {}", e))?;
    }
    Ok(())
}

/// A script's own children, such as a dev server, would otherwise keep running after it stops.
fn kill_process_tree(process_id: Option<u32>) {
    let Some(process_id) = process_id else {
        return;
    };
    #[cfg(unix)]
    // Scripts start as the leader of their own process group, so this cannot reach anything else.
    unsafe {
        libc::kill(-(process_id as i32), libc::SIGKILL);
    }
    #[cfg(windows)]
    {
        let _ = create_command("taskkill")
            .args(["/PID", &process_id.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
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
    async fn piped_output_keeps_flowing_after_invalid_utf8() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let input: &[u8] = b"first\r\nbad \xFF byte\nlast";
        pump_piped(input, false, tx).await;
        let mut text = String::new();
        while let Some(chunk) = rx.recv().await {
            text.push_str(&String::from_utf8(chunk).unwrap());
        }
        assert_eq!(text, "first\r\nbad \u{FFFD} byte\r\nlast\r\n");
    }

    #[tokio::test]
    async fn piped_error_lines_are_colored_red() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        pump_piped(&b"oops\n"[..], true, tx).await;
        let chunk = String::from_utf8(rx.recv().await.unwrap()).unwrap();
        assert_eq!(chunk, "\x1b[31moops\x1b[0m\r\n");
    }

    #[test]
    fn a_character_split_between_chunks_is_kept_whole() {
        let mut carry = Vec::new();
        let bytes = "a✓b".as_bytes();
        // ✓ is three bytes, split after its first.
        assert_eq!(decode_chunk(&mut carry, &bytes[..2]), "a");
        assert_eq!(decode_chunk(&mut carry, &bytes[2..]), "✓b");
        assert!(carry.is_empty());
    }

    #[test]
    fn invalid_bytes_become_replacement_characters_without_stopping_output() {
        let mut carry = Vec::new();
        assert_eq!(
            decode_chunk(&mut carry, b"x\xFFy\xFE"),
            "x\u{FFFD}y\u{FFFD}"
        );
        assert!(carry.is_empty());
    }

    #[tokio::test]
    async fn output_is_batched_and_an_unfinished_character_is_flushed_at_the_end() {
        let (tx, rx) = mpsc::unbounded_channel();
        tx.send(b"one ".to_vec()).unwrap();
        tx.send(b"two".to_vec()).unwrap();
        tx.send(vec![0xE2, 0x9C]).unwrap();
        drop(tx);
        let emitted = std::sync::Mutex::new(Vec::new());
        batch_output(rx, |text| emitted.lock().unwrap().push(text)).await;
        assert_eq!(emitted.into_inner().unwrap(), ["one two", "\u{FFFD}"]);
    }

    #[test]
    fn terminal_size_falls_back_to_a_default() {
        let size = pty_size(None, Some(0));
        assert_eq!((size.cols, size.rows), (DEFAULT_COLUMNS, DEFAULT_ROWS));
        let size = pty_size(Some(200), Some(50));
        assert_eq!((size.cols, size.rows), (200, 50));
    }

    /// Runs a shell command in a pseudo-terminal and collects everything it writes.
    #[cfg(unix)]
    async fn run_in_pty(command: &str, input: Option<&str>) -> (String, Option<u32>) {
        let dir = tempfile::tempdir().unwrap();
        let process = spawn_in_pty(
            "sh",
            &["-c".to_string(), command.to_string()],
            dir.path(),
            pty_size(Some(100), Some(20)),
        )
        .unwrap();
        let PtyProcess {
            mut child,
            reader,
            control,
        } = process;
        let (tx, rx) = mpsc::unbounded_channel();
        pump_pty(reader, tx);
        if let Some(input) = input {
            let mut writer = control.writer.lock().unwrap();
            writer
                .as_mut()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        let status = task::spawn_blocking(move || child.wait().ok())
            .await
            .unwrap();
        control.close();
        let collected = std::sync::Mutex::new(String::new());
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            batch_output(rx, |text| collected.lock().unwrap().push_str(&text)),
        )
        .await;
        (
            collected.into_inner().unwrap(),
            status.map(|s| s.exit_code()),
        )
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_pty_script_sees_a_terminal_and_its_colors_arrive_unchanged() {
        let (output, code) = run_in_pty(
            "if [ -t 1 ]; then echo tty; fi; echo \"$TERM\"; printf '\\033[32mgreen\\033[0m\\r\\033[1A'",
            None,
        )
        .await;
        assert!(output.contains("tty"), "{output:?}");
        assert!(output.contains("xterm-256color"), "{output:?}");
        assert!(
            output.contains("\x1b[32mgreen\x1b[0m\r\x1b[1A"),
            "{output:?}"
        );
        assert_eq!(code, Some(0));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_pty_script_reads_typed_input_and_reports_its_exit_code() {
        let (output, code) =
            run_in_pty("read answer; echo \"got $answer\"; exit 3", Some("yes\r")).await;
        assert!(output.contains("got yes"), "{output:?}");
        assert_eq!(code, Some(3));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_pty_script_is_told_its_size_and_when_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let process = spawn_in_pty(
            "sh",
            &["-c".to_string(), "stty size; read _; stty size".to_string()],
            dir.path(),
            pty_size(Some(90), Some(25)),
        )
        .unwrap();
        let PtyProcess {
            mut child,
            reader,
            control,
        } = process;
        let (tx, rx) = mpsc::unbounded_channel();
        pump_pty(reader, tx);
        sleep(Duration::from_millis(200)).await;
        control
            .master
            .lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .resize(pty_size(Some(150), Some(40)))
            .unwrap();
        control
            .writer
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .write_all(b"\r")
            .unwrap();
        task::spawn_blocking(move || child.wait())
            .await
            .unwrap()
            .unwrap();
        control.close();
        let collected = std::sync::Mutex::new(String::new());
        let _ = tokio::time::timeout(
            Duration::from_secs(5),
            batch_output(rx, |text| collected.lock().unwrap().push_str(&text)),
        )
        .await;
        let output = collected.into_inner().unwrap();
        assert!(output.contains("25 90"), "{output:?}");
        assert!(output.contains("40 150"), "{output:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stopping_a_pty_script_also_stops_its_children() {
        let is_alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 };
        let dir = tempfile::tempdir().unwrap();
        let process = spawn_in_pty(
            "sh",
            &[
                "-c".to_string(),
                "sleep 60 & echo \"child=$!\"; wait".to_string(),
            ],
            dir.path(),
            pty_size(None, None),
        )
        .unwrap();
        let PtyProcess {
            mut child,
            reader,
            control,
        } = process;
        let (tx, mut rx) = mpsc::unbounded_channel();
        pump_pty(reader, tx);
        let mut seen = String::new();
        let grandchild: i32 = loop {
            let chunk = tokio::time::timeout(Duration::from_secs(5), rx.recv())
                .await
                .unwrap()
                .unwrap();
            seen.push_str(&String::from_utf8_lossy(&chunk));
            if let Some(rest) = seen.split("child=").nth(1) {
                if let Some(pid) = rest.split_whitespace().next() {
                    if rest.contains('\n') {
                        break pid.parse().unwrap();
                    }
                }
            }
        };
        assert!(is_alive(grandchild));
        kill_process_tree(child.process_id());
        task::spawn_blocking(move || child.wait())
            .await
            .unwrap()
            .unwrap();
        control.close();
        for _ in 0..100 {
            if !is_alive(grandchild) {
                return;
            }
            sleep(Duration::from_millis(20)).await;
        }
        panic!("The script's child process is still running");
    }

    #[test]
    fn script_keys_are_separate_per_project() {
        assert_ne!(script_key("a", "build.ps1"), script_key("b", "build.ps1"));
        assert!(script_key("a", "build.ps1").starts_with(&script_key("a", "")));
    }

    #[test]
    fn line_endings_are_removed() {
        assert_eq!(decode_line(b"a\r\n"), "a");
        assert_eq!(decode_line(b"a\n"), "a");
        assert_eq!(decode_line(b"a"), "a");
        assert_eq!(decode_line(b"\n"), "");
    }

    #[test]
    fn a_temp_script_is_removed_when_its_guard_ends() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.ps1");
        write_private_file(&path, "secret").unwrap();
        drop(TempFileCleanup(path.clone()));
        assert!(!path.exists());
    }

    #[test]
    fn an_existing_temp_script_is_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.ps1");
        write_private_file(&path, "first").unwrap();
        assert!(write_private_file(&path, "second").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "first");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn killing_a_script_also_stops_its_children() {
        let is_alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 };
        let mut cmd = AsyncCommand::new("sh");
        cmd.args(["-c", "sleep 60 & echo $!; wait"])
            .stdout(Stdio::piped())
            .process_group(0);
        let mut child = cmd.spawn().unwrap();
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let grandchild: i32 = line.trim().parse().unwrap();
        assert!(is_alive(grandchild));
        kill_process_tree(child.id());
        child.wait().await.unwrap();
        for _ in 0..100 {
            if !is_alive(grandchild) {
                return;
            }
            sleep(Duration::from_millis(20)).await;
        }
        panic!("The script's child process is still running");
    }

    #[tokio::test]
    async fn shutting_down_stops_scripts_and_empties_the_list() {
        let processes: ProcessMap = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
        let (kill_tx, kill_rx) = oneshot::channel::<()>();
        let (done_tx, done_rx) = oneshot::channel::<()>();
        let handle = tokio::spawn(async move {
            let _ = kill_rx.await;
            let _ = done_tx.send(());
        });
        processes.lock().await.insert(
            script_key("a", "b"),
            RunningScript {
                kill: Some(kill_tx),
                handle,
                pty: None,
            },
        );
        shutdown(processes.clone()).await;
        assert!(done_rx.await.is_ok());
        assert!(processes.lock().await.is_empty());
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
