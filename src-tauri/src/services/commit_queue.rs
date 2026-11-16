//! Commit jobs: a commit made from the Git Controller, with its Run Before Commit script, then the commit, then a
//! sync when asked.
//!
//! Rust runs them, rather than the window that made them, so a commit finishes whatever happens to that screen,
//! and every screen sees the same jobs. A job made with Queue on waits for the queued ones before it, and they run
//! one at a time. Without Queue it starts straight away.
//!
//! `CommitStore` holds the jobs and decides everything without Tauri, so it is tested directly. `process` runs a
//! job through `runs` and the git commands, and the window shows its progress from `commit-jobs-changed`.

use crate::prelude::*;
use crate::services::git_controller;
use crate::services::runs::{self, RunRequest, RunTarget, Runs};
use crate::services::terminal_controller::TerminalManager;
use std::collections::VecDeque;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;

/// How many ended jobs are kept, so the Queue tab can say how each went.
const FINISHED_KEPT: usize = 20;
/// The terminal a commit's script runs in, in the project the commit was made in.
pub(crate) const BEFORE_COMMIT_TERMINAL: &str = "Before Commit";

#[derive(Clone, Copy, Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum JobState {
    Queued,
    Script,
    Committing,
    Finished,
}

/// The script a commit runs first. The window builds `content` from the values chosen for its parameters.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobScript {
    pub path: String,
    #[serde(skip_serializing)]
    pub content: String,
}

/// A message about a job, and the theme to show it in: info, success, warning, or danger.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobNote {
    pub text: String,
    pub theme: String,
}

/// How a job ended: Committed, "Committed, not synced", Failed, or Cancelled.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct JobOutcome {
    pub state: String,
    pub text: String,
    pub theme: String,
}

#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitJob {
    pub id: String,
    pub project_id: String,
    pub project_path: String,
    pub project_name: String,
    pub repo: String,
    pub message: String,
    /// The files chosen when the commit was made.
    pub files: Vec<String>,
    /// The files marked to leave out, which stay out even when its script changes them.
    pub excluded: Vec<String>,
    /// The project's ignored files, as `repo/file`.
    #[serde(skip_serializing)]
    pub ignored: Vec<String>,
    pub sync_after: bool,
    pub script: Option<JobScript>,
    pub state: JobState,
    /// Whether it waited in the queue, rather than starting straight away.
    pub queued: bool,
    /// For a job waiting in the queue: its place in it, from 1, and how many jobs run or wait before it.
    pub place: Option<usize>,
    pub ahead: Option<usize>,
    /// What it is doing, as it goes.
    pub note: Option<JobNote>,
    pub outcome: Option<JobOutcome>,
    pub committed: bool,
    pub created_at: u64,
    pub ended_at: Option<u64>,
}

/// The jobs every screen shows: those running, then those queued in order, and those that ended, the latest first.
#[derive(Clone, Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommitJobs {
    /// Raised each time the jobs change, so a screen keeps the newest of two updates.
    pub rev: u64,
    pub active: Vec<CommitJob>,
    pub finished: Vec<CommitJob>,
}

/// What cancelling a job did.
#[derive(Debug, PartialEq)]
pub(crate) enum Cancelled {
    /// It was taken out of the queue.
    Dequeued,
    /// Its script was asked to stop, which ends the job.
    StopScript { project_id: String },
    /// It is committing, has ended, or is unknown.
    No,
}

#[derive(Default, Debug)]
pub(crate) struct CommitStore {
    /// Jobs waiting or running, in the order they were made.
    jobs: Vec<CommitJob>,
    queue: VecDeque<String>,
    /// Whether a queued job is running, so the next waits for it.
    worker_busy: bool,
    finished: VecDeque<CommitJob>,
    rev: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize(path: &str) -> String {
    path.replace('\\', "/")
}

impl CommitStore {
    fn job_mut(&mut self, id: &str) -> Option<&mut CommitJob> {
        self.jobs.iter_mut().find(|job| job.id == id)
    }

    pub fn get(&self, id: &str) -> Option<CommitJob> {
        self.jobs.iter().find(|job| job.id == id).cloned()
    }

