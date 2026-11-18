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
npm run capture                  # Regenerate the website's loops and videos (tools/capture/README.md)
npm run capture -- loops -g "<name>"    # One website loop
pwsh ./PowerShell/IncrementVersion.ps1            # Bump patch version (-minor / -major)
pwsh ./PowerShell/Minify.ps1                      # Regenerate every .min.js and .min.css with esbuild
pwsh ./PowerShell/Publish.ps1                     # Before a release: version bump, minify, CI's tests, then start re-recording the website's media without waiting for it (-SkipMinify, -SkipTests, -SkipScreenshots or -SkipMedia, -WaitForScreenshots, -Version minor)
pwsh ./PowerShell/screenshots.ps1                 # Re-record every TaskProxy.com loop and video in the website checkout beside this repo (-OutputPath)
```

Rust tests are `#[cfg(test)]` modules in `src-tauri/src`. They need `dist/` to exist, because `generate_context!` embeds it, so run `trunk build` first on a fresh checkout. Git logic is tested against real temporary repositories, so keep it in plain functions that take a `Repository`, with the `#[tauri::command]` as a thin wrapper.

**Tests check what the software does, never how it looks** (the standard for every Stoic Dreams project, set 2026-11-17, in full in `Websites/CLAUDE.md`). Assert what is shown or hidden, its text, order, what an action does, and what is sent, saved, or returned. Never assert pixel positions, sizes, spacing, scroll offsets, or specific colors, fonts, or theme values: layout and look are checked by eye in the recorded screenshots and loops. `toBeVisible` and `toBeInViewport` are fine, scrolling is tested as what happens (the page not moving when a pane scrolls), and layout components are tested by their state.

**Tests pass every time** (the standard for every Stoic Dreams project, set 2026-11-17, in full in `Websites/CLAUDE.md` under "Tests that pass every time"; read it before writing or changing a test). A test fails only when the app is broken, on the first try, on a busy 2-core CI runner. In short:

- No waiting for an amount of time (`waitForTimeout`, sleeps): wait for the thing itself.
- Every check after an action retries (`await expect(locator)`, `expect.poll`), never `expect(await calls(...))` or `expect(await page.evaluate(...))` read once.
- When a test needs a wait to start safely, fix `openApp`, `openPage`, or `mount` to wait for the real signal.
- `openApp` returns once the project's page has settled. After anything else that replaces the page, use the helpers in `tests/support/app.mjs`: `switchProject(page, { name, path })` (or `null` to close it) to change project, `goToPage(page, path)` to navigate, and `pageSettled(page)` after a link or other action that changes the page. Acting sooner reaches the old page's components, which the loader keeps for about 300ms while it fades.
- Hold a mocked backend answer by replacing its handler in `window.__backend.handlers` with one that awaits a promise the test resolves (hold only the calls the test means to, since a commit asks for the changes again). The files search has `holdSearch: true` and `window.__backend.releaseSearch()`. `alertPopup(page, text)` in `tests/support/wait.mjs` waits for an alert.
- To check that nothing was called, wait for what the app does instead (its alert, the dialog closing), then check.
- Debounces, intervals, and dates use `page.clock`. An order between responses is forced with a promise the test resolves, not a delay.
- No longer timeouts, retries, or `toPass` to get a test through.
- `npm run test:stress -- <spec>` must pass every time for each new or changed spec, then `npm run test:min` once. Never report tests as passing after a rerun made a failure go away.
- A test that breaks these rules is a bug, and bugs come first (Erik's standard, in `Websites/CLAUDE.md`): fix it as soon as it is found, in whichever spec it is. Never mark a test flaky, skipped, or expected to fail.

UI tests use Playwright and follow the MyFiCDN conventions. `tests/support/app.mjs` serves the frontend straight from the repo with no build or server, and `tests/support/backend.mjs` stands in for every Tauri command through a mock `window.__TAURI__`. Each `wc/` component has a spec in `tests/components/`, and app-wide behavior is in `tests/app/`. `tests/coverage.spec.mjs` fails when a component has no spec, or when a command called from `app.js` is not registered in `lib.rs` or not mocked. Any uncaught error fails the test it happens in.

- **UI tests load `webui-*` components from the live CDN,** so a CDN deploy that breaks the app fails them. `tests/support/app.mjs` downloads each file once per test worker, retrying a failed download, and answers from memory after that, so they need network access but not a request per test. Set `WEBUI_CDN_ROOT` to a MyFiCDN checkout's `cdn` folder to test against components that are not deployed yet. When an app change depends on a CDN change, deploy the CDN first, or CI fails.
- **`npm test` runs the sources and CI runs the minified files,** for both `.min.js` and `app.min.css`, so after re-minifying, run `npm run test:min` before pushing.
- **CI's runners are slower than a dev machine, so the order of independent async work differs there.** A test that asserts which call came last, or that one part of the app finished before another, can pass every time locally and fail on CI. Wait for the state you expect with `expect.poll` or a locator, and check order with `callOrder` only between calls that depend on each other. Run new or changed specs with `npm run test:stress -- <spec>` before pushing: heavy parallel load is what shows these races locally, and slowing the CPU alone does not. Locally a test that only passes on retry fails. CI retries once, and lists a test that needed it as flaky: that is a test to fix, not a pass. When CI fails, the failed tests are named in the run's annotations, and its `playwright-report` artifact has their traces.
- **`tests/app/service-worker.spec.mjs` and `tests/app/scripts.spec.mjs` are shared** with every website and MyFiCDN, so change them in all of them at once. The script tests run the `PowerShell/` scripts in temporary folders and need `pwsh`.

## Things that will catch you out

- **Pushing to `main` releases.** `.github/workflows/deploy.yml` runs on every push to `main`: after the backend tests pass, it builds, signs, and publishes to the CDN and the app catalog. There is no separate PR workflow.
- **The app runs `.min.js` files, and they are committed.** `index.html`, the worker registration, and the component loader all reference minified files, so editing `wc/foo.js`, `root_files/app.js`, or `css/app.css` has no effect until the matching `.min` file is regenerated. The maintainer regenerates them with `PowerShell/Minify.ps1`, which downloads and runs the latest esbuild, or a minifier bound to a keyboard shortcut in their IDE. Don't edit or generate `.min` files unless asked; after changing a source file, list the ones that need re-minifying. Both versions get committed.
- **Don't open devtools during startup.** On WebKitGTK, attaching the inspector in the setup hook hung the page right after first render on a profile with existing WebKit data, while a fresh profile looked fine. Set `TASKPROXY_DEVTOOLS=1` to opt in for a debug run, or use the page's context menu.
- **Don't bump versions by hand.** The version lives in `Cargo.toml`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (`version` and `userAgent`), `deploy.yml`, `Docs/README.md`, and `root_files/service-worker{,.min}.js`. `IncrementVersion.ps1` updates them all. Don't write the current version anywhere else, such as in a docs table: `scripts.spec.mjs` takes every file that holds it for a version file, and fails when the bump leaves it there. Name a release by the one before it, as "after 0.1.121".
- **`src/` is not the app.** The root `taskproxy-ui` crate is an empty WASM stub that Trunk builds. The backend is the `taskproxy` crate in `src-tauri/`, and the frontend is `wc/`, `root_files/`, `d/`, `css/`, and `index.html`.
- **The app always runs the Web UI loader from the CDN, in development too.** There is no local copy: change the loader in `cdn/webui/loader.js` in StoicDreams/MyFiCDN. To try an unreleased loader or component here, run the tests with `WEBUI_CDN_ROOT` set to a MyFiCDN checkout's `cdn` folder.
- **The Web UI framework changes underneath released apps.** `webui-*` components, the markdown parser, shared CSS, and the loader all load from `cdn.myfi.ws` at runtime, and their source is not in this repo. A CDN deploy reaches installed apps without a release, so `app.js` and `wc/` must keep working with what is live there.
- **"Script error." with no file or line usually comes from a CDN component.** WebKit hides the details of these errors. Reproducing the action in Chromium shows the real message and stack.
- **The AppImage brings its own GStreamer, so it must bring the plugins too.** It bundles the build machine's GStreamer library, which cannot load the user's newer system plugins, and WebKit aborts the page (a gray window) when it finds no audio sink for a video. `bundleMediaFramework` in `tauri.conf.json` and the GStreamer packages the Linux build job installs keep media playable; `cargo tauri dev`, `.deb` and `.rpm` use the system's GStreamer and never show this.
- **Dev and installed builds share a data folder.** They use the same `.enc` files and WebKit profile, so a bug that needs existing data may not reproduce on a fresh profile, and autosaves from both can overwrite each other.
- **The main window label is `taskproxy`, not `main`.** This matters for `get_webview_window` and for `windows` in `src-tauri/capabilities/`.

## Website media

TaskProxy.com's media is recorded from this app by `tools/capture/` and regenerated on every publish, unless Publish runs with `-SkipScreenshots`. Publish starts the recording once the tests pass and doesn't wait for it, since it is written to the website's repo: run by Task Proxy, it shows in the "Website media" terminal, and otherwise it logs to `taskproxy-website-media.log` in the temp folder. `-WaitForScreenshots` waits for it. An image that promotes the app or documents an action is a short loop (`loops.capture.mjs`, shown with `<webui-loop-video>`), not a screenshot. When a UI change affects what a loop shows, update its steps in `loops.capture.mjs` too. Every Stoic Dreams website should automate its media the same way.

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

Wrappers usually take an optional `errHandler` (default: `webui.alert`) and resolve to `undefined` on failure, so callers test the result rather than using `try/catch`. CI results for the dropdowns' icons come from `services/ci_status.rs`, which asks each Git server's API about the commit a branch last pushed; GitHub Actions and GitLab CI/CD (gitlab.com, or self-hosted servers named `gitlab.*`) are supported, and adding a server is one `CiServer` variant. Git commands go through `invokeGit`, which matches the error text `Credentials Missing/Invalid` to prompt for a PAT and retry. Runs reach the window through the `run-changed` and `terminal-data` events.

**MyFi sign-in** (`services/myfi.rs`, the header's `app-account`) signs the app in to a Stoic Dreams account, which Remote Access needs (`Docs/RemoteAccess.md`). The app starts a sign-in on api.myfi.ws, opens StoicDreams.com in the user's browser to approve it with a code shown on both, then collects its session with a secret only it holds. The session stays in Rust and the OS keychain, and every MyFi call goes through Rust with `x-app` and `x-auth`; the window only gets the account's id and name. Apps belong to client companies, so MyFi never gives them the user's email.

### Frontend: lazy-loaded components

- A `MutationObserver` in the loader sees `app-foo` and loads `wc/foo.min.js`, and sees `webui-foo` and loads it from the CDN. Components are defined with `webui.define(name, {...})` (see `wc/template.js`). `preload: 'app:foo bar'` loads dependencies early.
- Static routes are markdown files in `d/` (`/git-controller` is `d/git-controller.md`, `/` is `d/root.md`), and they embed components as HTML.
- Unknown routes fall through to `<app-page-handler>` via `app-not-found-html` in `index.html`. It treats the path as a UUID and loads `.taskproxy/pages/<uuid>.md`. These user pages are split into `app-markdown-segment` editors, and fenced PowerShell blocks get injected variables and a run button.
- Anything built from project files (pages, docs) can come from an untrusted repo, so it goes through `sanitizeProjectHtml` in `app.js` before reaching the DOM. Tauri's CSP in `tauri.conf.json` is the second layer, and it does not apply under `cargo tauri dev`, so check new external hosts or inline behavior in a release build. Images and videos may come from any `https:` website, so pages can show media hosted elsewhere; scripts, connections and frames stay limited to the app and its services.
- Drawer components (`app-terminals`, `app-task-manager`, `app-var-manager`, `app-icon-drawer`, `app-plugins-drawer`) rebuild the shared right drawer each time they open. The drawer cancels the default action of clicks inside it, so checkboxes and `<details>` there must be toggled in code.
- **The Task Manager** (`services/task_manager.rs` with `sysinfo` and `listeners`) lists only the user's own processes, and only while its drawer is open: `close_task_manager` drops the process list when it closes. Which processes count as from a terminal or orphaned is decided in plain functions over a parent and session tree, tested without real processes. Stopping checks the start time as well as the pid, and never stops Task Proxy or the processes it runs in.
- **File previews stream from a local HTTP server** (`services/file_server.rs`) on 127.0.0.1, behind a random token, for files in the open project only. Never send file contents through a command as base64: a video froze and crashed the app that way. WebKitGTK will not play media from a custom URI scheme, which is why it is HTTP. Files over 20 MB are never read as text.
- **The Git Controller can show a file drawn** (Raw | Preview): markdown, HTML, and SVG in an `iframe` with `sandbox=""` and a `srcdoc` page whose own CSP allows no scripts, after `sanitizeProjectHtml`, so nothing in a project's file can reach the app; Web UI components there show as their content. `.webui` icon files are drawn by `webui-icon`'s `setIconDefinition`, which only sets path data. See `previewDocument` in `wc/git-manager.js`.
- **Icons are Web UI icons** from `cdn.myfi.ws/icons`, chosen for what they mean in that place, never emoji, in the app and on TaskProxy.com. When the right icon is missing, add it to MyFiCDN's `cdn/icons/` (and `all.json`) and deploy the CDN first. Emoji are only for user content and the Icons & Emojis picker.
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
- Rust state is a copy of JS state, kept current with patches (`services/shared_data.rs`): `syncAppData` and `syncProjectData` send only what changed since they last sent, Rust passes each patch to every other screen as `data-changed`, and `save_*` commands write the whole copy to disk. Keys each screen keeps for itself are `screenKeys` in `app.js`. `background.rs` autosaves on an interval, and `lib.rs` saves on window close. In the mock backend, `appData` and `savedProjects` are Rust's copies, and `otherScreen` sends a change as another screen would.
- `Navigation.json` and `Variables.json` can change underneath the app through git. `projects.rs` compares against a baseline of what it last read or wrote, skips writing unchanged data, and reports a conflict rather than overwriting a file that changed.
- Encrypted files are never overwritten if the current key can't read them. They move aside as `<name>.unreadable` and are restored if that key is entered again. Changing the key re-encrypts every `.enc` file.

### Scripts

`terminal_controller.rs` runs PowerShell in a project's root and tracks tasks by terminal id. If the id is a relative path to an existing file, that file runs. Otherwise the content goes to a private temp file under `script-tmp/` in the app-local data dir, because page scripts can contain injected secrets. Runs are kept in Rust (`services/runs.rs`): each project's terminals, their status, exit codes, capped output in numbered batches, the queue, and stopping (Ctrl+C, then forced after 3 s). So a run, its queue, and a commit's script carry on whatever happens to the window, and every screen sees the same runs.

- **`terminalHelpers` in `app.js` is the window's copy,** kept current by `run-changed` and `terminal-data`, and loaded with `get_runs` at startup. It keeps its API, so components read it synchronously. A screen that misses a batch fetches the rest with `get_run_output`. It stays outside `webui` data because `setData` clones and compares its whole value. Which terminal is shown is each screen's own.
- **`RunStore` decides everything without Tauri,** so its tests need no window. The commands around it start scripts through `terminal_controller::spawn_script`, which reports output and the end back to the store.
- **Scripts can open terminals here** (`services/script_api.rs`). Each run gets the `TaskProxy` module (`src-tauri/resources/powershell/`, written to `ps-modules/` in the app-local data dir) on `PSModulePath`, a local address in `TASKPROXY_URL`, and a key in `TASKPROXY_RUN` that works only while that run runs (`Grant` in `runs.rs`). `Start-TaskProxyTerminal` posts to that address, and the terminal opens in the run's project; `-Replace` stops one still running and waits for it. The module's tests run it in real PowerShell when `pwsh` is installed.
- **Page scripts are filled in by Rust** (`services/page_scripts.rs`). The page handler sends a block's text and the values typed or set on the page to `page_script_preview` (masked) or `run_page_script`, which adds project and global values, checks the project is trusted, and runs it. Change filling there, with a Rust test, and mirror it in the mock backend's `pageScripts`.
- **Secrets stay on the desktop** (`services/secrets.rs`): a remote device gets `{"$secret": true}` in place of each secret value, and a patch carrying that marker keeps the real value.
- **The mock backend keeps runs as `runs.rs` does.** Tests play a script with `runOutput` and `runEnds` from `tests/support/app.mjs`, and each script that starts is recorded as a `spawn_script` call.

- **Scripts run in a pseudo-terminal** (`portable-pty`), so tools see a real terminal and use colors, progress redraws, and prompts. Rust sends the raw output as text in batches (`terminal-data`), carrying a character split between reads over to the next batch. `write_terminal_input` and `resize_terminal` only work for these scripts.
- **If a pseudo-terminal cannot be opened, the script runs with piped output instead,** with `-NonInteractive` since nothing can answer a prompt, and error lines colored red. `start_script` returns `interactive: false` for these, and the UI stops them without sending Ctrl+C first.
- **`wc/terminal-view.js` draws output with xterm.js,** bundled in `root_files/vendor/xterm/` so a CDN deploy cannot break it. Those files are published builds copied unchanged, so don't edit or re-minify them. Each terminal keeps its raw output (about 2 MB) in Rust and in `terminalHelpers`, and the view replays it when switching terminals. The view ignores its own replies while replaying, since replayed output can ask the terminal questions, such as where the cursor is, whose answers would otherwise be typed into the running script.

### Git

`git_controller.rs` uses `git2` (libgit2) rather than the git CLI, authenticating over HTTPS with a PAT stored as the `git_pat` or `github_pat` variable (project scope first, then global). Checkouts that move between commits use `checkout_commit_safely`, which refuses to overwrite uncommitted work; only explicit revert and force-pull actions use `force()`. File paths passed to libgit2 are patterns, so use `escape_pathspec` or `disable_pathspec_match`. Validate paths from the UI with `safe_relative_path`.

Commits run in Rust as jobs (`services/commit_queue.rs`): the Run Before Commit script through `runs.rs`, then the commit, then a sync when asked, so a commit finishes whatever happens to the window. `git_commit` is called from there, not from the window. The Git Controller sends `commit_enqueue` and shows each job from `commit-jobs-changed`. In the mock backend, jobs record their git steps as `get_git_changes`, `git_commit` and `git_sync` calls.

### Remote Access

`src-tauri/src/remote/` is the gateway a paired phone or laptop uses (`Docs/RemoteAccess.md`). Devices pair and connect through api.myfi.ws's mailbox (`mailbox.rs`, `pairing.rs`, `connect.rs`), then talk over WebRTC with `str0m` (`webrtc.rs`, which reaches the app only through its `Hooks` trait, so its tests need no window). `service.rs` turns Remote Access on and off and reads the mailbox. Only local addresses are offered until a STUN server exists.

- **Every command in `generate_handler!` must be in `remote_commands!` in `dispatch.rs`, with its level, or in `DESKTOP_ONLY`,** and the test that reads `lib.rs` fails otherwise. A remote command must also be placed in `REDACTED` or `NO_VALUES` in that file's tests, after checking whether it returns variable values.
- **Send events with `remote::hub::broadcast`, not `app.emit`,** so devices get them. An event carrying variable values uses `broadcast_redacted`, as `data-changed` does.
- **Devices get secrets as `{"$secret": true}`** (`services/secrets.rs`), and a patch carrying the marker keeps the real value.
- **The Remote Access panel's commands (`remote_*` in `service.rs`) are desktop-only.** The window follows `remote-changed`, which `app.emit` sends to the window alone, since devices never need it.

### Plugins

Plugins such as Jira are WebAssembly in the separate TaskProxyPlugins repo (`../TaskProxyPlugins`), run by `src-tauri/src/plugins/` with Extism, and drawn by `wc/plugin-page.js`. `Docs/Plugins.md` covers the permission model, the catalog, and signing.

- **A plugin shows only in projects set up for it.** That means its settings (a sign-in) for the project, or, for a plugin with no settings, being turned on for it. Until then it has no nav entry, cards, or notifications there, and `run` in `commands.rs` refuses its calls. Global variables never set a plugin up, since they reach every project. Keep this for every plugin.
- **A plugin reaches nothing directly.** Every host call goes through `CallContext::handle` in `runtime.rs`, which checks it against the manifest. Add a host call there and in the SDK's `host.rs` together, and test the refusal with the test plugin.
- **What plugins can do is the plugin spec,** versioned apart from the app in TaskProxyPlugins' `spec/` folder. A patch only adds, and a breaking change is a new minor version with patch 0. `SPEC_VERSIONS` in `plugins/spec.rs` lists the newest patch of each line this app supports: raise it only once the app does all of that patch, and record each change in the table in `Docs/Plugins.md`. A manifest without `spec` is `apiVersion: 1`, which is spec 0.1.0, and plugins keep `apiVersion: 1` for releases up to 0.1.121.
- **Plugin text is untrusted.** `plugin-page.js` builds with `textContent`, escapes anything a Web UI component puts in `innerHTML` (such as `label`), and sanitizes markdown.
- **Plugin releases never need an app release,** and nothing in this repo should change when a plugin does. The test plugin's `.wasm` and signatures in `src-tauri/tests/fixtures/plugins/` change only when a test here needs a new host call: rebuild them with `pwsh ./scripts/build.ps1 -UpdateAppFixtures` in TaskProxyPlugins, which also replaces the throwaway test key.
- **Website loops of plugins** come from the plugins section of `tools/capture/loops.capture.mjs`, drawing screens the Jira plugin's demo wrote to `plugins/jira/demo/` in the TaskProxyPlugins checkout beside this one (or `TASKPROXY_PLUGINS_ROOT`).

### Dogfooding

`.taskproxy/` in this repo is Task Proxy's own data for this project; the release instructions are one of its pages.
