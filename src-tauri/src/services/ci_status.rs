//! The result of the CI runs for each repo's last pushed commit, from GitHub Actions or GitLab CI/CD, shown as
//! an icon beside the repo in the project and repo dropdowns.
//!
//! Finding the pushed commit, caching, and the icon are shared. Only asking the server is not, since every
//! Git server has its own API: adding one means a `CiServer` variant, a match in `CiServer::from_remote_url`,
//! and a request in `CiServer::fetch`.
use crate::prelude::*;
use crate::services::git_controller::{
    credentials_for, find_git_repos, other_project_values, selected_repo,
};
use git2::Repository;
use std::sync::LazyLock;
use std::time::Instant;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CiState {
    Running,
    Success,
    Failure,
}

/// The combined result of the CI runs for one commit.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CiStatus {
    pub state: CiState,
    /// The service's name, for the icon's title, such as "GitHub Actions".
    pub service: String,
    /// A page about the run, for the one that decided the state.
    pub url: String,
}

/// A server that reports CI results for commits, found from a remote URL.
#[derive(Clone, Debug, PartialEq)]
enum CiServer {
    GitHub {
        owner: String,
        repo: String,
    },
    /// A project on gitlab.com, or on a self-hosted server whose name starts with `gitlab.`.
    /// `path` is the full project path, which can include subgroups, as in group/subgroup/project.
    GitLab {
        host: String,
        path: String,
    },
}

impl CiServer {
    fn from_remote_url(url: &str) -> Option<Self> {
        let (host, path) = host_and_path(url)?;
        let host = host.to_ascii_lowercase();
        let path = path.trim_matches('/');
        let path = path.strip_suffix(".git").unwrap_or(path);
        let parts: Vec<&str> = path.split('/').collect();
        if parts.len() < 2 || parts.iter().any(|part| part.is_empty()) {
            return None;
        }
        match host.as_str() {
            "github.com" | "www.github.com" if parts.len() == 2 => Some(CiServer::GitHub {
                owner: parts[0].to_string(),
                repo: parts[1].to_string(),
            }),
            _ if is_gitlab_host(&host) => Some(CiServer::GitLab {
                host,
                path: parts.join("/"),
            }),
            _ => None,
        }
    }

    fn key(&self) -> String {
        match self {
            CiServer::GitHub { owner, repo } => format!("github:{}/{}", owner, repo),
            CiServer::GitLab { host, path } => format!("gitlab:{}/{}", host, path),
        }
    }

    /// Asks the server for the runs on a commit. `None` when it has none, or cannot say.
    async fn fetch(&self, sha: &str, token: Option<String>) -> Option<CiStatus> {
        match self {
            CiServer::GitHub { owner, repo } => {
                let url = format!(
                    "https://api.github.com/repos/{}/{}/actions/runs?head_sha={}&per_page=100",
                    owner, repo, sha
                );
                let headers = [
                    ("Accept", "application/vnd.github+json"),
                    ("X-GitHub-Api-Version", "2022-11-28"),
                ];
                let body = get_json(&url, &headers, token).await?;
                summarize_github_runs(&body)
            }
            CiServer::GitLab { host, path } => {
                // Project paths only hold letters, digits, '-', '_' and '.', so only the slashes need encoding.
                let url = format!(
                    "https://{}/api/v4/projects/{}/pipelines?sha={}&per_page=100",
                    host,
                    path.replace('/', "%2F"),
                    sha
                );
                let body = get_json(&url, &[("Accept", "application/json")], token).await?;
                summarize_gitlab_pipelines(&body)
            }
        }
    }
}

/// gitlab.com, or a self-hosted server named like gitlab.example.com. Other self-hosted names cannot be told
/// apart from any other Git server by their URL.
fn is_gitlab_host(host: &str) -> bool {
    host == "gitlab.com" || host == "www.gitlab.com" || host.starts_with("gitlab.")
}

/// The host and the path after it, from an https or ssh remote URL, leaving out any user or token.
fn host_and_path(url: &str) -> Option<(String, String)> {
    let url = url.trim();
    if let Some(rest) = url.split_once("://").map(|(_, rest)| rest) {
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit('@').next()?;
        let host = host.split(':').next()?;
        return Some((host.to_string(), path.to_string()));
    }
    // The scp-like form, as in git@github.com:owner/repo.git
    let (authority, path) = url.split_once(':')?;
    let host = authority.rsplit('@').next()?;
    if host.is_empty() || host.contains('/') {
        return None;
    }
    Some((host.to_string(), path.to_string()))
}

