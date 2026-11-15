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

### Task Manager, built in

The Task Manager was planned as a plugin, drafted as plugin spec 0.1.4. It was built into the app instead, as a header drawer between Terminals and the alerts (`wc/task-manager.js`, `services/task_manager.rs`), since processes belong to the whole machine rather than a project, and stopping any of the user's processes is too much to hand to plugin code. The spec draft stays for a plugin that ever needs processes.

Still to decide:

- **Scripts that outlive Task Proxy:** a choice to run a script detached, with its output in a log file, which Task Proxy finds again and follows on its next start, and lists in the Task Manager.

### Groundwork

- **A version control provider interface.** Before a Mercurial plugin can exist, `git_controller.rs` and the Git Controller UI need a provider interface covering status, diff, commit, branches, pull, and push, with git as the built-in provider. The UI should show only what a provider supports, since Mercurial has shelve instead of stash and no staging area. This refactor is useful on its own.
