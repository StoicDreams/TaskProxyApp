//! Turning Remote Connections on and off, asking api.myfi.ws for connection requests, answering them, and the
//! Settings panel's commands.
//!
//! While Remote Connections is on, this computer asks `POST remote/desktop/connections` every 5 seconds, which also
//! shows it as active on www.taskproxy.com. Each request is a browser's signed offer. It is checked (`signal.rs`),
//! its browser looked up (`browsers.rs`), and answered with a signed `ok`, `approval` or `refused`. An `ok` answer
//! carries this computer's WebRTC answer, and the connection is then served directly (`webrtc.rs`).

use super::browsers::{self, Decision, Level, no_such_browser};
use super::dispatch::Caller;
use super::protocol::{BrowserMessage, DesktopMessage};
use super::signal::{self, Offer, Status};
use super::{Remote, audit, awake, keys, now_ms, stun, webrtc};
use crate::prelude::*;
use crate::services::myfi::{self, MyFiApi};
use reqwest::Method;
use tokio::sync::mpsc::UnboundedReceiver;

/// How often to ask for connection requests. The API shows a computer as active for 30 seconds after each.
const POLL: Duration = Duration::from_secs(5);
/// The event the Remote Connections panel and the header's indicator follow.
pub(crate) const CHANGED: &str = "remote-changed";
const SIGN_IN_FIRST: &str =
    "Sign in to your Stoic Dreams account first, from the account button at the top.";

/// Whether api.myfi.ws can be reached, as the panel shows it.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Reachability {
    pub reachable: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovedStatus {
    pub key: String,
    pub name: String,
    pub code: String,
    pub added: u64,
    pub level: Level,
    pub connected: bool,
    /// How it reached this computer while connected, such as Direct (same network).
    pub route: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WaitingStatus {
    pub key: String,
    pub name: String,
    pub code: String,
    pub asked: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RefusedStatus {
    pub key: String,
    pub name: String,
    pub code: String,
    pub refused: u64,
}

/// Everything the Remote Connections panel shows.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteStatus {
    pub enabled: bool,
    /// What this computer is called on www.taskproxy.com, or its host name before one is chosen.
    pub name: String,
    pub desktop_id: Option<String>,
    pub reachability: Reachability,
    pub approved: Vec<ApprovedStatus>,
    pub waiting: Vec<WaitingStatus>,
    /// Browsers refused in the last 10 minutes, which can be allowed to ask again.
    pub refused: Vec<RefusedStatus>,
    /// Whether the computer is kept from sleeping while Remote Connections is on.
    pub keep_awake: bool,
    /// Whether it is kept awake right now, and why not when that failed.
    pub awake: bool,
    pub awake_error: Option<String>,
}

/// Something the window shows in the Alerts panel, as well as a desktop notification.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Notice {
    pub text: String,
    pub severity: &'static str,
}

fn lock<T>(mutex: &Mutex<T>) -> Result<std::sync::MutexGuard<'_, T>, String> {
    mutex.lock().map_err(|err| err.to_string())
}

/// A connection request from api.myfi.ws: a browser's offer, given once.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionRequest {
    pub connection_id: String,
    pub offer: String,
}

#[derive(Debug, PartialEq)]
pub(crate) enum ApiError {
    /// Remote Connections is off for this computer on api.myfi.ws, for example because its sign-in ended.
    Off,
    /// api.myfi.ws couldn't be reached, or answered with something else.
    Failed(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Off => f.write_str("Remote Connections is off for this computer."),
            ApiError::Failed(reason) => f.write_str(reason),
        }
    }
}

fn failed(status: u16, text: &str, general: &str) -> ApiError {
    let text = text.trim();
    ApiError::Failed(if text.is_empty() {
        format!("{} (api.myfi.ws answered {}.)", general, status)
    } else {
        text.to_string()
    })
}

fn unexpected() -> ApiError {
    ApiError::Failed(String::from(
        "api.myfi.ws answered with something unexpected.",
    ))
}

/// `POST remote/desktop`: turns Remote Connections on for this computer, or renames it. Returns its id.
pub(crate) async fn register(
    api: &MyFiApi,
    name: &str,
    public_key: &str,
) -> Result<String, ApiError> {
    let body = serde_json::json!({ "name": name, "publicKey": public_key });
    let (status, text) = api
        .send(Method::POST, "remote/desktop", Some(body))
        .await
        .map_err(ApiError::Failed)?;
    match status {
        200 => serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| json.get("desktopId")?.as_str().map(String::from))
            .filter(|id| !id.is_empty())
            .ok_or_else(unexpected),
        401 => Err(ApiError::Failed(String::from(SIGN_IN_FIRST))),
        _ => Err(failed(
            status,
            &text,
            "Remote Connections could not be turned on.",
        )),
    }
}