/// GitHub Actions runs for one commit, combined: running while any run is unfinished, then failed when any
/// failed, then passed when any passed.
fn summarize_github_runs(body: &Value) -> Option<CiStatus> {
    let runs = body.get("workflow_runs")?.as_array()?;
    let field = |run: &Value, name: &str| {
        run.get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let status = |state: CiState, run: &Value| CiStatus {
        state,
        service: String::from("GitHub Actions"),
        url: field(run, "html_url"),
    };
    if let Some(run) = runs.iter().find(|run| field(run, "status") != "completed") {
        return Some(status(CiState::Running, run));
    }
    let failed = ["failure", "timed_out", "startup_failure", "action_required"];
    if let Some(run) = runs
        .iter()
        .find(|run| failed.contains(&field(run, "conclusion").as_str()))
    {
        return Some(status(CiState::Failure, run));
    }
    runs.iter()
        .find(|run| field(run, "conclusion") == "success")
        .map(|run| status(CiState::Success, run))
}

/// GitLab pipelines for one commit, combined the same way as GitHub's runs. Only the newest pipeline for each
/// ref counts, since a pipeline that is run again replaces the old one, as on GitLab's own commit page.
/// Pipelines GitLab Duo runs for itself, on refs under refs/workloads/, are not about the push and are left out.
fn summarize_gitlab_pipelines(body: &Value) -> Option<CiStatus> {
    let mut pipelines: Vec<&Value> = body.as_array()?.iter().collect();
    let id = |pipeline: &Value| pipeline.get("id").and_then(Value::as_u64).unwrap_or(0);
    let field = |pipeline: &Value, name: &str| {
        pipeline
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    pipelines.sort_by_key(|pipeline| std::cmp::Reverse(id(pipeline)));
    let mut refs = Vec::new();
    pipelines.retain(|pipeline| {
        let name = field(pipeline, "ref");
        if name.starts_with("refs/workloads/") || refs.contains(&name) {
            return false;
        }
        refs.push(name);
        true
    });
    let status = |state: CiState, pipeline: &Value| CiStatus {
        state,
        service: String::from("GitLab CI/CD"),
        url: field(pipeline, "web_url"),
    };
    let find = |states: &[&str]| {
        pipelines
            .iter()
            .find(|pipeline| states.contains(&field(pipeline, "status").as_str()))
            .copied()
    };
    // canceled, skipped, and manual (waiting for someone to start a job) neither pass nor fail.
    let running = [
        "created",
        "waiting_for_resource",
        "preparing",
        "pending",
        "running",
        "scheduled",
    ];
    if let Some(pipeline) = find(&running) {
        return Some(status(CiState::Running, pipeline));
    }
    if let Some(pipeline) = find(&["failed"]) {
        return Some(status(CiState::Failure, pipeline));
    }
    find(&["success"]).map(|pipeline| status(CiState::Success, pipeline))
}

static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    // The updater sets this up the same way, and whichever runs first installs it.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent("TaskProxy")
        .timeout(Duration::from_secs(15))
        .build()
        .ok()
});

/// Reads a JSON response. A token the server refuses is dropped and the request made again, since the
/// token may be for another server and a public repo needs none.
async fn get_json(url: &str, headers: &[(&str, &str)], token: Option<String>) -> Option<Value> {
    let client = CLIENT.as_ref()?;
    let request = |token: Option<&str>| {
        let mut request = client.get(url);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        request.send()
    };
    let mut response = request(token.as_deref()).await.ok()?;
    if token.is_some() && response.status() == reqwest::StatusCode::UNAUTHORIZED {
        response = request(None).await.ok()?;
    }
    if !response.status().is_success() {
        return None;
    }
    response.json().await.ok()
}

/// How long to wait before asking again about a commit whose runs are unfinished or not started yet.
/// Finished results do not change, so they are kept.
const RECHECK: Duration = Duration::from_secs(60);
const CACHE_LIMIT: usize = 500;

/// When each commit's result was found, and the result, by server, repo, and commit.
type CiCache = HashMap<String, (Instant, Option<CiStatus>)>;
static CACHE: LazyLock<Mutex<CiCache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn is_fresh(status: &Option<CiStatus>, age: Duration) -> bool {
    match status {
        Some(CiStatus {
            state: CiState::Success | CiState::Failure,
            ..
        }) => true,
        _ => age < RECHECK,
    }
}

