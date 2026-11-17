# Remote Access: plan

Use the Task Proxy on your desktop from a phone or laptop while you're away: review what changed, give feedback, run scripts, and commit. Both devices must be signed in to the same MyFi account. You pair by scanning a QR code before you leave. After that the phone connects straight to the desktop wherever the networks allow it.

The work is in three phases:

1. **Accounts and the remote core.** MyFi sign-in for the app. The backend becomes the one source of truth, and secrets stay on the desktop. A remote gateway with permissions. Nothing listens for connections yet, so this phase can ship safely by itself.
2. **Pair and connect.** api.myfi.ws ties each desktop to its account and introduces the devices. Pairing is by QR code, and connections use WebRTC. The client is on TaskProxy.com, and you must be signed in there.
3. **Phone layout and working away from the desk.** Screens built for a phone, what changed since you left, and optional notifications.

## Decisions

| Decision | Chosen |
|---|---|
| Who may connect | Only a device signed in to taskproxy.com with the **same MyFi account** the desktop app is signed in to. api.myfi.ws checks this on every pairing and every connection, and the desktop checks it again. |
| Sessions | **One shared session.** The phone follows the desktop's open project, and page position and drawers stay separate for each screen. |
| Relay | **STUN only** at first. Record how often a direct connection fails, and add a TURN relay (coturn) only if needed. |
| A new device's level | **View**, raised when you pair. |
| How long a pairing lasts | **30 days**, renewed on each connection, and revocable. |
| Where the phone's app code comes from | **The desktop, over the connection**, so it always matches the desktop's version. |
| Where you sign in to the app | **In your usual browser** at stoicdreams.com, which approves the app with a code shown on both screens. Your password never goes into the app. *Recommended; confirm.* |

## What the code means for this

**Task Proxy app**
1. **The UI reaches the backend through four Tauri functions.** `root_files/app.js` uses `core.invoke` (62 calls), `event.listen` (3), `dialog.open` (1), and `opener.openUrl` (1). No `wc/` component touches Tauri directly. A remote client can run the same frontend with a small stand-in for `window.__TAURI__`, as `tests/support/backend.mjs` does for the UI tests.
2. **Commands are plain functions over Tauri state,** such as `git_commit(repo, files, message, project, State<CurrentProject>, State<SharedProjects>)`. A gateway can call them with `app.state()`.
3. **Rust has one open project** (`CurrentProject`), which most commands default to. That is why the session is shared.
4. **Some state lives only in the desktop window's JavaScript:**
   - terminal status, output and the script queue (`terminalHelpers` in `app.js`), now moved to Rust
   - the commit queue and Run Before Commit (top of `wc/git-manager.js`)
   - app and project data, synced to Rust as whole objects (`sync_app_data`, `sync_project_data`)

   A commit started from a phone must finish even if the phone loses signal, so this state moves to Rust.
5. **Secrets reach the window today.** `get_app_data` and `get_project_data` return every value, including secret variables, `git_pat` and `github_pat`. Page scripts get their values filled in by `injectVariableValues` in `wc/page-handler.js`.
6. **The backend sends events from a few places:** `run-changed` and `terminal-data` in `runs.rs`, and `webui-isclosing` in `lib.rs`.

**MyFi accounts** (`Apis/Api`, `Apis/Databases/Postgres`, `Websites/StoicDreams`)

7. **A request is tied to an account in `identity.StartRequest`.** The session comes from the `__Host-myfi-session` cookie or an `x-auth` header, and an app is named with an `x-app` header.
   - A request with an app key looks up `tokens.AppSessions`.
   - A request from a website looks up `tokens.SiteSessions` for its domain.
8. **Apps can't sign in yet.** `tokens.AppSessions` and `identity.Apps` exist, but no function creates an app session. Two more problems:
   - **A bug in `identity.StartRequest`:** for an app session it builds the user's details by joining `tokens.SiteSessions` on `site_id = 0`, which finds nothing. That has to be fixed before any app can sign in.
   - **No expiry:** `tokens.AppSessions` has no expiry.
9. **Websites sign in through stoicdreams.com.**
   1. A site sends you to `stoicdreams.com/signin?domain=<site>`.
   2. `user/signin/domain` makes a one-time code.
   3. You're sent to `https://<site>/#myfi-signin=<code>`.
   4. The site exchanges the code with `user/signin/code`.

   The code only works for the same `mach_id` (a hash of IP address and user agent) that asked for it, and a desktop app has a different user agent from your browser. So the app needs its own approval flow (1.1).
