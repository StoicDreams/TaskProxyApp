use crate::prelude::*;
use git2::{Cred, FetchOptions, PushOptions, RemoteCallbacks, Repository};

const CREDENTIALS_ERROR: &str = "Credentials Missing/Invalid";
const LOCAL_CHANGES_ERROR: &str =
    "Local changes would be overwritten. Commit or stash them first, then try again.";

fn get_repo_path(state: &State<'_, CurrentProject>, repo: &str) -> Result<PathBuf, String> {
    let project_state = state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?;
    if project_state.path.is_empty() {
        return Err(String::from("Project not loaded."));
    }
    let mut path = PathBuf::from(&project_state.path);
    if !repo.is_empty() {
        path.push(safe_relative_path(repo)?);
    }
    Ok(path)
}

/// The root of the project a command is for: the open project, or another saved project the UI names,
/// such as one a commit started in before the user switched away.
fn project_root(current: &str, known: &[Project], wanted: Option<&str>) -> Result<PathBuf, String> {
    let normalize = |path: &str| path.replace('\\', "/");
    let Some(wanted) = wanted.map(normalize) else {
        if current.is_empty() {
            return Err(String::from("Project not loaded."));
        }
        return Ok(PathBuf::from(current));
    };
    if wanted.is_empty() {
        return Err(String::from("Project not loaded."));
    }
    if normalize(current) == wanted
        || known
            .iter()
            .any(|project| normalize(&project.path) == wanted)
    {
        return Ok(PathBuf::from(wanted));
    }
    Err(format!("{} is not one of your projects.", wanted))
}

fn get_project_repo_path(
    state: &State<'_, CurrentProject>,
    projects: &State<'_, SharedProjects>,
    project: Option<&str>,
    repo: &str,
) -> Result<PathBuf, String> {
    if project.is_none() {
        return get_repo_path(state, repo);
    }
    let current = state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .path
        .clone();
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .clone();
    let mut path = project_root(&current, &known, project)?;
    if !repo.is_empty() {
        path.push(safe_relative_path(repo)?);
    }
    Ok(path)
}

const PAT_KEYS: [&str; 2] = ["git_pat", "github_pat"];

/// The first token saved under one of the token variables.
fn token_in(data: &HashMap<String, Value>) -> Option<String> {
    PAT_KEYS.iter().find_map(|key| {
        data.get(*key)
            .and_then(|value| value.as_str())
            .filter(|token| !token.is_empty())
            .map(String::from)
    })
}

fn global_git_credentials(app_handle: &AppHandle) -> Option<String> {
    crate::appdata::get_state_data::<TaskProxyData>(app_handle)
        .ok()
        .and_then(|global| token_in(&global.data))
}

fn get_git_credentials(app_handle: &AppHandle) -> Option<String> {
    crate::appdata::get_state_data::<ProjectData>(app_handle)
        .ok()
        .and_then(|project| token_in(&project.data))
        .or_else(|| global_git_credentials(app_handle))
}

/// The saved variable values of the project a command names, when that is not the open project.
async fn other_project_values(
    app_handle: &AppHandle,
    state: &State<'_, CurrentProject>,
    project: Option<&str>,
) -> Result<Option<HashMap<String, Value>>, String> {
    let Some(project) = project.map(|path| path.replace('\\', "/")) else {
        return Ok(None);
    };
    let current = state
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .path
        .replace('\\', "/");
    if current == project {
        return Ok(None);
    }
    let values =
        get_data_from_local_storage(app_handle, &format!("{}.enc", get_hash_code(&project)))
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<HashMap<String, Value>>(&bytes).ok())
            .unwrap_or_default();
    Ok(Some(values))
}

/// Finds the token for a command: the named project's own token, or the open project's, then the global one.
fn credentials_for(
    app_handle: AppHandle,
    other_project: Option<HashMap<String, Value>>,
) -> impl Fn() -> Option<String> {
    move || match &other_project {
        Some(values) => token_in(values).or_else(|| global_git_credentials(&app_handle)),
        None => get_git_credentials(&app_handle),
    }
}

/// Helper to construct Git2 remote callbacks for authentication injections.
fn create_remote_callbacks<'a>(token: impl Fn() -> Option<String> + 'a) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    // libgit2 asks again when a server rejects a credential, so a second request means it failed.
    let mut already_tried = false;
    callbacks.credentials(move |_url, username_from_url, _allowed_types| {
        if already_tried {
            return Err(git2::Error::from_str(CREDENTIALS_ERROR));
        }
        already_tried = true;
        if let Some(token) = token() {
            Cred::userpass_plaintext(username_from_url.unwrap_or("git"), &token)
        } else {
            Err(git2::Error::from_str(CREDENTIALS_ERROR))
        }
    });
    callbacks
}

/// Errors with this text make the UI ask for a new token.
fn remote_error(err: git2::Error) -> String {
    let message = err.message();
    if err.code() == git2::ErrorCode::Auth
        || message.contains(CREDENTIALS_ERROR)
        || message.contains("authentication replays")
    {
        String::from(CREDENTIALS_ERROR)
    } else {
        err.to_string()
    }
}

fn checkout_error(err: git2::Error) -> String {
    if err.code() == git2::ErrorCode::Conflict {
        String::from(LOCAL_CHANGES_ERROR)
    } else {
        err.to_string()
    }
}

/// Git itself reads paths as patterns, where `[id].tsx` would also match `i.tsx`.
fn escape_pathspec(path: &str) -> String {
    let mut escaped = String::with_capacity(path.len());
    for c in path.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\') {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    escaped
}

/// Update the working tree to a commit. Fails without changing anything if that would
/// overwrite uncommitted changes.
fn checkout_commit_safely(repository: &Repository, commit: &git2::Commit) -> Result<(), String> {
    repository
        .checkout_tree(
            commit.as_object(),
            Some(git2::build::CheckoutBuilder::new().safe()),
        )
        .map_err(checkout_error)
}

/// The working tree must be updated first, so a refused checkout leaves the branch where it was.
fn fast_forward(repository: &Repository, refname: &str, target: git2::Oid) -> Result<(), String> {
    let commit = repository.find_commit(target).map_err(|e| e.to_string())?;
    checkout_commit_safely(repository, &commit)?;
    repository
        .find_reference(refname)
        .map_err(|e| e.to_string())?
        .set_target(target, "Fast-Forward")
        .map_err(|e| e.to_string())?;
    repository.set_head(refname).map_err(|e| e.to_string())
}

/// Merge into HEAD and commit the result. Uncommitted changes are never overwritten.
fn merge_and_commit(
    repository: &Repository,
    their_commit: &git2::AnnotatedCommit,
    message: &str,
    conflict_message: &str,
) -> Result<(), String> {
    let mut checkout = git2::build::CheckoutBuilder::new();
    checkout.safe().allow_conflicts(true);
    repository
        .merge(&[their_commit], None, Some(&mut checkout))
        .map_err(checkout_error)?;
    let mut index = repository.index().map_err(|e| e.to_string())?;
    if index.has_conflicts() {
        return Err(conflict_message.to_string());
    }
    let oid = index.write_tree().map_err(|e| e.to_string())?;
    let tree = repository.find_tree(oid).map_err(|e| e.to_string())?;
    let signature = repository
        .signature()
        .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
        .map_err(|e| e.to_string())?;
    let head_commit = repository
        .head()
        .map_err(|e| e.to_string())?
        .peel_to_commit()
        .map_err(|e| e.to_string())?;
    let their_commit = repository
        .find_commit(their_commit.id())
        .map_err(|e| e.to_string())?;
    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &[&head_commit, &their_commit],
        )
        .map_err(|e| e.to_string())?;
    repository.cleanup_state().map_err(|e| e.to_string())
}

/// Integrate the fetched remote branch into the current branch.
fn integrate_remote_branch(repository: &Repository, branch_name: &str) -> Result<String, String> {
    let remote_ref_name = format!("refs/remotes/origin/{}", branch_name);
    let fetch_head = repository
        .find_reference(&remote_ref_name)
        .or_else(|_| repository.find_reference("FETCH_HEAD"))
        .map_err(|e| e.to_string())?;
    let fetch_commit = repository
        .reference_to_annotated_commit(&fetch_head)
        .map_err(|e| e.to_string())?;
    let analysis = repository
        .merge_analysis(&[&fetch_commit])
        .map_err(|e| e.to_string())?;
    if analysis.0.is_up_to_date() {
        Ok(String::from("Already up to date."))
    } else if analysis.0.is_fast_forward() {
        fast_forward(
            repository,
            &format!("refs/heads/{}", branch_name),
            fetch_commit.id(),
        )?;
        Ok(String::from("Fast-forward pull successful."))
    } else if analysis.0.is_normal() {
        let message = format!(
            "Merge remote-tracking branch 'origin/{}' into {}",
            branch_name, branch_name
        );
        merge_and_commit(
            repository,
            &fetch_commit,
            &message,
            "Pull resulted in conflicts. Please resolve them manually in your editor.",
        )?;
        Ok(String::from("Pull and merge successful."))
    } else {
        Err(String::from("Merge type not supported."))
    }
}

