//! The Task Manager: the user's own processes on Linux, macOS, and Windows, with which ones run from a terminal,
//! which outlived what started them, the ports they listen on, and the project folder they run in, so a process
//! left behind by a terminal or editor can be found and stopped.
//!
//! It costs nothing until the drawer opens: the process list is kept only while it is open, and dropped when it
//! closes. Each refresh reads only what changes (CPU, memory, status), and names, commands, and folders once per
//! process. Ports take longer to read, so they are read at most every few seconds.
use crate::prelude::*;
use std::collections::HashSet;
use std::time::Instant;
use sysinfo::{
    MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessesToUpdate, Signal, System, UpdateKind,
};

/// Shells, by name without `.exe`. A process started from one of these was started from a terminal.
const SHELLS: [&str; 16] = [
    "bash",
    "zsh",
    "fish",
    "sh",
    "dash",
    "ash",
    "ksh",
    "mksh",
    "tcsh",
    "csh",
    "nu",
    "elvish",
    "xonsh",
    "pwsh",
    "powershell",
    "cmd",
];
/// Reading ports looks at every process's open sockets, so a list this recent is reused.
const PORTS_MAX_AGE: Duration = Duration::from_secs(5);
/// Commands can be very long, such as a compiler's, and the list only needs to show and search them.
const COMMAND_LIMIT: usize = 4000;

/// The Task Manager's state while its drawer is open.
#[derive(Default, Clone)]
pub(crate) struct TaskManagerState(Arc<Mutex<Option<Monitor>>>);

struct Monitor {
    system: System,
    ports: HashMap<u32, Vec<u16>>,
    ports_at: Option<Instant>,
}

impl Monitor {
    fn new() -> Result<Self, String> {
        let mut system =
            System::new().map_err(|err| format!("The process list cannot be read: {}", err))?;
        refresh(&mut system);
        // CPU use is measured between two readings, so the first list already has it.
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        Ok(Self {
            system,
            ports: HashMap::new(),
            ports_at: None,
        })
    }

    fn refresh_ports(&mut self) {
        if self.ports_at.is_some_and(|at| at.elapsed() < PORTS_MAX_AGE) {
            return;
        }
        self.ports.clear();
        if let Ok(listeners) = listeners::get_all() {
            for listener in listeners {
                if listener.protocol != listeners::Protocol::TCP
                    || listener.state != listeners::SocketState::Listen
                {
                    continue;
                }
                let ports = self.ports.entry(listener.process.pid).or_default();
                let port = listener.socket.port();
                if !ports.contains(&port) {
                    ports.push(port);
                }
            }
        }
        self.ports
            .values_mut()
            .for_each(|ports| ports.sort_unstable());
        self.ports_at = Some(Instant::now());
    }
}

/// Reads what changes for every process, and what does not only for processes new since the last reading.
fn refresh(system: &mut System) {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_cpu()
            .with_memory()
            .with_user(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet)
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cwd(UpdateKind::OnlyIfNotSet),
    );
    system.refresh_cpu_usage();
    system.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
}