10. **TaskProxy.com already has MyFi sign-in** (`webui-myfi-info` in its `index.html`). That gives it a site session for `www.taskproxy.com`, as a partitioned cookie on api.myfi.ws.
11. **A new api.myfi.ws endpoint is a new SQL function.** The dynamic handler (`dyn_api.rs`) names the function from the path and fills its arguments from the request, so signaling is mailboxes in SQL that both sides poll.

**TaskProxy.com**

12. **It is static.** A pairing secret in the URL fragment (`#...`) never reaches the server.

## How the account check works

The API is the only party that knows both accounts, so it enforces the match. The QR code's keys protect the connection itself, so the API can't take it over.

**When you turn on Remote Access:**
- The signed-in desktop registers with api.myfi.ws, sending its name and public key under its app session.
- The API records the desktop under that account.
- Only that account can post to the desktop's mailbox, and only the desktop's own app session can read it.

**When you pair:**
1. The phone opens the QR link on taskproxy.com.
2. If you're signed out there, it has you sign in first, and keeps the pairing waiting.
3. It posts the first handshake message to the desktop's mailbox, with its taskproxy.com session.
4. The API refuses the post unless that session's account owns the desktop. If it accepts, it delivers the message with the sender's account id.
5. The desktop checks that account id against its own signed-in account, then finishes the handshake.
6. The device is saved as belonging to that account.

**Every later connection:** the same two checks.
- If the phone is signed out, or signed in to another account, it can't reach the desktop.
- If the desktop signs out, or signs in to another account, Remote Access turns off and every paired device is removed.

**Two things are needed to connect,** and neither is enough alone:

| What someone has | What happens |
|---|---|
| Your QR code or device key, without your account | The API refuses them. |
| Access to the API, without the keys | They can't read, change, or take over a connection. At most they can block one. |

## One protocol

All of these travel over a WebRTC data channel. Tests use an in-process pipe.

- **Encryption is Noise:** `snow` on the desktop, and in the browser a small implementation on `@noble/curves`, `@noble/ciphers` and `@noble/hashes`. The noble libraries are vendored, unedited, in `root_files/vendor/noble/`, like xterm.
- **Handshakes:**
  - **First pairing:** `Noise_XXpsk3`, with the QR code's one-time secret as the pre-shared key.
  - **Later connections:** `Noise_IK`.
  - Each side's WebRTC DTLS fingerprint travels inside the handshake and is checked. So neither api.myfi.ws nor a relay can stand in the middle.
- **Messages:**
  - `{id, cmd, args}` gets back `{id, ok, value}` or `{id, ok:false, error}`.
  - Events are `{event, payload, seq}`.
  - `{ping}` every 15 s.
- **Large values** are split into chunks of at most 64 KB.
- **Resuming:** each run's terminal output has its own sequence numbers, so a device that reconnects asks for what it missed, up to the 2 MB kept.
- **Version check:** the first message names the protocol version. A device built for another version is told to reload.

---

## Phase 1: Accounts and the remote core

When Phase 1 ships, the app can sign in to MyFi. Scripts, the commit queue and data live in Rust, secrets have a desktop-only path, and the remote gateway exists and is tested. No remote connection is possible yet.

### 1.1 MyFi sign-in for the app

**Database** (`Apis/Databases/Postgres`):
- **Apps are a MyFi service,** like domains: any account adds apps to its own companies on myfi.ws's Apps page (`/user/app*` functions). Task Proxy is added to the Stoic Dreams company there, and its key, the `x-app` value, goes into the app. It's an identifier, not a secret, since it ships inside the app.
- **Fix `identity.StartRequest`:** for app sessions, build the user's details from `tokens.AppSessions`, not `tokens.SiteSessions`.
- **Session expiry:** add an `expires` column to `tokens.AppSessions`, 90 days, extended on each use. `StartRequest` ignores expired sessions.
- **New `tokens.AppSigninRequests`:**
  - `request_id`
  - `app_id`
  - `user_code`: 6 characters, shown on both screens
  - `challenge`: the SHA-256 of a secret only the app knows
  - `user_id`, empty until approved
  - `expires`: 10 minutes
