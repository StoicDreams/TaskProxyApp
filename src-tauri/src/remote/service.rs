//! Turning Remote Access on and off, reading this desktop's mailbox, and the Remote Access panel's commands
//! (Docs/RemoteAccess.md, 2.2).
//!
//! While Remote Access is on, the desktop is registered with api.myfi.ws and reads its mailbox every 10 seconds, or
//! every second while a QR code is open or a device is pairing. Every command here is desktop-only.

use super::devices::{self, Device, Level, PAIRING_CHOICES};
use super::dispatch::Caller;
use super::mailbox::{Inbound, MailboxError};
use super::mailbox::{Kind, decode};
use super::pairing::{self, Desktop, Invite, Outcome};
use super::protocol::{DesktopMessage, DeviceMessage};
use super::{Remote, audit, awake, connect, now_ms, webrtc};
use crate::prelude::*;
use crate::services::myfi::{self, MyFiApi};
use tauri::Emitter;
use tokio::sync::mpsc::UnboundedReceiver;

const SLOW_POLL: Duration = Duration::from_secs(10);
const FAST_POLL: Duration = Duration::from_secs(1);
/// The event the Remote Access panel and the header's indicator follow.
pub(crate) const CHANGED: &str = "remote-changed";
/// The hours without a connection after which Remote Access can turn itself off. 0 never does.
pub(crate) const OFF_AFTER_CHOICES: &[u32] = &[0, 1, 4, 8, 12, 24, 48];
const HOUR_MS: u64 = 60 * 60 * 1000;

/// Whether Remote Access has gone unused for `hours` and should turn off. Never while a device is connected.
pub(crate) fn idle_off_due(hours: u32, last_activity: u64, now: u64, connected: bool) -> bool {
    hours > 0 && !connected && now.saturating_sub(last_activity) >= hours as u64 * HOUR_MS
}

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
    /// How it reached the desktop while connected, such as Direct (same network).
    pub route: Option<String>,
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
    /// Whether the computer is kept from sleeping while Remote Access is on.
    pub keep_awake: bool,
    /// Whether it is kept awake right now, and why not when that failed.
    pub awake: bool,
    pub awake_error: Option<String>,
    pub off_after_hours: u32,
    pub off_after_choices: Vec<u32>,
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
    let routes = remote.routes();
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
                route: routes
                    .get(&device.id)
                    .filter(|route| !route.is_empty())
                    .cloned(),
                device,
            })
            .collect(),
        pairing_days: PAIRING_CHOICES.to_vec(),
        keep_awake: !store.allow_sleep,
        awake: lock(&remote.awake)?.is_some(),
        awake_error: lock(&remote.awake_error)?.clone(),
        off_after_hours: store.off_after_hours,
        off_after_choices: OFF_AFTER_CHOICES.to_vec(),
    })
}

/// Keeps the computer awake while Remote Access is on and that is wanted, and lets it sleep otherwise.
fn apply_awake(remote: &Remote) {
    let wanted = remote
        .devices
        .lock()
        .is_ok_and(|store| store.enabled && !store.allow_sleep);
    let Ok(mut awake) = remote.awake.lock() else {
        return;
    };
    if !wanted {
        awake.take();
        if let Ok(mut error) = remote.awake_error.lock() {
            *error = None;
        }
        return;
    }
    if awake.is_some() {
        return;
    }
    let held = awake::hold();
    if let Ok(mut error) = remote.awake_error.lock() {
        *error = held.as_ref().err().cloned();
    }
    *awake = held.ok();
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
    let remote = app.state::<Remote>();
    remote.touch();
    apply_awake(&remote);
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
    apply_awake(&app.state::<Remote>());
    save(app).await?;
    changed(app, None);
    Ok(())
}

/// Ends connections and pairing, as turning off and signing out do.
fn end_sessions(remote: &Remote) -> Result<(), String> {
    lock(&remote.pairing)?.close();
    *lock(&remote.invite_status)? = None;
    remote.disconnect_all();
    lock(&remote.awake)?.take();
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
    let remote = app.state::<Remote>();
    remote.touch();
    apply_awake(&remote);
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
        if went_idle(&app).await {
            return;
        }
        let fast = app
            .state::<Remote>()
            .pairing
            .lock()
            .is_ok_and(|mut pairing| pairing.is_active(now_ms()));
        sleep(if fast { FAST_POLL } else { SLOW_POLL }).await;
    }
}

