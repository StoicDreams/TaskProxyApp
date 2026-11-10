# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Task Proxy is a cross-platform Tauri 2 desktop app for organizing a developer project's docs, PowerShell scripts, variables/secrets, and git workflow. The UI is plain JavaScript web components, not a Rust/WASM UI. User-facing docs and dev setup are in `Docs/README.md`.

## Commands

Prerequisites: `rustup target add wasm32-unknown-unknown`, plus `trunk` and `tauri-cli`. The version-bump and page scripts need `pwsh`.

```bash
cargo tauri dev                  # Run the app (starts `trunk serve` on 127.0.0.1:1426)
cargo tauri build                # Production build and bundles (runs `trunk build --release`)
trunk build                      # Build only the frontend into dist/
cargo check -p taskproxy         # Type-check the backend (use -p: the root crate is a WASM stub)
cargo clippy -p taskproxy        # Lint the backend
cargo fmt --all                  # Format Rust
cargo test -p taskproxy <name>   # Run one Rust test by name filter
npm test                         # UI tests against the source files (npm install first)
npm run test:min                 # UI tests against the .min.js files, as CI runs them
npm run test:stress -- <spec>    # Run specs 10 times each under heavy parallel load, to find timing races
npx playwright test -g "<name>"  # Run UI tests by name
npm run capture                  # Regenerate the website's screenshots and videos (tools/capture/README.md)
pwsh ./PowerShell/IncrementVersion.ps1            # Bump patch version (-minor / -major)
pwsh ./PowerShell/Minify.ps1                      # Regenerate every .min.js and .min.css with esbuild
pwsh ./PowerShell/Publish.ps1                     # Before a release: version bump, minify, then CI's tests (-SkipMinify, -SkipTests, -Version minor)
```

Rust tests are `#[cfg(test)]` modules in `src-tauri/src`. They need `dist/` to exist, because `generate_context!` embeds it, so run `trunk build` first on a fresh checkout. Git logic is tested against real temporary repositories, so keep it in plain functions that take a `Repository`, with the `#[tauri::command]` as a thin wrapper.

UI tests use Playwright and follow the MyFiCDN conventions. `tests/support/app.mjs` serves the frontend straight from the repo with no build or server, and `tests/support/backend.mjs` stands in for every Tauri command through a mock `window.__TAURI__`. Each `wc/` component has a spec in `tests/components/`, and app-wide behavior is in `tests/app/`. `tests/coverage.spec.mjs` fails when a component has no spec, or when a command called from `app.js` is not registered in `lib.rs` or not mocked. Any uncaught error fails the test it happens in.

- **UI tests load `webui-*` components from the live CDN,** so a CDN deploy that breaks the app fails them, and a slow CDN can make one retry. They need network access. Set `WEBUI_CDN_ROOT` to a MyFiCDN checkout's `cdn` folder to test against components that are not deployed yet. When an app change depends on a CDN change, deploy the CDN first, or CI fails.
- **`npm test` runs the sources and CI runs the minified files,** for both `.min.js` and `app.min.css`, so after re-minifying, run `npm run test:min` before pushing.
- **CI's runners are slower than a dev machine, so the order of independent async work differs there.** A test that asserts which call came last, or that one part of the app finished before another, can pass every time locally and fail on CI. Wait for the state you expect with `expect.poll` or a locator, and check order with `callOrder` only between calls that depend on each other. Run new or changed specs with `npm run test:stress -- <spec>` before pushing: heavy parallel load is what shows these races locally, and slowing the CPU alone does not. Locally a test that only passes on retry fails, while CI retries once for CDN slowness.
- **`tests/app/service-worker.spec.mjs` and `tests/app/scripts.spec.mjs` are shared** with every website and MyFiCDN, so change them in all of them at once. The script tests run the `PowerShell/` scripts in temporary folders and need `pwsh`.

## Things that will catch you out