- **New functions:**
  - `api_post_user_signin_app_start`:
    - Origin: any. Needs `x-app`.
    - Takes the challenge and the computer's name.
    - Returns the `request_id` and `user_code`.
    - Limited per IP address.
  - `api_post_user_signin_app_approve`:
    - Origin: `www.stoicdreams.com`. Needs a signed-in site session.
    - Marks the request approved for that user.
  - `api_post_user_signin_app_collect`:
    - Origin: any. Needs `x-app`.
    - Takes the `request_id` and the secret.
    - Once the request is approved and the secret matches its challenge, it deletes the request, creates a `tokens.AppSessions` row, and returns the session in the body, not as a cookie.
    - Until then it answers "pending".
- **Signing out:** extend `api_post_user_signout` to end app sessions.
- **Your sessions on stoicdreams.com:** add the app's sessions to the account's session list there, with the computer's name, so you can end them.

**stoicdreams.com** (`Websites/StoicDreams`):
- `app-signin` gains a branch for `?app=taskproxy&request=<id>`.
  - **Signed out:** sign in as usual first.
  - **Then:** "Sign in to Task Proxy on *<computer name>*? Continue only if Task Proxy shows **K7M-4QX**." Approving calls `user/signin/app/approve`.
- Add cases to `tests/account.spec.mjs`. Every site depends on `/signin`, so the existing `?domain=` flow must keep passing.

**api.myfi.ws:**
- Rust requests send `User-Agent: TaskProxy/<version>`, so `get_request_input` sees an `agent:taskproxy` origin rather than refusing an unknown one.
- Check that the new functions show in `openapi.json` only for the right origins.

**The app:**
- **New `services/myfi.rs`:**
  - `myfi_sign_in_start`:
    1. Makes the secret and challenge, and calls start.
    2. Opens `https://www.stoicdreams.com/signin?app=taskproxy&request=<id>` in the default browser.
    3. Returns the user code to show.
  - `myfi_sign_in_wait`: polls collect every 2 s until approved, cancelled, or expired.
  - `myfi_account` returns the account id and display name from `app/account`, or nothing when signed out. Apps belong to client companies, so they never get the user's email.
  - `myfi_sign_out` ends the session.
- **The session token** is kept in the OS keychain with `keyring`, like the security key. It never reaches the window. Every MyFi call goes through Rust, with `x-app` and `x-auth`.
- **Header button:** a new `wc/account.js` (`app-account`).
  - **Signed out:** **Sign In** opens a dialog showing the code, with "Approve this in your browser".
  - **Signed in:** your name, and **Sign Out**.
  - Icons are Web UI icons.
- **Sign-in is optional.** Everything works signed out except Remote Access.
- **Website media:** add the button to the header tour in the Set Up Task Proxy tutorial, with a loop.

### 1.2 Rust becomes the source of truth for shared state

The desktop benefits from this as well: terminals and commits no longer depend on the window that started them.

**Script runs:** `services/runs.rs`. *Done.*
- **Kept for each project:**
  - each terminal's name, status, exit code, start and end times, whether it was stopped, and whether it's a page script
  - the masked script it shows
  - its output in numbered batches, trimmed to 2 MB at a line start, as `appendOutput` does
  - the queue, which runs in its project whether or not that project is open
- **Stopping:** Ctrl+C, then force after 3 s, is in Rust. Ctrl+C typed into a terminal marks the run stopped too.
- **Commands:**
  - `run_script`, which starts a script or queues it
  - `get_runs` and `get_run_output(terminal, project, run, since)`
  - `stop_run`, `kill_all_scripts`
  - `clear_run_output`, `remove_run`, `remove_finished_page_scripts`
- **Events:** `run-changed`, with a revision so a screen keeps the newest, and `terminal-data` with the run and batch number.
- **The components:** `terminalHelpers` keeps its API (`getState`, `runScript`, `runAndWait`, `getDropdownOptions`, `runStatus`) over its copy of the Rust runs, which it loads at startup. `wc/terminals.js` only lost clearing the queue, which Rust does.

**Commit jobs:** `services/commit_queue.rs`. *Done.*
- **A job holds:**
  - the project and repo
  - the message
  - the files chosen, the files left out, and the project's ignored files
  - whether to sync after
  - its Run Before Commit script, as a path plus the PowerShell the window built from the values filled in
- **The steps:**
  1. Read the changed files, then run the script through `runs.rs` in the `Before Commit` terminal of the job's project, and wait for it.
  2. Commit the chosen files and those the script changed, then sync when asked, through `git_commit` and `git_sync`, called from Rust. `git_commit` is no longer a command, so a commit always runs as a job.
  3. Keep the last 20 finished jobs.