    /// Adds a job, refusing one for a repo that already has a commit waiting or running.
    pub fn add(&mut self, mut job: CommitJob, queue: bool) -> Result<(), String> {
        if self.jobs.iter().any(|other| {
            normalize(&other.project_path) == normalize(&job.project_path) && other.repo == job.repo
        }) {
            return Err(String::from(
                "This repo already has a commit waiting or running.",
            ));
        }
        job.state = JobState::Queued;
        job.queued = queue;
        if queue {
            self.queue.push_back(job.id.clone());
        }
        self.jobs.push(job);
        Ok(())
    }

    /// The next queued job, for the queue's worker, unless a queued job is running. With none left, the worker
    /// is done.
    pub fn next_queued(&mut self) -> Option<String> {
        if self.worker_busy {
            return None;
        }
        let next = self.queue.pop_front();
        self.worker_busy = next.is_some();
        next
    }

    /// Called by the worker when its job has ended.
    pub fn worker_done(&mut self) {
        self.worker_busy = false;
    }

    pub fn set_state(&mut self, id: &str, state: JobState, note: Option<JobNote>) {
        if let Some(job) = self.job_mut(id) {
            job.state = state;
            if note.is_some() {
                job.note = note;
            }
        }
    }

    pub fn set_note(&mut self, id: &str, note: JobNote) {
        if let Some(job) = self.job_mut(id) {
            job.note = Some(note);
        }
    }

    /// Ends a job, keeping it among the last few that ended.
    pub fn finish(&mut self, id: &str, outcome: JobOutcome, committed: bool, now: u64) {
        let Some(at) = self.jobs.iter().position(|job| job.id == id) else {
            return;
        };
        let mut job = self.jobs.remove(at);
        self.queue.retain(|queued| queued != id);
        job.state = JobState::Finished;
        job.outcome = Some(outcome);
        job.committed = committed;
        job.ended_at = Some(now);
        job.place = None;
        job.ahead = None;
        self.finished.push_front(job);
        self.finished.truncate(FINISHED_KEPT);
    }

    pub fn cancel(&mut self, id: &str, now: u64) -> Cancelled {
        let Some(job) = self.get(id) else {
            return Cancelled::No;
        };
        match job.state {
            JobState::Script => Cancelled::StopScript {
                project_id: job.project_id,
            },
            JobState::Queued if self.queue.contains(&job.id) => {
                self.finish(
                    id,
                    outcome("Cancelled", "Taken out of the queue.", "info"),
                    false,
                    now,
                );
                Cancelled::Dequeued
            }
            _ => Cancelled::No,
        }
    }