async fn cached_status(server: &CiServer, sha: &str, token: Option<String>) -> Option<CiStatus> {
    let key = format!("{}@{}", server.key(), sha);
    if let Ok(cache) = CACHE.lock()
        && let Some((when, status)) = cache.get(&key)
        && is_fresh(status, when.elapsed())
    {
        return status.clone();
    }
    let status = server.fetch(sha, token).await;
    if let Ok(mut cache) = CACHE.lock() {
        if cache.len() >= CACHE_LIMIT {
            cache.clear();
        }
        cache.insert(key, (Instant::now(), status.clone()));
    }
    status
}

/// The server for a repo's origin, and the commit its branch last pushed: the tip of the branch it tracks.
fn pushed_commit(path: &Path) -> Option<(CiServer, String)> {
    let repository = Repository::open(path).ok()?;
    let remote = repository.find_remote("origin").ok()?;
    let server = CiServer::from_remote_url(remote.url()?)?;
    let head = repository.head().ok()?;
    if !head.is_branch() {
        return None;
    }
    let branch = repository
        .find_branch(head.shorthand()?, git2::BranchType::Local)
        .ok()?;
    let sha = branch.upstream().ok()?.get().target()?.to_string();
    Some((server, sha))
}

async fn repo_ci_status(
    root: PathBuf,
    repo: String,
    token: impl Fn() -> Option<String>,
) -> Option<CiStatus> {
    let found = task::spawn_blocking(move || pushed_commit(&root.join(repo)))
        .await
        .ok()??;
    cached_status(&found.0, &found.1, token()).await
}

/// The CI result for each saved project's selected repo, by project path. Projects with no result are left out.
#[tauri::command]
pub(crate) async fn get_project_ci_status(
    current_repo: Option<String>,
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
) -> Result<HashMap<String, CiStatus>, String> {
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .clone();
    let (current_path, current_data) = {
        let current = state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        (current.path.replace('\\', "/"), current.data.clone())
    };
    let mut statuses = HashMap::new();
    for project in known {
        let path = project.path.replace('\\', "/");
        let other = other_project_values(&app_handle, &state, Some(&path)).await?;
        let selected = if path == current_path {
            current_repo
                .clone()
                .or_else(|| selected_repo(&current_data))
        } else {
            other.as_ref().and_then(selected_repo)
        };
        let root = PathBuf::from(&path);
        let repos = {
            let root = root.clone();
            task::spawn_blocking(move || find_git_repos(&root))
                .await
                .map_err(|err| format!("{}", err))?
        };
        // As the Git Controller does: the selected repo, or the first when none is chosen or it is gone.
        let Some(repo) = selected
            .filter(|selected| repos.contains(selected))
            .or_else(|| repos.first().cloned())
        else {
            continue;
        };
        let token = credentials_for(app_handle.clone(), other);
        if let Some(status) = repo_ci_status(root, repo, token).await {
            statuses.insert(project.path, status);
        }
    }
    Ok(statuses)
}