/// Turns Remote Access off when it went unused for longer than its setting. Returns whether it did, which ends the
/// mailbox loop this runs in.
async fn went_idle(app: &AppHandle) -> bool {
    let remote = app.state::<Remote>();
    let hours = remote
        .devices
        .lock()
        .map(|store| store.off_after_hours)
        .unwrap_or(0);
    let connected = remote.has_connections()
        || remote
            .pairing
            .lock()
            .is_ok_and(|mut pairing| pairing.is_active(now_ms()));
    if !idle_off_due(hours, remote.last_activity(), now_ms(), connected) {
        return false;
    }
    if let Ok(mut poller) = remote.poller.lock() {
        // This runs inside the loop, so it lets the loop end instead of stopping it part way.
        poller.take();
    }
    let _ = turn_off(app).await;
    changed(
        app,
        Some(Notice {
            text: format!(
                "Remote Access turned off after {} without a device connecting. Turn it on again in Settings.",
                if hours == 1 {
                    String::from("an hour")
                } else {
                    format!("{} hours", hours)
                }
            ),
            severity: "info",
        }),
    );
    true
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
    if matches!(decode(&inbound.message), Some((Kind::Connect1, _))) {
        connect_device(app, api, session, desktop_id, inbound).await;
        return;
    }
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
    if outcome != Outcome::Nothing {
        remote.touch();
    }
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

/// A paired device asking to connect: checks it, answers its offer, and serves the connection in the background.
async fn connect_device(
    app: &AppHandle,
    api: &MyFiApi,
    session: &str,
    desktop_id: &str,
    inbound: Inbound,
) {
    let remote = app.state::<Remote>();
    let accepted = (|| {
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
        Ok::<_, String>(connect::accept(&desktop, &inbound, &store, now_ms()))
    })();
    let reply = inbound.reply.as_str();
    let refused = |reason: String| async move {
        record(app, "", "Unknown device", "connect", Err(reason.clone()));
        let _ = api
            .send_reply(
                session,
                desktop_id,
                reply,
                &super::mailbox::encode(Kind::Refused, reason.as_bytes()),
            )
            .await;
        changed(
            app,
            Some(Notice {
                text: format!("A device was refused: {}", reason),
                severity: "warning",
            }),
        );
    };
    let accepted = match accepted {
        Ok(Ok(accepted)) => accepted,
        Ok(Err(Outcome::Refused { reason, .. })) => return refused(reason).await,
        _ => return,
    };
    remote.touch();
    let answered = match webrtc::answer_offer(&accepted.offer, &webrtc::local_addresses()).await {
        Ok(answered) => answered,
        Err(reason) => return refused(reason).await,
    };
    let device = accepted.device.clone();
    let (body, channel) = match accepted.answer(&answered.answer) {
        Ok(answer) => answer,
        Err(reason) => return refused(reason).await,
    };
    if api
        .send_reply(session, desktop_id, reply, &body)
        .await
        .is_err()
    {
        return;
    }
    let hooks = AppHooks {
        app: app.clone(),
        device,
    };
    tauri::async_runtime::spawn(webrtc::serve(answered, channel, hooks));
}

/// A connection's place in the app: the gateway, the paired device's record, the log, and the panel.
struct AppHooks {
    app: AppHandle,
    device: Device,
}

impl webrtc::Hooks for AppHooks {
    fn open(&mut self, route: &str) -> (u64, UnboundedReceiver<DesktopMessage>) {
        let remote = self.app.state::<Remote>();
        // The device as it is now, since its name or level may have changed since it paired.
        if let Ok(mut store) = remote.devices.lock() {
            store.connected(&self.device.id, now_ms());
            if let Some(device) = store
                .devices
                .iter()
                .find(|device| device.id == self.device.id)
            {
                self.device = device.clone();
            }
        }
        let (id, outgoing) = remote.open(Caller {
            device_id: self.device.id.clone(),
            name: self.device.name.clone(),
            level: self.device.level,
        });
        remote.set_route(id, route);
        record(
            &self.app,
            &self.device.id,
            &self.device.name,
            "connect",
            Ok(()),
        );
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = save(&app).await;
        });
        changed(
            &self.app,
            Some(Notice {
                text: format!("{} connected: {}.", self.device.name, route),
                severity: "info",
            }),
        );
        (id, outgoing)
    }

    fn message(&mut self, id: u64, message: DeviceMessage) {
        super::receive(&self.app, id, message);
    }

    fn closed(&mut self, id: Option<u64>, reason: &str) {
        if let Some(id) = id {
            self.app.state::<Remote>().close(id);
            record(
                &self.app,
                &self.device.id,
                &self.device.name,
                "disconnect",
                Ok(()),
            );
        } else {
            record(
                &self.app,
                &self.device.id,
                &self.device.name,
                "connect",
                Err(reason.into()),
            );
        }
        changed(&self.app, None);
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

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSettings {
    pub keep_awake: bool,
    pub off_after_hours: u32,
}

/// Whether the computer is kept awake while Remote Access is on, and after how many hours without a connection it
/// turns off.
#[tauri::command]
pub(crate) async fn remote_settings(
    app: AppHandle,
    settings: RemoteSettings,
) -> Result<RemoteStatus, String> {
    if !OFF_AFTER_CHOICES.contains(&settings.off_after_hours) {
        return Err(String::from(
            "Choose never, or 1, 4, 8, 12, 24 or 48 hours.",
        ));
    }
    let remote = app.state::<Remote>();
    {
        let mut store = lock(&remote.devices)?;
        store.allow_sleep = !settings.keep_awake;
        store.off_after_hours = settings.off_after_hours;
    }
    // A new limit counts from now, so turning it on doesn't turn Remote Access off at once.
    remote.touch();
    apply_awake(&remote);
    save(&app).await?;
    changed(&app, None);
    status(&app)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn it_turns_off_only_after_the_chosen_hours_unused() {
        assert!(
            !idle_off_due(0, 0, u64::MAX, false),
            "never, when no limit is set"
        );
        assert!(!idle_off_due(4, 0, 4 * HOUR_MS - 1, false));
        assert!(idle_off_due(4, 0, 4 * HOUR_MS, false));
        assert!(
            !idle_off_due(4, 0, 100 * HOUR_MS, true),
            "never while a device is connected"
        );
        assert!(
            !idle_off_due(1, 10 * HOUR_MS, 10 * HOUR_MS + 5, false),
            "counted from the last activity"
        );
        assert!(
            !idle_off_due(1, 10, 0, false),
            "a clock that went back doesn't count as idle"
        );
    }

    #[test]
    fn the_choices_offered_include_never() {
        assert_eq!(OFF_AFTER_CHOICES[0], 0);
        assert!(OFF_AFTER_CHOICES.windows(2).all(|pair| pair[0] < pair[1]));
    }
}
