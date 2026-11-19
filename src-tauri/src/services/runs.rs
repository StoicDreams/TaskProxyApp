//! Script runs: what each project's terminals are running or ran, their output, and the queue.
//!
//! Rust keeps this, rather than the window that started a run, so a run and its queue carry on whatever happens to
//! the screen that started them, and every screen sees the same runs. The window keeps a copy, updated by the
//! `run-changed` and `terminal-data` events (`terminalHelpers` in `app.js`).
//!
//! `RunStore` holds the state and decides everything without Tauri, so it is tested directly. The commands below
//! start and stop the scripts it describes, through `terminal_controller`.

use crate::prelude::*;
use crate::services::script_api;
use crate::services::terminal_controller::{
    self, ProcessMap, ScriptStarted, TerminalManager, script_key, script_project,
};
use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::sync::oneshot;

/// Output kept for each terminal, as the window keeps it, so switching terminals or reconnecting can replay it.
const MAX_OUTPUT: usize = 2 * 1024 * 1024;
/// How long a script asked to stop with Ctrl+C has before it is forced to end.
const STOP_GRACE: Duration = Duration::from_secs(3);
const STOP_POLL: Duration = Duration::from_millis(100);
const LIVE: &str = "live";
pub(crate) const ALREADY_RUNNING: &str =
    "Script is already running. You can manage it in the Terminal Manager.";

#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
pub(crate) enum RunStatus {
    Running,
    Finished,
}

/// A terminal's latest run, as every screen shows it.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunInfo {
    pub id: String,
    pub name: String,
    pub project_id: String,
    pub project_name: String,
    pub project_path: String,
    pub status: RunStatus,
    /// Null while running, when stopped, or when the exit code is unknown, such as for a separate window.
    pub exit_code: Option<i32>,
    /// A stopped run failed, whatever exit code Ctrl+C or the kill left it with.
    pub stopped: bool,
    /// Milliseconds since the Unix epoch.
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub is_page_script: bool,
    pub is_live: bool,
    /// What the Terminal Manager shows. Page scripts send a copy with their filled-in values masked.
    pub script: String,
    pub args: Vec<String>,
    /// Whether it runs in a pseudo-terminal, so it takes input and Ctrl+C.
    pub interactive: bool,
    /// Numbers each run, across every terminal, so output and endings from an earlier run are told apart.
    pub run: u64,
    /// Raised on every change, across every terminal, so a screen keeps the newest of two updates.
    pub rev: u64,
    /// Raised each time the output is cleared, so every screen clears its copy.
    pub cleared: u64,
}

/// What a script needs to start.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RunRequest {
    pub terminal_id: String,
    pub script_content: String,
    pub args: Vec<String>,
    pub in_separate_window: bool,
    pub is_page_script: bool,
    pub display_script: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    /// Runs `script_content` even when a file in the project has the terminal's name, as for a terminal a
    /// script opened by name.
    pub content_only: bool,
}

/// The project a run belongs to and runs in.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct RunTarget {
    pub project_id: String,
    pub project_path: String,
    pub project_name: String,
}

#[derive(Clone, Debug)]
pub(crate) struct Queued {
    pub target: RunTarget,
    pub request: RunRequest,
}

/// Output as the batches it arrived in, numbered from 1 within each run.
#[derive(Default, Debug)]
struct Output {
    chunks: VecDeque<(u64, String)>,
    size: usize,
    seq: u64,
}

impl Output {
    fn append(&mut self, data: String) -> u64 {
        self.seq += 1;
        self.size += data.len();
        self.chunks.push_back((self.seq, data));
        self.trim();
        self.seq
    }

    /// Drops the oldest output beyond the limit, starting what is kept on a new line, so a replay never begins
    /// inside a color code.
    fn trim(&mut self) {
        if self.size <= MAX_OUTPUT {
            return;
        }
        while self.chunks.len() > 1 && self.size - self.chunks[0].1.len() > MAX_OUTPUT {
            if let Some((_, chunk)) = self.chunks.pop_front() {
                self.size -= chunk.len();
            }
        }
        let Some((_, first)) = self.chunks.front_mut() else {
            return;
        };
        let cut = first
            .len()
            .saturating_sub(MAX_OUTPUT - (self.size - first.len()));
        let kept = match first.as_bytes()[cut..].iter().position(|b| *b == b'\n') {
            Some(at) => first[cut + at + 1..].to_string(),
            None => String::new(),
        };
        self.size -= first.len() - kept.len();
        *first = kept;
    }

    fn clear(&mut self) {
        self.chunks.clear();
        self.size = 0;
    }

    /// Output after `since`, or all that is kept when `since` is missing or older than what is kept.
    fn since(&self, since: Option<u64>) -> (String, bool) {
        let first = self
            .chunks
            .front()
            .map(|(seq, _)| *seq)
            .unwrap_or(self.seq + 1);
        match since {
            Some(since) if since + 1 >= first && since <= self.seq => (
                self.chunks
                    .iter()
                    .filter(|(seq, _)| *seq > since)
                    .map(|(_, chunk)| chunk.as_str())
                    .collect(),
                false,
            ),
            _ => (
                self.chunks
                    .iter()
                    .map(|(_, chunk)| chunk.as_str())
                    .collect(),
                true,
            ),
        }
    }
}

#[derive(Debug)]
struct Run {
    info: RunInfo,
    output: Output,
}

#[derive(Default, Debug)]
struct ProjectRuns {
    terminals: HashMap<String, Run>,
    queue: VecDeque<Queued>,
}

impl ProjectRuns {
    fn is_running(&self) -> bool {
        self.terminals
            .values()
            .any(|run| run.info.status == RunStatus::Running)
    }
}

/// Output since a screen's last batch, for a screen that missed some or is catching up.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunOutput {
    pub run: u64,
    pub seq: u64,
    pub data: String,
    /// When true, `data` is all the output kept, and replaces the screen's copy.
    pub reset: bool,
}