/// One process as the Task Manager shows it.
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessInfo {
    pid: u32,
    /// None when it has no parent, or its parent has exited.
    parent: Option<u32>,
    name: String,
    command: String,
    exe: String,
    folder: String,
    /// Seconds since 1970, which with the pid names this process and no later one given the same pid.
    started: u64,
    /// Percent of the whole machine, so every process together comes to at most 100.
    cpu: f32,
    memory: u64,
    status: String,
    ports: Vec<u16>,
    /// Started from a shell, as in a terminal or an editor's terminal.
    terminal: bool,
    /// Outlived the process that started it, and was handed to the system.
    orphan: bool,
    /// Task Proxy itself, or started by it, such as a script.
    task_proxy: bool,
    /// The saved project whose folder it runs in.
    project: Option<String>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProcessList {
    processes: Vec<ProcessInfo>,
    cpu_count: usize,
    /// The whole machine's CPU use, in percent.
    cpu: f32,
    memory_total: u64,
    memory_used: u64,
    /// Whether `ports` were read, which only happens when asked for.
    ports_read: bool,
}

/// What the classification needs of a process, apart from sysinfo so it can be tested.
#[derive(Clone, Debug)]
struct Node {
    parent: Option<u32>,
    session: Option<u32>,
    name: String,
    started: u64,
}

type Tree = HashMap<u32, Node>;

/// A process's name without `.exe` or a login shell's leading `-`, in lower case.
fn plain_name(name: &str) -> String {
    let name = name.trim_start_matches('-').to_lowercase();
    name.strip_suffix(".exe")
        .map(str::to_string)
        .unwrap_or(name)
}

fn is_shell(name: &str) -> bool {
    SHELLS.contains(&plain_name(name).as_str())
}

/// The parent, unless it has exited. A parent that started after its child is another process given the same pid.
fn live_parent(tree: &Tree, pid: u32) -> Option<u32> {
    let node = tree.get(&pid)?;
    let parent = node.parent?;
    let found = tree.get(&parent)?;
    (parent != pid && found.started <= node.started).then_some(parent)
}

/// The process's parent, its parent, and so on.
fn ancestors(tree: &Tree, pid: u32) -> Vec<u32> {
    let mut found = Vec::new();
    let mut at = pid;
    while let Some(parent) = live_parent(tree, at) {
        if found.contains(&parent) || parent == pid {
            break;
        }
        found.push(parent);
        at = parent;
    }
    found
}

/// Whether the process belongs to a terminal's session: its leader is a shell, or has exited, as when a terminal
/// is closed. Unix only, since Windows has no sessions.
fn in_terminal_session(tree: &Tree, pid: u32) -> bool {
    let Some(session) = tree.get(&pid).and_then(|node| node.session) else {
        return false;
    };
    if session == pid || session == 0 {
        return false;
    }
    match tree.get(&session) {
        Some(leader) => is_shell(&leader.name),
        None => true,
    }
}

/// Whether a process was started from a terminal: a shell is among its parents, or it is in a terminal's session.
/// A shell itself counts only when another shell started it, so the terminal's own shells stay out.
fn from_terminal(tree: &Tree, pid: u32) -> bool {
    ancestors(tree, pid)
        .iter()
        .any(|parent| tree.get(parent).is_some_and(|node| is_shell(&node.name)))
        || in_terminal_session(tree, pid)
}

/// Whether a process outlived what started it. On Linux and macOS the system adopts it, so its parent is no longer
/// in its terminal's session. On Windows its parent has exited.
fn is_orphan(tree: &Tree, pid: u32) -> bool {
    if cfg!(windows) {
        return tree.get(&pid).is_some_and(|node| node.parent.is_some())
            && live_parent(tree, pid).is_none();
    }
    if !in_terminal_session(tree, pid) {
        return false;
    }
    let session = tree.get(&pid).and_then(|node| node.session);
    match live_parent(tree, pid) {
        Some(parent) => tree.get(&parent).and_then(|node| node.session) != session,
        None => true,
    }
}

/// The processes below this one, the deepest first, so stopping them in order never leaves one without its parent
/// for long. `skip` and anything below it are left out.
fn descendants(tree: &Tree, pid: u32, skip: &HashSet<u32>) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for &child in tree.keys() {
        if let Some(parent) = live_parent(tree, child) {
            children.entry(parent).or_default().push(child);
        }
    }
    let mut found = Vec::new();
    let mut seen = HashSet::from([pid]);
    fn visit(
        at: u32,
        children: &HashMap<u32, Vec<u32>>,
        skip: &HashSet<u32>,
        seen: &mut HashSet<u32>,
        found: &mut Vec<u32>,
    ) {
        for &child in children.get(&at).into_iter().flatten() {
            if skip.contains(&child) || !seen.insert(child) {
                continue;
            }
            visit(child, children, skip, seen, found);
            found.push(child);
        }
    }
    visit(pid, &children, skip, &mut seen, &mut found);
    found
}

