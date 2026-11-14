# Roadmap

Planned work that has not started yet.

## Plugins with WebAssembly

Started in November 2026, with Jira as the first plugin. How they work is in [Plugins.md](Plugins.md), and the plugins are in [TaskProxyPlugins](https://github.com/StoicDreams/TaskProxyPlugins).

Decided:

- **Runtime:** Extism, without WASI or Extism's own HTTP and file access. Everything goes through one JSON host call that Task Proxy checks against the manifest.
- **Plugin UI:** plugins return screens as data, and Task Proxy draws them. No plugin code runs in the window.
- **Manifest:** `plugin.json`, with permissions for hosts, variables, and git, shown before installing.
- **Install:** per user, from the CDN catalog with signatures checked, or from a folder for development. Never from a repository.
- **Versioning:** a plugin spec, versioned apart from the app and plugins, in TaskProxyPlugins' `spec/`. Each app release and each plugin version lists the spec versions it supports, and they match on a shared line.
- **Secrets:** a plugin's settings are saved encrypted for it alone, and it reads only the variables it declares.

Still to decide:

- **More contribution points:** a drawer panel, commands, and hooks such as before and after commit.
- **Projects asking for plugins:** a `.taskproxy/plugins.json` listing the plugins a project wants, which the app offers to install.

### Next plugin: Task Manager

A plugin listing every running task, background processes included, drafted as plugin spec 0.1.4 in TaskProxyPlugins' `spec/0.1.md` (section 10), so a stuck one can be found and closed from Task Proxy. It comes from a real case: a `trunk serve` outlived the `cargo tauri dev` that started it, held port 1426 and blocked every later dev run, and Ctrl+C didn't stop the new runs.

- **What it shows:**
  - a table of processes with their name, command line, folder, parent, start time or age, CPU and memory, and the ports they listen on
  - filters by text, by project folder (the open project's processes first), and by orphans, meaning processes whose parent has exited and that are now owned by init or `systemd --user`
  - a process's child processes beside it
  - which process holds a port, such as 1426
- **Closing processes:**
  - Stop sends SIGTERM, or closes the process on Windows.
  - Force close sends SIGKILL, after a confirmation that names the process.
  - Either can close a process and its children together.
  - Both are host actions that run only after the user clicks, as `git.createBranch` does.
- **Groundwork in the app:**
  - New host calls to list processes and to stop or kill one, each behind a new manifest permission such as `processes: ["list", "stop"]`, checked in `CallContext::handle` and added to the SDK's `host.rs`.
  - The plugin can only reach the user's own processes, never system ones.
  - The `sysinfo` crate works on Linux, macOS, and Windows, and listening ports come from `/proc/net` or a crate such as `listeners`.
  - Test the refusals with the test plugin.
- **To decide:**
  - Plugins show only in projects set up for them, but processes belong to the whole machine. One option is turning it on per project and filtering to that project by default. Another is a kind of plugin that shows in every project once turned on, which would need its own rule.
  - Whether it also lists the scripts Task Proxy runs, beside the Terminal Manager's All Running view.

### Groundwork

- **A version control provider interface.** Before a Mercurial plugin can exist, `git_controller.rs` and the Git Controller UI need a provider interface covering status, diff, commit, branches, pull, and push, with git as the built-in provider. The UI should show only what a provider supports, since Mercurial has shelve instead of stash and no staging area. This refactor is useful on its own.
