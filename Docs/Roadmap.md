# Roadmap

Planned work that has not started yet.

## Plugins with WebAssembly

Started in November 2026, with Jira as the first plugin. How they work is in [Plugins.md](Plugins.md), and the plugins are in [TaskProxyPlugins](https://github.com/StoicDreams/TaskProxyPlugins).

Decided:

- **Runtime:** Extism, without WASI or Extism's own HTTP and file access. Everything goes through one JSON host call that Task Proxy checks against the manifest.
- **Plugin UI:** plugins return screens as data, and Task Proxy draws them. No plugin code runs in the window.
- **Manifest:** `plugin.json`, with permissions for hosts, variables, and git, shown before installing.
- **Install:** per user, from the CDN catalog with signatures checked, or from a folder for development. Never from a repository.
- **Versioning:** each manifest names its `apiVersion`, and the app refuses other versions.
- **Secrets:** a plugin's settings are saved encrypted for it alone, and it reads only the variables it declares.

Still to decide:

- **More contribution points:** a drawer panel, commands, and hooks such as before and after commit.
- **Projects asking for plugins:** a `.taskproxy/plugins.json` listing the plugins a project wants, which the app offers to install.

### Groundwork

- **A version control provider interface.** Before a Mercurial plugin can exist, `git_controller.rs` and the Git Controller UI need a provider interface covering status, diff, commit, branches, pull, and push, with git as the built-in provider. The UI should show only what a provider supports, since Mercurial has shelve instead of stash and no staging area. This refactor is useful on its own.