    pub fn snapshot(&self) -> CommitJobs {
        let mut active: Vec<CommitJob> = self
            .jobs
            .iter()
            .filter(|job| !self.queue.contains(&job.id))
            .cloned()
            .collect();
        let running_queued = usize::from(self.worker_busy);
        for (index, id) in self.queue.iter().enumerate() {
            if let Some(mut job) = self.get(id) {
                job.place = Some(index + 1);
                job.ahead = Some(index + running_queued);
                active.push(job);
            }
        }
        CommitJobs {
            rev: self.rev,
            active,
            finished: self.finished.iter().cloned().collect(),
        }
    }
}

fn outcome(state: &str, text: &str, theme: &str) -> JobOutcome {
    JobOutcome {
        state: state.into(),
        text: text.into(),
        theme: theme.into(),
    }
}

fn note(text: impl Into<String>, theme: &str) -> JobNote {
    JobNote {
        text: text.into(),
        theme: theme.into(),
    }
}

/// The file a `git status` style line names, using the new name of a renamed file.
fn change_name(line: &str) -> Option<String> {
    if line.len() < 3 {
        return None;
    }
    let status = &line[..2];
    let name = line[3..].trim();
    let name = match name.split_once(" -> ") {
        Some((_, renamed)) if status.contains('R') => renamed,
        _ => name,
    };
    Some(name.to_string())
}

/// The files a job commits, in the order git lists them: those chosen when it was made, and those its script
/// changed, leaving out the files marked to leave out and the project's ignored files.
fn files_to_commit(changes: &[String], job: &CommitJob, before: Option<&[String]>) -> Vec<String> {
    changes
        .iter()
        .filter_map(|line| change_name(line))
        .filter(|name| !job.ignored.contains(&format!("{}/{}", job.repo, name)))
        .filter(|name| !job.excluded.contains(name))
        .filter(|name| {
            job.files.contains(name) || before.is_some_and(|before| !before.contains(name))
        })
        .collect()
}

/// Why a script stopped the commit, or None when it succeeded.
fn script_failure(path: &str, exit_code: Option<i32>, stopped: bool) -> Option<String> {
    let how = match exit_code {
        Some(0) if !stopped => return None,
        Some(code) if !stopped => format!("failed with exit code {}", code),
        _ => String::from("was stopped"),
    };
    Some(format!(
        "{} {}, so nothing was committed. Its output is in the Terminals panel.",
        path, how
    ))
}

/// The shared commit jobs, managed by Tauri.
#[derive(Default)]
pub(crate) struct CommitQueue(pub Mutex<CommitStore>);

impl CommitQueue {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, CommitStore>, String> {
        self.0
            .lock()
            .map_err(|err| format!("State failure: {}", err))
    }
}

/// Tells every screen the jobs changed.
fn emit_jobs(app: &AppHandle) {
    let jobs = match app.state::<CommitQueue>().lock() {
        Ok(mut store) => {
            store.rev += 1;
            store.snapshot()
        }
        Err(_) => return,
    };
    let _ = app.emit("commit-jobs-changed", jobs);
}

/// Changes a job and tells every screen.
fn update(app: &AppHandle, change: impl FnOnce(&mut CommitStore)) {
    if let Ok(mut store) = app.state::<CommitQueue>().lock() {
        change(&mut store);
    }
    emit_jobs(app);
}

/// The files changed in a job's repo, as `git status` style lines.
async fn changes(app: &AppHandle, job: &CommitJob) -> Result<Vec<String>, String> {
    git_controller::get_git_changes(
        job.repo.clone(),
        Some(job.project_path.clone()),
        app.state(),
        app.state(),
    )
    .await
}

/// Runs a job: its script, then the commit, then a sync when asked. Returns the outcome and whether it committed.
async fn run_job(app: &AppHandle, job: &CommitJob) -> (JobOutcome, bool) {
    let mut before = None;
    if let Some(script) = &job.script {
        update(app, |store| {
            store.set_state(
                &job.id,
                JobState::Script,
                Some(note(
                    format!("Running {} before committing...", script.path),
                    "info",
                )),
            )
        });
        // The files changed before the script runs, so the changes it makes join the commit and no others do.
        before = changes(app, job).await.ok().map(|lines| {
            lines
                .iter()
                .filter_map(|line| change_name(line))
                .collect::<Vec<_>>()
        });
        let target = RunTarget {
            project_id: job.project_id.clone(),
            project_path: job.project_path.clone(),
            project_name: job.project_name.clone(),
        };
        let request = RunRequest {
            terminal_id: BEFORE_COMMIT_TERMINAL.into(),
            script_content: script.content.clone(),
            args: Vec::new(),
            in_separate_window: false,
            is_page_script: false,
            display_script: None,
            cols: None,
            rows: None,
            content_only: false,
        };
        match runs::run_and_wait(app, &target, &request).await {
            Err(err) => {
                let text = format!(
                    "{} could not run, so nothing was committed: {}",
                    script.path, err
                );
                return (outcome("Failed", &text, "danger"), false);
            }
            Ok(run) => {
                if let Some(text) = script_failure(&script.path, run.exit_code, run.stopped) {
                    return (outcome("Failed", &text, "danger"), false);
                }
            }
        }
    }
    update(app, |store| {
        store.set_state(&job.id, JobState::Committing, None)
    });
    let changed = match changes(app, job).await {
        Ok(changed) => changed,
        Err(err) => {
            let text = format!("{} Nothing was committed.", err);
            return (outcome("Failed", &text, "danger"), false);
        }
    };
    let files = files_to_commit(&changed, job, before.as_deref());
    if files.is_empty() {
        return (
            outcome("Failed", "No files are left to commit.", "warning"),
            false,
        );
    }
    let result = match git_controller::git_commit(
        job.repo.clone(),
        files,
        job.message.clone(),
        Some(job.project_path.clone()),
        app.state(),
        app.state(),
    )
    .await
    {
        Ok(result) => result,
        Err(err) => return (outcome("Failed", &err, "danger"), false),
    };
    if !job.sync_after {
        return (outcome("Committed", &result, "success"), true);
    }
    update(app, |store| {
        store.set_note(
            &job.id,
            note("Commit successful. Syncing with remote...", "info"),
        )
    });
    match git_controller::git_sync(
        job.repo.clone(),
        Some(job.project_path.clone()),
        app.state(),
        app.state(),
        app.clone(),
    )
    .await
    {
        Ok(_) => (
            outcome("Committed", "Commit and Sync successful!", "success"),
            true,
        ),
        Err(err) => {
            let text = format!(
                "{} Syncing failed, so sync it from the Git Controller: {}",
                result, err
            );
            (outcome("Committed, not synced", &text, "danger"), true)
        }
    }
}

async fn process(app: AppHandle, id: String) {
    let Some(job) = app
        .state::<CommitQueue>()
        .lock()
        .ok()
        .and_then(|store| store.get(&id))
    else {
        return;
    };
    let (ended, committed) = run_job(&app, &job).await;
    update(&app, |store| store.finish(&id, ended, committed, now_ms()));
}

/// Runs queued jobs one at a time, until the queue is empty.
async fn work_queue(app: AppHandle) {
    loop {
        let next = match app.state::<CommitQueue>().lock() {
            Ok(mut store) => store.next_queued(),
            Err(_) => None,
        };
        let Some(id) = next else {
            return;
        };
        process(app.clone(), id).await;
        if let Ok(mut store) = app.state::<CommitQueue>().lock() {
            store.worker_done();
        }
    }
}

/// Makes a commit in a repo of the open project, or of the saved project at `project` (a path). With `queue`, it
/// waits for the queued commits before it. Returns the job, which runs on whatever happens to the window.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn commit_enqueue(
    app_handle: AppHandle,
    commits: State<'_, CommitQueue>,
    project_state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    project: Option<String>,
    repo: String,
    message: String,
    files: Vec<String>,
    excluded: Vec<String>,
    ignored: Vec<String>,
    sync_after: bool,
    script: Option<JobScript>,
    queue: bool,
) -> Result<CommitJob, String> {
    let message = message.trim().to_string();
    if message.is_empty() {
        return Err(String::from("You forgot to set your message!"));
    }
    if files.is_empty() {
        return Err(String::from("Select at least one file to commit."));
    }
    if !repo.is_empty() {
        safe_relative_path(&repo)?;
    }
    let target = runs::run_target(&project_state, &projects, project.as_deref())?;
    let job = CommitJob {
        id: Uuid::now_v7().to_string(),
        project_id: target.project_id,
        project_path: target.project_path,
        project_name: target.project_name,
        repo,
        message,
        files,
        excluded,
        ignored,
        sync_after,
        script,
        state: JobState::Queued,
        queued: queue,
        place: None,
        ahead: None,
        note: None,
        outcome: None,
        committed: false,
        created_at: now_ms(),
        ended_at: None,
    };
    commits.lock()?.add(job.clone(), queue)?;
    emit_jobs(&app_handle);
    if queue {
        tauri::async_runtime::spawn(work_queue(app_handle.clone()));
    } else {
        tauri::async_runtime::spawn(process(app_handle.clone(), job.id.clone()));
    }
    Ok(commits.lock()?.get(&job.id).unwrap_or(job))
}