- Jobs made with Queue on run one at a time, in order. Others start straight away.
- **Commands:** `commit_enqueue`, `commit_jobs`, `commit_cancel`.
- **Event:** `commit-jobs-changed`, with a revision so a screen keeps the newest. Each job carries a note on what it is doing, and how it ended, which the window reports as it did before.
- `wc/git-manager.js` keeps its UI, `readScriptParameters` and `buildBeforeCommitScript`, and loads the jobs when it opens.
- **Missing credentials:** the job fails and says so. The token prompt stays on the desktop, at the next manual git action.
- **Tests:** `CommitStore` and choosing the files are tested in Rust. Running a whole job needs a Tauri app, so the mock backend runs jobs the same way for the UI tests. A Rust test against a temporary repository waits for a Tauri test runtime.

**App and project data as patches.** `services/shared_data.rs`. *Done.*
- **Commands:** `patch_app_data(patch, screen)` and `patch_project_data(id, patch, screen)` replace the whole-object syncs. A patch is `{set, remove, fields}`: values set and removed in `data`, and other fields, such as `variables` and `navigation`, given whole.
  - `syncAppData` and `syncProjectData` in `app.js` keep their names and work out the patch from what they last sent, so the components didn't change.
  - Rust applies each patch, raises the revision, and sends `data-changed` to every screen. The screen that sent it ignores its own, and the others apply it and call `setData`.
  - A patch for a project that is no longer open is dropped.
- **Shared and per-screen keys:**
  - Keys for one screen only are never applied from another: `page-path`, `page-title`, `page-subtitle`, `session-*`, `app-nav-routes`, the Terminal Manager's view and the home page state. They're listed in `screenKeys` in `app.js`. Rust keeps them like the rest, so the desktop opens where it was.
  - `app-current-project` is shared.
- **Saving:** `save_*`, autosave, and save on close don't change. A save still sends the window's whole copy, which has every other screen's changes applied.
- **Moved to 1.3:** checking `app-trusted-projects` in Rust when a page script runs, which belongs with filling in page scripts in Rust.

### 1.3 Secrets stay on the desktop

*Done.*

- **Redaction** (`services/secrets.rs`): what a remote device is sent replaces each secret value with `{"$secret": true}`. The gateway calls `redact_app_data` and `redact_project_data` for every device.
  - Secret values are every global variable (the Variables panel already treats them all as secret), project variables defined as `key|secret|...` in the project's values and in each environment in `_environments`, and `git_pat` and `github_pat` wherever they are set.
  - Plugin settings marked secret were already never sent to the window by `plugin_settings`.
  - A patch that carries the marker keeps the real value (`restore_markers`, applied in `shared_data.rs`), so a device that sends back what it was shown cannot overwrite a secret. Environments are matched by name.
  - `wc/var-manager.js` shows a kept value as an empty field with "Set. Type to replace it.", and won't copy it to another scope or the clipboard.
- **Filling in page scripts is in Rust** (`services/page_scripts.rs`):
  - `page_script_preview(script, pageValues)` returns the masked copy, for the code blocks and the trust prompt.
  - `run_page_script(terminalId, script, pageValues)` checks `app-trusted-projects`, fills in the real values, and starts the run with the masked copy shown.
  - The window sends the script's text, since a page can be run before its edits are saved, and the values typed or set on the page. Rust adds the project's and global values, so the window never needs a secret to run a script. A page value that is the marker is skipped, so the real value applies.
  - `injectVariableValues`, its regexes, Web UI's `toSnake`, and the scope switches are ported, with every case from the page handler's tests in Rust tests. The desktop uses the same commands, so there is one implementation.
- **Tests:** `secrets.rs` checks that no secret survives redaction, for data and for changes. `dispatch.rs` checks that every command a device may send either redacts what it returns or never returns a variable's value, so a new command can't be added without that decision. Calling every command with secrets set needs an app to call them in, which tests can't build while commands take the desktop's own `AppHandle`.

### 1.4 Remote gateway: `src-tauri/src/remote/`

*Done. Nothing calls it from outside yet: Phase 2 connects devices to it.*

