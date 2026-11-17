//! Turning Remote Access on and off, reading this desktop's mailbox, and the Remote Access panel's commands
//! (Docs/RemoteAccess.md, 2.2).
//!
//! While Remote Access is on, the desktop is registered with api.myfi.ws and reads its mailbox every 10 seconds, or
//! every second while a QR code is open or a device is pairing. Every command here is desktop-only.

use super::devices::{self, Device, Level, PAIRING_CHOICES};
use super::mailbox::{Inbound, MailboxError};
use super::pairing::{self, Desktop, Invite, Outcome};
use super::{Remote, audit, now_ms};
use crate::prelude::*;
use crate::services::myfi::{self, MyFiApi};
use tauri::Emitter;

const SLOW_POLL: Duration = Duration::from_secs(10);
const FAST_POLL: Duration = Duration::from_secs(1);
/// The event the Remote Access panel and the header's indicator follow.
pub(crate) const CHANGED: &str = "remote-changed";

/// Whether the mailbox can be read, as the panel shows it.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reachability {
    pub reachable: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceStatus {
    #[serde(flatten)]
    pub device: Device,
    pub connected: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InviteStatus {
    pub link: String,
    pub svg: String,
    pub name: String,
    pub level: Level,
    pub days: u32,
    pub expires_at: u64,
}

/// Everything the Remote Access panel shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteStatus {
    pub enabled: bool,
    pub signed_in: bool,
    pub desktop_name: String,
    pub desktop_id: Option<String>,
    pub fingerprint: Option<String>,
    pub reachability: Reachability,
    pub invite: Option<InviteStatus>,
    pub devices: Vec<DeviceStatus>,
    pub pairing_days: Vec<u32>,
}

/// Something the window shows in the Alerts panel, as well as a desktop notification.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    pub text: String,
    pub severity: &'static str,
}

fn desktop_name() -> String {
    myfi::computer_name(sysinfo::System::host_name().ok())
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|err| err.to_string())
}

/// What the panel shows now.
pub(crate) fn status(app: &AppHandle) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    let store = lock(&remote.devices)?.clone();
    let connected = remote.connected_devices();
    let invite = lock(&remote.invite_status)?
        .clone()
        .filter(|invite| invite.expires_at > now_ms());
    Ok(RemoteStatus {
        enabled: store.enabled,
        signed_in: lock(&remote.session)?.is_some() || store.account_id.is_some(),
        desktop_name: desktop_name(),
        desktop_id: store.desktop_id.clone(),
        fingerprint: store
            .desktop_keys
            .as_ref()
            .map(|keys| pairing::fingerprint(&keys.public)),
        reachability: lock(&remote.reachability)?.clone(),
        invite,
        devices: store
            .devices
            .into_iter()
            .map(|device| DeviceStatus {
                connected: connected.contains(&device.id),
                device,
            })
            .collect(),
        pairing_days: PAIRING_CHOICES.to_vec(),
    })
}

/// Tells the window that something the panel shows changed, with a notice to raise if there is one.
fn changed(app: &AppHandle, notice: Option<Notice>) {
    if let Some(notice) = &notice {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title("Task Proxy Remote Access")
            .body(&notice.text)
            .show();
    }
    let _ = app.emit(CHANGED, serde_json::json!({ "notice": notice }));
}

async fn save(app: &AppHandle) -> Result<(), String> {
    let store = lock(&app.state::<Remote>().devices)?.clone();
    devices::save(app, &store).await
}

/// The signed-in session and account, from the keychain, kept for the mailbox loop.
async fn sign_in_details(app: &AppHandle) -> Result<(String, String), String> {
    let (session, account) = myfi::session().await.ok_or_else(|| {
        String::from(
            "Sign in to your Stoic Dreams account first, from the account button at the top.",
        )
    })?;
    let account = match account {
        Some(account) => account,
        None => myfi::api()?
            .account(&session)
            .await?
            .ok_or_else(|| String::from("Sign in to your Stoic Dreams account again first."))?,
    };
    *lock(&app.state::<Remote>().session)? = Some(session.clone());
    Ok((session, account.id.to_string()))
}

/// Registers this desktop under the signed-in account, and returns its id.
async fn register(app: &AppHandle, api: &MyFiApi, session: &str) -> Result<String, String> {
    let keys = lock(&app.state::<Remote>().devices)?.desktop_keys()?;
    let desktop_id = api
        .register_desktop(session, &desktop_name(), &keys.public)
        .await
        .map_err(|err| err.to_string())?;
    lock(&app.state::<Remote>().devices)?.desktop_id = Some(desktop_id.clone());
    Ok(desktop_id)
}