/// `POST remote/desktop/connections`: the browsers waiting to connect, each given once.
pub(crate) async fn connections(api: &MyFiApi) -> Result<Vec<ConnectionRequest>, ApiError> {
    let (status, text) = api
        .send(
            Method::POST,
            "remote/desktop/connections",
            Some(serde_json::json!({})),
        )
        .await
        .map_err(ApiError::Failed)?;
    match status {
        200 => serde_json::from_str::<Value>(&text)
            .ok()
            .and_then(|json| serde_json::from_value(json.get("connections")?.clone()).ok())
            .ok_or_else(unexpected),
        // The sign-in ended, or Remote Connections was turned off for this computer from www.taskproxy.com.
        401 | 404 => Err(ApiError::Off),
        _ => Err(failed(
            status,
            &text,
            "Connection requests could not be read.",
        )),
    }
}

/// `POST remote/desktop/answer`: this computer's answer to a connection request.
pub(crate) async fn send_answer(
    api: &MyFiApi,
    connection_id: &str,
    answer: &str,
) -> Result<(), ApiError> {
    let body = serde_json::json!({ "connectionId": connection_id, "answer": answer });
    let (status, text) = api
        .send(Method::POST, "remote/desktop/answer", Some(body))
        .await
        .map_err(ApiError::Failed)?;
    match status {
        200 => Ok(()),
        _ => Err(failed(status, &text, "The answer could not be sent.")),
    }
}

/// `DELETE remote/desktop`: turns Remote Connections off for this computer. The API finds the computer by the
/// app's sign-in, and needs the field all the same.
pub(crate) async fn unregister(api: &MyFiApi, desktop_id: &str) -> Result<(), ApiError> {
    let body = serde_json::json!({ "desktopId": desktop_id });
    let (status, text) = api
        .send(Method::DELETE, "remote/desktop", Some(body))
        .await
        .map_err(ApiError::Failed)?;
    match status {
        200 => Ok(()),
        _ => Err(failed(
            status,
            &text,
            "Remote Connections could not be turned off.",
        )),
    }
}

/// `GET remote/servers`: the STUN servers, each as `host:port`. Read before each connection, since the list can
/// change.
pub(crate) async fn stun_servers(api: &MyFiApi) -> Result<Vec<String>, ApiError> {
    let (status, text) = api
        .send(Method::GET, "remote/servers", None)
        .await
        .map_err(ApiError::Failed)?;
    match status {
        200 => serde_json::from_str::<Value>(&text)
            .map(|json| stun::servers(&json))
            .map_err(|_| unexpected()),
        _ => Err(failed(status, &text, "The server list could not be read.")),
    }
}

/// A computer's name as www.taskproxy.com lists it: one line of 1 to 100 characters, without the characters MyFi
/// refuses in names.
pub(crate) fn computer_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(String::from("Name this computer in 1 to 100 characters."));
    }
    if name
        .chars()
        .any(|c| c.is_control() || "<>\"&`{}".contains(c))
    {
        return Err(String::from(
            "A computer's name can't have < > \" & ` { } in it.",
        ));
    }
    Ok(name.to_string())
}

fn host_name() -> String {
    myfi::computer_name(sysinfo::System::host_name().ok())
}

/// What the panel shows now.
pub(crate) fn status(app: &AppHandle) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    let store = lock(&remote.store)?.clone();
    let (waiting, refused) = {
        let mut waiting = lock(&remote.waiting)?;
        (waiting.list(now_ms()), waiting.refused(now_ms()))
    };
    let routes = remote.routes();
    let code = |key: &str| keys::browser_code(key).unwrap_or_default();
    Ok(RemoteStatus {
        enabled: store.enabled,
        name: if store.name.is_empty() {
            host_name()
        } else {
            store.name.clone()
        },
        desktop_id: store.desktop_id.clone(),
        reachability: lock(&remote.reachability)?.clone(),
        approved: store
            .approved
            .iter()
            .map(|browser| ApprovedStatus {
                key: browser.key.clone(),
                name: browser.name.clone(),
                code: code(&browser.key),
                added: browser.added,
                level: browser.level,
                connected: routes.contains_key(&browser.key),
                route: routes
                    .get(&browser.key)
                    .filter(|route| !route.is_empty())
                    .cloned(),
            })
            .collect(),
        waiting: waiting
            .iter()
            .map(|request| WaitingStatus {
                key: request.key.clone(),
                name: request.name.clone(),
                code: code(&request.key),
                asked: request.asked,
            })
            .collect(),
        refused: refused
            .iter()
            .map(|browser| RefusedStatus {
                key: browser.key.clone(),
                name: browser.name.clone(),
                code: code(&browser.key),
                refused: browser.refused,
            })
            .collect(),
        keep_awake: !store.allow_sleep,
        awake: lock(&remote.awake)?.is_some(),
        awake_error: lock(&remote.awake_error)?.clone(),
    })
}