fn merge_branch_into_head(repository: &Repository, branch: &str) -> Result<String, String> {
    let mut reference = repository
        .resolve_reference_from_short_name(branch)
        .map_err(|e| e.to_string())?;
    if !branch.contains('/') {
        let remote_branch_name = format!("origin/{}", branch);
        if let Ok(remote_ref) = repository.resolve_reference_from_short_name(&remote_branch_name) {
            if let (Some(local_oid), Some(remote_oid)) = (reference.target(), remote_ref.target()) {
                if local_oid != remote_oid {
                    if let Ok((_ahead, behind)) =
                        repository.graph_ahead_behind(local_oid, remote_oid)
                    {
                        if behind > 0 {
                            reference = remote_ref;
                        }
                    }
                }
            }
        }
    }
    let annotated_commit = repository
        .reference_to_annotated_commit(&reference)
        .map_err(|e| e.to_string())?;
    let analysis = repository
        .merge_analysis(&[&annotated_commit])
        .map_err(|e| e.to_string())?;
    if analysis.0.is_up_to_date() {
        Ok(String::from("Already up to date."))
    } else if analysis.0.is_fast_forward() {
        let head_ref = repository.head().map_err(|e| e.to_string())?;
        if !head_ref.is_branch() {
            return Err(String::from("Cannot merge while no branch is checked out."));
        }
        let refname = head_ref
            .name()
            .ok_or("Invalid current branch name")?
            .to_string();
        fast_forward(repository, &refname, annotated_commit.id())?;
        Ok(String::from("Fast-forward merge successful."))
    } else if analysis.0.is_normal() {
        let head_name = repository
            .head()
            .map_err(|e| e.to_string())?
            .shorthand()
            .unwrap_or("HEAD")
            .to_string();
        let message = format!("Merge branch '{}' into '{}'", branch, head_name);
        merge_and_commit(
            repository,
            &annotated_commit,
            &message,
            "Merge resulted in conflicts. Please resolve them manually in your editor.",
        )?;
        Ok(String::from("Merge successful."))
    } else {
        Err(String::from("Merge type not supported."))
    }
}

fn switch_to_reference(
    repository: &Repository,
    refname: &str,
    commit: &git2::Commit,
) -> Result<(), String> {
    checkout_commit_safely(repository, commit)?;
    repository.set_head(refname).map_err(|e| e.to_string())
}

fn switch_branch(repository: &Repository, branch: &str) -> Result<String, String> {
    if let Ok(mut local) = repository.find_branch(branch, git2::BranchType::Local) {
        if local.upstream().is_err() {
            let upstream_candidate = format!("origin/{}", branch);
            if repository
                .find_branch(&upstream_candidate, git2::BranchType::Remote)
                .is_ok()
            {
                let _ = local.set_upstream(Some(&upstream_candidate));
            }
        }
        let commit = local.get().peel_to_commit().map_err(|e| e.to_string())?;
        let refname = local
            .get()
            .name()
            .ok_or("Invalid local branch reference")?
            .to_string();
        switch_to_reference(repository, &refname, &commit)?;
    } else if let Ok(remote) = repository.find_branch(branch, git2::BranchType::Remote) {
        let local_name = branch.split_once('/').map_or(branch, |(_, name)| name);
        // An existing local branch may hold unpushed commits, so it is used as it is.
        if let Ok(mut local) = repository.find_branch(local_name, git2::BranchType::Local) {
            if local.upstream().is_err() {
                let _ = local.set_upstream(Some(branch));
            }
            let commit = local.get().peel_to_commit().map_err(|e| e.to_string())?;
            let refname = local
                .get()
                .name()
                .ok_or("Invalid local branch reference")?
                .to_string();
            switch_to_reference(repository, &refname, &commit)?;
        } else {
            let commit = remote.get().peel_to_commit().map_err(|e| e.to_string())?;
            let mut local = repository
                .branch(local_name, &commit, false)
                .map_err(|e| e.to_string())?;
            let _ = local.set_upstream(Some(branch));
            let refname = local
                .get()
                .name()
                .ok_or("Invalid local branch reference")?
                .to_string();
            if let Err(err) = switch_to_reference(repository, &refname, &commit) {
                let _ = local.delete();
                return Err(err);
            }
        }
    } else {
        return Err(format!("Branch not found: {}", branch));
    }
    Ok(String::from("Branch switched successfully."))
}

fn restore_file(repository: &Repository, file: &str) -> Result<String, String> {
    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder.path(escape_pathspec(file)).force();
    repository
        .checkout_head(Some(&mut checkout_builder))
        .map_err(|e| e.to_string())?;
    Ok(format!("Successfully reverted {}", file))
}

fn file_diff(repository: &Repository, file: &str) -> Result<String, String> {
    let tree = match repository.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(|e| e.to_string())?),
        Err(_) => None,
    };
    let mut diff_opts = git2::DiffOptions::new();
    diff_opts.pathspec(file).disable_pathspec_match(true);
    let diff = repository
        .diff_tree_to_workdir(tree.as_ref(), Some(&mut diff_opts))
        .map_err(|e| e.to_string())?;
    let mut diff_text = String::new();
    diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        let origin = line.origin();
        if origin == '+' || origin == '-' || origin == ' ' {
            diff_text.push(origin);
        }
        // Lines that are not valid UTF-8 must still show, or the diff would look shorter than it is.
        diff_text.push_str(&String::from_utf8_lossy(line.content()));
        true
    })
    .map_err(|e| e.to_string())?;
    Ok(diff_text)
}