/// Turns Remote Access on: registers the desktop and starts reading its mailbox. Devices paired before keep working.
pub(crate) async fn turn_on(app: &AppHandle) -> Result<(), String> {
    let (session, account) = sign_in_details(app).await?;
    {
        let remote = app.state::<Remote>();
        let mut store = lock(&remote.devices)?;
        if store
            .account_id
            .as_deref()
            .is_some_and(|before| before != account)
        {
            // Devices paired under another account never reach this one.
            store.devices.clear();
        }
        store.account_id = Some(account);
    }
    let api = myfi::api()?;
    let desktop_id = register(app, &api, &session).await?;
    lock(&app.state::<Remote>().devices)?.enabled = true;
    save(app).await?;
    start_polling(app, api, session, desktop_id);
    changed(app, None);
    Ok(())
}

/// Turns Remote Access off: stops reading the mailbox, ends every connection and any open QR code, and removes the
/// desktop from api.myfi.ws so devices can't reach it. Paired devices are kept for when it's turned on again.
pub(crate) async fn turn_off(app: &AppHandle) -> Result<(), String> {
    unregister(app).await;
    {
        let remote = app.state::<Remote>();
        let mut store = lock(&remote.devices)?;
        store.enabled = false;
        store.desktop_id = None;
    }
    save(app).await?;
    changed(app, None);
    Ok(())
}

/// Ends connections and pairing, as turning off and signing out do.
fn end_sessions(remote: &Remote) -> Result<(), String> {
    lock(&remote.pairing)?.close();
    *lock(&remote.invite_status)? = None;
    remote.disconnect_all();
    Ok(())
}

/// Called when the app signs in. Signing in as someone else forgets the devices paired under the last account.
pub(crate) async fn signed_in_as(app: &AppHandle, account: &str) -> Result<(), String> {
    let before = app
        .try_state::<Remote>()
        .and_then(|remote| remote.devices.lock().ok()?.account_id.clone());
    if before.is_some_and(|before| before != account) {
        super::forget_all(app).await?;
    }
    Ok(())
}

/// Starts reading the mailbox again at startup, if Remote Access was on. Without a network it keeps trying, and it
/// registers again if api.myfi.ws no longer has this desktop. Signed out, it turns off.
pub(crate) async fn resume(app: AppHandle) {
    let (enabled, desktop_id) = match app.state::<Remote>().devices.lock() {
        Ok(store) => (store.enabled, store.desktop_id.clone().unwrap_or_default()),
        Err(_) => return,
    };
    if !enabled {
        return;
    }
    let Some((session, _)) = myfi::session().await else {
        signed_out(&app).await;
        return;
    };
    let Ok(api) = myfi::api() else {
        return;
    };
    if let Ok(mut current) = app.state::<Remote>().session.lock() {
        *current = Some(session.clone());
    }
    start_polling(&app, api, session, desktop_id);
    changed(&app, None);
}

fn start_polling(app: &AppHandle, api: MyFiApi, session: String, desktop_id: String) {
    let remote = app.state::<Remote>();
    let Ok(mut poller) = remote.poller.lock() else {
        return;
    };
    if let Some(old) = poller.take() {
        old.abort();
    }
    let app = app.clone();
    *poller = Some(tauri::async_runtime::spawn(async move {
        poll(app, api, session, desktop_id).await;
    }));
}

/// Reads the mailbox until Remote Access is turned off.
async fn poll(app: AppHandle, api: MyFiApi, session: String, mut desktop_id: String) {
    loop {
        let result = if desktop_id.is_empty() {
            Err(MailboxError::NotRegistered)
        } else {
            api.take_messages(&session, &desktop_id).await
        };
        let reachability = match result {
            Ok(messages) => {
                for inbound in messages {
                    answer(&app, &api, &session, &desktop_id, inbound).await;
                }
                Reachability {
                    reachable: true,
                    error: None,
                }
            }
            Err(MailboxError::SignedOut) => {
                signed_out(&app).await;
                return;
            }
            Err(MailboxError::NotRegistered) => match register(&app, &api, &session).await {
                Ok(id) => {
                    desktop_id = id;
                    let _ = save(&app).await;
                    Reachability {
                        reachable: true,
                        error: None,
                    }
                }
                Err(err) => Reachability {
                    reachable: false,
                    error: Some(err),
                },
            },
            Err(err) => Reachability {
                reachable: false,
                error: Some(err.to_string()),
            },
        };
        let changed_now = app
            .state::<Remote>()
            .reachability
            .lock()
            .is_ok_and(|mut current| {
                let differs = current.reachable != reachability.reachable
                    || current.error != reachability.error;
                *current = reachability;
                differs
            });
        if changed_now {
            changed(&app, None);
        }
        let fast = app
            .state::<Remote>()
            .pairing
            .lock()
            .is_ok_and(|mut pairing| pairing.is_active(now_ms()));
        sleep(if fast { FAST_POLL } else { SLOW_POLL }).await;
    }
}