/// Keeps the computer awake while Remote Connections is on and that is wanted, and lets it sleep otherwise.
fn apply_awake(remote: &Remote) {
    let wanted = remote
        .store
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
            .title("Task Proxy Remote Connections")
            .body(&notice.text)
            .show();
    }
    let _ = app.emit(CHANGED, serde_json::json!({ "notice": notice }));
    // Connected browsers redraw their lists too. A notice is for the computer's own screen.
    if let Some(remote) = app.try_state::<Remote>() {
        remote.send_event(CHANGED, &serde_json::json!({ "notice": null }));
    }
}

async fn save(app: &AppHandle) -> Result<(), String> {
    let store = lock(&app.state::<Remote>().store)?.clone();
    browsers::save(app, &store).await
}

/// Turns Remote Connections on under `name`, or renames this computer when it is already on. The signing key is
/// made the first time. Browsers approved before keep working.
pub(crate) async fn turn_on(app: &AppHandle, name: &str) -> Result<(), String> {
    let name = computer_name(name)?;
    let api = myfi::signed_in_api()
        .await
        .ok_or_else(|| String::from(SIGN_IN_FIRST))?;
    let key = lock(&app.state::<Remote>().store)?.signing_key()?;
    // The key is saved before it is sent, so the one browsers remember is never lost to a failed save.
    save(app).await?;
    let desktop_id = register(&api, &name, &key.public_key())
        .await
        .map_err(|err| err.to_string())?;
    myfi::keep_cookies(&api).await;
    {
        let remote = app.state::<Remote>();
        let mut store = lock(&remote.store)?;
        store.enabled = true;
        store.name = name;
        store.desktop_id = Some(desktop_id.clone());
    }
    save(app).await?;
    let remote = app.state::<Remote>();
    apply_awake(&remote);
    start_polling(app, api, desktop_id);
    changed(app, None);
    Ok(())
}

/// Stops asking for requests and ends every connection, as turning off and signing out do.
fn stop(remote: &Remote, abort_poller: bool) {
    if let Ok(mut poller) = remote.poller.lock()
        && let Some(poller) = poller.take()
        && abort_poller
    {
        poller.abort();
    }
    if let Ok(mut store) = remote.store.lock() {
        store.enabled = false;
        store.desktop_id = None;
    }
    if let Ok(mut waiting) = remote.waiting.lock() {
        waiting.clear();
    }
    remote.disconnect_all();
    if let Ok(mut reachability) = remote.reachability.lock() {
        *reachability = Reachability::default();
    }
    apply_awake(remote);
}

/// Turns Remote Connections off: stops asking for requests, ends every connection, and removes this computer from
/// api.myfi.ws so browsers no longer list it. Approved browsers and this computer's key are kept for next time.
pub(crate) async fn turn_off(app: &AppHandle) -> Result<(), String> {
    let remote = app.state::<Remote>();
    let desktop_id = lock(&remote.store)?.desktop_id.clone();
    stop(&remote, true);
    if let Some(desktop_id) = desktop_id
        && let Some(api) = myfi::signed_in_api().await
    {
        // Off here either way. If the API can't be reached, the computer stops showing as active within 30 seconds.
        let _ = unregister(&api, &desktop_id).await;
        myfi::keep_cookies(&api).await;
    }
    save(app).await?;
    changed(app, None);
    Ok(())
}

/// The app signed out of MyFi, which removes this computer from api.myfi.ws: Remote Connections turns off here too.
pub(crate) async fn signed_out(app: &AppHandle) {
    let Some(remote) = app.try_state::<Remote>() else {
        return;
    };
    if !remote.store.lock().is_ok_and(|store| store.enabled) {
        return;
    }
    stop(&remote, true);
    let _ = save(app).await;
    changed(app, None);
}

