//! How much of the computer the scripts Task Proxy runs may use: their priority, and how many CPU threads. The
//! choices are app data (`app-script-performance`, set on Settings' Performance tab), read each time a script starts,
//! and applied to its process right after it starts, so everything the script then starts inherits them.
//!
//! - Linux: each of the script's threads is limited to the first threads Task Proxy itself may use, and lowered with
//!   nice, or for Lowest the idle scheduling class, which programs such as Chromium keep when they raise their own.
//! - Windows: the process's affinity mask and priority class, which processes it starts inherit.
//! - macOS: priority only, as macOS has no way to limit a process to some CPU threads.
use crate::prelude::*;

/// The app data key holding the choices.
pub(crate) const SETTINGS_KEY: &str = "app-script-performance";

/// How a script's priority is lowered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Priority {
    /// As any program the user starts.
    #[default]
    Normal,
    /// Below other programs, so the computer stays responsive.
    Low,
    /// Only CPU time nothing else wants.
    Lowest,
}

/// The choices, as saved in app data. `threads` of 0 means every thread Task Proxy may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ScriptPerformance {
    pub(crate) priority: Priority,
    pub(crate) threads: usize,
}

impl ScriptPerformance {
    /// The choices in an app data value, with anything missing or unreadable left at Normal and every thread.
    pub(crate) fn from_value(value: Option<&Value>) -> Self {
        value
            .and_then(|value| serde_json::from_value(value.clone()).ok())
            .unwrap_or_default()
    }

    /// Whether anything is limited at all.
    fn limits(&self, available: usize) -> bool {
        self.priority != Priority::Normal || (self.threads > 0 && self.threads < available)
    }
}

/// What this computer offers, for the Performance tab.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PerformanceInfo {
    /// The CPU threads Task Proxy may use, which scripts can be limited to some of.
    pub(crate) threads: usize,
    /// Whether scripts can be limited to some threads here (not on macOS).
    pub(crate) can_limit_threads: bool,
    /// Whether Lowest uses only spare CPU time (Linux's idle class, Windows' idle priority) rather than the lowest nice.
    pub(crate) has_idle_priority: bool,
}

/// The CPU threads Task Proxy itself may use, which scripts are limited to the first of.
fn allowed_cpus() -> Vec<usize> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: the set is zeroed and its size passed with it.
        unsafe {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            if libc::sched_getaffinity(0, std::mem::size_of::<libc::cpu_set_t>(), &mut set) == 0 {
                let cpus: Vec<usize> = (0..libc::CPU_SETSIZE as usize)
                    .filter(|&cpu| libc::CPU_ISSET(cpu, &set))
                    .collect();
                if !cpus.is_empty() {
                    return cpus;
                }
            }
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessAffinityMask};
        let mut process_mask = 0usize;
        let mut system_mask = 0usize;
        // SAFETY: the current process's pseudo handle needs no closing, and both masks are written by the call.
        if unsafe {
            GetProcessAffinityMask(GetCurrentProcess(), &mut process_mask, &mut system_mask)
        } != 0
        {
            let cpus: Vec<usize> = (0..usize::BITS as usize)
                .filter(|bit| process_mask & (1usize << bit) != 0)
                .collect();
            if !cpus.is_empty() {
                return cpus;
            }
        }
    }
    let count = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    (0..count).collect()
}

/// The threads a script may use: the first `threads` of those allowed, or all of them for 0 or too many.
fn chosen_cpus(allowed: &[usize], threads: usize) -> Vec<usize> {
    if threads == 0 || threads >= allowed.len() {
        allowed.to_vec()
    } else {
        allowed[..threads].to_vec()
    }
}

/// The nice value a priority lowers a script to, where nice is how priority is set.
fn nice_for(priority: Priority) -> Option<i32> {
    match priority {
        Priority::Normal => None,
        Priority::Low => Some(10),
        Priority::Lowest => Some(19),
    }
}

/// What the Performance tab shows about this computer.
#[tauri::command]
pub(crate) fn script_performance_info() -> PerformanceInfo {
    PerformanceInfo {
        threads: allowed_cpus().len(),
        can_limit_threads: cfg!(any(target_os = "linux", windows)),
        has_idle_priority: cfg!(any(target_os = "linux", windows)),
    }
}

/// The choices saved in the app's data now.
pub(crate) fn current(app_handle: &AppHandle) -> ScriptPerformance {
    get_state_data::<TaskProxyData>(app_handle)
        .map(|data| ScriptPerformance::from_value(data.data.get(SETTINGS_KEY)))
        .unwrap_or_default()
}

/// Applies the saved choices to a script that has just started. A script whose limits cannot be set still runs.
pub(crate) fn apply_saved(app_handle: &AppHandle, process_id: Option<u32>) {
    let Some(process_id) = process_id else {
        return;
    };
    let settings = current(app_handle);
    if !settings.limits(allowed_cpus().len()) {
        return;
    }
    if let Err(err) = apply(process_id, settings) {
        eprintln!("Could not limit script {}: {}", process_id, err);
    }
    // Threads a script starts before its limits are set keep running unlimited, so look again a little later.
    #[cfg(target_os = "linux")]
    std::thread::spawn(move || {
        for wait in [50, 450] {
            std::thread::sleep(Duration::from_millis(wait));
            let _ = apply(process_id, settings);
        }
    });
}

