# Plugins

Plugins add integrations, such as Jira, as WebAssembly that users install. Their source and SDK are in [TaskProxyPlugins](https://github.com/StoicDreams/TaskProxyPlugins).

## How they run

- **Runtime:** `src-tauri/src/plugins/runtime.rs` runs each plugin with Extism, without WASI and without Extism's own HTTP or file access. A call gets 30 seconds of WebAssembly time and 64 MB of memory, and a fresh instance from a module compiled once.
- **Host calls:** a plugin's only way out is the `taskproxy_host` import, which takes one JSON request (`var`, `storeGet`, `storeSet`, `projectFileRead`, `projectFileWrite`, `currentBranch`, `now`, `http`). `CallContext::handle` checks each against the plugin's `plugin.json`:
  - HTTPS only, to the declared hosts (`*.example.com` means subdomains), with no redirects and at most 10 MB back.
  - Only declared variables, looked up as a project variable, then a global one, then the plugin's own settings.
  - Project files only under `.taskproxy/plugins/<id>/`.
  - `currentBranch` and `createBranch` only when declared.
- **Exports:** `render` draws a page, `action` answers a click or form, `branch_info` returns a card for the Git Controller when the plugin contributes `gitBranchInfo`, and `notifications` and `notification_read` feed the Alerts panel when it contributes `notifications`.
- **Notifications:** `pluginAlerts` in `app.js` asks every two minutes and when the project or a plugin changes. New ones pop up, those found at startup only join the list, ones no longer listed are removed, and closing one calls `notification_read`. It needs Web UI's `webui.addAlert`, which resolves to the alert, whose `close` event fires when the user closes it.
- **Screens:** plugins return UI as data, which `wc/plugin-page.js` draws with Task Proxy's components. Text is set as text, labels are escaped, and markdown goes through `sanitizeProjectHtml`. An unknown node type shows a placeholder, so newer plugins still work.
- **Host actions:** opening a URL, creating a branch, copying, and opening the plugin's settings run in Task Proxy, only after the user clicks the button that names them.

## Installing

- **Where:** plugins install per user in the app data folder, as `plugins/<id>/<version>/{plugin.json, plugin.wasm}`, with `plugins/plugins.json` listing which are installed and turned on (`registry.rs`). Opening a project never installs one.
- **Catalog:** `https://cdn.myfi.ws/apps/task-proxy/plugins/catalog.json` lists published plugins (`catalog.rs`). Both files are signed with the app's update key, checked against the updater's public key in `tauri.conf.json`, and the signed manifest must ask for exactly the permissions the catalog shows.
- **From a folder:** for plugins a user builds, unsigned, after a warning.
- **Settings, per project:** a plugin's declared variables are entered in the Plugins drawer (`wc/plugin-settings.js`) and saved encrypted in `plugin-<id>-settings.enc`, apart from Task Proxy's variables, so project pages and scripts cannot read them. Secret values never return to the window. Each set of values is a sign-in, and each project uses one or none (`plugins/settings.rs`), so switching projects never reaches another project's account. Projects can share a sign-in. A file from before this was one set of values, which became a sign-in for the project open when it was first read.
- **Set up or not:** `plugin_list` says whether the open project has every declared variable (`configured`) and how many sign-ins exist. A plugin that is not set up is left out of the nav, or, once it has a sign-in anywhere, shows only "Set up for this project". Its pages show the settings instead of calling the plugin.
- **Storage:** what a plugin saves is in `plugin-<id>.enc`. Removing a plugin deletes both files.

## In the UI

- **Routes:** `/plugin/<id>/<page>?params`. `app-page-handler` hands these to `app-plugin-page`.
- **Nav:** enabled plugins' pages show in a second nav (`session-plugin-nav`), built by `refreshPluginNav` in `app.js` and never saved to `Navigation.json`. Pages marked `hidden` are left out.
- **Sections and panels:** whether each section, and each panel a `toggle` host action shows, is open is kept in `app-plugin-sections` (panels as `panel:<key>`).
- **Changing values in place:** a `select` node asks the plugin for its choices only when clicked (the result's `options`), and a `clip` node cuts text to 30 characters, with up to 100 in its tooltip. Both open their menus and dialogs from `wc/plugin-page.js`, not from Web UI components.
- **Dialogs:** an action result with `dialog` opens a native `<dialog>`. Actions inside it answer with `ui` to change it, `refresh` to draw the page behind it again, and `closeDialog` to close it.
- **Mentions:** a text field with `suggest` asks the plugin for people as the user types `@`, and the form also sends `<name>.mentions`, each `@Name` written with its id.
- **Plugins drawer:** the puzzle piece button beside Icons & Emojis (`wc/plugins-drawer.js`) opens the shared right drawer with `app-plugin-manager`. A plugin's `openSettings` host action opens it on that plugin's settings.

## Changing the plugin API

The protocol in the SDK's `protocol.rs` and `ui.rs` is shared with released apps. Adding optional fields and node types is safe. Renaming or removing anything needs a new `API_VERSION` in `plugins/manifest.rs` and the SDK, since a manifest for another version is refused.