/// Starts asking for requests again at startup, if Remote Connections was on. Signed out, it turns off.
pub(crate) async fn resume(app: AppHandle) {
    let (enabled, desktop_id) = match app.state::<Remote>().store.lock() {
        Ok(store) => (store.enabled, store.desktop_id.clone()),
        Err(_) => return,
    };
    if !enabled {
        return;
    }
    let (Some(api), Some(desktop_id)) = (myfi::signed_in_api().await, desktop_id) else {
        went_off(&app, false).await;
        return;
    };
    apply_awake(&app.state::<Remote>());
    start_polling(&app, api, desktop_id);
    changed(&app, None);
}

fn start_polling(app: &AppHandle, api: MyFiApi, desktop_id: String) {
    let remote = app.state::<Remote>();
    let Ok(mut poller) = remote.poller.lock() else {
        return;
    };
    if let Some(old) = poller.take() {
        old.abort();
    }
    let app = app.clone();
    *poller = Some(tauri::async_runtime::spawn(async move {
        poll(app, Arc::new(api), desktop_id).await;
    }));
}

/// Asks for connection requests until Remote Connections is turned off.
async fn poll(app: AppHandle, api: Arc<MyFiApi>, desktop_id: String) {
    loop {
        let reachability = match connections(&api).await {
            Ok(requests) => {
                for request in requests {
                    // Each is answered on its own, so one that waits for the STUN server doesn't hold up the rest.
                    let (app, api, desktop_id) = (app.clone(), api.clone(), desktop_id.clone());
                    tauri::async_runtime::spawn(async move {
                        answer_request(&app, &api, &desktop_id, request).await;
                    });
                }
                Reachability {
                    reachable: true,
                    error: None,
                }
            }
            Err(ApiError::Off) => {
                went_off(&app, true).await;
                return;
            }
            Err(ApiError::Failed(reason)) => Reachability {
                reachable: false,
                error: Some(reason),
            },
        };
        // The API renews its cookie as it is used, and what it set last is what the next start needs.
        myfi::keep_cookies(&api).await;
        let changed_now = app
            .state::<Remote>()
            .reachability
            .lock()
            .is_ok_and(|mut current| {
                let differs = *current != reachability;
                *current = reachability;
                differs
            });
        if changed_now {
            changed(&app, None);
        }
        sleep(POLL).await;
    }
}

/// api.myfi.ws no longer has this computer, for example because the app's sign-in ended: Remote Connections turns
/// off here too. `from_poller` when this runs inside the loop that asks for requests, which then ends by itself.
async fn went_off(app: &AppHandle, from_poller: bool) {
    stop(&app.state::<Remote>(), !from_poller);
    let _ = save(app).await;
    changed(
        app,
        Some(Notice {
            text: String::from(
                "Remote Connections turned off: this computer is no longer signed in for it. Sign in and turn it on again in Settings.",
            ),
            severity: "warning",
        }),
    );
}

/// What to answer a connection request, before any WebRTC: the status, the offer when it was read, and the hash of
/// its SDP for the answer's signature.
pub(crate) struct Checked {
    pub decision: Decision,
    pub offer: Option<Offer>,
    pub offer_sdp_hash: String,
    /// Why it was refused, for the log.
    pub refusal: Option<&'static str>,
}

/// Checks a request's offer and looks its browser up.
pub(crate) fn check_request(
    store: &browsers::Store,
    waiting: &mut browsers::Waiting,
    offer: &str,
    desktop_id: &str,
    now: u64,
) -> Checked {
    match signal::read_offer(offer, desktop_id, now) {
        Ok(offer) => {
            let decision = waiting.decide(store, &offer, now);
            Checked {
                decision,
                offer_sdp_hash: offer.sdp_hash(),
                refusal: (decision == Decision::Refused)
                    .then_some("This browser was refused, or too many are waiting."),
                offer: Some(offer),
            }
        }
        Err(refusal) => Checked {
            decision: Decision::Refused,
            offer: None,
            offer_sdp_hash: refusal.sdp_hash,
            refusal: Some(refusal.reason),
        },
    }
}

