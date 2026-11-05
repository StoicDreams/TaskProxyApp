use crate::prelude::*;
use ignore::WalkBuilder;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

/// Directories that never contain project files worth listing.
pub(crate) const COMMON_SKIP_DIRS: &[&str] = &["target", "dist", "build", "node_modules", ".git"];

pub(crate) fn create_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "linux")]
    cmd.env_remove("LD_LIBRARY_PATH");
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // 0x08000000 is the CREATE_NO_WINDOW flag
    cmd
}

pub(crate) fn get_hash_code(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hash_result = hasher.finalize();
    let hash_result = general_purpose::STANDARD.encode(hash_result);
    URL_SAFE_NO_PAD.encode(hash_result)
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json = serde_json::ser::to_string_pretty(value).map_err(|err| format!("{}", err))?;
    Ok(json)
}

/// Validate a path received from the UI, returning it only if it stays below its base directory.
pub(crate) fn safe_relative_path(path: &str) -> Result<PathBuf, String> {
    let invalid = || format!("Invalid path: {}", path);
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        return Err(invalid());
    }
    let mut result = PathBuf::new();
    for part in normalized.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err(invalid()),
            _ => {
                #[cfg(target_os = "windows")]
                if part.contains(':') {
                    return Err(invalid());
                }
                result.push(part);
            }
        }
    }
    if result.as_os_str().is_empty() {
        return Err(invalid());
    }
    Ok(result)
}

/// Writing into `.git` could install hooks or change configuration, which run as code.
pub(crate) fn targets_git_dir(path: &Path) -> bool {
    path.components()
        .any(|part| part.as_os_str().to_string_lossy().eq_ignore_ascii_case(".git"))
}

/// Confirm a path does not leave the root through a symbolic link.
pub(crate) fn ensure_inside_root(root: &Path, target: &Path) -> Result<(), String> {
    let outside = || format!("Path is outside of the project: {}", target.display());
    let root = fs::canonicalize(root).map_err(|err| err.to_string())?;
    let mut existing = target;
    while fs::symlink_metadata(existing).is_err() {
        existing = existing.parent().ok_or_else(outside)?;
    }
    let resolved = fs::canonicalize(existing).map_err(|_| outside())?;
    if resolved.starts_with(&root) {
        Ok(())
    } else {
        Err(outside())
    }
}

/// Replace a file in one step, so a crash mid-write cannot leave it truncated.
pub(crate) fn write_atomic(path: &Path, contents: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let temp = path.with_file_name(format!(".{}.{}.tmp", name, Uuid::now_v7().simple()));
    let write_result = (|| {
        let mut file = fs::File::create(&temp)?;
        io::Write::write_all(&mut file, contents)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

/// Visit every file below a project root. Honors `.gitignore` and never follows symbolic links.
pub(crate) fn walk_project_files(
    root: &Path,
    skip_dirs: &'static [&'static str],
    mut visit: impl FnMut(&Path),
) {
    let walker = WalkBuilder::new(root)
        .hidden(false)
        .follow_links(false)
        .git_global(false)
        .require_git(false)
        .parents(false)
        .filter_entry(move |entry| {
            let is_dir = entry.file_type().is_some_and(|kind| kind.is_dir());
            let name = entry.file_name().to_string_lossy();
            !(is_dir && entry.depth() > 0 && skip_dirs.contains(&name.as_ref()))
        })
        .build();
    for entry in walker.flatten() {
        if entry.file_type().is_some_and(|kind| kind.is_file()) {
            visit(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths_stay_below_their_base() {
        assert_eq!(
            safe_relative_path("a/b.md").unwrap(),
            PathBuf::from("a").join("b.md")
        );
        assert_eq!(
            safe_relative_path("a\\b.md").unwrap(),
            PathBuf::from("a").join("b.md")
        );
        assert!(safe_relative_path("name..with..dots.md").is_ok());
        for bad in ["", ".", "../x", "a/../../x", "a\\..\\x", "/etc/passwd", "\\x"] {
            assert!(safe_relative_path(bad).is_err(), "{bad} should be rejected");
        }
    }

    #[test]
    fn git_directory_is_detected_at_any_depth() {
        assert!(targets_git_dir(Path::new(".git/hooks/pre-commit")));
        assert!(targets_git_dir(Path::new("sub/.GIT/config")));
        assert!(!targets_git_dir(Path::new(".github/workflows/a.yml")));
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_links_cannot_escape_the_root() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "x").unwrap();
        std::os::unix::fs::symlink(&secret, root.path().join("link.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("dir")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("nope"), root.path().join("dangling"))
            .unwrap();
        assert!(ensure_inside_root(root.path(), &root.path().join("link.txt")).is_err());
        assert!(ensure_inside_root(root.path(), &root.path().join("dir/new.txt")).is_err());
        assert!(ensure_inside_root(root.path(), &root.path().join("dangling")).is_err());
        assert!(ensure_inside_root(root.path(), &root.path().join("new/file.txt")).is_ok());
    }

    #[test]
    fn atomic_write_replaces_content_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sub/file.txt");
        write_atomic(&path, b"one").unwrap();
        write_atomic(&path, b"two").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"two");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
    }

    #[test]
    fn walker_skips_ignored_paths_and_keeps_hidden_project_folders() {
        let dir = tempfile::tempdir().unwrap();
        for file in ["a.md", ".taskproxy/scripts/b.ps1", "target/c.md", "ignored/d.md"] {
            let path = dir.path().join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "x").unwrap();
        }
        fs::write(dir.path().join(".gitignore"), "ignored/\n").unwrap();
        let mut found = Vec::new();
        walk_project_files(dir.path(), COMMON_SKIP_DIRS, |path| {
            let relative = path.strip_prefix(dir.path()).unwrap();
            found.push(relative.to_string_lossy().replace('\\', "/"));
        });
        found.sort();
        assert_eq!(found, [".gitignore", ".taskproxy/scripts/b.ps1", "a.md"]);
    }
}
