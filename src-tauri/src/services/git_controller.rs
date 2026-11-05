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

fn get_git_credentials(app_handle: &AppHandle) -> Option<String> {
    let pat_keys = ["git_pat", "github_pat"];
    if let Ok(project_state) = crate::appdata::get_state_data::<ProjectData>(app_handle) {
        for key in &pat_keys {
            if let Some(val) = project_state.data.get(*key) {
                if let Some(token) = val.as_str() {
                    if !token.is_empty() {
                        return Some(token.to_string());
                    }
                }
            }
        }
    }
    if let Ok(global_state) = crate::appdata::get_state_data::<TaskProxyData>(app_handle) {
        for key in &pat_keys {
            if let Some(val) = global_state.data.get(*key) {
                if let Some(token) = val.as_str() {
                    if !token.is_empty() {
                        return Some(token.to_string());
                    }
                }
            }
        }
    }
    None
}

/// Helper to construct Git2 remote callbacks for authentication injections.
fn create_remote_callbacks<'a>(app_handle: AppHandle) -> RemoteCallbacks<'a> {
    let mut callbacks = RemoteCallbacks::new();
    // libgit2 asks again when a server rejects a credential, so a second request means it failed.
    let mut already_tried = false;
    callbacks.credentials(move |_url, username_from_url, _allowed_types| {
        if already_tried {
            return Err(git2::Error::from_str(CREDENTIALS_ERROR));
        }
        already_tried = true;
        if let Some(token) = get_git_credentials(&app_handle) {
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
        if let Ok(content) = std::str::from_utf8(line.content()) {
            diff_text.push_str(content);
        }
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
    app_handle: AppHandle,
) -> Result<(), String> {
    let rejections = Arc::new(Mutex::new(Vec::new()));
    let recorded = rejections.clone();
    let mut callbacks = create_remote_callbacks(app_handle);
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
        Err(format!("Push rejected by remote. {}", rejections.join("; ")))
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

#[tauri::command]
pub(crate) async fn git_push(
    repo: String,
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut remote = repository
            .find_remote("origin")
            .map_err(|e| e.to_string())?;
        let head = repository.head().map_err(|e| e.to_string())?;
        let branch_name = head.shorthand().ok_or("Invalid branch name")?;
        let refspec = format!("refs/heads/{}:refs/heads/{}", branch_name, branch_name);
        push_refspec(&mut remote, &refspec, app_handle)?;
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
                "No remote tracking branch set. Skipping pull.",
            ));
        }
        let callbacks = create_remote_callbacks(app_handle_clone);
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
        let callbacks = create_remote_callbacks(app_handle_clone);
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
    state: State<'_, CurrentProject>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let pull = git_pull(repo.clone(), state.clone(), app_handle.clone()).await?;
    let push = git_push(repo.clone(), state.clone(), app_handle.clone()).await?;
    Ok(format!("{}\n{}", pull, push))
}

#[tauri::command]
pub(crate) async fn git_commit(
    repo: String,
    files: Vec<String>,
    message: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
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
        for file in &files {
            let file_path = safe_relative_path(file)?;
            let file_path = file_path.as_path();
            if git_path.join(file_path).exists() {
                index
                    .add_path(file_path)
                    .map_err(|e| format!("Failed to add file: {}", e))?;
            } else {
                let _ = index.remove_path(file_path);
            }
        }
        if is_merging && index.has_conflicts() {
            let conflicts: Vec<PathBuf> = index
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
                .collect();
            for rel_path in conflicts {
                let full_path = git_path.join(&rel_path);
                if full_path.exists() {
                    if let Ok(content) = fs::read_to_string(&full_path) {
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
                    index
                        .add_path(&rel_path)
                        .map_err(|e| format!("Failed to stage resolved file: {}", e))?;
                } else {
                    let _ = index.remove_path(&rel_path);
                }
            }
        }
        index.write().map_err(|e| e.to_string())?;
        let oid = index.write_tree().map_err(|e| e.to_string())?;
        let signature = repository
            .signature()
            .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
            .map_err(|e| e.to_string())?;
        let mut parent_commits = Vec::new();
        if let Ok(head) = repository.head() {
            if let Ok(commit) = head.peel_to_commit() {
                parent_commits.push(commit);
            }
        }
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
                &message,
                &tree,
                &parents,
            )
            .map_err(|e| e.to_string())?;
        if is_merging {
            let _ = repository.cleanup_state();
        }
        Ok(String::from("Commit successful."))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
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
    state: State<'_, CurrentProject>,
) -> Result<Vec<String>, String> {
    let git_path = get_repo_path(&state, &path)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
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
    })
    .await;
    result.map_err(|err| format!("{}", err))?
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
        let mut branches = Vec::new();
        let mut current_branch = String::new();
        let head = repository.head().ok();
        let head_name = head.as_ref().and_then(|h| h.name());
        let iterator = repository.branches(None).map_err(|e| e.to_string())?;
        for branch_res in iterator {
            if let Ok((branch, _branch_type)) = branch_res {
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
        }
        Ok(GitBranchInfo {
            branches,
            current_branch,
        })
    })
    .await;
    result.map_err(|err| format!("{}", err))?
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
        let target_commit = if !base_branch.is_empty() {
            let reference = repository
                .resolve_reference_from_short_name(&base_branch)
                .map_err(|e| format!("Base branch not found: {}", e))?;
            reference.peel_to_commit().map_err(|e| e.to_string())?
        } else {
            let head = repository.head().map_err(|e| e.to_string())?;
            head.peel_to_commit().map_err(|e| e.to_string())?
        };
        let mut new_branch = repository
            .branch(&branch, &target_commit, false)
            .map_err(|e| format!("Failed to create branch: {}", e))?;
        if let Some(name) = new_branch.get().name().map(str::to_string) {
            if let Err(err) = switch_to_reference(&repository, &name, &target_commit) {
                let _ = new_branch.delete();
                return Err(err);
            }
        }
        Ok(format!("Branch '{}' created.", branch))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
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
                push_refspec(&mut remote, &refspec, app_handle_clone)?;
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
    let result = task::spawn_blocking(move || -> Result<GitRemoteStatus, String> {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
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
    })
    .await;
    result.map_err(|err| format!("{}", err))?
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
        let callbacks = create_remote_callbacks(app_handle_clone);
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