/// Answers one connection request, and serves the connection when its browser is approved.
async fn answer_request(
    app: &AppHandle,
    api: &MyFiApi,
    desktop_id: &str,
    request: ConnectionRequest,
) {
    let remote = app.state::<Remote>();
    let checked = {
        let (Ok(store), Ok(mut waiting)) = (remote.store.lock(), remote.waiting.lock()) else {
            return;
        };
        if !store.enabled {
            return;
        }
        check_request(&store, &mut waiting, &request.offer, desktop_id, now_ms())
    };
    let Ok(key) = lock(&remote.store).and_then(|mut store| store.signing_key()) else {
        return;
    };
    let (browser_key, browser_name) = checked
        .offer
        .as_ref()
        .map(|offer| (offer.key.clone(), offer.name.clone()))
        .unwrap_or_else(|| (String::new(), String::from("Unknown browser")));
    let reply = |status: Status, sdp: Option<String>| {
        let answer = signal::answer(
            &key,
            &request.connection_id,
            status,
            &checked.offer_sdp_hash,
            sdp.as_deref(),
        );
        async move {
            match answer {
                Ok(answer) => send_answer(api, &request.connection_id, &answer)
                    .await
                    .map_err(|err| err.to_string()),
                Err(err) => Err(err),
            }
        }
    };
    let (level, offer) = match (checked.decision, checked.offer) {
        (Decision::Connect(level), Some(offer)) => (level, offer),
        (Decision::Approval { new }, _) => {
            let _ = reply(Status::Approval, None).await;
            if new {
                changed(
                    app,
                    Some(Notice {
                        text: format!(
                            "{} is asking to connect to this computer. Check its code in Settings, under Remote Connections.",
                            browser_name
                        ),
                        severity: "info",
                    }),
                );
            }
            return;
        }
        _ => {
            remote.record(
                &browser_key,
                &browser_name,
                "connect",
                Err(checked.refusal.unwrap_or("Refused.").to_string()),
            );
            let _ = reply(Status::Refused, None).await;
            return;
        }
    };
    // The STUN server is read for each connection. Without it, the connection still works on the same network.
    let stun = match stun_servers(api).await {
        Ok(servers) => stun::resolve(&servers).await,
        Err(_) => None,
    };
    let answered = match webrtc::answer_offer(&offer.sdp, &webrtc::local_addresses(), stun).await {
        Ok(answered) => answered,
        Err(reason) => {
            remote.record(&browser_key, &browser_name, "connect", Err(reason));
            let _ = reply(Status::Refused, None).await;
            return;
        }
    };
    if let Err(reason) = reply(Status::Ok, Some(answered.answer.clone())).await {
        remote.record(&browser_key, &browser_name, "connect", Err(reason));
        return;
    }
    let hooks = AppHooks {
        app: app.clone(),
        caller: Caller {
            key: offer.key,
            name: offer.name,
            level,
        },
    };
    tauri::async_runtime::spawn(webrtc::serve(answered, hooks));
}

/// A connection's place in the app: the gateway, the approved browser's record, the log, and the panel.
struct AppHooks {
    app: AppHandle,
    caller: Caller,
}

impl webrtc::Hooks for AppHooks {
    fn open(&mut self, route: &str) -> (u64, UnboundedReceiver<DesktopMessage>) {
        let remote = self.app.state::<Remote>();
        // The browser as it is now, since it may have been removed or its level changed since its offer.
        let now = remote
            .store
            .lock()
            .ok()
            .and_then(|store| store.find(&self.caller.key).cloned());
        let Some(browser) = now else {
            // Removed while it was connecting: what it is sent ends at once, which ends the connection.
            let (_, ended) = tokio::sync::mpsc::unbounded_channel();
            return (0, ended);
        };
        self.caller.level = browser.level;
        let (id, outgoing) = remote.open(self.caller.clone());
        remote.set_route(id, route);
        remote.record(&self.caller.key, &self.caller.name, "connect", Ok(()));
        changed(
            &self.app,
            Some(Notice {
                text: format!("{} connected: {}.", self.caller.name, route),
                severity: "info",
            }),
        );
        (id, outgoing)
    }

    fn message(&mut self, id: u64, message: BrowserMessage) {
        super::receive(&self.app, id, message);
    }

    fn closed(&mut self, id: Option<u64>, reason: &str) {
        let remote = self.app.state::<Remote>();
        match id {
            Some(id) => {
                remote.close(id);
                remote.record(&self.caller.key, &self.caller.name, "disconnect", Ok(()));
            }
            None => remote.record(
                &self.caller.key,
                &self.caller.name,
                "connect",
                Err(reason.into()),
            ),
        }
        changed(&self.app, None);
    }
}