/// Push and confirm the server accepted it. A server rejection is only reported per
/// reference through a callback, the push call itself still succeeds.
fn push_refspec(
    remote: &mut git2::Remote,
    refspec: &str,
    token: impl Fn() -> Option<String>,
) -> Result<(), String> {
    let rejections = Arc::new(Mutex::new(Vec::new()));
    let recorded = rejections.clone();
    let mut callbacks = create_remote_callbacks(token);
    callbacks.push_update_reference(move |refname, status| {
        if let (Some(status), Ok(mut recorded)) = (status, recorded.lock()) {
            recorded.push(format!("{}: {}", refname, status));
        }
        Ok(())
    });
    let mut push_options = PushOptions::new();
    push_options.remote_callbacks(callbacks);
    remote
        .push(&[refspec], Some(&mut push_options))
        .map_err(remote_error)?;
    let rejections = rejections
        .lock()
        .map_err(|err| format!("Push result failure: {}", err))?;
    if rejections.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Push rejected by remote. {}",
            rejections.join("; ")
        ))
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchDetail {
    pub name: String,
    pub is_current: bool,
    pub updated_date: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitBranchInfo {
    pub branches: Vec<GitBranchDetail>,
    pub current_branch: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitRemoteStatus {
    pub has_upstream: bool,
    pub upstream_name: String,
    pub ahead: u32,
    pub behind: u32,
    pub remote_url: String,
}

/// Lines added and removed in one changed file, compared with the last commit.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GitFileLineStats {
    pub path: String,
    pub additions: usize,
    pub deletions: usize,
    pub binary: bool,
}

#[tauri::command]
pub(crate) async fn git_push(
    repo: String,
    project: Option<String>,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_project_repo_path(&state, &projects, project.as_deref(), &repo)?;
    let other_project = other_project_values(&app_handle, &state, project.as_deref()).await?;
    let token = credentials_for(app_handle, other_project);
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let refspec = format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name);
        push_refspec(&mut remote, &refspec, token)?;
        if let Ok(mut local_branch) = repository.find_branch(branch_name, git2::BranchType::Local) {
            let upstream_name = format!("origin/{}", branch_name);
            let _ = local_branch.set_upstream(Some(&upstream_name));
        }
        Ok(String::from("Push Successful"))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_pull(
    repo: String,
    project: Option<String>,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_project_repo_path(&state, &projects, project.as_deref(), &repo)?;
    let other_project = other_project_values(&app_handle, &state, project.as_deref()).await?;
    let token = credentials_for(app_handle, other_project);
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let local_branch = repository
            .find_branch(branch_name, git2::BranchType::Local)
            .map_err(|e| e.to_string())?;
        if local_branch.upstream().is_err() {
            return Ok(String::from(
                "No remote tracking branch set. Skipping pull.",
            ));
        }
        let callbacks = create_remote_callbacks(token);
        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        let refspec = format!(
            "+refs/heads/{}:refs/remotes/origin/{}",
            branch_name, branch_name
        );
        remote
            .fetch(&[&refspec], Some(&mut fetch_options), None)
            .map_err(remote_error)?;
        integrate_remote_branch(&repository, branch_name)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_pull_overwrite(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let local_branch = repository
            .find_branch(branch_name, git2::BranchType::Local)
            .map_err(|e| e.to_string())?;
        if local_branch.upstream().is_err() {
            return Ok(String::from(
                "No remote tracking branch set. Skipping pull overwrite.",
            ));
        }
        let callbacks = create_remote_callbacks(|| get_git_credentials(&app_handle_clone));
        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        let refspec = format!(
            "+refs/heads/{}:refs/remotes/origin/{}",
            branch_name, branch_name
        );
        remote
            .fetch(&[&refspec], Some(&mut fetch_options), None)
            .map_err(remote_error)?;
        let fetch_head_name = format!("refs/remotes/origin/{}", branch_name);
        let fetch_commit = repository
            .find_reference(&fetch_head_name)
            .map_err(|e| e.to_string())?
            .peel_to_commit()
            .map_err(|e| e.to_string())?;
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.force();
        repository
            .reset(
                fetch_commit.as_object(),
                git2::ResetType::Hard,
                Some(&mut checkout_builder),
            )
            .map_err(|e| e.to_string())?;

        Ok(format!(
            "Successfully pulled and overwrote local branch '{}'",
            branch_name
        ))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_sync(
    repo: String,
    project: Option<String>,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let pull = git_pull(
        repo.clone(),
        project.clone(),
        state.clone(),
        projects.clone(),
        app_handle.clone(),
    )
    .await?;
    let push = git_push(repo, project, state, projects, app_handle).await?;
    Ok(format!("{}\n{}", pull, push))
}

#[tauri::command]
pub(crate) async fn git_commit(
    repo: String,
    files: Vec<String>,
    message: String,
    project: Option<String>,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
) -> Result<String, String> {
    let git_path = get_project_repo_path(&state, &projects, project.as_deref(), &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        commit_files(&repository, &git_path, &files, &message)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

fn commit_files(
    repository: &Repository,
    git_path: &Path,
    files: &[String],
    message: &str,
) -> Result<String, String> {
    let merge_head_path = repository.path().join("MERGE_HEAD");
    let is_merging = merge_head_path.exists();
    let mut index = repository.index().map_err(|e| e.to_string())?;
    if !is_merging {
        if let Ok(head) = repository.head() {
            if let Ok(tree) = head.peel_to_tree() {
                let _ = index.read_tree(&tree);
            }
        } else {
            let _ = index.clear();
        }
    }
    // Checked before staging anything, because staging a file also clears its conflict.
    let conflicts: Vec<PathBuf> = if is_merging && index.has_conflicts() {
        index
            .conflicts()
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|c| {
                c.our
                    .or(c.their)
                    .or(c.ancestor)
                    .and_then(|entry| String::from_utf8(entry.path).ok())
                    .map(PathBuf::from)
            })
            .collect()
    } else {
        Vec::new()
    };
    for rel_path in &conflicts {
        if let Ok(content) = fs::read_to_string(git_path.join(rel_path)) {
            if content.contains("<<<<<<<")
                && content.contains("=======")
                && content.contains(">>>>>>>")
            {
                return Err(format!(
                    "Conflict markers still present in {}",
                    rel_path.display()
                ));
            }
        }
    }
    for file in files {
        let file_path = safe_relative_path(file)?;
        let file_path = file_path.as_path();
        // A broken symbolic link does not "exist", though it is a file to add.
        if fs::symlink_metadata(git_path.join(file_path)).is_ok() {
            index
                .add_path(file_path)
                .map_err(|e| format!("Failed to add file: {}", e))?;
        } else {
            let _ = index.remove_path(file_path);
        }
    }
    // A merge cannot be committed while any file is left unresolved, selected or not.
    for rel_path in conflicts {
        if fs::symlink_metadata(git_path.join(&rel_path)).is_ok() {
            index
                .add_path(&rel_path)
                .map_err(|e| format!("Failed to stage resolved file: {}", e))?;
        } else {
            let _ = index.remove_path(&rel_path);
        }
    }
    let oid = index.write_tree().map_err(|e| e.to_string())?;
    let mut parent_commits = Vec::new();
    if let Ok(head) = repository.head() {
        if let Ok(commit) = head.peel_to_commit() {
            parent_commits.push(commit);
        }
    }
    // Finishing a merge records the merge itself, so it can have no changes of its own.
    if !is_merging {
        let unchanged = match parent_commits.first() {
            Some(parent) => parent.tree_id() == oid,
            None => index.is_empty(),
        };
        if unchanged {
            // Put back the index, which still holds the staged changes of files left out.
            let _ = index.read(true);
            return Err(String::from("There are no changes to commit."));
        }
    }
    index.write().map_err(|e| e.to_string())?;
    let signature = repository
        .signature()
        .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
        .map_err(|e| e.to_string())?;
    if is_merging {
        let merge_head_content = fs::read_to_string(&merge_head_path).unwrap_or_default();
        for line in merge_head_content.lines() {
            if let Ok(oid) = git2::Oid::from_str(line.trim()) {
                if let Ok(commit) = repository.find_commit(oid) {
                    parent_commits.push(commit);
                }
            }
        }
    }
    let tree = repository.find_tree(oid).map_err(|e| e.to_string())?;
    let parents: Vec<&git2::Commit> = parent_commits.iter().collect();
    repository
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .map_err(|e| e.to_string())?;
    if is_merging {
        let _ = repository.cleanup_state();
    }
    Ok(String::from("Commit successful."))
}

#[tauri::command]
pub(crate) async fn get_git_repos(state: State<'_, CurrentProject>) -> Result<Vec<String>, String> {
    let project_path = get_repo_path(&state, "")?;
    task::spawn_blocking(move || find_git_repos(&project_path))
        .await
        .map_err(|err| format!("{}", err))
}

#[tauri::command]
pub(crate) async fn get_git_changes(
    path: String,
    project: Option<String>,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
) -> Result<Vec<String>, String> {
    let git_path = get_project_repo_path(&state, &projects, project.as_deref(), &path)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        collect_changes(&repository)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

/// Changed files and commits ahead of and behind the remote for every saved project, each totalled
/// across all its repos and leaving out the files that project ignores. Ahead and behind compare with
/// the last fetch, so they use no network. A project that cannot be read is left out.
#[tauri::command]
pub(crate) async fn get_project_git_status(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
) -> Result<HashMap<String, ProjectGitStatus>, String> {
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
        // The open project's settings can be newer than what is saved.
        let data = if path == current_path {
            Some(current_data.clone())
        } else {
            get_data_from_local_storage(&app_handle, &format!("{}.enc", get_hash_code(&path)))
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice::<HashMap<String, Value>>(&bytes).ok())
        };
        let ignored = data.map(|data| ignored_files(&data)).unwrap_or_default();
        let root = PathBuf::from(&path);
        let status = task::spawn_blocking(move || project_git_status(&root, &ignored))
            .await
            .map_err(|err| format!("{}", err))?;
        if let Some(status) = status {
            statuses.insert(project.path, status);
        }
    }
    Ok(statuses)
}

/// Fetches every saved project's repos from their origin, each with its own project's token, so ahead
/// and behind counts stay current for projects that are not open. Failures are skipped quietly, since
/// a project may be offline or have no token.
#[tauri::command]
pub(crate) async fn fetch_project_remotes(
    app_handle: AppHandle,
    state: State<'_, CurrentProject>,
    projects: State<'_, SharedProjects>,
) -> Result<usize, String> {
    let known = projects
        .lock()
        .map_err(|err| format!("State failure: {}", err))?
        .clone();
    let mut fetched = 0;
    for project in known {
        let other_project = other_project_values(&app_handle, &state, Some(&project.path)).await?;
        let token = credentials_for(app_handle.clone(), other_project);
        let root = PathBuf::from(&project.path);
        fetched += task::spawn_blocking(move || fetch_project_repos(&root, token))
            .await
            .map_err(|err| format!("{}", err))?;
    }
    Ok(fetched)
}

/// Fetches each repo in a project that has an origin. Returns how many fetched.
fn fetch_project_repos(root: &Path, token: impl Fn() -> Option<String>) -> usize {
    if !root.is_dir() {
        return 0;
    }
    find_git_repos(root)
        .into_iter()
        .filter(|repo| {
            let Ok(repository) = Repository::open(root.join(repo)) else {
                return false;
            };
            let Ok(mut remote) = repository.find_remote("origin") else {
                return false;
            };
            let mut fetch_options = FetchOptions::new();
            fetch_options.remote_callbacks(create_remote_callbacks(&token));
            remote
                .fetch(
                    &["+refs/heads/*:refs/remotes/origin/*"],
                    Some(&mut fetch_options),
                    None,
                )
                .is_ok()
        })
        .count()
}

/// The files a project's Git Controller always leaves out, written as repo/file.
fn ignored_files(data: &HashMap<String, Value>) -> std::collections::HashSet<String> {
    data.get("_gitIgnoreFiles")
        .and_then(|value| value.as_array())
        .map(|files| {
            files
                .iter()
                .filter_map(|file| file.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Counts the changed files in every repo of a project, or None when it has no repo that can be read.
/// What the project dropdown shows for a project, totalled across its repos.
#[derive(Serialize, Default, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectGitStatus {
    pub changes: usize,
    pub ahead: usize,
    pub behind: usize,
}

fn project_git_status(
    root: &Path,
    ignored: &std::collections::HashSet<String>,
) -> Option<ProjectGitStatus> {
    if !root.is_dir() {
        return None;
    }
    let mut total: Option<ProjectGitStatus> = None;
    for repo in find_git_repos(root) {
        let Ok(repository) = Repository::open(root.join(&repo)) else {
            continue;
        };
        let Ok(changes) = collect_changes(&repository) else {
            continue;
        };
        let count = changes
            .iter()
            .filter_map(|line| line.get(3..))
            .map(|name| {
                let name = name.trim();
                name.split(" -> ").last().unwrap_or(name)
            })
            .filter(|name| !ignored.contains(&format!("{}/{}", repo, name)))
            .count();
        let remote = remote_status(&repository).ok();
        let total = total.get_or_insert_with(ProjectGitStatus::default);
        total.changes += count;
        total.ahead += remote.as_ref().map_or(0, |status| status.ahead as usize);
        total.behind += remote.as_ref().map_or(0, |status| status.behind as usize);
    }
    total
}

fn collect_changes(repository: &Repository) -> Result<Vec<String>, String> {
    let mut options = git2::StatusOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let statuses = repository
        .statuses(Some(&mut options))
        .map_err(|e| e.to_string())?;
    let mut files = Vec::new();
    for entry in statuses.iter() {
        let status = entry.status();
        if status.is_ignored() {
            continue;
        }
        let mut status_str = String::with_capacity(2);
        if status.contains(git2::Status::CONFLICTED) {
            status_str = "C ".to_string();
        } else {
            if status.contains(git2::Status::INDEX_NEW) {
                status_str.push('A');
            } else if status.contains(git2::Status::INDEX_MODIFIED) {
                status_str.push('M');
            } else if status.contains(git2::Status::INDEX_DELETED) {
                status_str.push('D');
            } else if status.contains(git2::Status::INDEX_RENAMED) {
                status_str.push('R');
            } else if status.contains(git2::Status::INDEX_TYPECHANGE) {
                status_str.push('T');
            } else {
                status_str.push(' ');
            }
            if status.contains(git2::Status::WT_NEW) {
                if status_str == " " {
                    status_str = "??".to_string();
                } else {
                    status_str.push('?');
                }
            } else if status.contains(git2::Status::WT_MODIFIED) {
                status_str.push('M');
            } else if status.contains(git2::Status::WT_DELETED) {
                status_str.push('D');
            } else if status.contains(git2::Status::WT_RENAMED) {
                status_str.push('R');
            } else if status.contains(git2::Status::WT_TYPECHANGE) {
                status_str.push('T');
            } else if status_str != "??" {
                status_str.push(' ');
            }
        }
        let path_val = if status.contains(git2::Status::INDEX_RENAMED)
            || status.contains(git2::Status::WT_RENAMED)
        {
            let old_path = entry
                .head_to_index()
                .and_then(|d| d.old_file().path().and_then(|p| p.to_str()))
                .unwrap_or("");
            let new_path = entry.path().unwrap_or("");
            format!("{} -> {}", old_path, new_path)
        } else {
            entry.path().unwrap_or("").to_string()
        };
        files.push(format!("{} {}", status_str, path_val));
    }
    Ok(files)
}

#[tauri::command]
pub(crate) async fn get_git_change_stats(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<Vec<GitFileLineStats>, String> {
    let git_path = get_repo_path(&state, &repo)?;
    task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        change_line_stats(&repository)
    })
    .await
    .map_err(|err| format!("{}", err))?
}

/// Line counts for every change a commit would take: staged, unstaged and untracked, compared with HEAD.
/// Counts are per file, so the UI can total only the files it will commit.
fn change_line_stats(repository: &Repository) -> Result<Vec<GitFileLineStats>, String> {
    let head_tree = match repository.head() {
        Ok(head) => Some(head.peel_to_tree().map_err(|e| e.to_string())?),
        // A repository with no commits yet compares with nothing, so every file is added.
        Err(_) => None,
    };
    let mut options = git2::DiffOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);
    let mut diff = repository
        .diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut options))
        .map_err(|e| e.to_string())?;
    // Staged renames are listed under the new name, so count them as one change rather than a delete and an add.
    let mut find = git2::DiffFindOptions::new();
    find.renames(true);
    diff.find_similar(Some(&mut find))
        .map_err(|e| e.to_string())?;
    let mut stats = Vec::new();
    for index in 0..diff.deltas().len() {
        let Some(delta) = diff.get_delta(index) else {
            continue;
        };
        let path = delta
            .new_file()
            .path()
            .or_else(|| delta.old_file().path())
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        // Binary is only known once the patch has read the contents.
        let patch = git2::Patch::from_diff(&diff, index).map_err(|e| e.to_string())?;
        let (additions, deletions, binary) = match patch {
            Some(patch) if !patch.delta().flags().is_binary() => {
                let (_context, additions, deletions) =
                    patch.line_stats().map_err(|e| e.to_string())?;
                (additions, deletions, false)
            }
            _ => (0, 0, true),
        };
        stats.push(GitFileLineStats {
            path,
            additions,
            deletions,
            binary,
        });
    }
    Ok(stats)
}

#[tauri::command]
pub(crate) async fn get_git_file_diff(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    safe_relative_path(&file)?;
    task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        file_diff(&repository, &file)
    })
    .await
    .map_err(|err| format!("{}", err))?
}