#[tauri::command]
pub(crate) async fn git_stash(
    repo: String,
    message: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let mut repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let signature = repository
            .signature()
            .or_else(|_| git2::Signature::now("Task Proxy User", "user@taskproxy.local"))
            .map_err(|e| e.to_string())?;
        let msg = if message.is_empty() {
            None
        } else {
            Some(message.as_str())
        };
        repository
            .stash_save2(&signature, msg, Some(git2::StashFlags::DEFAULT))
            .map_err(|e| e.to_string())?;
        Ok(String::from("Changes stashed successfully."))
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
        let mut options = git2::StashApplyOptions::new();
        repository
            .stash_pop(0, Some(&mut options))
            .map_err(|e| e.to_string())?;
        Ok(String::from("Stash popped successfully."))
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
    let relative_path = safe_relative_path(&file)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut index = repository.index().map_err(|e| e.to_string())?;
        let path = relative_path.as_path();
        let _ = index.remove_path(path);
        index.write().map_err(|e| e.to_string())?;
        let target_path = git_path.join(path);
        ensure_inside_root(&git_path, &target_path)?;
        if target_path.exists() {
            fs::remove_file(&target_path)
                .map_err(|e| format!("Failed to delete file {}: {}", file, e))?;
        } else {
            return Err(format!("File {} does not exist", file));
        }
        Ok(format!("Successfully deleted {}", file))
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[tauri::command]
pub(crate) async fn git_restore_all(
    repo: String,
    state: State<'_, CurrentProject>,
) -> Result<String, String> {
    let git_path = get_repo_path(&state, &repo)?;
    let result = task::spawn_blocking(move || {
        let repository = Repository::open(&git_path).map_err(|e| e.to_string())?;
        let mut checkout_builder = git2::build::CheckoutBuilder::new();
        checkout_builder.force();
        repository
            .checkout_head(Some(&mut checkout_builder))
            .map_err(|e| e.to_string())?;
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
    })
    .await;
    result.map_err(|err| format!("{}", err))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
        repo.commit(Some("HEAD"), &signature, &signature, message, &tree, &parents)
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
        let local = Repository::clone(
            dir.join("upstream").to_str().unwrap(),
            dir.join("local"),
        )
        .unwrap();
        write(&upstream, "a.txt", "two\n");
        commit_all(&upstream, "second");
        fetch(&local);
        (upstream, local)
    }

    fn head_branch(repo: &Repository) -> String {
        repo.head().unwrap().shorthand().unwrap().to_string()
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
        assert_eq!(switch_branch(&repo, &main).unwrap_err(), LOCAL_CHANGES_ERROR);
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
}