- **Pushing to `main` releases.** `.github/workflows/deploy.yml` runs on every push to `main`: after the backend tests pass, it builds, signs, and publishes to the CDN and the app catalog. There is no separate PR workflow.
- **The app runs `.min.js` files, and they are committed.** `index.html`, the worker registration, and the component loader all reference minified files, so editing `wc/foo.js`, `root_files/app.js`, or `css/app.css` has no effect until the matching `.min` file is regenerated. The maintainer regenerates them with `PowerShell/Minify.ps1`, which downloads and runs the latest esbuild, or a minifier bound to a keyboard shortcut in their IDE. Don't edit or generate `.min` files unless asked; after changing a source file, list the ones that need re-minifying. Both versions get committed.
- **Don't open devtools during startup.** On WebKitGTK, attaching the inspector in the setup hook hung the page right after first render on a profile with existing WebKit data, while a fresh profile looked fine. Set `TASKPROXY_DEVTOOLS=1` to opt in for a debug run, or use the page's context menu.
- **Don't bump versions by hand.** The version lives in `Cargo.toml`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (`version` and `userAgent`), `deploy.yml`, `Docs/README.md`, and `root_files/service-worker{,.min}.js`. `IncrementVersion.ps1` updates them all.
- **`src/` is not the app.** The root `taskproxy-ui` crate is an empty WASM stub that Trunk builds. The backend is the `taskproxy` crate in `src-tauri/`, and the frontend is `wc/`, `root_files/`, `d/`, `css/`, and `index.html`.
- **Released apps run the CDN loader, and only `cargo tauri dev` runs `root_files/loader.js`.** An inline script in `index.html` picks the local copy when the hostname is `127.0.0.1`, which a release never uses. The local copy exists to make loader fixes easy to try here. The source of truth is `cdn/webui/` in StoicDreams/MyFiCDN, so port fixes there and copy the files back to stay in sync.
- **The Web UI framework changes underneath released apps.** `webui-*` components, the markdown parser, shared CSS, and now the loader all load from `cdn.myfi.ws` at runtime, and their source is not in this repo. A CDN deploy reaches installed apps without a release, so `app.js` and `wc/` must keep working with what is live there.
- **"Script error." with no file or line usually comes from a CDN component.** WebKit hides the details of these errors. Reproducing the action in Chromium shows the real message and stack.
- **Dev and installed builds share a data folder.** They use the same `.enc` files and WebKit profile, so a bug that needs existing data may not reproduce on a fresh profile, and autosaves from both can overwrite each other.
- **The main window label is `taskproxy`, not `main`.** This matters for `get_webview_window` and for `windows` in `src-tauri/capabilities/`.

## Commit messages

Use multiple lines. Each line is either a general statement or marks one update as `Feature: ...` or `Bug: ...`. Don't commit or push unless asked, since a push to `main` releases.

```text
Update Web UI loader to match the CDN
Feature: New Script button in the script manager
Bug: Pull could overwrite uncommitted files
```

## Architecture

### IPC: one JS gateway to Rust commands

`root_files/app.js` captures `window.__TAURI__`, deletes the global, and exposes the `Tauri` class as `webui.proxy`. Components call `webui.proxy.*`, never `invoke` directly.

To add a backend command:

1. Write a `#[tauri::command]` in `src-tauri/src/services/<area>.rs` returning `Result<T, String>`.
2. Register it in `generate_handler!` in `src-tauri/src/lib.rs`.
3. Add a wrapper on the `Tauri` class in `app.js`. Tauri maps camelCase JS args to snake_case Rust params.
4. Regenerate `app.min.js`.

Wrappers usually take an optional `errHandler` (default: `webui.alert`) and resolve to `undefined` on failure, so callers test the result rather than using `try/catch`. Git commands go through `invokeGit`, which matches the error text `Credentials Missing/Invalid` to prompt for a PAT and retry. Terminal output arrives through the `terminal-data` and `terminal-finished` events.

### Frontend: lazy-loaded components

- A `MutationObserver` in the loader sees `app-foo` and loads `wc/foo.min.js`, and sees `webui-foo` and loads it from the CDN. Components are defined with `webui.define(name, {...})` (see `wc/template.js`). `preload: 'app:foo bar'` loads dependencies early.
- Static routes are markdown files in `d/` (`/git-controller` is `d/git-controller.md`, `/` is `d/root.md`), and they embed components as HTML.
- Unknown routes fall through to `<app-page-handler>` via `app-not-found-html` in `index.html`. It treats the path as a UUID and loads `.taskproxy/pages/<uuid>.md`. These user pages are split into `app-markdown-segment` editors, and fenced PowerShell blocks get injected variables and a run button.
- Anything built from project files (pages, docs) can come from an untrusted repo, so it goes through `sanitizeProjectHtml` in `app.js` before reaching the DOM. Tauri's CSP in `tauri.conf.json` is the second layer, and it does not apply under `cargo tauri dev`, so check new external hosts or inline behavior in a release build.
- Drawer components (`app-terminals`, `app-var-manager`, `app-icon-drawer`) rebuild the shared right drawer each time they open.
- `root_files/worker.js` runs CPU work off the main thread through `webui.proxy.worker.send(name, data)`; git diff parsing lives there.