/// The saved project a folder is in: the deepest one, when projects are inside each other.
fn project_for(folder: &str, projects: &[Project]) -> Option<String> {
    if folder.is_empty() {
        return None;
    }
    let normalize = |path: &str| path.replace('\\', "/").trim_end_matches('/').to_string();
    let folder = normalize(folder);
    projects
        .iter()
        .filter(|project| {
            let root = normalize(&project.path);
            !root.is_empty() && (folder == root || folder.starts_with(&format!("{}/", root)))
        })
        .max_by_key(|project| project.path.len())
        .map(|project| project.name.clone())
}

/// A command line as it would be typed, with arguments that hold spaces quoted, cut short when very long.
fn join_command(args: &[std::ffi::OsString]) -> String {
    let mut command = String::new();
    for arg in args {
        let arg = arg.to_string_lossy();
        if !command.is_empty() {
            command.push(' ');
        }
        if arg.is_empty() || arg.contains(char::is_whitespace) {
            command.push('"');
            command.push_str(&arg);
            command.push('"');
        } else {
            command.push_str(&arg);
        }
        if command.len() > COMMAND_LIMIT {
            let mut end = COMMAND_LIMIT;
            while !command.is_char_boundary(end) {
                end -= 1;
            }
            command.truncate(end);
            command.push('…');
            break;
        }
    }
    command
}

fn tree_of(system: &System) -> Tree {
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                Node {
                    parent: process.parent().map(Pid::as_u32),
                    session: process.session_id().map(Pid::as_u32),
                    name: process.name().to_string_lossy().into_owned(),
                    started: process.start_time(),
                },
            )
        })
        .collect()
}

/// Task Proxy's own process, and the processes it runs in, which the Task Manager never stops.
fn protected(tree: &Tree) -> (u32, HashSet<u32>) {
    let me = std::process::id();
    let mut set: HashSet<u32> = ancestors(tree, me).into_iter().collect();
    set.insert(me);
    (me, set)
}

/// The user's own processes, the only ones listed or stopped.
fn current_user(system: &System) -> Option<sysinfo::Uid> {
    let me = Pid::from_u32(std::process::id());
    system
        .process(me)
        .and_then(|process| process.user_id())
        .cloned()
}