/// The session ended while reading the mailbox: Remote Access turns off, as signing out turns it off.
async fn signed_out(app: &AppHandle) {
    let remote = app.state::<Remote>();
    if let Ok(mut poller) = remote.poller.lock() {
        // This runs inside the loop, so it lets the loop end instead of stopping it part way.
        poller.take();
    }
    if let Ok(mut store) = remote.devices.lock() {
        store.enabled = false;
        store.desktop_id = None;
    }
    let _ = end_sessions(&remote);
    if let Ok(mut session) = remote.session.lock() {
        *session = None;
    }
    let _ = save(app).await;
    changed(
        app,
        Some(Notice {
            text: String::from(
                "Remote Access turned off: Task Proxy is no longer signed in to your Stoic Dreams account.",
            ),
            severity: "warning",
        }),
    );
}

/// Answers one message from the mailbox.
async fn answer(app: &AppHandle, api: &MyFiApi, session: &str, desktop_id: &str, inbound: Inbound) {
    let remote = app.state::<Remote>();
    let outcome = (|| {
        let mut store = lock(&remote.devices)?;
        let account = store.account_id.clone().unwrap_or_default();
        let keys = store.desktop_keys()?;
        let name = desktop_name();
        let desktop = Desktop {
            keys: &keys,
            id: desktop_id,
            name: &name,
            account: &account,
        };
        Ok::<_, String>(lock(&remote.pairing)?.receive(&desktop, &inbound, &mut store, now_ms()))
    })();
    let Ok(outcome) = outcome else {
        return;
    };
    let (answer, notice) = match outcome {
        Outcome::Nothing => return,
        Outcome::Answer(answer) => (answer, None),
        Outcome::Paired { device, answer } => {
            if let Ok(mut invite) = remote.invite_status.lock() {
                *invite = None;
            }
            record(app, &device.id, &device.name, "pair", Ok(()));
            let _ = save(app).await;
            let text = format!(
                "{} is paired, at the {} level.",
                device.name,
                level_name(device.level)
            );
            (
                answer,
                Some(Notice {
                    text,
                    severity: "success",
                }),
            )
        }
        Outcome::Refused { reason, answer } => {
            record(app, "", "Unknown device", "pair", Err(reason.clone()));
            (
                answer,
                Some(Notice {
                    text: format!("A device was refused: {}", reason),
                    severity: "warning",
                }),
            )
        }
    };
    let _ = api
        .send_reply(session, desktop_id, &inbound.reply, &answer)
        .await;
    if notice.is_some() {
        changed(app, notice);
    }
}

fn record(
    app: &AppHandle,
    device_id: &str,
    device_name: &str,
    cmd: &str,
    result: Result<(), String>,
) {
    if let Ok(mut log) = app.state::<Remote>().log.lock() {
        log.record(audit::Entry {
            at: now_ms(),
            device_id: device_id.into(),
            device_name: device_name.into(),
            cmd: cmd.into(),
            ok: result.is_ok(),
            error: result.err(),
        });
    }
}

fn level_name(level: Level) -> &'static str {
    match level {
        Level::View => "View",
        Level::Work => "Work",
        Level::Commit => "Commit",
    }
}