| File | What it does |
|---|---|
| `mod.rs` | The `Remote` state: paired devices, the log, and connections. `open` serves a device whose handshake finished, `receive` handles its messages, and `forget_all` runs on MyFi sign-out. |
| `protocol.rs` | Messages, frames of up to 64 KB, the 16 MB limit on a device's message, the version check |
| `noise.rs` | `Noise_XXpsk3` and `Noise_IK` handshakes with `snow`, both sides, with the DTLS fingerprints in the prologue, and the encrypted channel |
| `devices.rs` | Paired devices: name, public key, MyFi account id, level, expiry, last seen, and the desktop's own key. Kept in `remote-devices.enc`. |
| `dispatch.rs` | The command table and permission checks |
| `hub.rs` | `broadcast` sends an event to the window and to every device. `data-changed` reaches devices with its secrets redacted. |
| `audit.rs` | The log of every remote command, without its arguments, in `remote-log.enc`, keeping the last 1000. Saved on the autosave interval and on close. |

**Dispatch:**
- A `remote_commands!` table gives each command its permission level and a handler. The handler reads the camelCase arguments and calls the existing command with `app.state()`.
- A Rust test reads `generate_handler!` in `lib.rs` and fails unless every command is either in the table or on the desktop-only list.
- What a device gets that the window doesn't:
  - `get_app_data`, `get_project_data` and `reload_project_files` are redacted.
  - A device can't open or close a project yet, since the desktop's window would not know it changed. Phase 3 adds that.
  - `run_script`, and `commit_enqueue` with a Run Before Commit script, need the project to be trusted, as page scripts do.
  - A patch can't change `app-trusted-projects`, or make a secret variable ordinary, since the device could then read it.
  - A patch from a device names its screen `remote:<device>:<screen>`, so the window applies it.
  - A plugin's git host actions need the Commit level, and its links open on the device.
- File previews stream from 127.0.0.1, which a device can't reach, so `get_file_server_base` is desktop-only until Phase 2 sends files over the connection.

**Permission levels:**

| Level | Allows |
|---|---|
| **View** | Projects, pages, docs, diffs, file previews, CI, terminal output, the Task Manager list, plugin pages, notifications |
| **Work** | View, plus: edit pages, docs and navigation; set variables (secrets write-only); run trusted scripts; type into terminals; stop runs and processes; plugin actions that don't change git |
| **Commit** | Work, plus: commit and the commit queue; pull, push and sync; branches; stash; restore files; plugin host actions that change git |
| **Desktop only** | Security key, updates, Add Project, installing plugins from a folder, installing PowerShell, trusting a new project, pairing devices, MyFi sign-in and sign-out |

### 1.5 Tests

*Done.*

**Rust** (`cargo test -p taskproxy`):
- **Handshakes:** both, with `snow`, over an in-process pipe, including a wrong pairing secret, a party in the middle, and a device holding another desktop's key (`remote/noise.rs`). `remote/tests.rs` connects a paired device from its handshake to a command's reply.
- **Permissions:** every command at every level, and desktop-only commands always refused (`remote/dispatch.rs`).
- **Secrets:** redaction of data and of changes (`services/secrets.rs`), and every remote command placed as redacting or never returning a value (`remote/dispatch.rs`).
- **Runs:** the queue, output trimming and sequence numbers (`services/runs.rs`).
- **Commit pipeline:** a job's steps against a temporary repository: the files changed before its script, its changes, and the commit (`services/commit_queue.rs`).
- **Data:** patch revisions, and changes for a project no longer open (`services/shared_data.rs`).
- **Script filling:** the ported cases (`services/page_scripts.rs`).
- **MyFi sign-in:** start, wait, approval, refusal, cancel, a new sign-in replacing one, and expiry while the API can't be reached, against a fake API (`services/myfi.rs`).

**Database and API** (`pwsh ./PowerShell/Test-Database.ps1` in `Apis/Databases`, against a throwaway PostgreSQL cluster):
- **App sign-in:** a request that wasn't approved, the wrong secret, another app collecting, an expired request, a request used twice, who may approve, and the limit on sign-ins from one place.
- **The `StartRequest` fix:** an app session resolves to its user, which fails with the code from before the fix.
- **Session expiry:** each use keeps a session 90 more days, and an expired one signs no one in.
- API endpoints are these SQL functions, so the tests call them directly.

**UI:**
- `tests/components/account.spec.mjs`.
- The Terminal Manager, Git Controller and Variables specs run against the Rust-backed state in the mock backend.

---

## Phase 2: Pair and connect

When Phase 2 ships, the signed-in desktop shows a QR code. The phone, signed in to the same account on taskproxy.com, scans it once. From then on it connects from any network, directly whenever the networks allow, and both sides show how.