/// The approved and waiting browsers as `remote_browsers` gives them. `current` is the key of the browser asking.
pub(crate) fn browser_lists(app: &AppHandle, current: Option<&str>) -> Result<Value, String> {
    let remote = app.state::<Remote>();
    let store = lock(&remote.store)?;
    let waiting = lock(&remote.waiting)?.list(now_ms());
    Ok(browsers::lists(&store, &waiting, current))
}

/// Approves a waiting browser, and returns the lists after it. `by` is the connected browser that approved it, or
/// None for this computer's own window.
pub(crate) async fn approve_browser(
    app: &AppHandle,
    key: &str,
    by: Option<&Caller>,
) -> Result<Value, String> {
    let remote = app.state::<Remote>();
    let now = now_ms();
    let request = lock(&remote.waiting)?.take(key, now).ok_or_else(|| {
        String::from("That browser is no longer waiting. Ask it to connect again.")
    })?;
    lock(&remote.store)?.approve(&request.key, &request.name, now);
    remote.record(&request.key, &request.name, "approved", Ok(()));
    save(app).await?;
    changed(
        app,
        by.map(|by| Notice {
            text: format!("{} approved {} to connect.", by.name, request.name),
            severity: "info",
        }),
    );
    browser_lists(app, by.map(|by| by.key.as_str()))
}

/// Removes an approved browser, which ends its connection, or refuses a waiting one. Returns the lists after it.
pub(crate) async fn remove_browser(
    app: &AppHandle,
    key: &str,
    by: Option<&Caller>,
) -> Result<Value, String> {
    let remote = app.state::<Remote>();
    let removed = {
        let mut store = lock(&remote.store)?;
        let browser = store.find(key).cloned();
        store.remove(key);
        browser
    };
    match &removed {
        Some(browser) => {
            remote.disconnect_browser(key);
            remote.record(key, &browser.name, "removed", Ok(()));
            save(app).await?;
        }
        None => {
            if !lock(&remote.waiting)?.refuse(key, now_ms()) {
                return Err(no_such_browser());
            }
        }
    }
    changed(
        app,
        by.zip(removed.as_ref()).map(|(by, browser)| Notice {
            text: format!(
                "{} removed {} from this computer's browsers.",
                by.name, browser.name
            ),
            severity: "info",
        }),
    );
    browser_lists(app, by.map(|by| by.key.as_str()))
}

/// What the Remote Connections panel shows.
#[tauri::command]
pub(crate) async fn remote_status(app: AppHandle) -> Result<RemoteStatus, String> {
    status(&app)
}

/// Turns Remote Connections on under a name for this computer, renames it when it is already on, or turns it off.
#[tauri::command]
pub(crate) async fn remote_set_enabled(
    app: AppHandle,
    enabled: bool,
    name: Option<String>,
) -> Result<RemoteStatus, String> {
    if enabled {
        turn_on(&app, &name.unwrap_or_default()).await?;
    } else {
        turn_off(&app).await?;
    }
    status(&app)
}

/// The approved and waiting browsers, as a connected browser is given them.
#[tauri::command]
pub(crate) async fn remote_browsers(app: AppHandle) -> Result<Value, String> {
    browser_lists(&app, None)
}

/// Approves a waiting browser, after its code was checked against the one on its screen.
#[tauri::command]
pub(crate) async fn remote_browser_approve(app: AppHandle, key: String) -> Result<Value, String> {
    approve_browser(&app, &key, None).await
}

/// Removes an approved browser, which ends its connection, or refuses a waiting one.
#[tauri::command]
pub(crate) async fn remote_browser_remove(app: AppHandle, key: String) -> Result<Value, String> {
    remove_browser(&app, &key, None).await
}

/// Lets a refused browser ask to connect again. Its next request waits for approval as a new browser's does.
#[tauri::command]
pub(crate) async fn remote_browser_allow(
    app: AppHandle,
    key: String,
) -> Result<RemoteStatus, String> {
    if !lock(&app.state::<Remote>().waiting)?.allow(&key) {
        return Err(no_such_browser());
    }
    changed(&app, None);
    status(&app)
}

/// Changes what an approved browser may do. A lowered level applies to its next command.
#[tauri::command]
pub(crate) async fn remote_browser_level(
    app: AppHandle,
    key: String,
    level: Level,
) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    lock(&remote.store)?.set_level(&key, level)?;
    remote.set_level(&key, level);
    save(&app).await?;
    changed(&app, None);
    status(&app)
}