/// Limits a process, and on Linux each of its threads and the processes it has started.
pub(crate) fn apply(process_id: u32, settings: ScriptPerformance) -> Result<(), String> {
    let cpus = chosen_cpus(&allowed_cpus(), settings.threads);
    platform::apply(process_id, settings.priority, &cpus)
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::collections::HashSet;

    /// A process's threads, and the processes they started.
    fn tasks_and_children(process_id: u32) -> (Vec<u32>, Vec<u32>) {
        let mut tasks = Vec::new();
        let mut children = Vec::new();
        if let Ok(entries) = fs::read_dir(format!("/proc/{}/task", process_id)) {
            for entry in entries.flatten() {
                let Some(tid) = entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.parse::<u32>().ok())
                else {
                    continue;
                };
                tasks.push(tid);
                if let Ok(list) = fs::read_to_string(entry.path().join("children")) {
                    children.extend(
                        list.split_whitespace()
                            .filter_map(|pid| pid.parse::<u32>().ok()),
                    );
                }
            }
        }
        (tasks, children)
    }

    fn limit_thread(tid: u32, priority: Priority, cpus: &[usize]) -> Result<(), String> {
        // SAFETY: the set is zeroed, filled with CPU numbers below CPU_SETSIZE, and passed with its size.
        unsafe {
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            for &cpu in cpus.iter().filter(|&&cpu| cpu < libc::CPU_SETSIZE as usize) {
                libc::CPU_SET(cpu, &mut set);
            }
            if libc::sched_setaffinity(
                tid as libc::pid_t,
                std::mem::size_of::<libc::cpu_set_t>(),
                &set,
            ) != 0
            {
                return Err(format!("affinity: {}", io::Error::last_os_error()));
            }
            if priority == Priority::Lowest {
                let param = libc::sched_param { sched_priority: 0 };
                // Not every kernel offers the idle class, so nice below still lowers it.
                let _ = libc::sched_setscheduler(tid as libc::pid_t, libc::SCHED_IDLE, &param);
            }
            if let Some(nice) = nice_for(priority)
                && libc::setpriority(libc::PRIO_PROCESS, tid as libc::id_t, nice) != 0
            {
                return Err(format!("priority: {}", io::Error::last_os_error()));
            }
        }
        Ok(())
    }

    pub(super) fn apply(process_id: u32, priority: Priority, cpus: &[usize]) -> Result<(), String> {
        let mut pending = vec![process_id];
        let mut seen = HashSet::new();
        let mut first_error = None;
        while let Some(pid) = pending.pop() {
            if !seen.insert(pid) {
                continue;
            }
            let (tasks, children) = tasks_and_children(pid);
            for tid in if tasks.is_empty() { vec![pid] } else { tasks } {
                if let Err(err) = limit_thread(tid, priority, cpus)
                    && pid == process_id
                {
                    first_error.get_or_insert(err);
                }
            }
            pending.extend(children);
        }
        first_error.map_or(Ok(()), Err)
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        BELOW_NORMAL_PRIORITY_CLASS, IDLE_PRIORITY_CLASS, OpenProcess,
        PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, SetPriorityClass,
        SetProcessAffinityMask,
    };

    pub(super) fn apply(process_id: u32, priority: Priority, cpus: &[usize]) -> Result<(), String> {
        let mask = cpus
            .iter()
            .filter(|&&cpu| cpu < usize::BITS as usize)
            .fold(0usize, |mask, &cpu| mask | (1usize << cpu));
        // SAFETY: the handle is checked before use and closed after.
        unsafe {
            let handle = OpenProcess(
                PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION,
                0,
                process_id,
            );
            if handle.is_null() {
                return Err(io::Error::last_os_error().to_string());
            }
            let mut result = Ok(());
            if mask != 0 && SetProcessAffinityMask(handle, mask) == 0 {
                result = Err(format!("affinity: {}", io::Error::last_os_error()));
            }
            let class = match priority {
                Priority::Normal => None,
                Priority::Low => Some(BELOW_NORMAL_PRIORITY_CLASS),
                Priority::Lowest => Some(IDLE_PRIORITY_CLASS),
            };
            if let Some(class) = class
                && SetPriorityClass(handle, class) == 0
            {
                result = Err(format!("priority: {}", io::Error::last_os_error()));
            }
            CloseHandle(handle);
            result
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    use super::*;

    /// macOS cannot keep a process to some CPU threads, so only its priority is set.
    pub(super) fn apply(
        process_id: u32,
        priority: Priority,
        _cpus: &[usize],
    ) -> Result<(), String> {
        if let Some(nice) = nice_for(priority) {
            // SAFETY: setpriority only reads its arguments.
            if unsafe { libc::setpriority(libc::PRIO_PROCESS, process_id as libc::id_t, nice) } != 0
            {
                return Err(io::Error::last_os_error().to_string());
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn missing_or_unreadable_choices_are_normal_with_every_thread() {
        assert_eq!(
            ScriptPerformance::from_value(None),
            ScriptPerformance::default()
        );
        assert_eq!(
            ScriptPerformance::from_value(Some(&json!("fast"))),
            ScriptPerformance::default()
        );
        assert_eq!(
            ScriptPerformance::from_value(Some(&json!({ "priority": "lowest" }))),
            ScriptPerformance {
                priority: Priority::Lowest,
                threads: 0
            }
        );
        assert_eq!(
            ScriptPerformance::from_value(Some(&json!({ "priority": "low", "threads": 4 }))),
            ScriptPerformance {
                priority: Priority::Low,
                threads: 4
            }
        );
    }

    #[test]
    fn a_script_gets_the_first_threads_allowed_or_all_of_them() {
        let allowed = [0, 2, 3, 5, 8];
        assert_eq!(chosen_cpus(&allowed, 0), allowed.to_vec());
        assert_eq!(chosen_cpus(&allowed, 2), vec![0, 2]);
        assert_eq!(chosen_cpus(&allowed, 9), allowed.to_vec());
    }

    #[test]
    fn nothing_is_limited_at_normal_with_every_thread() {
        assert!(
            !ScriptPerformance {
                priority: Priority::Normal,
                threads: 0
            }
            .limits(12)
        );
        assert!(
            !ScriptPerformance {
                priority: Priority::Normal,
                threads: 12
            }
            .limits(12)
        );
        assert!(
            ScriptPerformance {
                priority: Priority::Normal,
                threads: 6
            }
            .limits(12)
        );
        assert!(
            ScriptPerformance {
                priority: Priority::Low,
                threads: 0
            }
            .limits(12)
        );
    }

    #[test]
    fn the_info_names_the_threads_task_proxy_may_use() {
        let info = script_performance_info();
        assert_eq!(info.threads, allowed_cpus().len());
        assert!(info.threads >= 1);
    }

    /// Reads a Linux process's nice value, scheduling class, and the CPUs it may run on.
    #[cfg(target_os = "linux")]
    fn limits_of(pid: u32) -> (i32, i32, Vec<usize>) {
        // SAFETY: getpriority, sched_getscheduler and sched_getaffinity only write the zeroed set passed with its size.
        unsafe {
            let nice = libc::getpriority(libc::PRIO_PROCESS, pid as libc::id_t);
            let class = libc::sched_getscheduler(pid as libc::pid_t);
            let mut set: libc::cpu_set_t = std::mem::zeroed();
            libc::sched_getaffinity(
                pid as libc::pid_t,
                std::mem::size_of::<libc::cpu_set_t>(),
                &mut set,
            );
            let cpus = (0..libc::CPU_SETSIZE as usize)
                .filter(|&cpu| libc::CPU_ISSET(cpu, &set))
                .collect();
            (nice, class, cpus)
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_limited_script_and_what_it_starts_afterwards_keep_to_its_threads_and_priority() {
        let allowed = allowed_cpus();
        let threads = if allowed.len() > 1 { 1 } else { 0 };
        let expected = chosen_cpus(&allowed, threads);
        // The shell starts its second sleep after the limits are set, as a script starts its tools. The true after it
        // keeps the shell from running that sleep in its own place.
        let mut script = std::process::Command::new("sh")
            .args(["-c", "sleep 0.3; sleep 5; true"])
            .spawn()
            .unwrap();
        apply(
            script.id(),
            ScriptPerformance {
                priority: Priority::Lowest,
                threads,
            },
        )
        .unwrap();
        let (nice, class, cpus) = limits_of(script.id());
        assert_eq!((nice, cpus.clone()), (19, expected.clone()));
        assert!(class == libc::SCHED_IDLE || class == libc::SCHED_OTHER);
        let started_after = (0..50)
            .find_map(|_| {
                std::thread::sleep(Duration::from_millis(50));
                fs::read_to_string(format!(
                    "/proc/{}/task/{}/children",
                    script.id(),
                    script.id()
                ))
                .ok()
                .and_then(|list| {
                    list.split_whitespace()
                        .next()
                        .and_then(|pid| pid.parse::<u32>().ok())
                })
                .filter(|&pid| {
                    fs::read_to_string(format!("/proc/{}/cmdline", pid))
                        .is_ok_and(|cmd| cmd.contains('5'))
                })
            })
            .expect("the script started its second sleep");
        let (child_nice, _, child_cpus) = limits_of(started_after);
        assert_eq!((child_nice, child_cpus), (19, expected));
        let _ = script.kill();
        let _ = script.wait();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn normal_with_every_thread_leaves_a_script_as_it_started() {
        let mut script = std::process::Command::new("sleep")
            .arg("5")
            .spawn()
            .unwrap();
        apply(script.id(), ScriptPerformance::default()).unwrap();
        let (nice, _, cpus) = limits_of(script.id());
        assert_eq!(
            (nice, cpus),
            (limits_of(std::process::id()).0, allowed_cpus())
        );
        let _ = script.kill();
        let _ = script.wait();
    }
}