fn list(monitor: &mut Monitor, projects: &[Project], with_ports: bool) -> ProcessList {
    refresh(&mut monitor.system);
    if with_ports {
        monitor.refresh_ports();
    }
    let system = &monitor.system;
    let tree = tree_of(system);
    let user = current_user(system);
    let (me, _) = protected(&tree);
    let cpu_count = system.cpus().len().max(1);
    let processes = system
        .processes()
        .iter()
        .filter(|(_, process)| user.is_none() || process.user_id() == user.as_ref())
        .map(|(pid, process)| {
            let pid = pid.as_u32();
            let folder = process
                .cwd()
                .map(|path| path.to_string_lossy().into_owned())
                .unwrap_or_default();
            ProcessInfo {
                pid,
                parent: live_parent(&tree, pid),
                name: process.name().to_string_lossy().into_owned(),
                command: join_command(process.cmd()),
                exe: process
                    .exe()
                    .map(|path| path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                project: project_for(&folder, projects),
                folder,
                started: process.start_time(),
                cpu: process.cpu_usage() / cpu_count as f32,
                memory: process.memory(),
                status: process.status().to_string(),
                ports: if with_ports {
                    monitor.ports.get(&pid).cloned().unwrap_or_default()
                } else {
                    Vec::new()
                },
                terminal: from_terminal(&tree, pid),
                orphan: is_orphan(&tree, pid),
                task_proxy: pid == me || ancestors(&tree, pid).contains(&me),
            }
        })
        .collect();
    ProcessList {
        processes,
        cpu_count,
        cpu: system.global_cpu_usage(),
        memory_total: system.total_memory(),
        memory_used: system.used_memory(),
        ports_read: with_ports,
    }
}

/// Lists the user's processes. Ports are read only when `ports` is set, since that takes longer.
#[tauri::command]
pub(crate) async fn list_processes(
    state: State<'_, TaskManagerState>,
    projects: State<'_, SharedProjects>,
    ports: bool,
) -> Result<ProcessList, String> {
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .clone();
    let state = state.inner().clone();
    task::spawn_blocking(move || {
        let mut guard = state
            .0
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if guard.is_none() {
            *guard = Some(Monitor::new()?);
        }
        let monitor = guard.as_mut().ok_or("The process list cannot be read.")?;
        Ok(list(monitor, &known, ports))
    })
    .await
    .map_err(|err| err.to_string())?
}

/// Lets go of the process list when the Task Manager closes, so it costs nothing while closed.
#[tauri::command]
pub(crate) fn close_task_manager(state: State<'_, TaskManagerState>) -> Result<(), String> {
    state
        .0
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .take();
    Ok(())
}

/// Stops a process, and with `children` everything it started, deepest first. `started` must match, so a process
/// that ended and whose pid was given to another is never stopped by mistake. Without `force` each is asked to
/// stop, as Ctrl+C or closing its window would: SIGTERM on Linux and macOS, and on Windows a request to close,
/// which a console program cannot take, so it must be forced. With `force` each is ended at once.
fn stop(
    system: &mut System,
    pid: u32,
    started: u64,
    children: bool,
    force: bool,
) -> Result<String, String> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_user(UpdateKind::OnlyIfNotSet),
    );
    let tree = tree_of(system);
    let (_, protect) = protected(&tree);
    let user = current_user(system);
    let process = system
        .process(Pid::from_u32(pid))
        .filter(|process| process.start_time() == started)
        .ok_or("That process has already ended.")?;
    if user.is_some() && process.user_id() != user.as_ref() {
        return Err("Only your own processes can be stopped.".into());
    }
    if protect.contains(&pid) {
        return Err(
            "Task Proxy runs in that process, so it cannot stop it. Close Task Proxy instead."
                .into(),
        );
    }
    let name = process.name().to_string_lossy().into_owned();
    let mut targets = if children {
        descendants(&tree, pid, &protect)
    } else {
        Vec::new()
    };
    targets.retain(|child| {
        system
            .process(Pid::from_u32(*child))
            .is_some_and(|process| user.is_none() || process.user_id() == user.as_ref())
    });
    targets.push(pid);
    let mut failed = Vec::new();
    for target in &targets {
        let Some(process) = system.process(Pid::from_u32(*target)) else {
            continue;
        };
        let done = if force {
            process.kill()
        } else {
            match process.kill_with(Signal::Term) {
                Some(done) => done,
                None => ask_to_close(*target),
            }
        };
        if !done {
            failed.push(*target);
        }
    }
    let others = targets.len() - 1;
    let what = match others {
        0 => format!("{} ({})", name, pid),
        1 => format!("{} ({}) and 1 process it started", name, pid),
        _ => format!("{} ({}) and {} processes it started", name, pid, others),
    };
    if failed.contains(&pid) || failed.len() == targets.len() {
        return Err(if force {
            format!("{} could not be closed.", what)
        } else if cfg!(windows) {
            format!(
                "{} did not accept a request to close, as console programs cannot. Use Force close.",
                what
            )
        } else {
            format!("{} could not be asked to stop. Use Force close.", what)
        });
    }
    let verb = if force { "Closed" } else { "Asked to stop" };
    if failed.is_empty() {
        Ok(format!("{} {}.", verb, what))
    } else {
        Ok(format!(
            "{} {}, except {} that could not be reached.",
            verb,
            what,
            failed.len()
        ))
    }
}

/// Asks a Windows process to close, as closing its window does.
#[cfg(windows)]
fn ask_to_close(pid: u32) -> bool {
    create_command("taskkill")
        .args(["/PID", &pid.to_string()])
        .output()
        .is_ok_and(|output| output.status.success())
}

#[cfg(not(windows))]
fn ask_to_close(_pid: u32) -> bool {
    false
}