/// Ends a browser's connections now. It stays approved, so it can connect again.
#[tauri::command]
pub(crate) async fn remote_browser_disconnect(
    app: AppHandle,
    key: String,
) -> Result<RemoteStatus, String> {
    app.state::<Remote>().disconnect_browser(&key);
    changed(&app, None);
    status(&app)
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSettings {
    pub keep_awake: bool,
}

/// Whether the computer is kept awake while Remote Connections is on.
#[tauri::command]
pub(crate) async fn remote_settings(
    app: AppHandle,
    settings: RemoteSettings,
) -> Result<RemoteStatus, String> {
    let remote = app.state::<Remote>();
    lock(&remote.store)?.allow_sleep = !settings.keep_awake;
    apply_awake(&remote);
    save(&app).await?;
    changed(&app, None);
    status(&app)
}

/// The latest things browsers did, newest first, for the panel's Activity.
#[tauri::command]
pub(crate) async fn remote_log(app: AppHandle) -> Result<Vec<audit::Entry>, String> {
    let mut entries = lock(&app.state::<Remote>().log)?.latest();
    entries.truncate(200);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::keys::{SigningKey, fixed};
    use crate::remote::signal::tests::{DESK, signed_offer};
    use crate::services::myfi::tests::{Answer, body_of, fake_api};

    const COOKIE: &str = "__Host-myfi-session=token-1";

    fn api(base: &str) -> MyFiApi {
        MyFiApi::signed_in(base, &[String::from(COOKIE)]).unwrap()
    }

    #[tokio::test]
    async fn turning_on_sends_the_name_and_public_key_and_returns_the_computers_id() {
        let (base, received) = fake_api(vec![
            (
                200,
                r#"{"desktopId":"3160d8e4-e8dd-43c7-a397-43b17ef46cbc"}"#,
            ),
            (401, ""),
            (400, "Name the computer in 1 to 100 characters"),
            (200, "{}"),
        ]);
        let api = api(&base);
        assert_eq!(
            register(&api, "Desk", fixed::PUBLIC_KEY).await.unwrap(),
            DESK
        );
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /remote/desktop HTTP/1.1");
        assert_eq!(request.headers["cookie"], COOKIE);
        assert!(request.headers.contains_key("x-app"));
        assert_eq!(
            body_of(&request),
            serde_json::json!({ "name": "Desk", "publicKey": fixed::PUBLIC_KEY })
        );
        assert_eq!(
            register(&api, "Desk", fixed::PUBLIC_KEY).await.unwrap_err(),
            ApiError::Failed(SIGN_IN_FIRST.into())
        );
        assert_eq!(
            register(&api, "Desk", fixed::PUBLIC_KEY).await.unwrap_err(),
            ApiError::Failed("Name the computer in 1 to 100 characters".into())
        );
        assert_eq!(
            register(&api, "Desk", fixed::PUBLIC_KEY).await.unwrap_err(),
            unexpected()
        );
    }

    #[tokio::test]
    async fn connection_requests_are_read_and_404_means_it_is_off() {
        let (base, received) = fake_api(vec![
            (
                200,
                r#"{"connections":[{"connectionId":"c-1","offer":"{\"v\":1}"},{"connectionId":"c-2","offer":"x"}]}"#,
            ),
            (200, r#"{"connections":[]}"#),
            (404, "Remote Connections is off for this computer."),
            (401, ""),
            (500, ""),
        ]);
        let api = api(&base);
        assert_eq!(
            connections(&api).await.unwrap(),
            vec![
                ConnectionRequest {
                    connection_id: "c-1".into(),
                    offer: r#"{"v":1}"#.into()
                },
                ConnectionRequest {
                    connection_id: "c-2".into(),
                    offer: "x".into()
                },
            ]
        );
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /remote/desktop/connections HTTP/1.1");
        assert_eq!(request.headers["cookie"], COOKIE);
        assert_eq!(body_of(&request), serde_json::json!({}));
        assert_eq!(connections(&api).await.unwrap(), vec![]);
        assert_eq!(connections(&api).await.unwrap_err(), ApiError::Off);
        assert_eq!(connections(&api).await.unwrap_err(), ApiError::Off);
        assert_eq!(
            connections(&api).await.unwrap_err(),
            ApiError::Failed(
                "Connection requests could not be read. (api.myfi.ws answered 500.)".into()
            )
        );
    }

    #[tokio::test]
    async fn not_reaching_the_api_is_not_the_same_as_off() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        assert!(matches!(
            connections(&api(&base)).await.unwrap_err(),
            ApiError::Failed(reason) if reason.starts_with("Could not reach api.myfi.ws")
        ));
    }

    #[tokio::test]
    async fn answers_turning_off_and_the_server_list_go_where_the_api_takes_them() {
        let (base, received) = fake_api(vec![
            Answer::from((200, "")),
            Answer::from((404, "This connection request has ended.")),
            Answer::from((200, "Remote Connections is off for this computer.")),
            Answer::from((200, r#"{"iceServers":[{"urls":"stun:api.myfi.ws:3478"}]}"#)),
        ]);
        let api = api(&base);
        send_answer(&api, "c-1", r#"{"v":1,"status":"refused"}"#)
            .await
            .unwrap();
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /remote/desktop/answer HTTP/1.1");
        assert_eq!(
            body_of(&request),
            serde_json::json!({ "connectionId": "c-1", "answer": r#"{"v":1,"status":"refused"}"# })
        );
        assert_eq!(
            send_answer(&api, "c-1", "x").await.unwrap_err(),
            ApiError::Failed("This connection request has ended.".into())
        );
        received.recv().unwrap();

        unregister(&api, DESK).await.unwrap();
        let request = received.recv().unwrap();
        assert_eq!(request.line, "DELETE /remote/desktop HTTP/1.1");
        assert_eq!(body_of(&request), serde_json::json!({ "desktopId": DESK }));

        assert_eq!(stun_servers(&api).await.unwrap(), vec!["api.myfi.ws:3478"]);
        let request = received.recv().unwrap();
        assert_eq!(request.line, "GET /remote/servers HTTP/1.1");
        assert_eq!(request.headers["cookie"], COOKIE);
    }

    #[test]
    fn a_request_is_refused_kept_for_approval_or_connected() {
        let mut store = browsers::Store::default();
        let mut waiting = browsers::Waiting::default();
        let browser = SigningKey::generate().unwrap();
        let now = 1_795_000_000_000;
        let offer = signed_offer(&browser, DESK, "Firefox", now, "v=0\r\n").to_string();

        // An offer that fails a check is refused, and its browser is not kept.
        let bad = check_request(&store, &mut waiting, "{}", DESK, now);
        assert_eq!(bad.decision, Decision::Refused);
        assert_eq!(bad.refusal, Some("The offer is missing something."));
        assert_eq!(bad.offer_sdp_hash, "");
        let elsewhere = check_request(&store, &mut waiting, &offer, "another-computer", now);
        assert_eq!(elsewhere.decision, Decision::Refused);
        assert_eq!(elsewhere.offer_sdp_hash, keys::sha256_hex("v=0\r\n"));
        let stale = check_request(&store, &mut waiting, &offer, DESK, now + 121_000);
        assert_eq!(stale.decision, Decision::Refused);
        assert!(waiting.list(now).is_empty());

        // A browser this computer hasn't seen is kept for approval.
        let first = check_request(&store, &mut waiting, &offer, DESK, now);
        assert_eq!(first.decision, Decision::Approval { new: true });
        assert!(first.refusal.is_none());
        assert_eq!(waiting.list(now).len(), 1);

        // Approved, its next offer connects.
        store.approve(&browser.public_key(), "Firefox", now);
        let next = check_request(&store, &mut waiting, &offer, DESK, now + 3000);
        assert_eq!(next.decision, Decision::Connect(Level::View));
        assert_eq!(next.offer.unwrap().key, browser.public_key());

        // Removed, it waits again. Refused, it is refused.
        store.remove(&browser.public_key());
        waiting.clear();
        assert_eq!(
            check_request(&store, &mut waiting, &offer, DESK, now).decision,
            Decision::Approval { new: true }
        );
        waiting.refuse(&browser.public_key(), now);
        let refused = check_request(&store, &mut waiting, &offer, DESK, now);
        assert_eq!(refused.decision, Decision::Refused);
        assert!(refused.refusal.is_some());
    }

    #[test]
    fn computer_names_are_1_to_100_plain_characters() {
        assert_eq!(computer_name("  Desk PC  ").unwrap(), "Desk PC");
        assert!(computer_name("   ").is_err());
        assert!(computer_name(&"x".repeat(101)).is_err());
        assert_eq!(
            computer_name(&"é".repeat(100)).unwrap().chars().count(),
            100
        );
        assert!(computer_name("<b>Desk</b>").unwrap_err().contains("< >"));
        assert!(computer_name("Desk\nPC").is_err());
    }
}