/// What `RunStore::start` did.
#[derive(Debug, PartialEq)]
pub(crate) enum Begun {
    Started(Box<RunInfo>),
    Queued,
}

#[derive(Default, Debug)]
pub(crate) struct RunStore {
    rev: u64,
    next_run: u64,
    projects: HashMap<String, ProjectRuns>,
    /// Those waiting for a run to end, by run number, such as a commit waiting on its script.
    waiters: HashMap<u64, Vec<oneshot::Sender<RunInfo>>>,
    /// The keys scripts use to ask Task Proxy for things, such as opening a terminal, by key. Each works only
    /// while its run is running (`services/script_api.rs`).
    grants: HashMap<String, Grant>,
}

/// What a script's key allows: asking for things in the project of the run it was given to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Grant {
    pub target: RunTarget,
    pub terminal_id: String,
    pub run: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl RunStore {
    fn bump(&mut self) -> u64 {
        self.rev += 1;
        self.rev
    }

    fn run_mut(&mut self, project_id: &str, terminal_id: &str) -> Option<&mut Run> {
        self.projects
            .get_mut(project_id)?
            .terminals
            .get_mut(terminal_id)
    }

    fn info(&self, project_id: &str, terminal_id: &str) -> Option<RunInfo> {
        Some(
            self.projects
                .get(project_id)?
                .terminals
                .get(terminal_id)?
                .info
                .clone(),
        )
    }

    /// Starts a run now, or with `queue`, after whatever is running in its project ends.
    pub fn start(
        &mut self,
        target: &RunTarget,
        request: &RunRequest,
        queue: bool,
        now: u64,
    ) -> Result<Begun, String> {
        let project = self.projects.entry(target.project_id.clone()).or_default();
        if project
            .terminals
            .get(&request.terminal_id)
            .is_some_and(|run| run.info.status == RunStatus::Running)
        {
            return Err(ALREADY_RUNNING.into());
        }
        if queue && project.is_running() {
            project.queue.push_back(Queued {
                target: target.clone(),
                request: request.clone(),
            });
            return Ok(Begun::Queued);
        }
        Ok(Begun::Started(Box::new(self.begin(target, request, now))))
    }

    /// Marks a terminal running a new run, with its output cleared.
    fn begin(&mut self, target: &RunTarget, request: &RunRequest, now: u64) -> RunInfo {
        self.next_run += 1;
        let run = self.next_run;
        let rev = self.bump();
        let id = request.terminal_id.clone();
        let is_live = id == LIVE;
        let cleared = self
            .info(&target.project_id, &id)
            .map(|info| info.cleared)
            .unwrap_or(0);
        let info = RunInfo {
            name: if is_live {
                "Live Command".into()
            } else {
                id.clone()
            },
            id: id.clone(),
            project_id: target.project_id.clone(),
            project_name: target.project_name.clone(),
            project_path: target.project_path.clone(),
            status: RunStatus::Running,
            exit_code: None,
            stopped: false,
            started_at: now,
            ended_at: None,
            is_page_script: request.is_page_script,
            is_live,
            script: request
                .display_script
                .clone()
                .unwrap_or_else(|| request.script_content.clone()),
            args: request.args.clone(),
            interactive: false,
            run,
            rev,
            cleared,
        };
        self.projects
            .entry(target.project_id.clone())
            .or_default()
            .terminals
            .insert(
                id,
                Run {
                    info: info.clone(),
                    output: Output::default(),
                },
            );
        info
    }

    /// Records whether a run that started takes input.
    pub fn set_interactive(
        &mut self,
        project_id: &str,
        terminal_id: &str,
        run: u64,
        interactive: bool,
    ) -> Option<RunInfo> {
        let rev = self.rev + 1;
        let entry = self
            .run_mut(project_id, terminal_id)
            .filter(|entry| entry.info.run == run)?;
        entry.info.interactive = interactive;
        entry.info.rev = rev;
        let info = entry.info.clone();
        self.rev = rev;
        Some(info)
    }

    /// Keeps a batch of output, returning its number, or None for a run that is not the terminal's latest.
    pub fn append(
        &mut self,
        project_id: &str,
        terminal_id: &str,
        run: u64,
        data: String,
    ) -> Option<u64> {
        let entry = self
            .run_mut(project_id, terminal_id)
            .filter(|entry| entry.info.run == run)?;
        Some(entry.output.append(data))
    }

    /// Marks a run finished. Returns None when it already was, or is not the terminal's latest run.
    pub fn finish(
        &mut self,
        project_id: &str,
        terminal_id: &str,
        run: u64,
        code: Option<i32>,
        now: u64,
    ) -> Option<RunInfo> {
        let rev = self.rev + 1;
        let entry = self
            .run_mut(project_id, terminal_id)
            .filter(|entry| entry.info.run == run && entry.info.status == RunStatus::Running)?;
        entry.info.status = RunStatus::Finished;
        entry.info.exit_code = code;
        entry.info.ended_at = Some(now);
        entry.info.rev = rev;
        let info = entry.info.clone();
        self.rev = rev;
        for waiter in self.waiters.remove(&run).unwrap_or_default() {
            let _ = waiter.send(info.clone());
        }
        self.grants.retain(|_, grant| grant.run != run);
        Some(info)
    }

    /// Gives a running run's script a key, which works until the run ends.
    pub fn grant(&mut self, key: String, target: &RunTarget, terminal_id: &str, run: u64) -> bool {
        let running = self
            .info(&target.project_id, terminal_id)
            .is_some_and(|info| info.run == run && info.status == RunStatus::Running);
        if running {
            self.grants.insert(
                key,
                Grant {
                    target: target.clone(),
                    terminal_id: terminal_id.into(),
                    run,
                },
            );
        }
        running
    }

    /// What a key allows, while its run is running.
    pub fn grant_for(&self, key: &str) -> Option<Grant> {
        let grant = self.grants.get(key)?;
        self.is_running(&grant.target.project_id, &grant.terminal_id, grant.run)
            .then(|| grant.clone())
    }

    /// The terminal's run, while it is running.
    pub fn running_run(&self, project_id: &str, terminal_id: &str) -> Option<RunInfo> {
        self.info(project_id, terminal_id)
            .filter(|info| info.status == RunStatus::Running)
    }

    /// Resolves with run `run` once it ends, or straight away when it already has.
    pub fn wait(
        &mut self,
        project_id: &str,
        terminal_id: &str,
        run: u64,
    ) -> oneshot::Receiver<RunInfo> {
        let (sender, receiver) = oneshot::channel();
        match self
            .info(project_id, terminal_id)
            .filter(|info| info.run == run)
        {
            Some(info) if info.status == RunStatus::Finished => {
                let _ = sender.send(info);
            }
            Some(_) => self.waiters.entry(run).or_default().push(sender),
            // A run that is gone cannot end, so the receiver reports it closed.
            None => {}
        }
        receiver
    }

    /// The next queued script for a project, marked running, once nothing runs there.
    pub fn next_queued(&mut self, project_id: &str, now: u64) -> Option<(Queued, RunInfo)> {
        let project = self.projects.get_mut(project_id)?;
        if project.is_running() {
            return None;
        }
        let next = project.queue.pop_front()?;
        let info = self.begin(&next.target, &next.request, now);
        Some((next, info))
    }

    /// Forgets a project's queue, returning how many scripts it held.
    pub fn clear_queue(&mut self, project_id: &str) -> usize {
        self.projects
            .get_mut(project_id)
            .map(|project| std::mem::take(&mut project.queue).len())
            .unwrap_or(0)
    }

    /// Marks a running script as stopped, before it is asked to end.
    pub fn mark_stopped(&mut self, project_id: &str, terminal_id: &str) -> Option<RunInfo> {
        let rev = self.rev + 1;
        let entry = self
            .run_mut(project_id, terminal_id)
            .filter(|entry| entry.info.status == RunStatus::Running)?;
        entry.info.stopped = true;
        entry.info.rev = rev;
        let info = entry.info.clone();
        self.rev = rev;
        Some(info)
    }

    /// The terminals running in a project.
    pub fn running(&self, project_id: &str) -> Vec<String> {
        self.projects
            .get(project_id)
            .map(|project| {
                project
                    .terminals
                    .values()
                    .filter(|run| run.info.status == RunStatus::Running)
                    .map(|run| run.info.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn is_running(&self, project_id: &str, terminal_id: &str, run: u64) -> bool {
        self.info(project_id, terminal_id)
            .is_some_and(|info| info.run == run && info.status == RunStatus::Running)
    }

    pub fn output(
        &self,
        project_id: &str,
        terminal_id: &str,
        run: Option<u64>,
        since: Option<u64>,
    ) -> Option<RunOutput> {
        let entry = self.projects.get(project_id)?.terminals.get(terminal_id)?;
        let since = since.filter(|_| run == Some(entry.info.run));
        let (data, reset) = entry.output.since(since);
        Some(RunOutput {
            run: entry.info.run,
            seq: entry.output.seq,
            data,
            reset,
        })
    }

    pub fn clear_output(&mut self, project_id: &str, terminal_id: &str) -> Option<RunInfo> {
        let rev = self.rev + 1;
        let entry = self.run_mut(project_id, terminal_id)?;
        entry.output.clear();
        entry.info.cleared += 1;
        entry.info.rev = rev;
        let info = entry.info.clone();
        self.rev = rev;
        Some(info)
    }

    /// Forgets a terminal and its output. Running scripts and the live terminal are kept.
    pub fn remove(&mut self, project_id: &str, terminal_id: &str) -> bool {
        let Some(project) = self.projects.get_mut(project_id) else {
            return false;
        };
        let removable = terminal_id != LIVE
            && project
                .terminals
                .get(terminal_id)
                .is_some_and(|run| run.info.status != RunStatus::Running);
        if removable {
            project.terminals.remove(terminal_id);
        }
        removable
    }

    /// Forgets every page script in a project that is not running, returning their ids.
    pub fn remove_finished_page_scripts(&mut self, project_id: &str) -> Vec<String> {
        let Some(project) = self.projects.get_mut(project_id) else {
            return Vec::new();
        };
        let mut ids: Vec<String> = project
            .terminals
            .values()
            .filter(|run| run.info.is_page_script && run.info.status != RunStatus::Running)
            .map(|run| run.info.id.clone())
            .collect();
        ids.sort();
        for id in &ids {
            project.terminals.remove(id);
        }
        ids
    }

    /// Every terminal that has run, in every project.
    pub fn list(&self) -> Vec<RunInfo> {
        let mut runs: Vec<RunInfo> = self
            .projects
            .values()
            .flat_map(|project| project.terminals.values().map(|run| run.info.clone()))
            .collect();
        runs.sort_by_key(|info| info.run);
        runs
    }
}

/// The shared run store, managed by Tauri.
#[derive(Default)]
pub(crate) struct Runs(pub Mutex<RunStore>);

impl Runs {
    pub(crate) fn lock(&self) -> Result<std::sync::MutexGuard<'_, RunStore>, String> {
        self.0
            .lock()
            .map_err(|err| format!("State failure: {}", err))
    }
}

/// A run's change, or its removal when `run` is null.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunChanged {
    project_id: String,
    terminal_id: String,
    run: Option<RunInfo>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalData {
    project_id: String,
    terminal_id: String,
    run: u64,
    seq: u64,
    data: String,
}

fn emit_changed(app: &AppHandle, info: &RunInfo) {
    crate::remote::hub::broadcast(
        app,
        "run-changed",
        RunChanged {
            project_id: info.project_id.clone(),
            terminal_id: info.id.clone(),
            run: Some(info.clone()),
        },
    );
}

fn emit_removed(app: &AppHandle, project_id: &str, terminal_id: &str) {
    crate::remote::hub::broadcast(
        app,
        "run-changed",
        RunChanged {
            project_id: project_id.into(),
            terminal_id: terminal_id.into(),
            run: None,
        },
    );
}

/// Keeps a batch of a script's output and sends it to every screen.
pub(crate) fn output(app: &AppHandle, project_id: &str, terminal_id: &str, run: u64, data: String) {
    let seq = match app.state::<Runs>().lock() {
        Ok(mut store) => store.append(project_id, terminal_id, run, data.clone()),
        Err(_) => None,
    };
    if let Some(seq) = seq {
        crate::remote::hub::broadcast(
            app,
            "terminal-data",
            TerminalData {
                project_id: project_id.into(),
                terminal_id: terminal_id.into(),
                run,
                seq,
                data,
            },
        );
    }
}

/// Marks a script finished, and starts the next one queued in its project.
pub(crate) fn finished(
    app: &AppHandle,
    project_id: &str,
    terminal_id: &str,
    run: u64,
    code: Option<i32>,
) {
    let info = match app.state::<Runs>().lock() {
        Ok(mut store) => store.finish(project_id, terminal_id, run, code, now_ms()),
        Err(_) => None,
    };
    if let Some(info) = info {
        emit_changed(app, &info);
    }
    let next: Pin<Box<dyn Future<Output = ()> + Send>> =
        Box::pin(run_queued(app.clone(), project_id.to_string()));
    tauri::async_runtime::spawn(next);
}

/// Marks a run stopped by Ctrl+C typed into its terminal.
pub(crate) fn stopped_by_input(app: &AppHandle, project_id: &str, terminal_id: &str) {
    let info = match app.state::<Runs>().lock() {
        Ok(mut store) => store.mark_stopped(project_id, terminal_id),
        Err(_) => None,
    };
    if let Some(info) = info {
        emit_changed(app, &info);
    }
}

/// Starts a run the store has marked running. A run that cannot start is marked finished, with the reason
/// written to its output, so every screen sees why.
async fn launch(
    app: &AppHandle,
    target: &RunTarget,
    request: &RunRequest,
    info: RunInfo,
) -> Result<RunInfo, String> {
    let processes = app.state::<TerminalManager>().processes.clone();
    // The script's key for the script API, so it can open terminals here rather than in windows of their own.
    let key = script_api::new_key();
    let granted = app
        .state::<Runs>()
        .lock()?
        .grant(key.clone(), target, &info.id, info.run);
    let env = if granted {
        script_api::script_env(&key)
    } else {
        Vec::new()
    };
    let started: Result<ScriptStarted, String> =
        terminal_controller::spawn_script(app, &processes, target, info.run, request, &env).await;
    let runs = app.state::<Runs>();
    match started {
        // A script in its own window is not watched, so its run ends as it opens.
        Ok(_) if request.in_separate_window => {
            let done = runs
                .lock()?
                .finish(&target.project_id, &info.id, info.run, None, now_ms());
            if let Some(done) = &done {
                emit_changed(app, done);
            }
            run_queued_soon(app, &target.project_id);
            Ok(done.unwrap_or(info))
        }
        Ok(started) => {
            let updated = runs.lock()?.set_interactive(
                &target.project_id,
                &info.id,
                info.run,
                started.interactive,
            );
            if let Some(updated) = &updated {
                emit_changed(app, updated);
            }
            Ok(updated.unwrap_or(info))
        }
        Err(err) => {
            output(
                app,
                &target.project_id,
                &info.id,
                info.run,
                format!("\x1b[31m{}\x1b[0m\r\n", err),
            );
            finished(app, &target.project_id, &info.id, info.run, None);
            Err(err)
        }
    }
}

fn run_queued_soon(app: &AppHandle, project_id: &str) {
    let next: Pin<Box<dyn Future<Output = ()> + Send>> =
        Box::pin(run_queued(app.clone(), project_id.to_string()));
    tauri::async_runtime::spawn(next);
}

/// Starts the next queued script in a project, if nothing runs there.
async fn run_queued(app: AppHandle, project_id: String) {
    let next = match app.state::<Runs>().lock() {
        Ok(mut store) => store.next_queued(&project_id, now_ms()),
        Err(_) => None,
    };
    let Some((queued, info)) = next else {
        return;
    };
    emit_changed(&app, &info);
    // A failed start is marked finished, which starts the next one in turn.
    let _ = launch(&app, &queued.target, &queued.request, info).await;
}

/// The project a run is for: the open one, or the saved project at `project` (a path).
pub(crate) fn run_target(
    project_state: &CurrentProject,
    projects: &SharedProjects,
    project: Option<&str>,
) -> Result<RunTarget, String> {
    let open = project_state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    let (project_id, project_path) = script_project((&open.id, &open.path), &known, project)?;
    let normalize = |path: &str| path.replace('\\', "/");
    let project_name = known
        .iter()
        .find(|saved| normalize(&saved.path) == normalize(&project_path))
        .map(|saved| saved.name.clone())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| project_path.clone());
    Ok(RunTarget {
        project_id,
        project_path,
        project_name,
    })
}

/// The project id a command names, or the open project's.
fn target_id(
    project_state: &State<'_, CurrentProject>,
    project_id: Option<String>,
) -> Result<String, String> {
    match project_id.filter(|id| !id.is_empty()) {
        Some(id) => Ok(id),
        None => Ok(project_state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?
            .id
            .clone()),
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RunStarted {
    /// "Started" or "Queued".
    pub result: String,
    pub run: Option<RunInfo>,
}

/// Runs a script in a terminal of the open project, or of the saved project at `project`. With `queue`, it
/// waits for whatever is running in that project to end.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_script(
    app_handle: AppHandle,
    runs: State<'_, Runs>,
    project_state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    terminal_id: String,
    script_content: String,
    args: Vec<String>,
    in_separate_window: bool,
    cols: Option<u16>,
    rows: Option<u16>,
    project: Option<String>,
    queue: Option<bool>,
    is_page_script: Option<bool>,
    display_script: Option<String>,
) -> Result<RunStarted, String> {
    let target = run_target(&project_state, &projects, project.as_deref())?;
    let request = RunRequest {
        terminal_id,
        script_content,
        args,
        in_separate_window,
        is_page_script: is_page_script.unwrap_or(false),
        display_script,
        cols,
        rows,
        content_only: false,
    };
    let begun = runs
        .lock()?
        .start(&target, &request, queue.unwrap_or(false), now_ms())?;
    match begun {
        Begun::Queued => Ok(RunStarted {
            result: "Queued".into(),
            run: None,
        }),
        Begun::Started(info) => {
            emit_changed(&app_handle, &info);
            let info = launch(&app_handle, &target, &request, *info).await?;
            Ok(RunStarted {
                result: "Started".into(),
                run: Some(info),
            })
        }
    }
}

/// Runs a script now in a terminal of the project `target` names, returning its run once it has started.
pub(crate) async fn start_now(
    app: &AppHandle,
    target: &RunTarget,
    request: &RunRequest,
) -> Result<RunInfo, String> {
    let begun = app
        .state::<Runs>()
        .lock()?
        .start(target, request, false, now_ms())?;
    let Begun::Started(info) = begun else {
        return Err(ALREADY_RUNNING.into());
    };
    emit_changed(app, &info);
    launch(app, target, request, *info).await
}

/// Runs a script now, in the project `target` names, and resolves with the run once it ends.
pub(crate) async fn run_and_wait(
    app: &AppHandle,
    target: &RunTarget,
    request: &RunRequest,
) -> Result<RunInfo, String> {
    let runs = app.state::<Runs>();
    let (info, ended) = {
        let mut store = runs.lock()?;
        let Begun::Started(info) = store.start(target, request, false, now_ms())? else {
            return Err(ALREADY_RUNNING.into());
        };
        let ended = store.wait(&target.project_id, &info.id, info.run);
        (*info, ended)
    };
    emit_changed(app, &info);
    launch(app, target, request, info).await?;
    ended
        .await
        .map_err(|_| String::from("The script's terminal was removed before it ended."))
}

/// Every terminal that has run, in every project. Output comes from `get_run_output`.
#[tauri::command]
pub(crate) fn get_runs(runs: State<'_, Runs>) -> Result<Vec<RunInfo>, String> {
    Ok(runs.lock()?.list())
}

/// A terminal's output after batch `since` of run `run`, or all that is kept.
#[tauri::command]
pub(crate) fn get_run_output(
    runs: State<'_, Runs>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    project_id: Option<String>,
    run: Option<u64>,
    since: Option<u64>,
) -> Result<Option<RunOutput>, String> {
    let project_id = target_id(&project_state, project_id)?;
    Ok(runs.lock()?.output(&project_id, &terminal_id, run, since))
}

/// Asks a run to stop: Ctrl+C for a script in a terminal, then forced after a few seconds, or forced straight
/// away for one without a terminal. Returns once it has been asked.
#[tauri::command]
pub(crate) fn stop_run(
    app_handle: AppHandle,
    runs: State<'_, Runs>,
    manager: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let project_id = target_id(&project_state, project_id)?;
    stop(&app_handle, &runs, &manager, &project_id, &terminal_id)
}

/// Asks a run to stop, as `stop_run` does.
pub(crate) fn stop(
    app_handle: &AppHandle,
    runs: &Runs,
    manager: &TerminalManager,
    project_id: &str,
    terminal_id: &str,
) -> Result<(), String> {
    let Some(info) = runs.lock()?.mark_stopped(project_id, terminal_id) else {
        return Ok(());
    };
    emit_changed(app_handle, &info);
    let processes = manager.processes.clone();
    let key = script_key(project_id, terminal_id);
    let app = app_handle.clone();
    tauri::async_runtime::spawn(async move {
        let still_running = || {
            app.state::<Runs>()
                .lock()
                .map(|store| store.is_running(&info.project_id, &info.id, info.run))
                .unwrap_or(false)
        };
        stop_sequence(
            info.interactive,
            terminal_controller::send_input(&processes, &key, "\x03".into()),
            still_running,
            force(&processes, &key),
            STOP_GRACE,
        )
        .await;
    });
    Ok(())
}

async fn force(processes: &ProcessMap, key: &str) {
    terminal_controller::force_stop(processes, key).await;
}

/// Sends Ctrl+C to a script in a terminal and gives it `grace` to end, then forces it. A script without a
/// terminal, or one that Ctrl+C cannot reach, is forced straight away.
async fn stop_sequence<C, R, F>(interactive: bool, ctrl_c: C, running: R, force: F, grace: Duration)
where
    C: Future<Output = Result<(), String>>,
    R: Fn() -> bool,
    F: Future<Output = ()>,
{
    if interactive && ctrl_c.await.is_ok() {
        let mut waited = Duration::ZERO;
        while waited < grace && running() {
            sleep(STOP_POLL).await;
            waited += STOP_POLL;
        }
        if !running() {
            return;
        }
    }
    force.await;
}

/// Stops every script in the open project, and forgets its queue first, so the next one does not start.
#[tauri::command]
pub(crate) async fn kill_all_scripts(
    app_handle: AppHandle,
    runs: State<'_, Runs>,
    manager: State<'_, TerminalManager>,
    project_state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let project_id = target_id(&project_state, None)?;
    let stopped: Vec<RunInfo> = {
        let mut store = runs.lock()?;
        store.clear_queue(&project_id);
        store
            .running(&project_id)
            .iter()
            .filter_map(|id| store.mark_stopped(&project_id, id))
            .collect()
    };
    for info in &stopped {
        emit_changed(&app_handle, info);
    }
    terminal_controller::force_stop_project(&manager.processes, &project_id).await;
    Ok("All processes killed".into())
}

/// Empties a terminal's output, on every screen.
#[tauri::command]
pub(crate) fn clear_run_output(
    app_handle: AppHandle,
    runs: State<'_, Runs>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let project_id = target_id(&project_state, project_id)?;
    if let Some(info) = runs.lock()?.clear_output(&project_id, &terminal_id) {
        emit_changed(&app_handle, &info);
    }
    Ok(())
}

/// Forgets a terminal that is not running. Returns whether it was removed.
#[tauri::command]
pub(crate) fn remove_run(
    app_handle: AppHandle,
    runs: State<'_, Runs>,
    project_state: State<'_, CurrentProject>,
    terminal_id: String,
    project_id: Option<String>,
) -> Result<bool, String> {
    let project_id = target_id(&project_state, project_id)?;
    let removed = runs.lock()?.remove(&project_id, &terminal_id);
    if removed {
        emit_removed(&app_handle, &project_id, &terminal_id);
    }
    Ok(removed)
}

/// Forgets every page script in the open project that is not running. Returns how many were removed.
#[tauri::command]
pub(crate) fn remove_finished_page_scripts(
    app_handle: AppHandle,
    runs: State<'_, Runs>,
    project_state: State<'_, CurrentProject>,
) -> Result<usize, String> {
    let project_id = target_id(&project_state, None)?;
    let removed = runs.lock()?.remove_finished_page_scripts(&project_id);
    for id in &removed {
        emit_removed(&app_handle, &project_id, id);
    }
    Ok(removed.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    const TEST_GRACE: Duration = Duration::from_millis(300);

    fn target(id: &str) -> RunTarget {
        RunTarget {
            project_id: id.into(),
            project_path: format!("/{}", id),
            project_name: id.to_uppercase(),
        }
    }

    fn request(id: &str) -> RunRequest {
        RunRequest {
            terminal_id: id.into(),
            script_content: format!("body of {}", id),
            args: vec!["-x".into()],
            in_separate_window: false,
            is_page_script: false,
            display_script: None,
            cols: None,
            rows: None,
            content_only: false,
        }
    }

    fn started(begun: Result<Begun, String>) -> RunInfo {
        match begun {
            Ok(Begun::Started(info)) => *info,
            other => panic!("expected a start, got {:?}", other),
        }
    }

    #[test]
    fn a_run_starts_running_with_what_the_terminal_manager_shows() {
        let mut store = RunStore::default();
        let info = started(store.start(&target("p"), &request("a.ps1"), false, 10));
        assert_eq!(info.status, RunStatus::Running);
        assert_eq!(info.name, "a.ps1");
        assert_eq!(info.project_name, "P");
        assert_eq!(info.script, "body of a.ps1");
        assert_eq!(info.args, ["-x"]);
        assert_eq!(info.started_at, 10);
        assert!(!info.is_live);
        let live = started(store.start(&target("p"), &request("live"), false, 10));
        assert_eq!((live.name.as_str(), live.is_live), ("Live Command", true));
        assert!(live.run > info.run && live.rev > info.rev);
    }

    #[test]
    fn a_page_script_shows_its_masked_copy() {
        let mut store = RunStore::default();
        let mut page = request("p1");
        page.is_page_script = true;
        page.display_script = Some("$secret = 'RE***AL'".into());
        let info = started(store.start(&target("p"), &page, false, 0));
        assert_eq!(info.script, "$secret = 'RE***AL'");
        assert!(info.is_page_script);
    }

    #[test]
    fn a_running_terminal_cannot_start_again_even_queued() {
        let mut store = RunStore::default();
        started(store.start(&target("p"), &request("a.ps1"), false, 0));
        assert_eq!(
            store.start(&target("p"), &request("a.ps1"), false, 0),
            Err(ALREADY_RUNNING.into())
        );
        assert_eq!(
            store.start(&target("p"), &request("a.ps1"), true, 0),
            Err(ALREADY_RUNNING.into())
        );
        // The same terminal in another project is another terminal.
        started(store.start(&target("q"), &request("a.ps1"), false, 0));
    }

    #[test]
    fn queued_scripts_wait_for_their_own_project_in_order() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), true, 0));
        assert_eq!(
            store.start(&target("p"), &request("b.ps1"), true, 0),
            Ok(Begun::Queued)
        );
        assert_eq!(
            store.start(&target("p"), &request("c.ps1"), true, 0),
            Ok(Begun::Queued)
        );
        // Another project's queue is its own.
        started(store.start(&target("q"), &request("b.ps1"), true, 0));
        // Without queue it starts beside what is running.
        started(store.start(&target("p"), &request("now.ps1"), false, 0));
        assert!(store.next_queued("p", 0).is_none());
        store.finish("p", "a.ps1", a.run, Some(0), 1);
        assert!(store.next_queued("p", 0).is_none(), "now.ps1 still runs");
        let now = store.info("p", "now.ps1").unwrap();
        store.finish("p", "now.ps1", now.run, Some(0), 1);
        let (queued, b) = store.next_queued("p", 2).unwrap();
        assert_eq!(
            (queued.request.terminal_id.as_str(), b.status),
            ("b.ps1", RunStatus::Running)
        );
        assert_eq!(queued.target, target("p"));
        assert!(store.next_queued("p", 2).is_none(), "b.ps1 runs now");
        store.finish("p", "b.ps1", b.run, Some(0), 3);
        assert_eq!(
            store.next_queued("p", 3).unwrap().0.request.terminal_id,
            "c.ps1"
        );
    }

    #[test]
    fn kill_all_forgets_the_queue() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), true, 0));
        assert_eq!(
            store.start(&target("p"), &request("b.ps1"), true, 0),
            Ok(Begun::Queued)
        );
        assert_eq!(store.clear_queue("p"), 1);
        store.finish("p", "a.ps1", a.run, None, 1);
        assert!(store.next_queued("p", 1).is_none());
    }

    #[test]
    fn finishing_records_the_exit_code_and_time_once() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 5));
        let done = store.finish("p", "a.ps1", a.run, Some(3), 9).unwrap();
        assert_eq!(
            (done.status, done.exit_code, done.ended_at),
            (RunStatus::Finished, Some(3), Some(9))
        );
        assert!(done.rev > a.rev);
        assert!(store.finish("p", "a.ps1", a.run, Some(0), 10).is_none());
    }

    #[test]
    fn an_earlier_run_cannot_finish_or_write_to_the_next() {
        let mut store = RunStore::default();
        let first = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        store.finish("p", "a.ps1", first.run, Some(0), 1);
        let second = started(store.start(&target("p"), &request("a.ps1"), false, 2));
        assert!(
            store
                .append("p", "a.ps1", first.run, "late".into())
                .is_none()
        );
        assert!(store.finish("p", "a.ps1", first.run, Some(1), 3).is_none());
        assert!(store.is_running("p", "a.ps1", second.run));
        assert_eq!(store.output("p", "a.ps1", None, None).unwrap().data, "");
    }

    #[test]
    fn a_new_run_starts_with_empty_output() {
        let mut store = RunStore::default();
        let first = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        store.append("p", "a.ps1", first.run, "old".into());
        store.finish("p", "a.ps1", first.run, Some(0), 1);
        let second = started(store.start(&target("p"), &request("a.ps1"), false, 2));
        let output = store.output("p", "a.ps1", Some(second.run), None).unwrap();
        assert_eq!(
            (output.data.as_str(), output.seq, output.run),
            ("", 0, second.run)
        );
    }

    #[test]
    fn stopping_marks_a_running_script_and_nothing_else() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        assert!(store.mark_stopped("p", "a.ps1").unwrap().stopped);
        assert!(store.mark_stopped("p", "missing").is_none());
        store.finish("p", "a.ps1", a.run, Some(0), 1);
        assert!(store.mark_stopped("p", "a.ps1").is_none());
        assert!(
            store.info("p", "a.ps1").unwrap().stopped,
            "a stopped run stays failed"
        );
    }

    #[test]
    fn interactive_comes_from_how_it_started() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        assert!(
            store
                .set_interactive("p", "a.ps1", a.run, true)
                .unwrap()
                .interactive
        );
        assert!(
            store
                .set_interactive("p", "a.ps1", a.run + 1, true)
                .is_none()
        );
    }

    #[test]
    fn output_is_numbered_and_read_since_a_batch() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        assert_eq!(
            store.append("p", "a.ps1", a.run, "\x1b[32mone\x1b[0m\r\n".into()),
            Some(1)
        );
        assert_eq!(store.append("p", "a.ps1", a.run, "two".into()), Some(2));
        let all = store.output("p", "a.ps1", Some(a.run), None).unwrap();
        assert_eq!(
            (all.data.as_str(), all.seq, all.reset),
            ("\x1b[32mone\x1b[0m\r\ntwo", 2, true)
        );
        let rest = store.output("p", "a.ps1", Some(a.run), Some(1)).unwrap();
        assert_eq!((rest.data.as_str(), rest.reset), ("two", false));
        let none = store.output("p", "a.ps1", Some(a.run), Some(2)).unwrap();
        assert_eq!((none.data.as_str(), none.reset), ("", false));
        // Another run's batch numbers say nothing about this one.
        let other = store
            .output("p", "a.ps1", Some(a.run + 7), Some(1))
            .unwrap();
        assert!(other.reset);
        assert!(store.output("p", "missing", None, None).is_none());
    }

    #[test]
    fn kept_output_is_trimmed_by_size_starting_on_a_new_line() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("big"), false, 0));
        let line = format!("{}\n", "x".repeat(1023));
        for i in 0..3 * 1024 {
            store.append("p", "big", a.run, format!("\x1b[31m{}\x1b[0m{}", i, line));
        }
        let kept = store.output("p", "big", Some(a.run), None).unwrap();
        assert!(kept.data.len() <= MAX_OUTPUT);
        assert!(kept.data.len() as f64 > 1.9 * 1024.0 * 1024.0);
        assert!(kept.data.starts_with("\x1b[31m"));
        // A screen that has only the first batches gets everything kept, to replace its copy.
        assert!(
            store
                .output("p", "big", Some(a.run), Some(1))
                .unwrap()
                .reset
        );
        let latest = store
            .output("p", "big", Some(a.run), Some(kept.seq - 1))
            .unwrap();
        assert!(!latest.reset);
    }

    #[test]
    fn one_large_batch_is_trimmed_to_a_line_start_within_it() {
        let mut output = Output::default();
        let text: String = (0..3000)
            .map(|i| format!("line {:04} {}\n", i, "y".repeat(1000)))
            .collect();
        output.append(text);
        let (kept, _) = output.since(None);
        assert!(kept.len() <= MAX_OUTPUT && kept.len() == output.size);
        assert!(kept.starts_with("line "));
    }

    #[test]
    fn clearing_empties_the_output_and_tells_every_screen() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        store.append("p", "a.ps1", a.run, "GONE".into());
        let cleared = store.clear_output("p", "a.ps1").unwrap();
        assert_eq!(cleared.cleared, 1);
        assert_eq!(store.output("p", "a.ps1", None, None).unwrap().data, "");
        // Batches keep their numbers, so a screen that read up to the clear reads on.
        assert_eq!(store.append("p", "a.ps1", a.run, "next".into()), Some(2));
        assert_eq!(
            store
                .output("p", "a.ps1", Some(a.run), Some(1))
                .unwrap()
                .data,
            "next"
        );
    }

    #[test]
    fn only_finished_terminals_other_than_live_can_be_removed() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        let live = started(store.start(&target("p"), &request("live"), false, 0));
        assert!(!store.remove("p", "a.ps1"));
        store.finish("p", "a.ps1", a.run, Some(0), 1);
        store.finish("p", "live", live.run, Some(0), 1);
        assert!(store.remove("p", "a.ps1"));
        assert!(!store.remove("p", "live"));
        assert!(!store.remove("p", "missing"));
        assert!(!store.remove("nowhere", "a.ps1"));
    }

    #[test]
    fn removing_finished_page_scripts_keeps_running_ones_and_other_scripts() {
        let mut store = RunStore::default();
        let page = |id: &str| RunRequest {
            is_page_script: true,
            ..request(id)
        };
        let done = started(store.start(&target("p"), &page("done"), false, 0));
        store.finish("p", "done", done.run, Some(0), 1);
        started(store.start(&target("p"), &page("running"), false, 0));
        let file = started(store.start(&target("p"), &request("file.ps1"), false, 0));
        store.finish("p", "file.ps1", file.run, Some(0), 1);
        let other = started(store.start(&target("q"), &page("elsewhere"), false, 0));
        store.finish("q", "elsewhere", other.run, Some(0), 1);
        assert_eq!(store.remove_finished_page_scripts("p"), ["done"]);
        let mut left: Vec<String> = store
            .list()
            .into_iter()
            .map(|info| format!("{}/{}", info.project_id, info.id))
            .collect();
        left.sort();
        assert_eq!(left, ["p/file.ps1", "p/running", "q/elsewhere"]);
    }

    #[tokio::test]
    async fn waiting_resolves_when_the_run_ends_or_at_once_if_it_has() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        let waiting = store.wait("p", "a.ps1", a.run);
        store.finish("p", "a.ps1", a.run, Some(2), 1);
        assert_eq!(waiting.await.unwrap().exit_code, Some(2));
        let again = store.wait("p", "a.ps1", a.run);
        assert_eq!(again.await.unwrap().exit_code, Some(2));
        // An earlier run is gone once the terminal runs again.
        started(store.start(&target("p"), &request("a.ps1"), false, 2));
        assert!(store.wait("p", "a.ps1", a.run).await.is_err());
    }

    #[test]
    fn a_scripts_key_works_only_while_its_run_runs() {
        let mut store = RunStore::default();
        let a = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        assert!(store.grant("key".into(), &target("p"), "a.ps1", a.run));
        let grant = store.grant_for("key").unwrap();
        assert_eq!(
            (grant.target, grant.terminal_id.as_str(), grant.run),
            (target("p"), "a.ps1", a.run)
        );
        assert!(store.grant_for("other").is_none());
        store.finish("p", "a.ps1", a.run, Some(0), 1);
        assert!(store.grant_for("key").is_none());
        // A run that is not running gets no key.
        assert!(!store.grant("late".into(), &target("p"), "a.ps1", a.run));
        assert!(!store.grant("none".into(), &target("p"), "missing", 99));
    }

    #[test]
    fn a_key_from_an_earlier_run_stops_when_the_terminal_runs_again() {
        let mut store = RunStore::default();
        let first = started(store.start(&target("p"), &request("a.ps1"), false, 0));
        store.grant("first".into(), &target("p"), "a.ps1", first.run);
        store.mark_stopped("p", "a.ps1");
        let info = store.info("p", "a.ps1").unwrap();
        assert!(info.stopped);
        assert!(
            store.grant_for("first").is_some(),
            "still running until it ends"
        );
        store.finish("p", "a.ps1", first.run, None, 1);
        let second = started(store.start(&target("p"), &request("a.ps1"), false, 2));
        assert!(store.grant_for("first").is_none());
        assert_eq!(
            store.running_run("p", "a.ps1").map(|info| info.run),
            Some(second.run)
        );
    }

    #[test]
    fn the_list_covers_every_project_in_the_order_runs_started() {
        let mut store = RunStore::default();
        started(store.start(&target("q"), &request("b.ps1"), false, 0));
        started(store.start(&target("p"), &request("a.ps1"), false, 0));
        let ids: Vec<String> = store.list().into_iter().map(|info| info.id).collect();
        assert_eq!(ids, ["b.ps1", "a.ps1"]);
    }

    #[tokio::test]
    async fn stop_lets_a_script_that_ends_from_ctrl_c_end_without_forcing() {
        let running = Cell::new(true);
        let forced = Cell::new(false);
        let ctrl_c = async {
            running.set(false);
            Ok(())
        };
        stop_sequence(
            true,
            ctrl_c,
            || running.get(),
            async { forced.set(true) },
            TEST_GRACE,
        )
        .await;
        assert!(!forced.get());
    }

    #[tokio::test]
    async fn stop_forces_a_script_that_ignores_ctrl_c_after_the_grace_period() {
        let sent = Cell::new(false);
        let forced = Cell::new(false);
        let start = std::time::Instant::now();
        let ctrl_c = async {
            sent.set(true);
            Ok(())
        };
        stop_sequence(
            true,
            ctrl_c,
            || true,
            async { forced.set(true) },
            TEST_GRACE,
        )
        .await;
        assert!(sent.get() && forced.get());
        assert!(start.elapsed() >= TEST_GRACE);
    }

    #[tokio::test]
    async fn stop_forces_a_script_without_a_terminal_straight_away() {
        let sent = Cell::new(false);
        let forced = Cell::new(false);
        let start = std::time::Instant::now();
        let ctrl_c = async {
            sent.set(true);
            Ok(())
        };
        stop_sequence(
            false,
            ctrl_c,
            || true,
            async { forced.set(true) },
            TEST_GRACE,
        )
        .await;
        assert!(!sent.get() && forced.get());
        assert!(start.elapsed() < STOP_POLL);
    }

    #[tokio::test]
    async fn stop_forces_a_script_that_ctrl_c_cannot_reach() {
        let forced = Cell::new(false);
        let ctrl_c = async { Err(String::from("The script has finished.")) };
        stop_sequence(
            true,
            ctrl_c,
            || true,
            async { forced.set(true) },
            TEST_GRACE,
        )
        .await;
        assert!(forced.get());
    }
}