/// The commits waiting or running, and the last few that ended.
#[tauri::command]
pub(crate) fn commit_jobs(commits: State<'_, CommitQueue>) -> Result<CommitJobs, String> {
    Ok(commits.lock()?.snapshot())
}

/// Takes a queued commit out of the queue, or stops the script a running one waits on. Returns whether it did.
#[tauri::command]
pub(crate) fn commit_cancel(
    app_handle: AppHandle,
    commits: State<'_, CommitQueue>,
    runs: State<'_, Runs>,
    manager: State<'_, TerminalManager>,
    id: String,
) -> Result<bool, String> {
    let cancelled = commits.lock()?.cancel(&id, now_ms());
    match cancelled {
        Cancelled::Dequeued => {
            emit_jobs(&app_handle);
            Ok(true)
        }
        Cancelled::StopScript { project_id } => {
            runs::stop(
                &app_handle,
                &runs,
                &manager,
                &project_id,
                BEFORE_COMMIT_TERMINAL,
            )?;
            Ok(true)
        }
        Cancelled::No => Ok(false),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, path: &str, repo: &str) -> CommitJob {
        CommitJob {
            id: id.into(),
            project_id: format!("id-{}", path),
            project_path: path.into(),
            project_name: "Repo".into(),
            repo: repo.into(),
            message: "msg".into(),
            files: vec!["a.txt".into(), "b.txt".into(), "c.txt".into()],
            excluded: Vec::new(),
            ignored: Vec::new(),
            sync_after: false,
            script: None,
            state: JobState::Queued,
            queued: false,
            place: None,
            ahead: None,
            note: None,
            outcome: None,
            committed: false,
            created_at: 0,
            ended_at: None,
        }
    }

    fn lines(names: &[&str]) -> Vec<String> {
        names.iter().map(|line| line.to_string()).collect()
    }

    #[test]
    fn a_repo_has_one_commit_waiting_or_running_at_a_time() {
        let mut store = CommitStore::default();
        store.add(job("1", "/repo", ""), false).unwrap();
        assert!(store.add(job("2", "/repo", ""), true).is_err());
        assert!(store.add(job("3", "\\repo", ""), true).is_err());
        store.add(job("4", "/repo", "libs/api"), true).unwrap();
        store.add(job("5", "/other", ""), true).unwrap();
        store.finish(
            "1",
            outcome("Committed", "Commit successful.", "success"),
            true,
            1,
        );
        store.add(job("6", "/repo", ""), false).unwrap();
    }

    #[test]
    fn queued_jobs_run_one_at_a_time_in_order() {
        let mut store = CommitStore::default();
        store.add(job("1", "/repo", ""), true).unwrap();
        store.add(job("2", "/repo", "libs/api"), true).unwrap();
        // A job made without Queue is not in it.
        store.add(job("now", "/other", ""), false).unwrap();
        assert_eq!(store.next_queued().as_deref(), Some("1"));
        assert_eq!(store.next_queued(), None, "1 is running");
        store.finish("1", outcome("Committed", "", "success"), true, 1);
        store.worker_done();
        assert_eq!(store.next_queued().as_deref(), Some("2"));
        store.finish("2", outcome("Committed", "", "success"), true, 2);
        store.worker_done();
        assert_eq!(store.next_queued(), None);
        assert!(!store.worker_busy);
    }

    #[test]
    fn the_snapshot_lists_running_jobs_then_the_queue_with_each_ones_place() {
        let mut store = CommitStore::default();
        store.add(job("1", "/repo", ""), true).unwrap();
        store.add(job("2", "/repo", "libs/api"), true).unwrap();
        store.add(job("3", "/other", ""), true).unwrap();
        store.next_queued();
        store.set_state("1", JobState::Script, Some(note("Running x", "info")));
        let jobs = store.snapshot();
        let shown: Vec<(&str, Option<usize>, Option<usize>)> = jobs
            .active
            .iter()
            .map(|job| (job.id.as_str(), job.place, job.ahead))
            .collect();
        assert_eq!(
            shown,
            [
                ("1", None, None),
                ("2", Some(1), Some(1)),
                ("3", Some(2), Some(2))
            ]
        );
        assert_eq!(jobs.active[0].note, Some(note("Running x", "info")));
        assert!(jobs.finished.is_empty());
    }

    #[test]
    fn cancelling_takes_a_queued_job_out_or_stops_a_running_script() {
        let mut store = CommitStore::default();
        store.add(job("1", "/repo", ""), true).unwrap();
        store.add(job("2", "/repo", "libs/api"), true).unwrap();
        store.next_queued();
        store.set_state("1", JobState::Script, None);
        assert_eq!(store.cancel("2", 5), Cancelled::Dequeued);
        assert_eq!(
            store.cancel("1", 5),
            Cancelled::StopScript {
                project_id: "id-/repo".into()
            }
        );
        store.set_state("1", JobState::Committing, None);
        assert_eq!(store.cancel("1", 5), Cancelled::No);
        assert_eq!(store.cancel("missing", 5), Cancelled::No);
        let ended = &store.snapshot().finished[0];
        assert_eq!((ended.id.as_str(), ended.ended_at), ("2", Some(5)));
        assert_eq!(
            ended.outcome,
            Some(outcome("Cancelled", "Taken out of the queue.", "info"))
        );
        assert_eq!(store.next_queued(), None, "2 left the queue");
    }

    #[test]
    fn a_job_that_started_without_the_queue_cannot_be_dequeued() {
        let mut store = CommitStore::default();
        store.add(job("1", "/repo", ""), false).unwrap();
        assert_eq!(store.cancel("1", 0), Cancelled::No);
    }

    #[test]
    fn only_the_last_jobs_that_ended_are_kept_the_latest_first() {
        let mut store = CommitStore::default();
        for i in 0..FINISHED_KEPT + 5 {
            let id = i.to_string();
            store.add(job(&id, &format!("/p{}", i), ""), false).unwrap();
            store.finish(&id, outcome("Committed", "", "success"), true, i as u64);
        }
        let finished = store.snapshot().finished;
        assert_eq!(finished.len(), FINISHED_KEPT);
        assert_eq!(finished[0].id, (FINISHED_KEPT + 4).to_string());
    }

    #[test]
    fn the_commit_takes_the_chosen_files_and_those_the_script_changed() {
        let mut chosen = job("1", "/repo", "");
        chosen.files = lines(&["a.txt", "c.txt"]);
        chosen.excluded = lines(&["b.txt"]);
        let changes = lines(&[
            " M a.txt",
            "?? b.txt",
            " D c.txt",
            " M a.min.txt",
            " M old.txt",
        ]);
        let before = lines(&["a.txt", "b.txt", "c.txt", "old.txt"]);
        // old.txt changed before the script and was not chosen, so it stays out.
        assert_eq!(
            files_to_commit(&changes, &chosen, Some(&before)),
            ["a.txt", "c.txt", "a.min.txt"]
        );
        // Without a list from before the script, only the chosen files go in.
        assert_eq!(files_to_commit(&changes, &chosen, None), ["a.txt", "c.txt"]);
    }

    #[test]
    fn excluded_and_ignored_files_stay_out_even_when_the_script_changes_them() {
        let mut chosen = job("1", "/repo", "libs/api");
        chosen.files = lines(&["a.txt", "b.txt"]);
        chosen.excluded = lines(&["new.txt"]);
        chosen.ignored = lines(&["libs/api/b.txt", "/a.txt"]);
        let changes = lines(&[" M a.txt", " M b.txt", "?? new.txt"]);
        assert_eq!(files_to_commit(&changes, &chosen, Some(&[])), ["a.txt"]);
    }

    #[test]
    fn a_renamed_file_uses_its_new_name_and_an_arrow_in_a_name_is_kept() {
        assert_eq!(
            change_name("R  old.txt -> new.txt").as_deref(),
            Some("new.txt")
        );
        assert_eq!(change_name(" M a -> b.txt").as_deref(), Some("a -> b.txt"));
        assert_eq!(change_name("?? folder/").as_deref(), Some("folder/"));
        assert_eq!(change_name("M"), None);
    }

    #[test]
    fn a_script_that_failed_or_was_stopped_says_so() {
        assert_eq!(script_failure("Publish.ps1", Some(0), false), None);
        assert_eq!(
            script_failure("Publish.ps1", Some(1), false).unwrap(),
            "Publish.ps1 failed with exit code 1, so nothing was committed. Its output is in the Terminals panel."
        );
        // Stopped counts as stopped whatever PowerShell exits with, and an unknown exit code as stopped.
        for (code, stopped) in [(Some(0), true), (Some(1), true), (None, false)] {
            assert!(
                script_failure("Publish.ps1", code, stopped)
                    .unwrap()
                    .starts_with("Publish.ps1 was stopped,")
            );
        }
    }
}