### 2.1 Desktops and mailboxes in api.myfi.ws

**Everything is SQL functions behind the dynamic API handler,** like every other MyFi endpoint: no Rust crate. Rust in the API is only for the shared request handling, and none is needed here.

**Tables:** `remote.Desktops` (`desktop_id`, `user_id`, `app_id`, `name`, `public_key`, `last_seen`, `created`) and `remote.Messages` (`id`, `mailbox`, `from_user_id`, `body`, `expires`). Messages last seconds, and a function deletes them as it reads them.

**Endpoints.** dyn_api names a function from the path, so ids go in the body or query string, never in the path:

| Endpoint | Function | Who | What |
|---|---|---|---|
| `POST remote/desktop/register` | `api_post_remote_desktop_register` | An app's session (`p_request_app_id`, `p_user_id`) | Registers or updates this desktop (name, public key) under its account. Returns `desktopId`. |
| `DELETE remote/desktop` | `api_delete_remote_desktop` | The owner, from the app or `www.taskproxy.com` | Removes the desktop and its messages |
| `GET remote/desktops` | `api_get_remote_desktops` | `www.taskproxy.com`, signed in | Your desktops: name, key fingerprint, and whether each is online (checked in the last 60 s) |
| `POST remote/message/send` | `api_post_remote_message_send` | `www.taskproxy.com`, signed in to the **same account** as the desktop | Leaves a message for the desktop, with a reply mailbox id. Refused (403) for any other account, and stored with the sender's account id. |
| `POST remote/messages` | `api_post_remote_messages` | The desktop's own app session | Returns and deletes its waiting messages, with each sender's account id. Also marks the desktop online. |
| `POST remote/reply/send` and `POST remote/replies` | `api_post_remote_reply_send`, `api_post_remote_replies` | The desktop sends, and the phone reads with the same account's session | The desktop's replies. The reply id is random for each attempt. |
| `GET remote/turn` | `api_get_remote_turn` | Either side, signed in | Short-lived coturn credentials, only if TURN is added. HMAC in SQL needs the `pgcrypto` extension. |

**Polling, not long-polling.** A function call returns at once and doesn't hold a database connection open, so both sides poll:
- The desktop polls every 10 s while Remote Access is on, and every 1 s while a connection is being set up.
- The phone polls its reply mailbox every 1 s while connecting.
- So a connection starts within about 10 s. If that's too slow, the exception would be a small, general wait in the shared request handling, not a remote-only service. Decide that from use.

**Limits, in the functions:**
- Each message is at most 16 KB, at most 20 wait at once, and each is dropped after 60 s.
- Sends are limited per account and per `mach_id`.

**What the API can't do:** read or change the messages. Every message is a Noise message, so it can't read, forge or take over a connection, only refuse one.

**Origins:** each function checks its own, as `@origin` requires.
- Site endpoints: `@origin: www.taskproxy.com`.
- App endpoints: `@origin: any`, refusing calls without an app (`p_request_app_id` of 0).

**STUN:** run your own (coturn does this) rather than a third party's.

### 2.2 Pairing

**Remote Access panel:** a new `wc/remote-access.js`, opened from Settings and from a header button that shows while anything is connected.

**Turning it on:**
1. If you're signed out, the switch has you sign in first.
2. Turning it on registers the desktop and starts polling its mailbox every 10 s.
3. It asks the OS not to sleep: systemd-inhibit on Linux, an IOPMAssertion on macOS, `SetThreadExecutionState` on Windows.
4. A setting turns it off after a number of hours with no connection.

**Pairing a device:**
1. Choose a name, a level, and how long it lasts (7, 30, 90 days, or never).
2. The panel shows a QR code (drawn in Rust as SVG by the `qrcode` crate) and a link.
   - **The link:** `https://www.taskproxy.com/remote/#pair=<payload>`.
   - **The payload, as base64url:** `{v, desktopId, desktopKey, secret, expires}`.
   - **The secret** works once and expires in 10 minutes.
3. The phone checks the account (see "How the account check works"), and the device is saved with its account id.

**Paired devices:**
- Each shows its account, the last time it connected, and how.
- You can rename one, change its level, revoke it, or disconnect it now.

**Activity:** the audit log.

**Header indicator:** while a device is connected, a Web UI icon in the header shows its name. Pairing, connecting, and refusals, including a refused account, raise a desktop notification and an alert in the Alerts panel.