### Data scopes and persistence

`app.js` wraps `webui.getData`/`setData` to resolve **Page → Project → Global**, and `project.key` or `global.key` targets a scope directly. Keys starting with `app-` or `session-`, plus `page-path`/`page-title`/`page-subtitle`, are app state; ordinary variables can be switched off per scope. App-prefixed state is copied into `webui.taskProxyData` and debounced to Rust.

| Data | JS / Rust state | Stored in |
|---|---|---|
| Project list | `SharedProjects` | `projects.data.enc` |
| Global variables and app state | `webui.taskProxyData` / `SharedAppData` | `app.data.enc` |
| Project variable values | `webui.projectData.data` / `CurrentProject` | `<path-hash>.enc` |
| Project's last page | `webui.projectData.currentPage` | `<path-hash>.cp.enc` |
| Nav, variable definitions, pages, scripts | `webui.projectData` | `<project>/.taskproxy/`, committed with that project |

`.enc` files live in the app-local data dir, encrypted with AES-256-GCM (`src-tauri/src/appdata.rs`) using a passphrase held in the OS keychain.

- **Rust structs define what persists.** `ProjectData` and `TaskProxyData` drop unknown fields during deserialization, so a new top-level property on `webui.projectData` silently vanishes unless you add it to `datatypes.rs`. Arbitrary per-project values belong in `webui.projectData.data`.
- Variable definitions are strings in the form `key|type|default`.
- Rust state is a copy of JS state: `sync_*` commands update memory only, and `save_*` commands also write to disk. `background.rs` autosaves on an interval, and `lib.rs` saves on window close.
- `Navigation.json` and `Variables.json` can change underneath the app through git. `projects.rs` compares against a baseline of what it last read or wrote, skips writing unchanged data, and reports a conflict rather than overwriting a file that changed.
- Encrypted files are never overwritten if the current key can't read them. They move aside as `<name>.unreadable` and are restored if that key is entered again. Changing the key re-encrypts every `.enc` file.

### Scripts

`terminal_controller.rs` runs PowerShell in a project's root and tracks tasks by terminal id. If the id is a relative path to an existing file, that file runs. Otherwise the content goes to a private temp file under `script-tmp/` in the app-local data dir, because page scripts can contain injected secrets. Queueing, status, and capped output are tracked per project in JS (`terminalHelpers` in `app.js`), deliberately outside `webui` data because `setData` clones and compares its whole value.

- **Scripts run in a pseudo-terminal** (`portable-pty`), so tools see a real terminal and use colors, progress redraws, and prompts. Rust sends the raw output as text in batches (`terminal-data`), carrying a character split between reads over to the next batch. `write_terminal_input` and `resize_terminal` only work for these scripts.
- **If a pseudo-terminal cannot be opened, the script runs with piped output instead,** with `-NonInteractive` since nothing can answer a prompt, and error lines colored red. `start_script` returns `interactive: false` for these, and the UI stops them without sending Ctrl+C first.
- **`wc/terminal-view.js` draws output with xterm.js,** bundled in `root_files/vendor/xterm/` so a CDN deploy cannot break it. Those files are published builds copied unchanged, so don't edit or re-minify them. Each terminal keeps its raw output (about 2 MB) in `terminalHelpers`, and the view replays it when switching terminals. The view ignores its own replies while replaying, since replayed output can ask the terminal questions, such as where the cursor is, whose answers would otherwise be typed into the running script.

### Git

`git_controller.rs` uses `git2` (libgit2) rather than the git CLI, authenticating over HTTPS with a PAT stored as the `git_pat` or `github_pat` variable (project scope first, then global). Checkouts that move between commits use `checkout_commit_safely`, which refuses to overwrite uncommitted work; only explicit revert and force-pull actions use `force()`. File paths passed to libgit2 are patterns, so use `escape_pathspec` or `disable_pathspec_match`. Validate paths from the UI with `safe_relative_path`.

### Dogfooding

`.taskproxy/` in this repo is Task Proxy's own data for this project; the release instructions are one of its pages.