/// The CI result for each repo in the open project, by repo. Repos with no result are left out.
#[tauri::command]
pub(crate) async fn get_git_repo_ci_status(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
) -> Result<HashMap<String, CiStatus>, String> {
    let root = {
        let current = state
            .lock()
            .map_err(|err| format!("State failure: {}", err))?;
        if current.path.is_empty() {
            return Err(String::from("Project not loaded."));
        }
        PathBuf::from(&current.path)
    };
    let repos = {
        let root = root.clone();
        task::spawn_blocking(move || find_git_repos(&root))
            .await
            .map_err(|err| format!("{}", err))?
    };
    let mut statuses = HashMap::new();
    for repo in repos {
        let token = credentials_for(app_handle.clone(), None);
        if let Some(status) = repo_ci_status(root.clone(), repo.clone(), token).await {
            statuses.insert(repo, status);
        }
    }
    Ok(statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn github(owner: &str, repo: &str) -> Option<CiServer> {
        Some(CiServer::GitHub {
            owner: owner.into(),
            repo: repo.into(),
        })
    }

    #[test]
    fn github_remotes_are_found_in_every_url_form() {
        for url in [
            "https://github.com/StoicDreams/TaskProxyApp.git",
            "https://github.com/StoicDreams/TaskProxyApp",
            "https://github.com/StoicDreams/TaskProxyApp/",
            "https://user:token@github.com/StoicDreams/TaskProxyApp.git",
            "git@github.com:StoicDreams/TaskProxyApp.git",
            "ssh://git@github.com/StoicDreams/TaskProxyApp.git",
            "ssh://git@github.com:22/StoicDreams/TaskProxyApp",
            "https://GitHub.com/StoicDreams/TaskProxyApp",
        ] {
            assert_eq!(
                CiServer::from_remote_url(url),
                github("StoicDreams", "TaskProxyApp"),
                "{}",
                url
            );
        }
    }

    fn gitlab(host: &str, path: &str) -> Option<CiServer> {
        Some(CiServer::GitLab {
            host: host.into(),
            path: path.into(),
        })
    }

    #[test]
    fn gitlab_remotes_are_found_with_subgroups_and_self_hosted_servers() {
        for (url, expected) in [
            (
                "https://gitlab.com/group/project.git",
                gitlab("gitlab.com", "group/project"),
            ),
            (
                "git@gitlab.com:group/sub/project.git",
                gitlab("gitlab.com", "group/sub/project"),
            ),
            (
                "https://oauth2:token@GitLab.com/group/sub/deeper/project",
                gitlab("gitlab.com", "group/sub/deeper/project"),
            ),
            (
                "ssh://git@gitlab.example.com:2222/team/app.git",
                gitlab("gitlab.example.com", "team/app"),
            ),
        ] {
            assert_eq!(CiServer::from_remote_url(url), expected, "{}", url);
        }
    }

    #[test]
    fn other_servers_and_odd_paths_have_no_ci_server() {
        for url in [
            "https://bitbucket.org/team/project.git",
            "https://git.example.com/team/project.git",
            "https://mygitlab.example.com/team/project.git",
            "https://gitlab.com/group",
            "https://gitlab.com/group//project",
            "https://github.com/StoicDreams",
            "https://github.com/a/b/c",
            "/home/me/upstream",
            "C:/repos/upstream",
            "",
        ] {
            assert_eq!(CiServer::from_remote_url(url), None, "{}", url);
        }
    }

    fn runs(list: &[(&str, &str)]) -> Value {
        let runs: Vec<Value> = list
            .iter()
            .enumerate()
            .map(|(index, (status, conclusion))| {
                json!({ "status": status, "conclusion": conclusion, "html_url": format!("run/{}", index) })
            })
            .collect();
        json!({ "total_count": runs.len(), "workflow_runs": runs })
    }

    fn state(list: &[(&str, &str)]) -> Option<(CiState, String)> {
        summarize_github_runs(&runs(list)).map(|status| (status.state, status.url))
    }

    #[test]
    fn github_runs_combine_into_one_result() {
        assert_eq!(state(&[]), None);
        assert_eq!(
            state(&[("completed", "success"), ("in_progress", "")]),
            Some((CiState::Running, "run/1".into()))
        );
        assert_eq!(
            state(&[("queued", ""), ("completed", "failure")]),
            Some((CiState::Running, "run/0".into()))
        );
        assert_eq!(
            state(&[("completed", "success"), ("completed", "failure")]),
            Some((CiState::Failure, "run/1".into()))
        );
        assert_eq!(
            state(&[("completed", "timed_out")]).map(|found| found.0),
            Some(CiState::Failure)
        );
        assert_eq!(
            state(&[("completed", "skipped"), ("completed", "success")]),
            Some((CiState::Success, "run/1".into()))
        );
        assert_eq!(state(&[("completed", "cancelled")]), None);
        assert_eq!(
            summarize_github_runs(&json!({ "message": "Not Found" })),
            None
        );
    }

    fn gitlab_state(list: &[(u64, &str, &str)]) -> Option<(CiState, String)> {
        let pipelines: Vec<Value> = list
            .iter()
            .map(|(id, reference, status)| {
                json!({ "id": id, "ref": reference, "status": status, "web_url": format!("pipeline/{}", id) })
            })
            .collect();
        summarize_gitlab_pipelines(&json!(pipelines)).map(|status| (status.state, status.url))
    }

    #[test]
    fn gitlab_pipelines_combine_into_one_result() {
        assert_eq!(gitlab_state(&[]), None);
        assert_eq!(
            gitlab_state(&[(1, "main", "success"), (2, "dev", "pending")]),
            Some((CiState::Running, "pipeline/2".into()))
        );
        assert_eq!(
            gitlab_state(&[(1, "main", "success"), (2, "dev", "failed")]),
            Some((CiState::Failure, "pipeline/2".into()))
        );
        // A newer pipeline on the same ref replaces the failed one, whatever order they come in.
        assert_eq!(
            gitlab_state(&[(5, "main", "success"), (3, "main", "failed")]),
            Some((CiState::Success, "pipeline/5".into()))
        );
        assert_eq!(
            gitlab_state(&[(3, "main", "success"), (5, "main", "failed")]),
            Some((CiState::Failure, "pipeline/5".into()))
        );
        assert_eq!(
            gitlab_state(&[(1, "main", "success"), (2, "refs/workloads/0f5e", "failed")]),
            Some((CiState::Success, "pipeline/1".into()))
        );
        assert_eq!(gitlab_state(&[(1, "main", "canceled")]), None);
        assert_eq!(gitlab_state(&[(1, "main", "manual")]), None);
        assert_eq!(
            summarize_gitlab_pipelines(&json!({ "message": "404 Project Not Found" })),
            None
        );
    }

    #[test]
    fn finished_results_are_kept_and_others_checked_again() {
        let status = |state| {
            Some(CiStatus {
                state,
                service: String::new(),
                url: String::new(),
            })
        };
        let long = RECHECK * 10;
        assert!(is_fresh(&status(CiState::Success), long));
        assert!(is_fresh(&status(CiState::Failure), long));
        assert!(!is_fresh(&status(CiState::Running), long));
        assert!(!is_fresh(&None, long));
        assert!(is_fresh(&None, Duration::from_secs(1)));
    }

    fn commit_file(repo: &Repository, name: &str, text: &str) -> git2::Oid {
        std::fs::write(repo.workdir().unwrap().join(name), text).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(name)).unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "commit",
            &tree,
            &parents,
        )
        .unwrap()
    }

    #[test]
    fn the_pushed_commit_is_the_tracked_branch_not_local_commits() {
        let dir = tempfile::tempdir().unwrap();
        let upstream = Repository::init(dir.path().join("upstream")).unwrap();
        let pushed = commit_file(&upstream, "a.txt", "one\n");
        let local_path = dir.path().join("local");
        let local =
            Repository::clone(dir.path().join("upstream").to_str().unwrap(), &local_path).unwrap();
        // A local path is not a CI server, so nothing is found until origin points at GitHub.
        assert_eq!(pushed_commit(&local_path), None);
        local
            .remote_set_url("origin", "https://github.com/owner/name.git")
            .unwrap();
        commit_file(&local, "b.txt", "not pushed\n");
        assert_eq!(
            pushed_commit(&local_path),
            Some((github("owner", "name").unwrap(), pushed.to_string()))
        );
    }
}