/// Removes this desktop from api.myfi.ws and stops reading its mailbox, as signing out does.
pub(crate) async fn unregister(app: &AppHandle) {
    let Some(remote) = app.try_state::<Remote>() else {
        return;
    };
    if let Ok(mut poller) = remote.poller.lock()
        && let Some(poller) = poller.take()
    {
        poller.abort();
    }
    let desktop_id = remote
        .devices
        .lock()
        .ok()
        .and_then(|store| store.desktop_id.clone());
    let session = remote
        .session
        .lock()
        .ok()
        .and_then(|mut session| session.take());
    let session = match session {
        Some(session) => Some(session),
        None => myfi::session().await.map(|(session, _)| session),
    };
    if let (Some(desktop_id), Some(session), Ok(api)) = (desktop_id, session, myfi::api()) {
        let _ = api.remove_desktop(&session, &desktop_id).await;
    }
    let _ = end_sessions(&remote);
    if let Ok(mut reachability) = remote.reachability.lock() {
        *reachability = Reachability::default();
    }
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InviteRequest {
    pub name: String,
    pub level: Level,
    pub days: u32,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeviceChange {
    pub name: Option<String>,
    pub level: Option<Level>,
}

/// What the Remote Access panel shows.
#[tauri::command]
pub(crate) async fn remote_status(app: AppHandle) -> Result<RemoteStatus, String> {
    status(&app)
}

/// Turns Remote Access on or off.
#[tauri::command]
pub(crate) async fn remote_set_enabled(
    app: AppHandle,
    enabled: bool,
) -> Result<RemoteStatus, String> {
    if enabled {
        turn_on(&app).await?;
    } else {
        turn_off(&app).await?;
    }
    status(&app)
}

/// Opens a QR code that pairs one device, at the level and for the time chosen, within 10 minutes.
#[tauri::command]
pub(crate) async fn remote_invite(
    app: AppHandle,
    invite: InviteRequest,
) -> Result<RemoteStatus, String> {
    if !PAIRING_CHOICES.contains(&invite.days) {
        return Err(String::from("Choose 7, 30 or 90 days, or for good."));
    }
    let remote = app.state::<Remote>();
    let (desktop_id, keys) = {
        let mut store = lock(&remote.devices)?;
        if !store.enabled {
            return Err(String::from("Turn Remote Access on first."));
        }
        let desktop_id = store.desktop_id.clone().ok_or_else(|| {
            String::from("This desktop isn't registered yet. Check your connection and try again.")
        })?;
        (desktop_id, store.desktop_keys()?)
    };
    let invite = Invite::new(&invite.name, invite.level, invite.days, now_ms());
    let link = pairing::link(&desktop_id, &keys.public, &desktop_name(), &invite);
    let shown = InviteStatus {
        svg: pairing::qr_svg(&link)?,
        link,
        name: invite.name.clone(),
        level: invite.level,
        days: invite.days,
        expires_at: invite.expires_at,
    };
    lock(&remote.pairing)?.open(invite);
    *lock(&remote.invite_status)? = Some(shown);
    changed(&app, None);
    status(&app)
}

/// Closes the open QR code, so it pairs nothing.
#[tauri::command]
pub(crate) async fn remote_invite_cancel(app: AppHandle) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    lock(&remote.pairing)?.close();
    *lock(&remote.invite_status)? = None;
    changed(&app, None);
    status(&app)
}

/// Renames a paired device or changes its level. A lowered level applies to its next command.
#[tauri::command]
pub(crate) async fn remote_device_update(
    app: AppHandle,
    id: String,
    change: DeviceChange,
) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    {
        let mut store = lock(&remote.devices)?;
        if let Some(name) = &change.name {
            store.rename(&id, name)?;
        }
        if let Some(level) = change.level {
            store.set_level(&id, level)?;
        }
    }
    if let Some(level) = change.level {
        remote.set_level(&id, level);
    }
    save(&app).await?;
    changed(&app, None);
    status(&app)
}

/// Unpairs a device and ends its connections. It must pair again to reach this desktop.
#[tauri::command]
pub(crate) async fn remote_device_remove(
    app: AppHandle,
    id: String,
) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    if !lock(&remote.devices)?.remove(&id) {
        return Err(String::from("No such device."));
    }
    remote.disconnect_device(&id);
    save(&app).await?;
    changed(&app, None);
    status(&app)
}

/// Ends a device's connections now. It stays paired, so it can connect again.
#[tauri::command]
pub(crate) async fn remote_device_disconnect(
    app: AppHandle,
    id: String,
) -> Result<RemoteStatus, String> {
    app.state::<Remote>().disconnect_device(&id);
    changed(&app, None);
    status(&app)
}

/// The latest commands devices sent, newest first, for the panel's Activity.
#[tauri::command]
pub(crate) async fn remote_log(app: AppHandle) -> Result<Vec<audit::Entry>, String> {
    let mut entries = lock(&app.state::<Remote>().log)?.latest();
    entries.truncate(200);
    Ok(entries)
}