#[tauri::command]
pub(crate) async fn stop_process(
    state: State<'_, TaskManagerState>,
    pid: u32,
    started: u64,
    children: bool,
    force: bool,
) -> Result<String, String> {
    let state = state.inner().clone();
    task::spawn_blocking(move || {
        let mut guard = state
            .0
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if guard.is_none() {
            *guard = Some(Monitor::new()?);
        }
        let monitor = guard.as_mut().ok_or("The process list cannot be read.")?;
        stop(&mut monitor.system, pid, started, children, force)
    })
    .await
    .map_err(|err| err.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(parent: Option<u32>, session: Option<u32>, name: &str, started: u64) -> Node {
        Node {
            parent,
            session,
            name: name.into(),
            started,
        }
    }

    /// systemd (1), a user's service manager (100), an editor (200) with a terminal shell (300) running cargo (400),
    /// which started trunk (500). A daemon (600) started its own session.
    fn sample() -> Tree {
        HashMap::from([
            (1, node(None, Some(1), "systemd", 0)),
            (100, node(Some(1), Some(100), "systemd", 10)),
            (200, node(Some(100), Some(200), "zed", 20)),
            (300, node(Some(200), Some(300), "bash", 30)),
            (400, node(Some(300), Some(300), "cargo", 40)),
            (500, node(Some(400), Some(300), "trunk", 50)),
            (600, node(Some(100), Some(600), "pipewire", 15)),
        ])
    }

    #[test]
    fn processes_started_from_a_shell_are_from_a_terminal_and_the_shell_and_editor_are_not() {
        let tree = sample();
        assert!(from_terminal(&tree, 400));
        assert!(from_terminal(&tree, 500));
        assert!(!from_terminal(&tree, 300), "the terminal's own shell");
        assert!(!from_terminal(&tree, 200));
        assert!(!from_terminal(&tree, 600));
        assert!(
            is_shell("-bash")
                && is_shell("pwsh.exe")
                && is_shell("PowerShell.EXE")
                && !is_shell("bashful")
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn a_process_whose_parent_exited_is_an_orphan_still_from_its_terminal() {
        let mut tree = sample();
        assert!(!is_orphan(&tree, 500));
        // cargo exits, and the user's service manager adopts trunk, which keeps its terminal's session.
        tree.remove(&400);
        tree.get_mut(&500).unwrap().parent = Some(100);
        assert!(is_orphan(&tree, 500));
        assert!(
            from_terminal(&tree, 500),
            "its session is still the terminal's"
        );
        // The terminal closes too, and its session leader is gone.
        tree.remove(&300);
        assert!(is_orphan(&tree, 500));
        assert!(from_terminal(&tree, 500));
        // A daemon in its own session is never an orphan.
        assert!(!is_orphan(&tree, 600));
    }

    #[test]
    fn a_parent_that_started_after_its_child_is_another_process_with_the_same_pid() {
        let mut tree = sample();
        tree.insert(400, node(Some(1), Some(400), "reused", 99));
        assert_eq!(live_parent(&tree, 500), None);
        assert_eq!(ancestors(&tree, 500), Vec::<u32>::new());
        assert_eq!(ancestors(&sample(), 500), vec![400, 300, 200, 100, 1]);
    }

    #[test]
    fn descendants_come_deepest_first_and_leave_out_protected_processes() {
        let tree = sample();
        assert_eq!(descendants(&tree, 300, &HashSet::new()), vec![500, 400]);
        assert_eq!(
            descendants(&tree, 300, &HashSet::from([400])),
            Vec::<u32>::new()
        );
        assert_eq!(descendants(&tree, 500, &HashSet::new()), Vec::<u32>::new());
        // A loop in the parents never repeats.
        let mut looped = sample();
        looped.get_mut(&300).unwrap().parent = Some(500);
        assert_eq!(descendants(&looped, 300, &HashSet::new()).len(), 2);
    }

    #[test]
    fn a_folder_belongs_to_the_deepest_project_it_is_in() {
        let projects = vec![
            Project {
                name: "Outer".into(),
                path: "/work".into(),
            },
            Project {
                name: "Inner".into(),
                path: "/work/app/".into(),
            },
            Project {
                name: "Win".into(),
                path: "C:\\code\\site".into(),
            },
        ];
        assert_eq!(
            project_for("/work/app/src", &projects).as_deref(),
            Some("Inner")
        );
        assert_eq!(
            project_for("/work/other", &projects).as_deref(),
            Some("Outer")
        );
        assert_eq!(project_for("/work", &projects).as_deref(), Some("Outer"));
        assert_eq!(project_for("/workshop", &projects), None);
        assert_eq!(
            project_for("C:\\code\\site\\web", &projects).as_deref(),
            Some("Win")
        );
        assert_eq!(project_for("", &projects), None);
    }

    #[test]
    fn commands_quote_arguments_with_spaces_and_are_cut_short() {
        let args: Vec<std::ffi::OsString> = ["trunk", "serve", "--dist", "my dist", ""]
            .iter()
            .map(Into::into)
            .collect();
        assert_eq!(join_command(&args), r#"trunk serve --dist "my dist" """#);
        let long: Vec<std::ffi::OsString> = vec!["é".repeat(5000).into()];
        let joined = join_command(&long);
        assert!(joined.len() <= COMMAND_LIMIT + 3 && joined.ends_with('…'));
    }

    #[test]
    fn the_list_has_this_process_marked_as_task_proxy_with_its_own_numbers() {
        let mut monitor = Monitor::new().unwrap();
        let listed = list(&mut monitor, &[], false);
        let me = listed
            .processes
            .iter()
            .find(|process| process.pid == std::process::id())
            .unwrap();
        assert!(me.task_proxy);
        assert!(me.memory > 0);
        assert!(listed.memory_total >= listed.memory_used && listed.cpu_count >= 1);
        assert!(
            listed
                .processes
                .iter()
                .all(|process| process.ports.is_empty())
        );
    }

    #[cfg(unix)]
    #[test]
    fn stopping_with_children_ends_the_whole_tree_and_never_this_process() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "sleep 60 & sleep 60; wait"])
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(300));
        let mut monitor = Monitor::new().unwrap();
        let tree = tree_of(&monitor.system);
        let below = descendants(&tree, pid, &HashSet::new());
        assert_eq!(below.len(), 2, "both sleeps");
        let started = tree[&pid].started;
        assert!(
            stop(&mut monitor.system, pid, started + 1, true, false)
                .unwrap_err()
                .contains("already ended")
        );
        assert!(
            stop(
                &mut monitor.system,
                std::process::id(),
                tree[&std::process::id()].started,
                false,
                true
            )
            .unwrap_err()
            .contains("Task Proxy runs in that process")
        );
        let message = stop(&mut monitor.system, pid, started, true, false).unwrap();
        assert!(
            message.contains("and 2 processes it started"),
            "{}",
            message
        );
        child.wait().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        let is_alive = |pid: u32| unsafe { libc::kill(pid as i32, 0) == 0 };
        assert!(below.iter().all(|pid| !is_alive(*pid)));
    }

    #[cfg(unix)]
    #[test]
    fn force_close_ends_a_process_that_ignores_being_asked() {
        let mut child = std::process::Command::new("sh")
            .args(["-c", "trap '' TERM; while true; do sleep 1; done"])
            .spawn()
            .unwrap();
        let pid = child.id();
        std::thread::sleep(Duration::from_millis(300));
        let mut monitor = Monitor::new().unwrap();
        let started = tree_of(&monitor.system)[&pid].started;
        stop(&mut monitor.system, pid, started, false, false).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(child.try_wait().unwrap().is_none(), "it ignored SIGTERM");
        // The name is what the system reports for the shell: bash on macOS, where /bin/sh is bash.
        let message = stop(&mut monitor.system, pid, started, true, true).unwrap();
        assert!(
            message.starts_with("Closed ") && message.contains(&format!("({})", pid)),
            "{}",
            message
        );
        child.wait().unwrap();
    }
}
