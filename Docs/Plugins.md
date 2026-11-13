# Plugins

Plugins add integrations, such as Jira, as WebAssembly that users install. Their source and SDK are in [TaskProxyPlugins](https://github.com/StoicDreams/TaskProxyPlugins).

## How they run

- **Runtime:** `src-tauri/src/plugins/runtime.rs` runs each plugin with Extism, without WASI and without Extism's own HTTP or file access. A call gets 30 seconds of WebAssembly time and 64 MB of memory, and a fresh instance from a module compiled once.
- **Host calls:** a plugin's only way out is the `taskproxy_host` import, which takes one JSON request (`var`, `storeGet`, `storeSet`, `projectFileRead`, `projectFileWrite`, `currentBranch`, `now`, `http`). `CallContext::handle` checks each against the plugin's `plugin.json`:
  - HTTPS only, to the declared hosts (`*.example.com` means subdomains), with no redirects and at most 10 MB back.
  - Only declared variables, looked up as a project variable, then a global one, then the plugin's own settings.
  - Project files only under `.taskproxy/plugins/<id>/`.
  - `currentBranch` and `createBranch` only when declared.
- **Exports:** `render` draws a page, `action` answers a click or form, and `branch_info` returns a card for the Git Controller when the plugin contributes `gitBranchInfo`.
- **Screens:** plugins return UI as data, which `wc/plugin-page.js` draws with Task Proxy's components. Text is set as text, labels are escaped, and markdown goes through `sanitizeProjectHtml`. An unknown node type shows a placeholder, so newer plugins still work.
- **Host actions:** opening a URL, creating a branch, copying, and opening the plugin's settings run in Task Proxy, only after the user clicks the button that names them.

## Installing

- **Where:** plugins install per user in the app data folder, as `plugins/<id>/<version>/{plugin.json, plugin.wasm}`, with `plugins/plugins.json` listing which are installed and turned on (`registry.rs`). Opening a project never installs one.
- **Catalog:** `https://cdn.myfi.ws/apps/task-proxy/plugins/catalog.json` lists published plugins (`catalog.rs`). Both files are signed with the app's update key, checked against the updater's public key in `tauri.conf.json`, and the signed manifest must ask for exactly the permissions the catalog shows.
- **From a folder:** for plugins a user builds, unsigned, after a warning.
- **Settings:** a plugin's declared variables are entered in the Plugins drawer and saved encrypted in `plugin-<id>-settings.enc`, apart from Task Proxy's variables, so project pages and scripts cannot read them. Secret values never return to the window.
- **Storage:** what a plugin saves is in `plugin-<id>.enc`. Removing a plugin deletes both files.

## In the UI

- **Routes:** `/plugin/<id>/<page>?params`. `app-page-handler` hands these to `app-plugin-page`.
- **Nav:** enabled plugins' pages show in a second nav (`session-plugin-nav`), built by `refreshPluginNav` in `app.js` and never saved to `Navigation.json`. Pages marked `hidden` are left out.
- **Sections:** whether each section is open is kept in `app-plugin-sections`.
- **Plugins drawer:** the puzzle piece button beside Icons & Emojis (`wc/plugins-drawer.js`) opens the shared right drawer with `app-plugin-manager`. A plugin's `openSettings` host action opens it on that plugin's settings.

## Changing the plugin API

The protocol in the SDK's `protocol.rs` and `ui.rs` is shared with released apps. Adding optional fields and node types is safe. Renaming or removing anything needs a new `API_VERSION` in `plugins/manifest.rs` and the SDK, since a manifest for another version is refused.
