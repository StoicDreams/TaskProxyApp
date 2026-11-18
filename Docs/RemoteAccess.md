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
| `noise.rs` | `Noise_XXpsk3` and `Noise_IK` handshakes with `snow`, both sides, with the desktop's id and the reply mailbox in the prologue, and the encrypted channel |
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
| **Desktop only** | Security key, updates, Add Project, installing plugins from a folder, installing PowerShell, trusting a new project, pairing devices (except a paired device's "Continue on another device", capped at its own level), MyFi sign-in and sign-out |

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

*Done in `Apis/Databases`. Nothing calls it until 2.2.*

**Everything is SQL functions behind the dynamic API handler,** like every other MyFi endpoint: no Rust crate. Rust in the API is only for the shared request handling, and none was needed.

**Tables,** in a new `remote` schema (`Postgres/Tables/Remote/`):
- `remote.Desktops`: `desktop_id`, `user_id`, `app_id`, `mach_id`, `name`, `public_key`, `last_seen`. One row per account and public key.
- `remote.Messages`: `mailbox`, `to_desktop`, `desktop_id`, `user_id` (the sender, always the desktop's account), `reply`, `body`, `expires`. Deleted as they are read.
- `remote.Sends`: when each message was sent, by which account and from which `mach_id`, kept for a minute for the limits (`remote.CanSend`).

**Endpoints.** dyn_api names a function from the path, so ids go in the body or query string, never in the path. Bodies are camelCase, such as `desktopId`. `message` is the encrypted Noise message as base64url.

| Endpoint | Who | Sends | Returns |
|---|---|---|---|
| `POST remote/desktop/register` | An app's session | `name`, `publicKey` (64 hex) | `{desktopId}`. The same key on the same account keeps its id. |
| `DELETE remote/desktop` | The app that registered it, or `www.taskproxy.com`, signed in to its account | `desktopId` | Removes it and its messages |
| `GET remote/desktops` | `www.taskproxy.com`, signed in | | `{desktops: [{desktopId, name, fingerprint, online, lastSeen}]}`. `fingerprint` is the first 16 hex of the key's SHA-256; online means read in the last 60 s. |
| `POST remote/message/send` | `www.taskproxy.com`, signed in to the **desktop's account** | `desktopId`, `reply` (a random UUID per attempt), `message` | `{online}`. Any other account, or an unknown desktop, gets the same 403. |
| `POST remote/messages` | The app that registered it, signed in to its account | `desktopId` | `{messages: [{reply, from, message}]}`, oldest first, then deletes them. `from` is the sender's account id. Marks the desktop online. |
| `POST remote/reply/send` | The same app | `desktopId`, `reply`, `message` | Leaves the answer in the reply mailbox |
| `POST remote/replies` | `www.taskproxy.com`, signed in | `reply` | `{messages: [{desktopId, message}]}`, only from that account's desktops, then deletes them |

`GET remote/turn` waits until TURN is added.

**Origins:** each function checks its own, as `@origin` requires. Site endpoints refuse app sessions, and app endpoints refuse calls without an app (`p_request_app_id` of 0).

**Polling, not long-polling.** A function call returns at once and doesn't hold a database connection open, so both sides poll:
- The desktop polls every 10 s while Remote Access is on, and every 1 s while a connection is being set up.
- The phone polls its reply mailbox every 1 s while connecting.
- So a connection starts within about 10 s. If that's too slow, the exception would be a small, general wait in the shared request handling, not a remote-only service. Decide that from use.

**Limits, in the functions:**
- Each message is at most 16 KB of base64url.
- At most 20 wait for a desktop, and 20 in a reply mailbox. Each is dropped after 60 s.
- An account sends at most 120 a minute, desktop answers included, and a `mach_id` at most 60.
- An account has at most 20 desktops.

**What the API can't do:** read or change the messages. Every message is a Noise message, so it can't read, forge or take over a connection, only refuse one.

**The request log keeps bodies,** so it holds the encrypted messages too. They are useless without the keys, but they take space: a connection is about ten messages of a few KB.

**Tests:** `Postgres/Tests/RemoteAccess.test.sql`, run by `Test-Database.ps1` (see 2.5).

**STUN:** run your own (coturn does this) rather than a third party's.

### 2.2 Pairing

*The desktop's side is done. A device can pair once 2.4 builds the page the QR code opens.*

**Remote Access panel:** `wc/remote-access.js`, in Settings, and in the header as a button that shows while a device is connected and opens the panel in a dialog.

**Turning it on** (`remote/service.rs`):
1. Signed out, the panel says to sign in first, with a Sign In button.
2. Turning it on registers the desktop with its name and key, and reads its mailbox every 10 s, or every second while a QR code is open or a device is pairing.
3. At startup it reads the mailbox again if it was on. Without a network it keeps trying. If api.myfi.ws no longer has the desktop, it registers again. If the session ended, it turns off with a notice.
4. Turning it off stops reading, removes the desktop from api.myfi.ws, ends connections and any QR code, and keeps the paired devices for next time.
5. **While it's on, the computer is kept awake** (`remote/awake.rs`, the `keepawake` crate): systemd's inhibitor locks on Linux, a power assertion on macOS, and `SetThreadExecutionState` on Windows, held on a thread of its own since Windows keeps a computer awake only for the thread that asked. The screen can still turn off. A setting lets it sleep as usual, and the panel says when it couldn't be kept awake.
6. **It can turn off by itself** after 1, 4, 8, 12, 24 or 48 hours without a device connecting, sending, or pairing, counted from turning on or the setting's last change. Never while a device is connected or pairing. It's off (never) unless chosen, and turning off raises a notice.

**Pairing a device** (`remote/pairing.rs`), through the mailbox, so it needs no direct connection:
1. Choose a name, a level, and how long it stays paired without connecting: 7, 30 or 90 days, or for good. A connection renews it.
2. The panel shows a QR code, drawn in Rust as SVG by the `qrcode` crate, and the link, with Copy Link and Cancel.
   - **The link:** `https://www.taskproxy.com/remote/#pair=<payload>`.
   - **The payload, as base64url JSON:** `{v: 1, desktopId, desktopKey (hex), secret (base64url), expires (ms), name}`.
   - **The secret** works once and expires in 10 minutes. A new QR code replaces the open one.
3. The phone and desktop run `Noise_XXpsk3` through the mailbox. Each message's body is a kind byte and the Noise message (`remote/mailbox.rs`):

   | Kind | From | Carries |
   |---|---|---|
   | 1 `Pair1` | Device | Its ephemeral key |
   | 2 `Pair2` | Desktop | Its key, and `{name}` |
   | 3 `Pair3` | Device | Its key, `{name}`, and proof it holds the secret |
   | 4 `Paired` | Desktop | Encrypted `{ok, deviceId, name, level, days, desktopName}` |
   | 5 `Refused` | Desktop | Why, as plain text |

   - The prologue holds the desktop's id and the reply mailbox, so a message can't be moved to another pairing.
   - At most 4 pairings wait at once, each for 2 minutes between messages.
   - A wrong secret is refused without using up the QR code.
4. The sender's account is checked against the desktop's own (see "How the account check works"), and the device is saved with its account id, level, and lifetime.

**Moving to another device:** working on the phone, then picking up the laptop in another room.
- **"Continue on another device"** in the client asks the desktop, over the phone's connection, for a one-time pairing like the QR code's: the same payload, 10 minutes, used once.
- The phone shows it as a QR code and a short link. Opening either on the laptop pairs the laptop: the same account check applies, and the laptop's level and expiry can't be more than the phone's.
- The payload also carries where the phone was (project, route, open terminal), so the laptop opens on the same screen.
- The phone stays connected until it's closed or disconnected. Both are separate paired devices, each in the Paired devices list and the log, and the desktop raises a notification that the phone added the laptop.
- **Once paired,** the laptop connects from its own list of desktops on taskproxy.com, with no phone needed. "Continue on another device" then only hands over the screen: the link opens the same place on a device that's already paired.
- **Needs a new command,** `remote_continue`, at the Work level. It is the only way a device creates a pairing, and its level and expiry are capped by the caller's own. The desktop's own `remote_invite` stays desktop-only.

**Paired devices:**
- Each shows when it paired, when it last connected, when it unpairs, and whether it's connected now. How it connected comes with 2.3.
- You can rename one, change its level, unpair it, or disconnect it now.

**Activity:** the audit log, including pairings and refused pairings, newest first.

**Header indicator:** while a device is connected, a Web UI icon in the header shows its name. Pairing and refusals, including a refused account, raise a desktop notification and an alert in the Alerts panel. Connecting comes with 2.3.

**Signing out on the desktop**, or signing in as someone else, turns Remote Access off, deletes this desktop from the API, and removes every paired device.

**Commands,** all desktop-only: `remote_status`, `remote_set_enabled`, `remote_invite`, `remote_invite_cancel`, `remote_device_update`, `remote_device_remove`, `remote_device_disconnect`, `remote_log`, `remote_settings`. `remote-changed` tells the window to refresh, with a notice when there is one.

### 2.3 WebRTC on the desktop

*The desktop's side is done, for devices on the same network or VPN. Connections across the internet wait for a STUN server (below). A device can connect once 2.4 builds the client.*

**The library: `str0m` 0.25, with its OpenSSL backend.** It does no I/O itself, so it fits Tokio. `webrtc` (webrtc-rs) was the alternative.

**Binary size, measured on 2026-11-17** with the app's release settings (LTO, `opt-level = "s"`, stripped). Each program sets up two peers in one process and sends a message over the data channel, so all of ICE, DTLS, SCTP and the channel is linked in:

| Program | Size | Crates new to Task Proxy |
|---|---|---|
| The crypto Task Proxy already has (vendored OpenSSL, ring) | 4.99 MB | |
| With str0m, OpenSSL backend (`features = ["openssl", "vendored"]`) | 7.37 MB (+2.4 MB) | 10: str0m, str0m-proto, str0m-openssl, sctp-proto, dimpl, and small helpers |
| With str0m, pure-Rust backend (`rust-crypto`) | 7.80 MB (+2.8 MB) | 38, including a second crypto library (aws-lc) |

- **The OpenSSL backend reuses the OpenSSL git2 already vendors,** so it adds the least. +2.4 MB is the most it can add to the app, since the measuring programs share less with str0m than Task Proxy does.
- Both backends connected the two peers, with the message arriving after 0.3 s of simulated time.

**How a connection is made** (`remote/connect.rs`, `remote/webrtc.rs`), one message each way through the mailbox:
1. **`Connect1`:** the phone posts the first `Noise_IK` message to the desktop's mailbox, carrying `{offer}`, its WebRTC offer with all its addresses.
2. **`Connect2`:** the desktop checks the sender's account, finds the device by its key (paired, not expired, on this account, Remote Access on), and answers with `{answer}`, carrying all of its own addresses. A refusal says why, as with pairing.
3. The data channel opens, and the protocol above runs over it. Each message on it is a frame of the Noise channel the handshake finished, inside WebRTC's own DTLS.

**Decided on 2026-11-17:**
- **The DTLS fingerprints travel in the offer and answer, inside the Noise handshake,** which authenticates them, rather than in the prologue. The phone writes the first message before it can know the desktop's fingerprint, so the prologue can't hold both. The prologue holds the desktop's id and the reply mailbox instead. WebRTC then refuses a DTLS peer whose certificate doesn't match its side's fingerprint.
- **Candidates aren't trickled:** each side sends all of its addresses at once, so a connection takes two mailbox messages, and the browser waits for its own addresses before sending its offer.
- **Same network first:** the desktop offers its local IPv4 addresses (each interface except loopback, from `sysinfo`), one UDP socket each, so it knows which address each packet arrived on. That covers the same Wi-Fi, Tailscale and WireGuard. **A STUN server,** for connections across the internet, becomes a setting once one runs on coturn. Until then, the same network or a VPN is needed.

**The connection's life:**
- The data channel must open within 30 s of the answer. A connected device that goes 45 s without a message (it pings every 15 s) is dropped, as is one whose network goes away.
- Unpairing or disconnecting a device on the desktop ends its connection at once.
- Each connection, disconnection and refusal goes in the Activity log, and a connection raises a notice.

**The gateway:** dispatch, permissions and events from 1.4 don't change. `webrtc.rs` reaches the app only through its `Hooks` trait, so its tests run a real connection without a window.

**How it connected:** the panel shows **Direct (same network)** or **Direct (internet)**, read from the addresses the connection uses: both on a private network, a VPN such as Tailscale (100.64.0.0/10), or this computer, is the same network. **Relayed** comes with TURN.

**Tests** (`cargo test -p taskproxy remote::`):
- A paired device connects over real UDP on this computer, says hello, runs a command and gets its reply, all inside the Noise channel, and is cut off when the desktop drops it.
- An answer with a swapped DTLS fingerprint never connects.
- Accepting a connection: an unpaired device, another account, an expired pairing, Remote Access off, a message for another desktop or moved to another mailbox, and one without an offer.
- Reading the route from the addresses.

### 2.4 The client on TaskProxy.com

*Built and tested against a test desktop, not yet against a real one.* What's done, and what's left:

- **Done:** signing in, pairing, the desktop list, connecting, and the app running from the desktop in the frame. Also the app's remote mode, `remote_app_file`, and the tests.
- **Left:**
  - a run between a real phone and Task Proxy on a desktop
  - file previews (`get_project_file_range`)
  - components hiding what the level doesn't allow
  - "Continue on another device"
  - caching the app's files between visits

**Files,** in the website repo's `webapp/root_files/remote/`, a static page outside the site's nav shell:

| File | What it does |
|---|---|
| `index.html`, `remote.css` | The page |
| `remote.js` | Signing in, pairing, the desktop list, and connecting |
| `api.js` | api.myfi.ws |
| `store.js` | IndexedDB |
| `noise.js` | Noise, checked against the Noise test vectors |
| `connection.js` | The mailbox, pairing, connecting, and the protocol |
| `frame.js` | The app in the frame |
| `sw.js` | The service worker |
| `app.webmanifest` | Add to Home Screen |

`web.config` rewrites `/remote/` to the page, since the site's rule otherwise sends every path that isn't a file to the home page.

**Signing in comes first.**
- **Signed out:** the page keeps the `#pair=` payload in `sessionStorage` for that tab, then signs in through the usual stoicdreams.com handoff.
- **A return path for the handoff (done):** `/signin?domain=<site>&return=<path>` on stoicdreams.com sends you back to `https://<site><path>#myfi-signin=<code>`, accepting only a path on that same site, and falls back to the site's home page otherwise. `webui-myfi-info` sends the page you're on, and its `signinUrl(path)` builds the address for any page, such as `/remote/`.
- **Back on `/remote/`:** the page exchanges the code as the loader does, then continues the pairing.

**Your desktops:** the page lists them from `GET remote/desktops`, showing which are paired on this device and which are online. A paired one has Connect and Forget. A tab that was connected connects again when it reloads.

**Device keys:**
- Kept in IndexedDB, one pairing per desktop, with the device's private key for it.
- **Only the signed-in account's desktops are listed,** so after you sign in as another account, only that account's pairings show. The API only lists an account's own desktops, so the pairings need no account id of their own.
- **Pairing sends no name,** so the desktop keeps the one chosen with the QR code. The page checks that the key the desktop proved in the handshake is the QR code's.

**Codes in the address:** `#pair=` and `#myfi-signin=` are taken off the address at once. A code opened in a tab that already shows `/remote/` changes only the `#` part, which doesn't load the page again, so the page acts on `hashchange` too. A connection open at the time is closed first.

**Waiting for the desktop:** the page reads its reply mailbox 150 ms after sending, then twice as long each time, up to once a second, so an answer the desktop has ready isn't kept waiting.

**WebRTC:**
- The page waits for its own addresses before sending its offer, up to 5 s.
- Browsers name their local addresses with random `.local` names, or offer none. `str0m` accepts both (tested with a real Chromium offer), and the desktop learns the browser's real address from its connectivity checks.
- **Check on the real run:** Chrome's Local Network Access checks, which may ask before a public site such as taskproxy.com reaches the desktop's private address.

**The app comes from the desktop** (proven by the spike below):
- The outer page holds the connection.
- The app runs in a same-origin `<iframe>`, opened at `/remote/app/?c=<connection>`, so moving between its pages never drops the connection. `<connection>` is a random id the outer page makes for its connection.
- **A service worker, `remote/sw.js` scoped to `/remote/app/`,** controls the frame because the frame first loads inside that path. From then on it answers every request the frame makes, whatever its path, so the app's `/d/`, `/wc/` and `/appConfig.json` never reach the website. Requests to other sites, such as the CDN, go to the network.
- **The service worker keeps nothing,** since the browser stops an idle one and its memory with it:
  - The frame's first load names its connection (`?c=`), and the outer page holding that connection answers. Another tab's outer page says nothing.
  - Every other request goes to the frame that made it, whose stand-in passes it to the outer page above it.
  - Anything that fails answers 503, such as a request made while the frame is going away.
- **The `__TAURI__` stand-in** is put first in the app's `index.html` `<head>`. Anywhere later deadlocks: the stylesheet above it waits on the frame's message handler, which the stand-in sets, and the browser won't run the stand-in until that stylesheet loads. The stand-in:
  - **Replaces the frame's address with the app's own route** (`/`, or the route the tab was on), so the loader's paths, routes and `<base href="/">` work exactly as on the desktop.
  - Passes the service worker's requests to the outer page.
  - **Wraps `Worker`:** a worker's own script never reaches the page's service worker, so the stand-in starts it from a blob that imports the real script. The import carries `remote-connection=<id>` to name the connection, since the service worker hasn't seen the worker before.
  - **Reports the route** on every `pushState`, `replaceState` and `popstate`, except a project reload's `/_reloading`. The outer page keeps it in `sessionStorage`, so reloading opens the app where it was.
  - **Tells the outer page when the frame unloads,** and the outer page opens the app again. The frame's address is outside the service worker's scope, so a reload of the frame alone would otherwise load the website. Neither the app nor the loader reloads the page, so this is only a safeguard.
  - `core.invoke` and `event.listen` go over the connection.
  - `opener.openUrl` uses `window.open`.
  - `dialog.open` says "Only on the desktop".
- **The outer page removes the app's own service worker registration** from `index.html`, which would otherwise register the website's.
- **Caching:** files are cached by content hash.
- **The CDN:** `webui-*` components still load from it.

**`app.js` changes** (done unless noted):
- `webui.proxy.remote` gives `{level, deviceName, desktopName}`, from `window.__taskProxyRemote`, which the stand-in sets. `index.html` checks the same flag, so the frame never asks to stay when the outer page reloads.
- **Saving on a device sends a patch,** since `save_app_data` and `save_project_data` are desktop-only and the desktop saves on its own. A View device sends nothing, since the desktop would refuse it.
- **`get_version` and `has_securitykey` are View commands,** since the app asks both as it starts. Neither says more than a version number or that a key exists.
- **`remote_app_file`** gives a device the app's files, built into the app or from the dev server under `cargo tauri dev`. Only devices send it, so `lib.rs` doesn't register it, and the dispatch test accepts it from its `DEVICE_ONLY` list.
- *Left:* components hiding what the level doesn't allow.
- Components hide what the level doesn't allow. The backend refuses those commands anyway.
- **The page shown is each screen's own.** At startup the app opens the project's last page, which the backend keeps, and every page change updates it. On a device, that is the desktop's page. So in remote mode the app starts on the route the stand-in restored, and its page changes don't change the project's last page.

**File previews:** the service worker answers `/remote/app/files/<path>` with byte ranges, through a new `get_project_file_range`, so videos stream.

**Add to Home Screen:** `remote/app.webmanifest`, scoped to `/remote/`, lets the page be installed. On iOS, Safari can delete a site's storage after 7 days without a visit unless it's on the Home Screen. If keys are lost, pair again.

**The spike (done 2026-11-17): the app runs under `/remote/app/` in a frame, so no subdomain is needed.** A prototype stood in for taskproxy.com with a local server, played the desktop with the UI tests' mock backend in the outer page, and served the app's files from this repo as the connection will. In Chromium and Firefox:
- The app starts in the frame, controlled by the remote service worker, and its home page loads.
- Routes, lazy-loaded components, and a real click on a nav link all load through the service worker. None of the app's requests reached the website.
- The app's background worker answers through the blob import.
- Reloading the outer page, or the frame alone, opens the app again on its route.

The approach above is the one the prototype settled on. Each of its points fixed a failure the prototype hit:
- **Answering the frame's requests:** keeping each connection in the service worker's memory failed after the browser restarted it.
- **The stand-in's place in `<head>`:** later than first, it deadlocked.
- **The worker's script** reached the website until the stand-in started it from a blob.
- **The frame's address:** a reload of the frame alone loaded the website until the outer page reopened the app.
- **Failures:** Firefox reported the service worker throwing for a request made while the frame unloaded, until it answered 503.

taskproxy.com sends no content security policy, so the blob worker needs no change there.

**The shared website tests:** `service-worker.spec.mjs` is shared with every site and stays unchanged. Add a test that the main service worker never answers under `/remote/app/`.

### 2.5 Tests

**API:** *done, in `Postgres/Tests/RemoteAccess.test.sql`.*
- **Account checks:**
  - a post from another account is refused
  - a desktop's mailbox can't be read with another app session
  - a signed-out post is refused
- **Limits,** expiry, and registration.

**Desktop:** *done, in `src-tauri/src/remote/`.*
- signaling against a fake API (`mailbox.rs`)
- a phone and the desktop connecting over UDP on this computer (`webrtc.rs`)
- a swapped DTLS fingerprint is refused (`webrtc.rs`)
- a message whose account id doesn't match is refused (`pairing.rs`, `connect.rs`)
- signing out removes every device (`devices.rs`)

**Website:** *done, in `tests/remote.spec.mjs` and `tests/remote-noise.spec.mjs` in the website repo.* They run against a test desktop in the browser (`tests/fixtures/remote/desktop.js`) and a mock of the mailbox, with real service workers and WebRTC. They run in Playwright's own Chromium, since Arch's Chromium 156 offers no WebRTC addresses at all when Playwright drives it. Covered:
- the Noise test vectors, both handshakes
- **The pairing page:**
  - signed out, it keeps the payload through sign-in and comes back to `/remote/`
  - a refused account says so
  - an expired code says so
- **End to end:** a test peer in the browser plays the desktop and loads the app through the service worker.
- reloading, a dropped connection, Disconnect, the desktop list, another protocol version, and the site's own service worker
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
- **The iframe and service worker approach** was proven in Chromium and Firefox by the 2.4 spike. Safari on iOS is the browser most phones will use, so the client's end-to-end test should run in WebKit too, and a subdomain such as `remote.taskproxy.com` stays the fallback if WebKit differs.
- **Polling** makes a connection start within about 10 s, and costs one small request every 10 s per desktop with Remote Access on.
- **iOS can drop a site's storage.** Recommend the Home Screen, and make pairing again quick.