**Signing out on the desktop**, or signing in as someone else, turns Remote Access off, deletes this desktop from the API, and removes every paired device.

### 2.3 WebRTC on the desktop

**The library:**
- **`str0m`** is the recommendation: it does no I/O itself, so it fits Tokio.
- **`webrtc` (webrtc-rs)** is the alternative.
- **Measure the binary size,** as was done for Extism.

**How a connection is made:**
1. The phone posts the first Noise message, carrying its SDP offer, to the desktop's mailbox.
2. The desktop checks the sender's account and replies with the second message, carrying its answer, to the reply mailbox.
3. ICE candidates go back and forth the same way.
4. The data channel opens, and the protocol above runs over it.

**The gateway:** dispatch, permissions and events from 1.4 don't change.

**How it connected:** shown on both sides as **Direct (same network)**, **Direct (internet)**, or **Relayed**, read from the ICE candidate pair in use.

**On the same network,** or over Tailscale or WireGuard, host candidates make the connection direct.

### 2.4 The client on TaskProxy.com

**Files:** `webapp/root_files/remote/index.html` and `remote.js` in the website repo. This is a static page outside the site's nav shell.

**Signing in comes first.**
- **Signed out:** the page keeps the `#pair=` payload in `sessionStorage` for that tab, then signs in through the usual stoicdreams.com handoff.
- **A return path for the handoff:** add a `&return=/remote/` parameter to `/signin?domain=`, and to `webui-myfi-info` in MyFiCDN. It accepts only a path on the same site, and sends you to `https://<site><path>#myfi-signin=<code>`. Other sites can use it too, so deploy the CDN first.
- **Back on `/remote/`:** the page exchanges the code as the loader does, then continues the pairing.

**Your desktops:** the page lists them from `GET remote/desktops`, showing which are paired on this device and which are online.

**Device keys:**
- Kept in IndexedDB, with the account id they belong to.
- After you sign in as another account, only that account's pairings show.

**The app comes from the desktop:**
- The outer page holds the connection.
- The app runs in a same-origin `<iframe>` at `/remote/app/`, so moving between its pages never drops the connection.
- A service worker, `remote/sw.js` scoped to `/remote/app/`, answers the iframe's requests by asking the outer page, which asks the desktop.
- **The `__TAURI__` stand-in** is put into the app's `index.html` before `app.min.js`:
  - `core.invoke` and `event.listen` go over the connection.
  - `opener.openUrl` uses `window.open`.
  - `dialog.open` says "Only on the desktop".
- **Caching:** files are cached by content hash.
- **The CDN:** `webui-*` components still load from it.

**`app.js` changes:**
- `webui.proxy.remote` gives `{level, deviceName, account}`.
- Components hide what the level doesn't allow. The backend refuses those commands anyway.

**File previews:** the service worker answers `/remote/app/files/<path>` with byte ranges, through a new `get_project_file_range`, so videos stream.

**Add to Home Screen:** `remote/app.webmanifest`, scoped to `/remote/`, lets the page be installed. On iOS, Safari can delete a site's storage after 7 days without a visit unless it's on the Home Screen. If keys are lost, pair again.

**Spike this first:** whether the Web UI loader, routes, and `wc/` paths work under `/remote/app/` in an iframe, since the app assumes `<base href="/">`.
- **Fallback:** a static subdomain such as `remote.taskproxy.com`.
- **What a subdomain needs:** registering in `identity.Sites` for MyFi sign-in, and its own session.

**The shared website tests:** `service-worker.spec.mjs` is shared with every site and stays unchanged. Add a test that the main service worker never answers under `/remote/app/`.

### 2.5 Tests

**API:**
- **Account checks:**
  - a post from another account is refused
  - a desktop's mailbox can't be read with another app session
  - a signed-out post is refused
- **Limits,** expiry, and registration.

**Desktop:**
- signaling against a fake API
- two `str0m` peers in one process over loopback
- a swapped DTLS fingerprint is refused
- a message whose account id doesn't match is refused
- signing out removes every device

**Website:**
- **The pairing page:**
  - signed out, it keeps the payload through sign-in and comes back to `/remote/`
  - a refused account says so
  - an expired code says so
- **End to end:** a test peer in the browser plays the desktop and loads the app through the service worker.
- **On stoicdreams.com:** the `return` path, including refusing another site's path.

**By hand:** the phone on cellular data with the desktop at home. Count Direct against failed, which settles TURN.

