//! What scripts Task Proxy runs can ask of it, such as opening a terminal in the Terminal Manager rather than a
//! terminal window of its own.
//!
//! Every script Task Proxy runs gets the `TaskProxy` PowerShell module on `PSModulePath`, the address of a local
//! HTTP listener in `TASKPROXY_URL`, and a key in `TASKPROXY_RUN`. The key belongs to that run (`Grant` in
//! `runs.rs`) and stops working when it ends, so only scripts Task Proxy is running can ask, and only for their own
//! project. The listener is on 127.0.0.1, and a request without a known key is refused before anything else is read.
//! A browser cannot send the key header without a preflight, which this never answers.

use crate::prelude::*;
use crate::services::runs::{self, Grant, RunInfo, RunRequest, Runs};
use crate::services::terminal_controller::TerminalManager;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;

/// The module scripts use, written to the app's data folder at startup.
const MODULE: &str = include_str!("../../resources/powershell/TaskProxy/TaskProxy.psm1");
const MODULE_DIR: &str = "ps-modules";
const KEY_HEADER: &str = "x-taskproxy-run";
const MAX_BODY: usize = 64 * 1024;
const MAX_NAME: usize = 80;
/// How long Replace waits for a terminal's command to stop.
const REPLACE_WAIT: Duration = Duration::from_secs(15);

/// `http://127.0.0.1:<port>`, once the listener has started.
static ADDRESS: OnceLock<String> = OnceLock::new();
/// The folder holding the `TaskProxy` module, for `PSModulePath`.
static MODULES: OnceLock<PathBuf> = OnceLock::new();

/// A new key for a run's script.
pub(crate) fn new_key() -> String {
    use rand::RngExt;
    let bytes: [u8; 24] = rand::rng().random();
    hex::encode(bytes)
}

/// The environment a script gets, so it can reach Task Proxy with `key`. Empty when the listener did not start.
pub(crate) fn script_env(key: &str) -> Vec<(String, String)> {
    let (Some(address), Some(modules)) = (ADDRESS.get(), MODULES.get()) else {
        return Vec::new();
    };
    vec![
        ("TASKPROXY_URL".into(), address.clone()),
        ("TASKPROXY_RUN".into(), key.into()),
        (
            "PSModulePath".into(),
            module_path(modules, std::env::var("PSModulePath").ok().as_deref()),
        ),
    ]
}

/// `PSModulePath` with Task Proxy's modules first.
fn module_path(modules: &Path, existing: Option<&str>) -> String {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let ours = modules.to_string_lossy().into_owned();
    match existing.filter(|existing| !existing.is_empty()) {
        Some(existing) => format!("{}{}{}", ours, separator, existing),
        None => ours,
    }
}

/// A request to open a terminal.
#[derive(Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalRequest {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub replace: bool,
}