fn find_git_repos(root: &Path) -> Vec<String> {
    let mut results = Vec::new();
    find_git_repos_recursive(root, root, &mut results);
    results
}

fn find_git_repos_recursive(root: &Path, path: &Path, results: &mut Vec<String>) {
    // TODO: Make this extendable through a config file setting.
    const IGNORED_DIRS: &[&str] = &[
        "node_modules",
        "target",
        "dist",
        "build",
        ".taskproxy",
        ".vscode",
        ".git",
        ".github",
    ];
    // A .git file rather than a folder marks a submodule or worktree.
    if path.join(".git").exists() {
        if let Ok(rel_path) = path.strip_prefix(root) {
            results.push(rel_path.to_string_lossy().to_string());
        }
        return;
    }
    if let Ok(entries) = fs::read_dir(path) {
        for entry in entries.flatten() {
            let is_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
            let name = entry.file_name();
            if is_dir && !IGNORED_DIRS.contains(&name.to_string_lossy().as_ref()) {
                find_git_repos_recursive(root, &entry.path(), results);
            }
        }
    }
}

#[tauri::command]
pub(crate) async fn get_git_branches(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<GitBranchInfo, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        list_branches(&repository)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

fn list_branches(repository: &Repository) -> Result<GitBranchInfo, String> {
    let mut branches = Vec::new();
    let mut current_branch = String::new();
    let head = repository.head().ok();
    let head_name = head.as_ref().and_then(|h| h.name());
    let iterator = repository.branches(None).map_err(|e| e.to_string())?;
    for (branch, _branch_type) in iterator.flatten() {
        // A symbolic reference such as origin/HEAD is an alias, not a branch.
        if branch.get().kind() == Some(git2::ReferenceType::Symbolic) {
            continue;
        }
        if let Ok(Some(name)) = branch.name() {
            let is_current = head_name == branch.get().name();
            if is_current {
                current_branch = name.to_string();
            }
            let mut updated_date = String::new();
            if let Ok(commit) = branch.get().peel_to_commit() {
                let time = commit.time();
                if let Some(dt) = chrono::DateTime::from_timestamp(time.seconds(), 0) {
                    updated_date = dt.format("%Y-%m-%d").to_string();
                }
            }
            branches.push(GitBranchDetail {
                name: name.to_string(),
                is_current,
                updated_date,
            });
        }
    }
    Ok(GitBranchInfo {
        branches,
        current_branch,
    })
}

#[tauri::command]
pub(crate) async fn git_switch_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        switch_branch(&repository, &branch)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_create_branch(
    repo: String,
    branch: String,
    base_branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        create_branch(&repository, &branch, &base_branch)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

fn create_branch(
    repository: &Repository,
    branch: &str,
    base_branch: &str,
) -> Result<String, String> {
    let target_commit = if !base_branch.is_empty() {
        let reference = repository
            .resolve_reference_from_short_name(base_branch)
            .map_err(|e| format!("Base branch not found: {}", e))?;
        reference.peel_to_commit().map_err(|e| e.to_string())?
    } else {
        let head = repository.head().map_err(|e| e.to_string())?;
        head.peel_to_commit().map_err(|e| e.to_string())?
    };
    let mut new_branch = repository
        .branch(branch, &target_commit, false)
        .map_err(|e| format!("Failed to create branch: {}", e))?;
    if let Some(name) = new_branch.get().name().map(str::to_string) {
        if let Err(err) = switch_to_reference(repository, &name, &target_commit) {
            let _ = new_branch.delete();
            return Err(err);
        }
    }
    Ok(format!("Branch '{}' created.", branch))
}

#[tauri::command]
pub(crate) async fn git_delete_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        if let Ok(mut local_branch) = repository.find_branch(&branch, git2::BranchType::Local) {
            local_branch
                .delete()
                .map_err(|e| format!("Failed to delete local branch: {}", e))?;
            return Ok(format!("Branch '{}' deleted.", branch));
        }
        if branch.contains('/') {
            let parts: Vec<&str> = branch.splitn(2, '/').collect();
            if parts.len() == 2 {
                let remote_name = parts[0];
                let remote_branch = parts[1];
                let mut remote = repository
                    .find_remote(remote_name)
                    .map_err(|e| e.to_string())?;
                let refspec = format!(":refs/heads/{}", remote_branch);
                push_refspec(&mut remote, &refspec, || {
                    get_git_credentials(&app_handle_clone)
                })?;
                return Ok(format!("Remote branch '{}' deleted.", branch));
            }
        }
        Err(format!(
            "Branch '{}' not found or could not be deleted.",
            branch
        ))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_merge_branch(
    repo: String,
    branch: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        merge_branch_into_head(&repository, &branch)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

/// Reports status from local data. The UI decides when to fetch, since that uses the network.
#[tauri::command]
pub(crate) async fn get_git_remote_status(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<GitRemoteStatus, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        remote_status(&repository)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

fn remote_status(repository: &Repository) -> Result<GitRemoteStatus, String> {
    let mut upstream_name = String::new();
    let mut has_upstream = false;
    let mut ahead = 0;
    let mut behind = 0;
    let remote_url = repository
        .find_remote("origin")
        .map(|remote| remote.url().unwrap_or("").to_string())
        .unwrap_or_default();
    if let Ok(head) = repository.head() {
        if head.is_branch() {
            if let Some(branch_name) = head.shorthand() {
                if let Ok(local_branch) =
                    repository.find_branch(branch_name, git2::BranchType::Local)
                {
                    if let Ok(upstream) = local_branch.upstream() {
                        has_upstream = true;
                        upstream_name = upstream
                            .name()
                            .unwrap_or(Some(""))
                            .unwrap_or("")
                            .to_string();
                        if let (Some(local_oid), Some(upstream_oid)) =
                            (local_branch.get().target(), upstream.get().target())
                        {
                            if let Ok((a, b)) =
                                repository.graph_ahead_behind(local_oid, upstream_oid)
                            {
                                ahead = a as u32;
                                behind = b as u32;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(GitRemoteStatus {
        has_upstream,
        upstream_name,
        ahead,
        behind,
        remote_url,
    })
}

#[tauri::command]
pub(crate) async fn git_fetch(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let app_handle_clone = app_handle.clone();
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let callbacks = create_remote_callbacks(|| get_git_credentials(&app_handle_clone));
        let mut fetch_options = FetchOptions::new();
        fetch_options.remote_callbacks(callbacks);
        remote
            .fetch(
                &["+refs/heads/*:refs/remotes/origin/*"],
                Some(&mut fetch_options),
                None,
            )
            .map_err(remote_error)?;
        Ok(String::from("Fetch successful. Remote data is up to date."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

/// Stash uncommitted changes to tracked files, with an optional message.
fn stash_changes(repository: &mut Repository, message: &str) -> Result<String, String> {
    let signature = repository
        .signature()
        .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
        .map_err(|e| e.to_string())?;
    let msg = if message.is_empty() {
        None
    } else {
        Some(message)
    };
    repository
        .stash_save2(&signature, msg, Some(git2::StashFlags::DEFAULT))
        .map_err(|e| e.to_string())?;
    Ok(String::from("Changes stashed successfully."))
}

/// Apply the newest stash and drop it. libgit2 checks out safely, so uncommitted work is never overwritten,
/// and the stash is kept if it cannot be applied.
fn pop_stash(repository: &mut Repository) -> Result<String, String> {
    let mut options = git2::StashApplyOptions::new();
    repository
        .stash_pop(0, Some(&mut options))
        .map_err(|e| e.to_string())?;
    Ok(String::from("Stash popped successfully."))
}

#[tauri::command]
pub(crate) async fn git_stash(
    repo: String,
    message: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let mut repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        stash_changes(&mut repository, &message)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_stash_pop(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let mut repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        pop_stash(&mut repository)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_restore_file(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    safe_relative_path(&file)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        restore_file(&repository, &file)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_delete_file(
    repo: String,
    file: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        delete_file(&repository, &git_path, &file)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

fn delete_file(repository: &Repository, git_path: &Path, file: &str) -> Result<String, String> {
    let relative_path = safe_relative_path(file)?;
    if targets_git_dir(&relative_path) {
        return Err(format!("Cannot delete inside a .git folder: {}", file));
    }
    let target_path = git_path.join(&relative_path);
    // Only the folder needs checking. Deleting a symbolic link removes the link, not its target.
    let parent = target_path.parent().unwrap_or(git_path);
    ensure_inside_root(git_path, parent)?;
    if fs::symlink_metadata(&target_path).is_err() {
        return Err(format!("File {} does not exist", file));
    }
    let mut index = repository.index().map_err(|e| e.to_string())?;
    let _ = index.remove_path(&relative_path);
    index.write().map_err(|e| e.to_string())?;
    fs::remove_file(&target_path).map_err(|e| format!("Failed to delete file {}: {}", file, e))?;
    Ok(format!("Successfully deleted {}", file))
}

#[tauri::command]
pub(crate) async fn git_restore_all(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        restore_all(&repository, &git_path)
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

/// Discard every change, including staged files and any merge in progress.
fn restore_all(repository: &Repository, git_path: &Path) -> Result<String, String> {
    let head = repository
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|e| e.to_string())?;
    let mut checkout_builder = git2::build::CheckoutBuilder::new();
    checkout_builder.force();
    repository
        .reset(
            head.as_object(),
            git2::ResetType::Hard,
            Some(&mut checkout_builder),
        )
        .map_err(|e| e.to_string())?;
    repository.cleanup_state().map_err(|e| e.to_string())?;
    let mut status_opts = git2::StatusOptions::new();
    status_opts
        .include_untracked(true)
        .recurse_untracked_dirs(true);
    if let Ok(statuses) = repository.statuses(Some(&mut status_opts)) {
        for entry in statuses.iter() {
            if entry.status().contains(git2::Status::WT_NEW) {
                if let Some(path_str) = entry.path() {
                    let target_path = git_path.join(path_str);
                    if target_path.is_dir() {
                        let _ = fs::remove_dir_all(&target_path);
                    } else {
                        let _ = fs::remove_file(&target_path);
                    }
                }
            }
        }
    }
    Ok(String::from("All changes have been successfully reverted."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved(path: &str) -> Project {
        Project {
            name: String::from("Saved"),
            path: String::from(path),
        }
    }

    #[test]
    fn project_root_is_the_open_project_when_none_is_named() {
        assert_eq!(project_root("/open", &[], None), Ok(PathBuf::from("/open")));
        assert!(project_root("", &[], None).is_err());
    }

    #[test]
    fn a_token_is_found_under_either_name_and_blank_ones_are_skipped() {
        let values = |pairs: &[(&str, &str)]| -> HashMap<String, Value> {
            pairs
                .iter()
                .map(|(key, value)| (key.to_string(), Value::from(*value)))
                .collect()
        };
        assert_eq!(token_in(&values(&[("git_pat", "a")])).as_deref(), Some("a"));
        assert_eq!(
            token_in(&values(&[("github_pat", "b")])).as_deref(),
            Some("b")
        );
        assert_eq!(
            token_in(&values(&[("git_pat", ""), ("github_pat", "b")])).as_deref(),
            Some("b")
        );
        assert_eq!(
            token_in(&values(&[("git_pat", "a"), ("github_pat", "b")])).as_deref(),
            Some("a")
        );
        assert_eq!(token_in(&values(&[("other", "c")])), None);
    }

    #[test]
    fn project_root_can_be_another_saved_project() {
        let known = [saved("C:\\work\\first"), saved("/work/second")];
        assert_eq!(
            project_root("/open", &known, Some("/work/second")),
            Ok(PathBuf::from("/work/second"))
        );
        // Windows paths match either way the slashes are written.
        assert_eq!(
            project_root("/open", &known, Some("C:/work/first")),
            Ok(PathBuf::from("C:/work/first"))
        );
        assert_eq!(
            project_root("/open", &[], Some("/open")),
            Ok(PathBuf::from("/open"))
        );
    }

    #[test]
    fn project_root_refuses_a_folder_that_is_not_a_project() {
        let known = [saved("/work/second")];
        assert!(project_root("/open", &known, Some("/etc")).is_err());
        assert!(project_root("/open", &known, Some("")).is_err());
    }

    fn commit_all(repo: &Repository, message: &str) -> git2::Oid {
        let mut index = repo.index().unwrap();
        index
            .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
            .unwrap();
        index.write().unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let parent = repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parents,
        )
        .unwrap()
    }

    fn write(repo: &Repository, file: &str, contents: &str) {
        fs::write(repo.workdir().unwrap().join(file), contents).unwrap();
    }

    fn read(repo: &Repository, file: &str) -> String {
        fs::read_to_string(repo.workdir().unwrap().join(file)).unwrap()
    }

    fn fetch(repo: &Repository) {
        repo.find_remote("origin")
            .unwrap()
            .fetch(&["+refs/heads/*:refs/remotes/origin/*"], None, None)
            .unwrap();
    }

    /// An upstream repo and a clone of it, with one newer commit upstream that changes a.txt.
    fn upstream_and_clone(dir: &Path) -> (Repository, Repository) {
        let upstream = Repository::init(dir.join("upstream")).unwrap();
        write(&upstream, "a.txt", "one\n");
        write(&upstream, "other.txt", "original\n");
        commit_all(&upstream, "first");
        let local =
            Repository::clone(dir.join("upstream").to_str().unwrap(), dir.join("local")).unwrap();
        write(&upstream, "a.txt", "two\n");
        commit_all(&upstream, "second");
        fetch(&local);
        (upstream, local)
    }

    fn head_branch(repo: &Repository) -> String {
        repo.head().unwrap().shorthand().unwrap().to_string()
    }

    #[test]
    fn project_changes_are_counted_across_its_repos() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        let first = Repository::init(root.join("first")).unwrap();
        commit_all(&first, "start");
        let second = Repository::init(root.join("libs").join("second")).unwrap();
        write(&first, "a.txt", "new\n");
        write(&second, "b.txt", "new\n");
        write(&second, "c.txt", "new\n");
        let none = std::collections::HashSet::new();
        assert_eq!(project_git_status(&root, &none).map(|s| s.changes), Some(3));
    }

    #[test]
    fn project_changes_leave_out_ignored_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        write(&repo, "a.txt", "new\n");
        write(&repo, "local.env", "secret\n");
        let ignored = ignored_files(&HashMap::from([(
            String::from("_gitIgnoreFiles"),
            serde_json::json!(["/local.env"]),
        )]));
        assert_eq!(
            project_git_status(dir.path(), &ignored).map(|s| s.changes),
            Some(1)
        );
    }

    #[test]
    fn a_project_with_no_changes_counts_zero_and_one_without_a_repo_is_left_out() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("repo")).unwrap();
        write(&repo, "a.txt", "one\n");
        commit_all(&repo, "start");
        let none = std::collections::HashSet::new();
        assert_eq!(
            project_git_status(&dir.path().join("repo"), &none),
            Some(ProjectGitStatus::default())
        );
        std::fs::create_dir(dir.path().join("plain")).unwrap();
        assert_eq!(project_git_status(&dir.path().join("plain"), &none), None);
        assert_eq!(project_git_status(&dir.path().join("missing"), &none), None);
    }

    #[test]
    fn project_status_counts_commits_ahead_and_behind_the_last_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let (upstream, local) = upstream_and_clone(dir.path());
        write(&local, "mine.txt", "x\n");
        commit_all(&local, "mine");
        write(&local, "theirs.txt", "y\n");
        let none = std::collections::HashSet::new();
        let root = dir.path().join("local");
        assert_eq!(
            project_git_status(&root, &none),
            Some(ProjectGitStatus {
                changes: 1,
                ahead: 1,
                behind: 1
            })
        );
        // Behind only changes once the remote is fetched.
        write(&upstream, "a.txt", "three\n");
        commit_all(&upstream, "third");
        assert_eq!(project_git_status(&root, &none).unwrap().behind, 1);
        assert_eq!(fetch_project_repos(&root, || None), 1);
        assert_eq!(project_git_status(&root, &none).unwrap().behind, 2);
    }

    #[test]
    fn fetching_skips_repos_without_an_origin_and_missing_projects() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("plain")).unwrap();
        commit_all(&repo, "start");
        assert_eq!(fetch_project_repos(&dir.path().join("plain"), || None), 0);
        assert_eq!(fetch_project_repos(&dir.path().join("missing"), || None), 0);
    }

    #[test]
    fn fast_forward_pull_keeps_uncommitted_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "other.txt", "my work\n");
        let branch = head_branch(&local);
        let message = integrate_remote_branch(&local, &branch).unwrap();
        assert!(message.contains("Fast-forward"));
        assert_eq!(read(&local, "a.txt"), "two\n");
        assert_eq!(read(&local, "other.txt"), "my work\n");
    }

    #[test]
    fn fast_forward_pull_refuses_to_overwrite_and_changes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "a.txt", "my work\n");
        let before = local.head().unwrap().target();
        let branch = head_branch(&local);
        let err = integrate_remote_branch(&local, &branch).unwrap_err();
        assert_eq!(err, LOCAL_CHANGES_ERROR);
        assert_eq!(read(&local, "a.txt"), "my work\n");
        assert_eq!(local.head().unwrap().target(), before);
    }

    #[test]
    fn merging_pull_keeps_uncommitted_changes() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "local.txt", "committed\n");
        commit_all(&local, "local commit");
        write(&local, "other.txt", "my work\n");
        let branch = head_branch(&local);
        let message = integrate_remote_branch(&local, &branch).unwrap();
        assert!(message.contains("merge"));
        assert_eq!(read(&local, "a.txt"), "two\n");
        assert_eq!(read(&local, "other.txt"), "my work\n");
        assert_eq!(local.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn merging_pull_refuses_to_overwrite_and_leaves_no_merge_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "local.txt", "committed\n");
        commit_all(&local, "local commit");
        write(&local, "a.txt", "my work\n");
        let branch = head_branch(&local);
        assert!(integrate_remote_branch(&local, &branch).is_err());
        assert_eq!(read(&local, "a.txt"), "my work\n");
        assert_eq!(local.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn merge_conflicts_are_written_for_the_user_to_resolve() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "a.txt", "conflicting\n");
        commit_all(&local, "local commit");
        let branch = head_branch(&local);
        let err = integrate_remote_branch(&local, &branch).unwrap_err();
        assert!(err.contains("conflicts"));
        assert!(read(&local, "a.txt").contains("<<<<<<<"));
        assert_eq!(local.state(), git2::RepositoryState::Merge);
    }

    #[test]
    fn merge_branch_keeps_uncommitted_changes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("repo")).unwrap();
        write(&repo, "a.txt", "one\n");
        write(&repo, "other.txt", "original\n");
        let first = commit_all(&repo, "first");
        let main = head_branch(&repo);
        let commit = repo.find_commit(first).unwrap();
        repo.branch("feature", &commit, false).unwrap();
        repo.set_head("refs/heads/feature").unwrap();
        write(&repo, "a.txt", "two\n");
        commit_all(&repo, "feature work");
        switch_branch(&repo, &main).unwrap();
        write(&repo, "other.txt", "my work\n");
        merge_branch_into_head(&repo, "feature").unwrap();
        assert_eq!(read(&repo, "a.txt"), "two\n");
        assert_eq!(read(&repo, "other.txt"), "my work\n");
    }

    #[test]
    fn switching_to_a_remote_branch_keeps_unpushed_local_commits() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        let main = head_branch(&local);
        let start = local.head().unwrap().peel_to_commit().unwrap();
        local.branch("work", &start, false).unwrap();
        switch_branch(&local, "work").unwrap();
        write(&local, "unpushed.txt", "x\n");
        let unpushed = commit_all(&local, "unpushed");
        switch_branch(&local, &main).unwrap();
        // origin/work does not need to exist for the local branch check; make it exist.
        let tip = local.head().unwrap().peel_to_commit().unwrap();
        local
            .reference("refs/remotes/origin/work", tip.id(), true, "test")
            .unwrap();
        switch_branch(&local, "origin/work").unwrap();
        assert_eq!(head_branch(&local), "work");
        assert_eq!(local.head().unwrap().target(), Some(unpushed));
    }

    #[test]
    fn switching_branches_refuses_to_overwrite_changes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("repo")).unwrap();
        write(&repo, "a.txt", "one\n");
        let first = commit_all(&repo, "first");
        let main = head_branch(&repo);
        repo.branch("feature", &repo.find_commit(first).unwrap(), false)
            .unwrap();
        switch_branch(&repo, "feature").unwrap();
        write(&repo, "a.txt", "two\n");
        commit_all(&repo, "feature work");
        write(&repo, "a.txt", "my work\n");
        assert_eq!(
            switch_branch(&repo, &main).unwrap_err(),
            LOCAL_CHANGES_ERROR
        );
        assert_eq!(head_branch(&repo), "feature");
        assert_eq!(read(&repo, "a.txt"), "my work\n");
    }

    #[test]
    fn file_names_with_pattern_characters_are_treated_literally() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("repo")).unwrap();
        for name in ["[id].tsx", "i.tsx"] {
            write(&repo, name, "original\n");
        }
        commit_all(&repo, "first");
        for name in ["[id].tsx", "i.tsx"] {
            write(&repo, name, "changed\n");
        }
        let diff = file_diff(&repo, "[id].tsx").unwrap();
        assert!(diff.contains("[id].tsx"));
        assert!(!diff.contains("b/i.tsx"));
        restore_file(&repo, "[id].tsx").unwrap();
        assert_eq!(read(&repo, "[id].tsx"), "original\n");
        assert_eq!(read(&repo, "i.tsx"), "changed\n");
    }

    #[test]
    fn restoring_a_file_also_clears_its_staged_change() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("repo")).unwrap();
        write(&repo, "a.txt", "original\n");
        commit_all(&repo, "first");
        write(&repo, "a.txt", "staged\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        restore_file(&repo, "a.txt").unwrap();
        assert_eq!(read(&repo, "a.txt"), "original\n");
        let statuses = repo.statuses(None).unwrap();
        assert_eq!(statuses.len(), 0);
    }

    fn all_changes(repo: &Repository) -> Vec<String> {
        let mut changes = collect_changes(repo).unwrap();
        changes.sort();
        changes
    }

    fn committed_files(repo: &Repository) -> Vec<String> {
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        let mut names: Vec<String> = tree
            .iter()
            .map(|entry| entry.name().unwrap().to_string())
            .collect();
        names.sort();
        names
    }

    fn new_repo(dir: &Path) -> Repository {
        let repo = Repository::init(dir.join("repo")).unwrap();
        write(&repo, "a.txt", "one\n");
        commit_all(&repo, "first");
        repo
    }

    fn root_of(repo: &Repository) -> PathBuf {
        repo.workdir().unwrap().to_path_buf()
    }

    fn files(names: &[&str]) -> Vec<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn commit_only_includes_the_selected_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "b.txt", "b\n");
        write(&repo, "c.txt", "c\n");
        commit_files(&repo, &root_of(&repo), &files(&["b.txt"]), "msg").unwrap();
        assert_eq!(committed_files(&repo), ["a.txt", "b.txt"]);
        assert_eq!(all_changes(&repo), ["?? c.txt"]);
        assert_eq!(
            repo.head().unwrap().peel_to_commit().unwrap().message(),
            Some("msg")
        );
    }

    #[test]
    fn commit_records_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "b.txt", "b\n");
        commit_all(&repo, "second");
        fs::remove_file(root_of(&repo).join("b.txt")).unwrap();
        commit_files(&repo, &root_of(&repo), &files(&["b.txt"]), "remove").unwrap();
        assert_eq!(committed_files(&repo), ["a.txt"]);
    }

    #[test]
    fn commit_with_no_changes_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        let before = repo.head().unwrap().target();
        write(&repo, "b.txt", "b\n");
        let err = commit_files(&repo, &root_of(&repo), &[], "msg").unwrap_err();
        assert!(err.contains("no changes"));
        assert_eq!(repo.head().unwrap().target(), before);
    }

    #[test]
    fn commit_works_in_a_new_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("repo")).unwrap();
        write(&repo, "a.txt", "one\n");
        commit_files(&repo, &root_of(&repo), &files(&["a.txt"]), "first").unwrap();
        assert_eq!(committed_files(&repo), ["a.txt"]);
    }

    #[test]
    fn commit_refuses_paths_outside_the_repository() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        assert!(commit_files(&repo, &root_of(&repo), &files(&["../x"]), "msg").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn commit_adds_a_broken_symbolic_link() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        std::os::unix::fs::symlink("missing-target", root_of(&repo).join("link")).unwrap();
        commit_files(&repo, &root_of(&repo), &files(&["link"]), "msg").unwrap();
        assert_eq!(committed_files(&repo), ["a.txt", "link"]);
    }

    #[test]
    fn finishing_a_merge_commits_with_both_parents() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "a.txt", "conflicting\n");
        commit_all(&local, "local commit");
        let branch = head_branch(&local);
        integrate_remote_branch(&local, &branch).unwrap_err();
        let root = root_of(&local);
        let err = commit_files(&local, &root, &files(&["a.txt"]), "merge").unwrap_err();
        assert!(err.contains("Conflict markers"));
        write(&local, "a.txt", "resolved\n");
        commit_files(&local, &root, &files(&["a.txt"]), "merge").unwrap();
        assert_eq!(
            local
                .head()
                .unwrap()
                .peel_to_commit()
                .unwrap()
                .parent_count(),
            2
        );
        assert_eq!(local.state(), git2::RepositoryState::Clean);
    }

    #[test]
    fn changes_report_each_kind_of_status() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "gone.txt", "x\n");
        write(&repo, "staged.txt", "x\n");
        commit_all(&repo, "second");
        write(&repo, "a.txt", "changed\n");
        write(&repo, "new file.txt", "x\n");
        fs::remove_file(root_of(&repo).join("gone.txt")).unwrap();
        write(&repo, "staged.txt", "changed\n");
        write(&repo, "added.txt", "x\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("staged.txt")).unwrap();
        index.add_path(Path::new("added.txt")).unwrap();
        index.write().unwrap();
        assert_eq!(
            all_changes(&repo),
            [
                " D gone.txt",
                " M a.txt",
                "?? new file.txt",
                "A  added.txt",
                "M  staged.txt"
            ]
        );
    }

    #[test]
    fn changes_list_files_inside_new_folders_and_skip_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, ".gitignore", "skip.txt\n");
        commit_all(&repo, "ignore");
        fs::create_dir_all(root_of(&repo).join("sub/deep")).unwrap();
        write(&repo, "sub/deep/b.txt", "x\n");
        write(&repo, "skip.txt", "x\n");
        assert_eq!(all_changes(&repo), ["?? sub/deep/b.txt"]);
    }

    #[test]
    fn conflicts_are_reported() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "a.txt", "conflicting\n");
        commit_all(&local, "local commit");
        let branch = head_branch(&local);
        integrate_remote_branch(&local, &branch).unwrap_err();
        assert_eq!(all_changes(&local), ["C  a.txt"]);
    }

    #[test]
    fn diff_keeps_lines_that_are_not_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        fs::write(root_of(&repo).join("a.txt"), b"caf\xE9 changed\n").unwrap();
        let diff = file_diff(&repo, "a.txt").unwrap();
        assert!(diff.contains("-one"));
        assert!(diff.contains("+caf\u{FFFD} changed"));
    }

    #[test]
    fn restoring_everything_removes_all_kinds_of_change() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "a.txt", "changed\n");
        write(&repo, "untracked.txt", "x\n");
        fs::create_dir_all(root_of(&repo).join("new/deep")).unwrap();
        write(&repo, "new/deep/x.txt", "x\n");
        write(&repo, "staged-new.txt", "x\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("staged-new.txt")).unwrap();
        index.write().unwrap();
        restore_all(&repo, &root_of(&repo)).unwrap();
        assert_eq!(all_changes(&repo), Vec::<String>::new());
        assert_eq!(read(&repo, "a.txt"), "one\n");
        assert!(!root_of(&repo).join("staged-new.txt").exists());
    }

    #[test]
    fn restoring_everything_ends_a_merge_in_progress() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        write(&local, "a.txt", "conflicting\n");
        let kept = commit_all(&local, "local commit");
        let branch = head_branch(&local);
        integrate_remote_branch(&local, &branch).unwrap_err();
        assert_eq!(local.state(), git2::RepositoryState::Merge);
        restore_all(&local, &root_of(&local)).unwrap();
        assert_eq!(local.state(), git2::RepositoryState::Clean);
        assert_eq!(local.head().unwrap().target(), Some(kept));
        assert_eq!(read(&local, "a.txt"), "conflicting\n");
    }

    #[test]
    fn deleting_a_file_removes_it_and_any_staged_copy() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "b.txt", "x\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("b.txt")).unwrap();
        index.write().unwrap();
        delete_file(&repo, &root_of(&repo), "b.txt").unwrap();
        assert!(!root_of(&repo).join("b.txt").exists());
        assert_eq!(all_changes(&repo), Vec::<String>::new());
    }

    #[test]
    fn deleting_refuses_git_internals_and_outside_paths() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        let root = root_of(&repo);
        assert!(delete_file(&repo, &root, ".git/config").is_err());
        assert!(root.join(".git/config").exists());
        assert!(delete_file(&repo, &root, "../outside.txt").is_err());
        assert!(delete_file(&repo, &root, "missing.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn deleting_a_symbolic_link_keeps_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        let outside = dir.path().join("outside.txt");
        fs::write(&outside, "keep\n").unwrap();
        std::os::unix::fs::symlink(&outside, root_of(&repo).join("link")).unwrap();
        delete_file(&repo, &root_of(&repo), "link").unwrap();
        assert!(fs::symlink_metadata(root_of(&repo).join("link")).is_err());
        assert_eq!(fs::read_to_string(outside).unwrap(), "keep\n");
    }

    #[cfg(unix)]
    #[test]
    fn deleting_through_a_linked_folder_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        let outside = dir.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), "keep\n").unwrap();
        std::os::unix::fs::symlink(&outside, root_of(&repo).join("linked")).unwrap();
        assert!(delete_file(&repo, &root_of(&repo), "linked/keep.txt").is_err());
        assert!(outside.join("keep.txt").exists());
    }

    #[test]
    fn branches_list_local_and_remote_without_aliases() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        let main = head_branch(&local);
        create_branch(&local, "feature", "").unwrap();
        let info = list_branches(&local).unwrap();
        assert_eq!(info.current_branch, "feature");
        let names: Vec<&str> = info.branches.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"feature"));
        assert!(names.contains(&main.as_str()));
        assert!(names.contains(&format!("origin/{}", main).as_str()));
        assert!(!names.contains(&"origin/HEAD"));
        assert_eq!(info.branches.iter().filter(|b| b.is_current).count(), 1);
        assert!(info.branches.iter().all(|b| b.updated_date.len() == 10));
    }

    #[test]
    fn a_branch_can_start_from_another_branch() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        let main = head_branch(&local);
        create_branch(&local, "from-remote", &format!("origin/{}", main)).unwrap();
        assert_eq!(head_branch(&local), "from-remote");
        assert_eq!(read(&local, "a.txt"), "two\n");
    }

    #[test]
    fn creating_a_branch_that_would_overwrite_changes_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        let main = head_branch(&local);
        write(&local, "a.txt", "my work\n");
        assert!(create_branch(&local, "bad", &format!("origin/{}", main)).is_err());
        assert_eq!(head_branch(&local), main);
        assert!(local.find_branch("bad", git2::BranchType::Local).is_err());
        assert_eq!(read(&local, "a.txt"), "my work\n");
    }

    #[test]
    fn creating_a_branch_that_exists_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        create_branch(&repo, "feature", "").unwrap();
        let main_tip = repo.head().unwrap().target();
        assert!(create_branch(&repo, "feature", "").is_err());
        assert_eq!(repo.head().unwrap().target(), main_tip);
    }

    #[test]
    fn switching_to_a_remote_branch_creates_a_tracking_branch() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        let tip = local.head().unwrap().peel_to_commit().unwrap();
        local
            .reference("refs/remotes/origin/topic/one", tip.id(), true, "test")
            .unwrap();
        switch_branch(&local, "origin/topic/one").unwrap();
        assert_eq!(head_branch(&local), "topic/one");
        let branch = local
            .find_branch("topic/one", git2::BranchType::Local)
            .unwrap();
        assert_eq!(
            branch.upstream().unwrap().name().unwrap(),
            Some("origin/topic/one")
        );
    }

    #[test]
    fn switching_to_an_unknown_branch_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        assert!(
            switch_branch(&repo, "nope")
                .unwrap_err()
                .contains("not found")
        );
    }

    #[test]
    fn remote_status_reports_ahead_and_behind() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        let status = remote_status(&local).unwrap();
        assert!(status.has_upstream);
        assert_eq!((status.ahead, status.behind), (0, 1));
        assert!(status.upstream_name.starts_with("origin/"));
        assert!(status.remote_url.contains("upstream"));
        write(&local, "local.txt", "x\n");
        commit_all(&local, "local");
        assert_eq!(remote_status(&local).unwrap().ahead, 1);
    }

    #[test]
    fn remote_status_with_no_remote_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        let status = remote_status(&repo).unwrap();
        assert!(!status.has_upstream);
        assert_eq!(status.remote_url, "");
    }

    #[test]
    fn push_updates_the_remote() {
        let dir = tempfile::tempdir().unwrap();
        let bare = Repository::init_bare(dir.path().join("remote.git")).unwrap();
        let local = new_repo(dir.path());
        local
            .remote("origin", dir.path().join("remote.git").to_str().unwrap())
            .unwrap();
        let branch = head_branch(&local);
        let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch);
        let mut remote = local.find_remote("origin").unwrap();
        push_refspec(&mut remote, &refspec, || None).unwrap();
        let pushed = bare.find_branch(&branch, git2::BranchType::Local).unwrap();
        assert_eq!(pushed.get().target(), local.head().unwrap().target());
    }

    #[test]
    fn push_that_is_not_a_fast_forward_fails() {
        let dir = tempfile::tempdir().unwrap();
        let (_upstream, local) = upstream_and_clone(dir.path());
        Repository::init_bare(dir.path().join("remote.git")).unwrap();
        local.remote_delete("origin").unwrap();
        local
            .remote("origin", dir.path().join("remote.git").to_str().unwrap())
            .unwrap();
        let branch = head_branch(&local);
        let refspec = format!("refs/heads/{0}:refs/heads/{0}", branch);
        write(&local, "x.txt", "1\n");
        let first = commit_all(&local, "one");
        let mut remote = local.find_remote("origin").unwrap();
        push_refspec(&mut remote, &refspec, || None).unwrap();
        // Rewrite history locally, so the remote has a commit this branch does not.
        local
            .find_commit(first)
            .unwrap()
            .parent(0)
            .and_then(|parent| local.reset(parent.as_object(), git2::ResetType::Hard, None))
            .unwrap();
        write(&local, "y.txt", "2\n");
        commit_all(&local, "two");
        let mut remote = local.find_remote("origin").unwrap();
        assert!(push_refspec(&mut remote, &refspec, || None).is_err());
    }

    #[test]
    fn credential_errors_are_recognized_by_the_frontend() {
        let err = git2::Error::from_str("too many redirects or authentication replays");
        assert_eq!(remote_error(err), CREDENTIALS_ERROR);
        let err = git2::Error::from_str(CREDENTIALS_ERROR);
        assert_eq!(remote_error(err), CREDENTIALS_ERROR);
        let err = git2::Error::from_str("network down");
        assert_ne!(remote_error(err), CREDENTIALS_ERROR);
    }

    #[test]
    fn pattern_characters_are_escaped() {
        assert_eq!(escape_pathspec("a[b]*?\\c.txt"), "a\\[b\\]\\*\\?\\\\c.txt");
        assert_eq!(escape_pathspec("plain/path.txt"), "plain/path.txt");
    }

    #[test]
    fn repositories_inside_a_repository_are_not_searched() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        Repository::init(&root).unwrap();
        Repository::init(root.join("nested")).unwrap();
        assert_eq!(find_git_repos(&root), [""]);
    }

    #[test]
    fn build_folders_are_not_searched_for_repositories() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        Repository::init(root.join("node_modules/pkg")).unwrap();
        Repository::init(root.join("target/x")).unwrap();
        Repository::init(root.join("apps/web")).unwrap();
        let expected = Path::new("apps").join("web").to_string_lossy().into_owned();
        assert_eq!(find_git_repos(&root), [expected]);
    }

    #[test]
    fn repositories_are_found_in_any_root_folder_and_through_git_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("build");
        Repository::init(root.join("app")).unwrap();
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/.git"), "gitdir: ../elsewhere\n").unwrap();
        let mut repos = find_git_repos(&root);
        repos.sort();
        assert_eq!(repos, ["app", "sub"]);
    }

    fn line_stats(repo: &Repository) -> Vec<(String, usize, usize, bool)> {
        let mut stats: Vec<_> = change_line_stats(repo)
            .unwrap()
            .into_iter()
            .map(|s| (s.path, s.additions, s.deletions, s.binary))
            .collect();
        stats.sort();
        stats
    }

    #[test]
    fn line_stats_count_modified_new_and_deleted_files() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "gone.txt", "x\ny\nz\n");
        commit_all(&repo, "second");
        write(&repo, "a.txt", "one changed\ntwo\n");
        write(&repo, "new.txt", "1\n2\n3\n");
        fs::remove_file(root_of(&repo).join("gone.txt")).unwrap();
        assert_eq!(
            line_stats(&repo),
            [
                ("a.txt".to_string(), 2, 1, false),
                ("gone.txt".to_string(), 0, 3, false),
                ("new.txt".to_string(), 3, 0, false),
            ]
        );
    }

    #[test]
    fn line_stats_combine_staged_and_unstaged_changes() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "a.txt", "one\ntwo\n");
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        write(&repo, "a.txt", "one\ntwo\nthree\n");
        assert_eq!(line_stats(&repo), [("a.txt".to_string(), 2, 0, false)]);
    }

    #[test]
    fn line_stats_include_files_in_new_folders_and_skip_ignored_ones() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, ".gitignore", "skip.txt\n");
        commit_all(&repo, "ignore");
        fs::create_dir(root_of(&repo).join("folder")).unwrap();
        write(&repo, "folder/inner.txt", "a\nb\n");
        write(&repo, "skip.txt", "ignored\n");
        assert_eq!(
            line_stats(&repo),
            [("folder/inner.txt".to_string(), 2, 0, false)]
        );
    }

    #[test]
    fn line_stats_mark_binary_files_without_counting_lines() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        fs::write(
            root_of(&repo).join("image.bin"),
            [0u8, 159, 146, 150, 0, 1, 2],
        )
        .unwrap();
        assert_eq!(line_stats(&repo), [("image.bin".to_string(), 0, 0, true)]);
    }

    #[test]
    fn line_stats_work_before_the_first_commit() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path().join("empty")).unwrap();
        write(&repo, "first.txt", "a\nb\n");
        assert_eq!(line_stats(&repo), [("first.txt".to_string(), 2, 0, false)]);
    }

    #[test]
    fn line_stats_count_a_staged_rename_under_its_new_name() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        write(&repo, "old.txt", "1\n2\n3\n4\n5\n");
        commit_all(&repo, "second");
        fs::rename(
            root_of(&repo).join("old.txt"),
            root_of(&repo).join("new.txt"),
        )
        .unwrap();
        let mut index = repo.index().unwrap();
        index.remove_path(Path::new("old.txt")).unwrap();
        index.add_path(Path::new("new.txt")).unwrap();
        index.write().unwrap();
        assert_eq!(line_stats(&repo), [("new.txt".to_string(), 0, 0, false)]);
    }

    #[test]
    fn no_changes_means_no_line_stats() {
        let dir = tempfile::tempdir().unwrap();
        let repo = new_repo(dir.path());
        assert!(line_stats(&repo).is_empty());
    }

    /// A repo with one commit holding a.txt, and a name and email for stashing.
    fn repo_with_commit(dir: &Path) -> Repository {
        let repo = Repository::init(dir.join("repo")).unwrap();
        let mut config = repo.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        write(&repo, "a.txt", "one\n");
        commit_all(&repo, "first");
        repo
    }

    #[test]
    fn stash_sets_changes_aside_and_pop_brings_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = repo_with_commit(dir.path());
        write(&repo, "a.txt", "my work\n");
        stash_changes(&mut repo, "before pulling").unwrap();
        assert_eq!(read(&repo, "a.txt"), "one\n");
        let mut messages = Vec::new();
        repo.stash_foreach(|_, message, _| {
            messages.push(message.to_string());
            true
        })
        .unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].contains("before pulling"));

        pop_stash(&mut repo).unwrap();
        assert_eq!(read(&repo, "a.txt"), "my work\n");
        let mut count = 0;
        repo.stash_foreach(|_, _, _| {
            count += 1;
            true
        })
        .unwrap();
        assert_eq!(count, 0, "a popped stash is dropped");
    }

    #[test]
    fn stash_with_no_message_still_stashes() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = repo_with_commit(dir.path());
        write(&repo, "a.txt", "my work\n");
        stash_changes(&mut repo, "").unwrap();
        assert_eq!(read(&repo, "a.txt"), "one\n");
    }

    #[test]
    fn stash_with_nothing_changed_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = repo_with_commit(dir.path());
        assert!(stash_changes(&mut repo, "").is_err());
    }

    #[test]
    fn pop_with_no_stash_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = repo_with_commit(dir.path());
        assert!(pop_stash(&mut repo).is_err());
    }

    #[test]
    fn pop_never_overwrites_uncommitted_work_and_keeps_the_stash() {
        let dir = tempfile::tempdir().unwrap();
        let mut repo = repo_with_commit(dir.path());
        write(&repo, "a.txt", "stashed work\n");
        stash_changes(&mut repo, "").unwrap();
        write(&repo, "a.txt", "newer work\n");
        assert!(pop_stash(&mut repo).is_err());
        assert_eq!(read(&repo, "a.txt"), "newer work\n");
        let mut count = 0;
        repo.stash_foreach(|_, _, _| {
            count += 1;
            true
        })
        .unwrap();
        assert_eq!(count, 1, "the stash is kept when it cannot be applied");
    }
}
