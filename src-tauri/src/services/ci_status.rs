//! The result of the CI runs for each repo's last pushed commit, such as GitHub Actions, shown as an icon
//! beside the repo in the project and repo dropdowns.
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
    GitHub { owner: String, repo: String },
}

impl CiServer {
    fn from_remote_url(url: &str) -> Option<Self> {
        let (host, path) = host_and_path(url)?;
        let mut parts = path.trim_matches('/').split('/');
        let owner = parts.next().filter(|part| !part.is_empty())?;
        let repo = parts.next()?.trim_end_matches(".git");
        if repo.is_empty() || parts.next().is_some() {
            return None;
        }
        match host.to_ascii_lowercase().as_str() {
            "github.com" | "www.github.com" => Some(CiServer::GitHub {
                owner: owner.to_string(),
                repo: repo.to_string(),
            }),
            _ => None,
        }
    }

    fn key(&self) -> String {
        match self {
            CiServer::GitHub { owner, repo } => format!("github:{}/{}", owner, repo),
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
                let body = get_json(&url, token).await?;
                summarize_github_runs(&body)
            }
        }
    }
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
async fn get_json(url: &str, token: Option<String>) -> Option<Value> {
    let client = CLIENT.as_ref()?;
    let request = |token: Option<&str>| {
        let mut request = client
            .get(url)
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
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

    #[test]
    fn other_servers_and_odd_paths_have_no_ci_server() {
        for url in [
            "https://gitlab.com/group/project.git",
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
}