/// Refuses a request that cannot be run, with why.
fn check(request: &TerminalRequest, grant: &Grant) -> Result<(), String> {
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME {
        return Err(format!(
            "A terminal's name must be 1 to {} characters.",
            MAX_NAME
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(String::from(
            "A terminal's name cannot hold control characters.",
        ));
    }
    if name.eq_ignore_ascii_case("live") {
        return Err(String::from(
            "The live terminal is kept for typed commands.",
        ));
    }
    if name == grant.terminal_id {
        return Err(String::from(
            "A script cannot open a terminal with its own terminal's name.",
        ));
    }
    if request.command.trim().is_empty() {
        return Err(String::from("There is no command to run."));
    }
    Ok(())
}

/// What the terminal runs: the command, in the folder the script asked for.
fn terminal_script(request: &TerminalRequest) -> String {
    match request
        .working_directory
        .as_deref()
        .filter(|folder| !folder.trim().is_empty())
    {
        Some(folder) => format!(
            "Set-Location -LiteralPath '{}'\n{}\n",
            folder.replace('\'', "''"),
            request.command
        ),
        None => format!("{}\n", request.command),
    }
}

/// Gets a terminal ready to run a new command. When its last command still runs, `replace` stops it, with Ctrl+C
/// and then forced as Stop does, and waits up to `wait` for it to end. Without `replace`, it is left running and
/// the request is refused.
async fn clear_terminal(
    runs: &Runs,
    project_id: &str,
    name: &str,
    replace: bool,
    wait: Duration,
    stop: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let ended = {
        let mut store = runs.lock()?;
        let Some(running) = store.running_run(project_id, name) else {
            return Ok(());
        };
        if !replace {
            return Err(format!(
                "The terminal '{}' is still running. Pass -Replace to stop it first.",
                name
            ));
        }
        store.wait(project_id, name, running.run)
    };
    stop()?;
    match tokio::time::timeout(wait, ended).await {
        Ok(_) => Ok(()),
        Err(_) => Err(format!("The terminal '{}' did not stop.", name)),
    }
}

/// Opens the terminal a script asked for, in the project of the run that asked.
async fn open_terminal(
    app: &AppHandle,
    grant: Grant,
    request: TerminalRequest,
) -> Result<RunInfo, String> {
    check(&request, &grant)?;
    let name = request.name.trim().to_string();
    let project_id = grant.target.project_id.clone();
    let runs = app.state::<Runs>();
    clear_terminal(
        &runs,
        &project_id,
        &name,
        request.replace,
        REPLACE_WAIT,
        || {
            runs::stop(
                app,
                &runs,
                &app.state::<TerminalManager>(),
                &project_id,
                &name,
            )
        },
    )
    .await?;
    let script = terminal_script(&request);
    let run = RunRequest {
        terminal_id: name,
        script_content: script.clone(),
        args: Vec::new(),
        in_separate_window: false,
        is_page_script: false,
        display_script: Some(script),
        cols: None,
        rows: None,
        content_only: true,
    };
    runs::start_now(app, &grant.target, &run).await
}

struct Reply {
    status: u16,
    reason: &'static str,
    content_type: &'static str,
    body: String,
}

fn reply(status: u16, reason: &'static str, message: impl Into<String>) -> Reply {
    Reply {
        status,
        reason,
        content_type: "text/plain; charset=utf-8",
        body: message.into(),
    }
}

/// Answers one request. `grant_for` looks up a key, and `open` opens a terminal, so tests need no Tauri app.
fn answer(
    method: &str,
    path: &str,
    key: Option<&str>,
    body: &[u8],
    grant_for: impl Fn(&str) -> Option<Grant>,
    open: impl FnOnce(Grant, TerminalRequest) -> Result<RunInfo, String>,
) -> Reply {
    let Some(grant) = key.and_then(&grant_for) else {
        return reply(
            401,
            "Unauthorized",
            "This only answers scripts Task Proxy is running.",
        );
    };
    if path != "/terminal" {
        return reply(404, "Not Found", "Not found");
    }
    if method != "POST" {
        return reply(405, "Method Not Allowed", "Only POST is supported.");
    }
    let request: TerminalRequest = match serde_json::from_slice(body) {
        Ok(request) => request,
        Err(err) => {
            return reply(
                400,
                "Bad Request",
                format!("The request could not be read: {}", err),
            );
        }
    };
    match open(grant, request) {
        Ok(info) => Reply {
            status: 200,
            reason: "OK",
            content_type: "application/json",
            body: serde_json::json!({ "terminal": info.id, "project": info.project_name, "run": info.run })
                .to_string(),
        },
        Err(message) => reply(409, "Conflict", message),
    }
}

/// Reads one request and answers it.
fn serve_connection(
    mut stream: TcpStream,
    grant_for: impl Fn(&str) -> Option<Grant>,
    open: impl FnOnce(Grant, TerminalRequest) -> Result<RunInfo, String>,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts
        .next()
        .unwrap_or("")
        .split('?')
        .next()
        .unwrap_or("")
        .to_string();
    let mut key = None;
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            let name = name.trim();
            if name.eq_ignore_ascii_case(KEY_HEADER) {
                key = Some(value.trim().to_string());
            } else if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let response = if length > MAX_BODY {
        reply(413, "Payload Too Large", "The request is too large.")
    } else {
        // A request without a known key is answered before its body is read.
        let grant = key.as_deref().and_then(&grant_for);
        let mut body = vec![0; length];
        if grant.is_some() {
            reader.read_exact(&mut body)?;
        }
        answer(
            &method,
            &path,
            key.as_deref(),
            &body,
            |_| grant.clone(),
            open,
        )
    };
    let text = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\nContent-Type: {}\r\nContent-Length: {}\r\nCache-Control: no-store\r\n\r\n{}",
        response.status,
        response.reason,
        response.content_type,
        response.body.len(),
        response.body
    );
    stream.write_all(text.as_bytes())?;
    stream.flush()
}

/// Writes the module where `PSModulePath` will find it.
fn write_module(app: &AppHandle) -> Result<PathBuf, String> {
    let modules = app
        .path()
        .app_local_data_dir()
        .map_err(|err| err.to_string())?
        .join(MODULE_DIR);
    let folder = modules.join("TaskProxy");
    fs::create_dir_all(&folder)
        .map_err(|err| format!("Failed to create the module folder: {}", err))?;
    fs::write(folder.join("TaskProxy.psm1"), MODULE)
        .map_err(|err| format!("Failed to write the TaskProxy module: {}", err))?;
    Ok(modules)
}

/// Starts the listener on a free port. Without it, scripts run as before, just without the module.
pub(crate) fn start(app: AppHandle) -> Result<(), String> {
    let modules = write_module(&app)?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let _ = MODULES.set(modules);
    let _ = ADDRESS.set(format!("http://127.0.0.1:{}", port));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            std::thread::spawn(move || {
                let grant_for = |key: &str| {
                    app.state::<Runs>()
                        .lock()
                        .ok()
                        .and_then(|store| store.grant_for(key))
                };
                let open = |grant, request| {
                    tauri::async_runtime::block_on(open_terminal(&app, grant, request))
                };
                let _ = serve_connection(stream, grant_for, open);
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::runs::{RunStatus, RunTarget};
    use std::sync::mpsc;

    fn grant() -> Grant {
        Grant {
            target: RunTarget {
                project_id: "p1".into(),
                project_path: "/repo".into(),
                project_name: "Repo".into(),
            },
            terminal_id: "opynlocal".into(),
            run: 3,
        }
    }

    fn request(name: &str) -> TerminalRequest {
        TerminalRequest {
            name: name.into(),
            command: "& './run-local-iris.ps1' -nobuild".into(),
            working_directory: None,
            replace: false,
        }
    }

    fn started(name: &str) -> RunInfo {
        RunInfo {
            id: name.into(),
            name: name.into(),
            project_id: "p1".into(),
            project_name: "Repo".into(),
            project_path: "/repo".into(),
            status: RunStatus::Running,
            exit_code: None,
            stopped: false,
            started_at: 0,
            ended_at: None,
            is_page_script: false,
            is_live: false,
            script: String::new(),
            args: Vec::new(),
            interactive: true,
            run: 9,
            rev: 1,
            cleared: 0,
        }
    }

    fn known(key: &str) -> Option<Grant> {
        (key == "good").then(grant)
    }

    #[test]
    fn a_request_without_a_known_key_is_refused_before_anything_runs() {
        let body = br#"{"name":"iris","command":"x"}"#;
        for key in [None, Some("wrong")] {
            let reply = answer("POST", "/terminal", key, body, known, |_, _| {
                panic!("must not open")
            });
            assert_eq!(reply.status, 401);
        }
    }

    #[test]
    fn only_post_to_terminal_is_answered() {
        let body = br#"{"name":"iris","command":"x"}"#;
        assert_eq!(
            answer(
                "GET",
                "/terminal",
                Some("good"),
                body,
                known,
                |_, _| panic!()
            )
            .status,
            405
        );
        assert_eq!(
            answer("POST", "/other", Some("good"), body, known, |_, _| panic!()).status,
            404
        );
        assert_eq!(
            answer(
                "POST",
                "/terminal",
                Some("good"),
                b"not json",
                known,
                |_, _| panic!()
            )
            .status,
            400
        );
    }

    #[test]
    fn a_terminal_opens_in_the_project_of_the_run_that_asked() {
        let body = br#"{"name":"iris","command":"run it","workingDirectory":"/repo/scripts","replace":true}"#;
        let reply = answer(
            "POST",
            "/terminal",
            Some("good"),
            body,
            known,
            |given, request| {
                assert_eq!(given, grant());
                assert_eq!(request.name, "iris");
                assert!(request.replace);
                Ok(started("iris"))
            },
        );
        assert_eq!(reply.status, 200);
        let json: Value = serde_json::from_str(&reply.body).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "terminal": "iris", "project": "Repo", "run": 9 })
        );
    }

    #[test]
    fn why_a_terminal_could_not_open_is_passed_back() {
        let body = br#"{"name":"iris","command":"x"}"#;
        let reply = answer("POST", "/terminal", Some("good"), body, known, |_, _| {
            Err("It is still running.".into())
        });
        assert_eq!(
            (reply.status, reply.body.as_str()),
            (409, "It is still running.")
        );
    }

    #[test]
    fn names_and_commands_are_checked() {
        assert!(check(&request("iris"), &grant()).is_ok());
        for name in [
            "",
            "   ",
            "live",
            "LIVE",
            "opynlocal",
            "bad\nname",
            &"x".repeat(MAX_NAME + 1),
        ] {
            assert!(check(&request(name), &grant()).is_err(), "{:?}", name);
        }
        let mut empty = request("iris");
        empty.command = "  ".into();
        assert!(check(&empty, &grant()).is_err());
    }

    #[test]
    fn the_command_starts_in_the_folder_asked_for() {
        let mut asked = request("iris");
        assert_eq!(
            terminal_script(&asked),
            "& './run-local-iris.ps1' -nobuild\n"
        );
        asked.working_directory = Some("/home/me/it's here".into());
        assert_eq!(
            terminal_script(&asked),
            "Set-Location -LiteralPath '/home/me/it''s here'\n& './run-local-iris.ps1' -nobuild\n"
        );
    }

    #[test]
    fn task_proxys_modules_come_first_on_the_module_path() {
        let ours = Path::new("/data/ps-modules");
        let separator = if cfg!(windows) { ";" } else { ":" };
        assert_eq!(module_path(ours, None), "/data/ps-modules");
        assert_eq!(
            module_path(ours, Some("/usr/lib")),
            format!("/data/ps-modules{}/usr/lib", separator)
        );
    }

    fn running(runs: &Runs, name: &str) -> u64 {
        let target = grant().target;
        let request = RunRequest {
            terminal_id: name.into(),
            script_content: "dotnet run".into(),
            args: Vec::new(),
            in_separate_window: false,
            is_page_script: false,
            display_script: None,
            cols: None,
            rows: None,
            content_only: true,
        };
        runs.lock()
            .unwrap()
            .start(&target, &request, false, 0)
            .unwrap();
        runs.lock().unwrap().running_run("p1", name).unwrap().run
    }

    #[tokio::test]
    async fn replace_stops_the_running_command_and_waits_for_it_to_end() {
        let runs = Arc::new(Runs::default());
        let run = running(&runs, "iris");
        let stopper = runs.clone();
        clear_terminal(
            &runs,
            "p1",
            "iris",
            true,
            Duration::from_secs(5),
            move || {
                // The script ends a moment after it is asked to stop, as one does after Ctrl+C.
                tokio::spawn(async move {
                    sleep(Duration::from_millis(200)).await;
                    let mut store = stopper.lock().unwrap();
                    store.mark_stopped("p1", "iris");
                    store.finish("p1", "iris", run, None, 1);
                });
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(runs.lock().unwrap().running_run("p1", "iris").is_none());
    }

    #[tokio::test]
    async fn without_replace_a_running_terminal_is_left_alone() {
        let runs = Runs::default();
        running(&runs, "iris");
        let refused = clear_terminal(&runs, "p1", "iris", false, Duration::from_secs(1), || {
            panic!("must not stop")
        })
        .await
        .unwrap_err();
        assert!(refused.contains("-Replace"), "{}", refused);
        // A terminal with nothing running needs nothing stopped.
        clear_terminal(&runs, "p1", "admin", false, Duration::from_secs(1), || {
            panic!("must not stop")
        })
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn a_command_that_will_not_stop_is_reported() {
        let runs = Runs::default();
        running(&runs, "iris");
        let failed = clear_terminal(
            &runs,
            "p1",
            "iris",
            true,
            Duration::from_millis(200),
            || Ok(()),
        )
        .await
        .unwrap_err();
        assert_eq!(failed, "The terminal 'iris' did not stop.");
        let refused = clear_terminal(&runs, "p1", "iris", true, Duration::from_secs(1), || {
            Err("no".into())
        })
        .await
        .unwrap_err();
        assert_eq!(refused, "no");
    }

    /// Serves requests on a real port, sending each request that gets in to `seen`.
    fn listen() -> (String, mpsc::Receiver<TerminalRequest>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let (seen, received) = mpsc::channel();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let seen = seen.clone();
                let _ = serve_connection(stream, known, move |_, request| {
                    let refuse = request.name == "busy";
                    let _ = seen.send(request);
                    if refuse {
                        Err("The terminal 'busy' is still running.".into())
                    } else {
                        Ok(started("iris"))
                    }
                });
            }
        });
        (address, received)
    }

    fn pwsh() -> Option<&'static str> {
        ["pwsh", "pwsh.exe"].into_iter().find(|program| {
            Command::new(program)
                .args(["-NoProfile", "-Command", "exit 0"])
                .output()
                .is_ok_and(|output| output.status.success())
        })
    }

    /// Runs PowerShell as Task Proxy would, with the module on the module path and the given key.
    fn run_script(address: &str, key: Option<&str>, script: &str) -> std::process::Output {
        let modules = tempfile::tempdir().unwrap();
        fs::create_dir_all(modules.path().join("TaskProxy")).unwrap();
        fs::write(modules.path().join("TaskProxy/TaskProxy.psm1"), MODULE).unwrap();
        let mut command = Command::new(pwsh().unwrap());
        command
            // Errors are written plainly, since PowerShell colors and wraps the ones it shows.
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                &format!(
                    "try {{ {} }} catch {{ Write-Output \"ERROR: $($_.Exception.Message)\"; exit 1 }}",
                    script
                ),
            ])
            .env(
                "PSModulePath",
                module_path(
                    modules.path(),
                    std::env::var("PSModulePath").ok().as_deref(),
                ),
            )
            .env("TASKPROXY_URL", address)
            .env_remove("TASKPROXY_RUN");
        if let Some(key) = key {
            command.env("TASKPROXY_RUN", key);
        }
        command.output().unwrap()
    }

    #[test]
    fn the_module_opens_a_terminal_from_a_script() {
        if pwsh().is_none() {
            eprintln!("PowerShell is not installed, so the module was not tried.");
            return;
        }
        let (address, received) = listen();
        let output = run_script(
            &address,
            Some("good"),
            "if (Get-Command Start-TaskProxyTerminal -ErrorAction SilentlyContinue) { Set-Location ([IO.Path]::GetTempPath()); $r = Start-TaskProxyTerminal -Name iris -Command \"& 'x.ps1'\" -Replace; Write-Output \"opened $($r.terminal) $($r.run)\" } else { Write-Output 'not found' }",
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("opened iris 9"),
            "{}{}",
            stdout,
            String::from_utf8_lossy(&output.stderr)
        );
        let request = received.try_recv().unwrap();
        assert_eq!(
            (
                request.name.as_str(),
                request.command.as_str(),
                request.replace
            ),
            ("iris", "& 'x.ps1'", true)
        );
        assert!(
            request
                .working_directory
                .is_some_and(|folder| !folder.is_empty())
        );
    }

    #[test]
    fn the_module_says_why_task_proxy_refused() {
        if pwsh().is_none() {
            return;
        }
        let (address, received) = listen();
        let output = run_script(
            &address,
            Some("good"),
            "Start-TaskProxyTerminal -Name busy -Command 'x'",
        );
        assert!(!output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("ERROR: Task Proxy could not open the terminal 'busy'"),
            "{}",
            stdout
        );
        assert!(stdout.contains("still running"), "{}", stdout);
        assert_eq!(received.try_recv().unwrap().name, "busy");
    }

    #[test]
    fn outside_task_proxy_the_module_says_so_and_sends_nothing() {
        if pwsh().is_none() {
            return;
        }
        let (address, received) = listen();
        let output = run_script(
            &address,
            None,
            "Write-Output (Test-TaskProxy); Start-TaskProxyTerminal -Name iris -Command 'x'",
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("False"));
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("only works in scripts Task Proxy runs")
        );
        assert!(received.try_recv().is_err());
        // A wrong key is refused by the listener.
        let output = run_script(
            &address,
            Some("wrong"),
            "Start-TaskProxyTerminal -Name iris -Command 'x'",
        );
        assert!(
            String::from_utf8_lossy(&output.stdout)
                .contains("only answers scripts Task Proxy is running")
        );
        assert!(received.try_recv().is_err());
    }
}