#[cfg(test)]
mod network_tests {
    use super::*;

    /// Asks GitHub about this repo's pushed commit. Run with: cargo test -p taskproxy -- --ignored github_answers
    #[tokio::test]
    #[ignore = "needs network access"]
    async fn github_answers_for_this_repos_pushed_commit() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .to_path_buf();
        let (server, sha) = pushed_commit(&root).expect("this repo tracks a GitHub branch");
        let status = server.fetch(&sha, None).await;
        println!("{} @ {}: {:?}", server.key(), sha, status);
        assert!(status.is_some(), "GitHub returned no runs for {}", sha);
    }

    /// Asks gitlab.com about the newest commit on a public project's default branch.
    /// Run with: cargo test -p taskproxy -- --ignored gitlab_answers
    #[tokio::test]
    #[ignore = "needs network access"]
    async fn gitlab_answers_for_a_public_projects_commit() {
        let server = CiServer::from_remote_url("https://gitlab.com/gitlab-org/gitlab-runner.git")
            .expect("a GitLab project");
        let commit = get_json(
            "https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-runner/repository/commits/main",
            &[],
            None,
        )
        .await
        .expect("gitlab.com answers");
        let sha = commit["id"].as_str().expect("a commit id");
        let status = server.fetch(sha, None).await;
        println!("{} @ {}: {:?}", server.key(), sha, status);
        assert!(status.is_some(), "GitLab returned no pipelines for {}", sha);
    }
}