**Then:** `/security-review` before release.

---

## Phase 3: Phone layout and working away from the desk

**Layout:** `@media (max-width: 700px)` in `css/app.css` and in components.
- Drawers become full screen with a back button, and the nav opens over the page.
- Check `webui-app` and `webui-drawer` when narrow, and fix the framework in MyFiCDN first.

**Changes since you left:** `wc/remote-home.js`, the first screen a remote device sees. For each project:
- changed files, and commits ahead and behind
- CI
- runs that are going and those that finished since your last connection, failures first
- queued and finished commits

Each item opens the right screen.

**The Git Controller:**
- A full-width file list with large include and exclude controls.
- Tapping a file opens its diff full screen, with lines wrapped.
- A bar fixed to the bottom holds the message, the Run Before Commit status, and Commit.

**Terminals:**
- xterm fits the screen's width.
- Output is read-only until you tap Type.
- A key row gives Ctrl+C, Enter, Tab, Esc, and the arrow keys.
- The Finished view is one tap away.

**Pages:** read first, and a segment opens its editor when tapped.

**The Task Manager:** cards rather than table rows.

**Review notes (optional, confirm first):** a note on a diff line, saved to `.taskproxy/review-notes.md` or copied as text, so Claude started from the phone can read your feedback.

**Notifications (optional):**
- **When:** a run, commit, or CI result finishes while the phone isn't connected.
- **How:** Web Push through api.myfi.ws (VAPID), sent only to devices of the desktop's account.
- **The message:** the desktop sends it already encrypted for the device.
- **iOS:** needs the page on the Home Screen.

**TURN:** decide from Phase 2's numbers.

**Tests:** a phone-sized Playwright project, and website loops recorded at phone size by `tools/capture`.

---

## Docs and website

**`Docs/README.md`:**
- MyFi sign-in
- Remote Access, and its levels
- the account rule
- what never leaves the desktop

**`CLAUDE.md`:** a Remote Access section covering:
- the gateway table and choosing a level
- secrets never sent to a device
- shared and per-screen keys
- the MyFi token staying in Rust

**TaskProxy.com:**
- A Remote Access page covering:
  - the account rule
  - the levels and the encryption
  - what api.myfi.ws sees: which desktops your account has, when devices connect, and the size of encrypted messages
- A "Use Task Proxy from your phone" tutorial in the tutorial chain, with its Continue button and loops.

**stoicdreams.com:** the account page lists app sign-ins and Task Proxy desktops.

## Order of work

**Phase 1:**
1. **The database and API for app sign-in,** including the `StartRequest` fix. Then the approval page on stoicdreams.com. Then sign-in in the app.
2. **1.2, moving runs, commits and data to Rust.** Ship it with sign-in; it's the riskiest for regressions.
3. **1.3, secrets on the desktop.** Then 1.4, the gateway, with its tests.

**Alongside Phase 1:** the 2.4 spike, since it can change the client's design.

**Phase 2:**
1. **2.1, the API.** Then the `return` path on stoicdreams.com and in MyFiCDN.
2. **Then the rest:** 2.2 pairing, 2.3 WebRTC, 2.4 the client, and 2.5 the tests.

**Phase 3:** the layout, then "changes since you left". Then decide on review notes, notifications and TURN.

**Each repo ships on its own:** the database, the API, stoicdreams.com, MyFiCDN, TaskProxy.com, and Task Proxy. Deploy what the app depends on first, as with CDN changes today.

## Risks

- **A phone can run code on the desktop.**
  - Guarded by:
    - the account check
    - the device keys
    - permission levels
    - the command table that fails without a decision
    - the secret sweep
    - the audit log
    - devices that expire
  - A security review before each phase ships.
- **Sign-in phishing:** someone sends you an approval link for their own request. The page names the computer and shows a code that must match Task Proxy's, and requests expire in 10 minutes. A desktop signed in that way would also show in your account's desktop list.
- **Moving state to Rust** touches the Git Controller, the Terminal Manager, and the Variables panel.
- **Some phone networks block direct connections,** which settles the TURN decision.
- **The iframe and service worker approach** depends on the Web UI loader working under a path. That's the spike, with a subdomain as the fallback.
- **Polling** makes a connection start within about 10 s, and costs one small request every 10 s per desktop with Remote Access on.
- **iOS can drop a site's storage.** Recommend the Home Screen, and make pairing again quick.
