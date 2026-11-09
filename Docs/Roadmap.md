# Roadmap

Planned work that has not started yet.

## Plugins with WebAssembly

Integrations such as Jira, other issue trackers, and other version control systems such as Mercurial should be add-ons that users install, not part of the Task Proxy installation, so nobody carries features they don't use.

The chosen direction is plugins compiled to WebAssembly and run by the Rust backend, using wasmtime or Extism.

- **Sandboxed by default.** A plugin only reaches the network hosts, files, and variables it declares and the user approves at install.
- **One file for every platform.** The same `.wasm` file runs on Windows, macOS, and Linux, with no build for each.
- **Authors can use any language that compiles to WebAssembly,** such as Rust, Go, C#, or JavaScript through a WebAssembly runtime.

### Decisions to make

- **What a plugin can contribute.** Start with a small list and grow it on purpose: nav items and pages, a drawer panel, variable definitions (secrets included), commands, hooks such as before and after commit, and a version control provider.
- **Plugin UI.** WebAssembly gives the backend logic. Screens either come from data the plugin returns, such as forms, lists, and tables that Task Proxy draws, or from plugin components in a sandboxed iframe that reach the app only through `postMessage`. A plugin component must never run in the main page, where it could reach all of `webui.proxy`.
- **Manifest.** A `plugin.json` with the name, version, plugin API version, contribution points, and permissions (network hosts, variables, project file access). Permissions are shown when installing.
- **Install and discovery.** Plugins install per user in the app-local data folder, never automatically from a repository. A project can list the plugins it wants in `.taskproxy/plugins.json`, and the app offers to install them, as the trust prompt does for scripts. A plugin catalog could be published to the CDN beside the app catalog.
- **Versioning.** The host API is versioned, and each manifest names the version it was built for, so a released app can refuse or adapt to plugins built for an older API.
- **Secrets.** Plugins get only the variables they declared, read through the host, never the whole data store.

### Groundwork

- **A version control provider interface.** Before a Mercurial plugin can exist, `git_controller.rs` and the Git Controller UI need a provider interface covering status, diff, commit, branches, pull, and push, with git as the built-in provider. The UI should show only what a provider supports, since Mercurial has shelve instead of stash and no staging area. This refactor is useful on its own.
- **Jira as the first plugin.** Build one real plugin before generalizing the API, so the contribution points come from what an integration actually needs.
