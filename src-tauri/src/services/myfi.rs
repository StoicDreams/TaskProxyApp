//! Signing Task Proxy in to a MyFi account (api.myfi.ws), which Remote Access needs (see Docs/RemoteAccess.md).
//!
//! The app never sees a password. It starts a sign-in with the SHA-256 of a secret only it knows, opens
//! www.stoicdreams.com in the user's browser, and shows a code. The user signs in there, checks the code matches,
//! and approves. The app then collects its session with the secret. The session is kept in the OS keychain and
//! used only here: the window gets the account's id and name, never the session. Apps belong to client companies,
//! so MyFi gives them no more than that, never the user's email.
use crate::prelude::*;
use keyring::Entry;
use std::sync::LazyLock;
use std::time::Instant;

const API: &str = "https://api.myfi.ws";
/// Task Proxy's app key, sent as x-app: the key myfi.ws gave the Task Proxy app added to the Stoic Dreams company on its
/// Apps page, as any company adds its apps. It ships inside the app, so it names the app and is not a secret.
/// Until it is set, api.myfi.ws answers "Unknown app" and signing in can't start.
const APP_KEY: &str = "b961e1fc-0e9b-471f-9c25-44ea6cfdb044";
const SIGNIN_PAGE: &str = "https://www.stoicdreams.com/signin";
/// The API names a request by its agent's first word when there is no Origin, as from here: agent:taskproxy.
const USER_AGENT: &str = "TaskProxy";
const KEYCHAIN_SERVICE_NAME: &str = "com.task-proxy.app";
const KEYCHAIN_SESSION: &str = "myfi_session";
/// How often to ask whether the user has approved the sign-in yet.
const POLL: Duration = Duration::from_secs(2);

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MyFiAccount {
    pub id: i64,
    pub display_name: String,
}

/// The signed-in account, and whether it comes from what was saved because api.myfi.ws could not be reached.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MyFiStatus {
    #[serde(flatten)]
    pub account: MyFiAccount,
    pub offline: bool,
}

/// What the window shows while it waits: the code to check, and the page to approve it on.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SignInStarted {
    pub code: String,
    pub url: String,
}

/// What the keychain holds: the session, and its account, which is shown while api.myfi.ws can't be reached.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct StoredSignIn {
    session: String,
    account: Option<MyFiAccount>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Started {
    pub request: String,
    pub code: String,
    pub expires_in: u64,
}

#[derive(Debug, PartialEq)]
pub(crate) enum Collected {
    /// Not approved yet.
    Waiting,
    Session(String),
    /// Refused, expired, or started by another app, with the API's reason.
    Ended(String),
}

/// A sign-in waiting for approval. The secret stays here, so only this app can collect the session.
struct Pending {
    id: u64,
    request: String,
    secret: String,
    expires: Instant,
}

/// The sign-in waiting for the user's approval. Starting another replaces it, and the one waiting stops.
#[derive(Default)]
pub(crate) struct SignIns {
    pending: Mutex<Option<Pending>>,
    next: Mutex<u64>,
}

static SIGN_INS: LazyLock<SignIns> = LazyLock::new(SignIns::default);

impl SignIns {
    /// Starts waiting for a request the API made, which lasts `lasts`. Returns its id.
    pub(crate) fn begin(
        &self,
        request: String,
        secret: String,
        lasts: Duration,
    ) -> Result<u64, String> {
        let id = {
            let mut next = self.next.lock().map_err(|_| "Failed to acquire lock")?;
            *next += 1;
            *next
        };
        *self.pending.lock().map_err(|_| "Failed to acquire lock")? = Some(Pending {
            id,
            request,
            secret,
            expires: Instant::now() + lasts,
        });
        Ok(id)
    }

    /// Stops waiting. The request is left to expire.
    pub(crate) fn cancel(&self) -> Result<(), String> {
        *self.pending.lock().map_err(|_| "Failed to acquire lock")? = None;
        Ok(())
    }

    /// Waits for the user to approve the sign-in, asking the API every `poll`, and returns its session. None when
    /// it was cancelled or replaced by a new sign-in. A refusal or expiry is an error with the reason.
    pub(crate) async fn wait(
        &self,
        api: &MyFiApi,
        poll: Duration,
    ) -> Result<Option<String>, String> {
        let Some(id) = self
            .pending
            .lock()
            .map_err(|_| "Failed to acquire lock")?
            .as_ref()
            .map(|p| p.id)
        else {
            return Ok(None);
        };
        let take = || {
            if let Ok(mut pending) = self.pending.lock()
                && pending.as_ref().map(|p| p.id) == Some(id)
            {
                *pending = None;
            }
        };
        loop {
            let (request, secret, expired) = {
                let pending = self.pending.lock().map_err(|_| "Failed to acquire lock")?;
                match pending.as_ref() {
                    Some(p) if p.id == id => (
                        p.request.clone(),
                        p.secret.clone(),
                        Instant::now() >= p.expires,
                    ),
                    _ => return Ok(None),
                }
            };
            if expired {
                take();
                return Err(String::from("The sign-in expired. Start signing in again."));
            }
            // Not reaching the API is often brief, so it keeps asking until the request expires.
            match api.collect(&request, &secret).await {
                Ok(Collected::Waiting) | Err(_) => sleep(poll).await,
                Ok(Collected::Ended(reason)) => {
                    take();
                    return Err(reason);
                }
                Ok(Collected::Session(session)) => {
                    // A sign-in cancelled while the API answered is not kept.
                    let current = self
                        .pending
                        .lock()
                        .map_err(|_| "Failed to acquire lock")?
                        .as_ref()
                        .map(|p| p.id);
                    if current != Some(id) {
                        return Ok(None);
                    }
                    take();
                    return Ok(Some(session));
                }
            }
        }
    }
}

/// api.myfi.ws, as the app uses it. The address can change for tests.
pub(crate) struct MyFiApi {
    base: String,
    client: reqwest::Client,
}

impl MyFiApi {
    pub fn new(base: &str) -> Result<Self, String> {
        // The updater sets this up the same way, and whichever runs first installs it.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|err| err.to_string())?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            client,
        })
    }

    /// The status and text of a response. Only failing to reach the API is an error.
    pub(crate) async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        session: Option<&str>,
    ) -> Result<(u16, String), String> {
        let mut request = self
            .client
            .request(method, format!("{}/{}", self.base, path))
            .header("x-app", APP_KEY);
        if let Some(session) = session {
            request = request.header("x-auth", session);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|err| format!("Could not reach api.myfi.ws: {}", err))?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Ok((status, text))
    }

    pub async fn start(&self, challenge: &str, name: &str) -> Result<Started, String> {
        let body = serde_json::json!({ "challenge": challenge, "name": name });
        let (status, text) = self
            .send(
                reqwest::Method::POST,
                "user/signin/app/start",
                Some(body),
                None,
            )
            .await?;
        if status != 200 {
            return Err(failure(status, &text, "Signing in could not start."));
        }
        serde_json::from_str(&text)
            .map_err(|_| String::from("api.myfi.ws answered with something unexpected."))
    }

    pub async fn collect(&self, request: &str, secret: &str) -> Result<Collected, String> {
        let body = serde_json::json!({ "request": request, "secret": secret });
        let (status, text) = self
            .send(
                reqwest::Method::POST,
                "user/signin/app/collect",
                Some(body),
                None,
            )
            .await?;
        Ok(match status {
            202 => Collected::Waiting,
            200 => match serde_json::from_str::<Value>(&text).ok().and_then(|json| {
                json.get("session")
                    .and_then(|s| s.as_str())
                    .map(String::from)
            }) {
                Some(session) => Collected::Session(session),
                None => Collected::Ended(String::from(
                    "api.myfi.ws answered with something unexpected.",
                )),
            },
            _ => Collected::Ended(failure(status, &text, "The sign-in ended.")),
        })
    }

    /// The account the session belongs to, or None when the API no longer accepts the session.
    pub async fn account(&self, session: &str) -> Result<Option<MyFiAccount>, String> {
        let (status, text) = self
            .send(reqwest::Method::GET, "app/account", None, Some(session))
            .await?;
        match status {
            200 => serde_json::from_str(&text)
                .map(Some)
                .map_err(|_| String::from("api.myfi.ws answered with something unexpected.")),
            401 => Ok(None),
            _ => Err(failure(status, &text, "Your account could not be read.")),
        }
    }

    pub async fn sign_out(&self, session: &str) -> Result<(), String> {
        let (status, text) = self
            .send(
                reqwest::Method::POST,
                "user/signout",
                Some(serde_json::json!({})),
                Some(session),
            )
            .await?;
        if status == 200 {
            Ok(())
        } else {
            Err(failure(status, &text, "Signing out failed."))
        }
    }
}

/// The API's reason, or a general one when it gave none.
fn failure(status: u16, text: &str, general: &str) -> String {
    let text = text.trim();
    if text.is_empty() {
        format!("{} (api.myfi.ws answered {}.)", general, status)
    } else {
        text.to_string()
    }
}

/// A random secret, and its SHA-256 as 64 lowercase hex characters, as the API checks it.
pub(crate) fn new_secret() -> (String, String) {
    use rand::RngExt;
    let bytes: [u8; 32] = rand::rng().random();
    let secret = hex::encode(bytes);
    let challenge = hex::encode(Sha256::digest(secret.as_bytes()));
    (secret, challenge)
}

/// The computer's name as the account lists it: one line of at most 100 characters, without the characters MyFi
/// refuses in names.
pub(crate) fn computer_name(host: Option<String>) -> String {
    let cleaned: String = host
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control() && !"<>\"&`{}".contains(*c))
        .take(100)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        String::from("Task Proxy computer")
    } else {
        cleaned.to_string()
    }
}

/// The page that approves a request. The request comes from the API, so it is checked before going in an address.
pub(crate) fn sign_in_page_url(request: &str) -> Result<String, String> {
    let request = Uuid::parse_str(request)
        .map_err(|_| String::from("api.myfi.ws answered with something unexpected."))?;
    Ok(format!("{}?app=taskproxy&request={}", SIGNIN_PAGE, request))
}

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE_NAME, KEYCHAIN_SESSION)
        .map_err(|err| format!("The keychain could not be opened: {:?}", err))
}

async fn read_stored() -> Option<StoredSignIn> {
    task::spawn_blocking(|| {
        let password = keychain_entry().ok()?.get_password().ok()?;
        serde_json::from_str(&password).ok()
    })
    .await
    .ok()
    .flatten()
}

async fn write_stored(stored: StoredSignIn) -> Result<(), String> {
    task::spawn_blocking(move || {
        let json = serde_json::to_string(&stored).map_err(|err| err.to_string())?;
        keychain_entry()?
            .set_password(&json)
            .map_err(|err| format!("Your sign-in could not be saved in the keychain: {:?}", err))
    })
    .await
    .map_err(|err| err.to_string())?
}

async fn delete_stored() {
    let _ = task::spawn_blocking(|| {
        if let Ok(entry) = keychain_entry() {
            let _ = entry.delete_credential();
        }
    })
    .await;
}

/// The stored session and the account it was last read as, or None when signed out. Reads the keychain, so callers
/// that ask often keep the session themselves.
pub(crate) async fn session() -> Option<(String, Option<MyFiAccount>)> {
    read_stored()
        .await
        .map(|stored| (stored.session, stored.account))
}

pub(crate) fn api() -> Result<MyFiApi, String> {
    MyFiApi::new(API)
}

/// The signed-in account, or None when signed out. A session the API no longer accepts is forgotten.
#[tauri::command]
pub(crate) async fn myfi_account() -> Result<Option<MyFiStatus>, String> {
    let Some(mut stored) = read_stored().await else {
        return Ok(None);
    };
    match api()?.account(&stored.session).await {
        Ok(Some(account)) => {
            if stored.account.as_ref() != Some(&account) {
                stored.account = Some(account.clone());
                let _ = write_stored(stored).await;
            }
            Ok(Some(MyFiStatus {
                account,
                offline: false,
            }))
        }
        Ok(None) => {
            delete_stored().await;
            Ok(None)
        }
        Err(_) => Ok(stored.account.map(|account| MyFiStatus {
            account,
            offline: true,
        })),
    }
}

/// Starts signing in, opens the approval page in the user's browser, and returns the code it should show.
#[tauri::command]
pub(crate) async fn myfi_sign_in_start(app: AppHandle) -> Result<SignInStarted, String> {
    let (secret, challenge) = new_secret();
    let name = computer_name(sysinfo::System::host_name().ok());
    let started = api()?.start(&challenge, &name).await?;
    let url = sign_in_page_url(&started.request)?;
    SIGN_INS.begin(
        started.request,
        secret,
        Duration::from_secs(started.expires_in.min(3600)),
    )?;
    {
        use tauri_plugin_opener::OpenerExt;
        // The page's address is shown too, so a browser that doesn't open is not the end of it.
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
    Ok(SignInStarted {
        code: started.code,
        url,
    })
}

/// Waits for the user to approve the sign-in, then saves the session. None when it was cancelled or replaced by a
/// new sign-in. A refusal or expiry is an error with the reason.
#[tauri::command]
pub(crate) async fn myfi_sign_in_wait(app: AppHandle) -> Result<Option<MyFiStatus>, String> {
    let api = api()?;
    let Some(session) = SIGN_INS.wait(&api, POLL).await? else {
        return Ok(None);
    };
    let account = api.account(&session).await.ok().flatten();
    write_stored(StoredSignIn {
        session,
        account: account.clone(),
    })
    .await?;
    if let Some(account) = &account {
        crate::remote::service::signed_in_as(&app, &account.id.to_string()).await?;
    }
    Ok(account.map(|account| MyFiStatus {
        account,
        offline: false,
    }))
}

/// Stops waiting for a sign-in. The request is left to expire.
#[tauri::command]
pub(crate) async fn myfi_sign_in_cancel() -> Result<(), String> {
    SIGN_INS.cancel()
}

/// Ends the session with the API, when it can be reached, and forgets it here either way. Remote Access turns off
/// and every paired device is forgotten, since they were paired under this account.
#[tauri::command]
pub(crate) async fn myfi_sign_out(app: AppHandle) -> Result<(), String> {
    crate::remote::forget_all(&app).await?;
    if let Some(stored) = read_stored().await
        && let Ok(api) = api()
    {
        let _ = api.sign_out(&stored.session).await;
    }
    delete_stored().await;
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;

    /// A request the fake API received: its first line, headers in lowercase, and body.
    #[derive(Debug)]
    pub(crate) struct Received {
        pub line: String,
        pub headers: HashMap<String, String>,
        pub body: String,
    }

    /// An API that answers each connection with the next of `answers`, and reports what it received.
    pub(crate) fn fake_api<S: Into<String>>(
        answers: Vec<(u16, S)>,
    ) -> (String, mpsc::Receiver<Received>) {
        let answers: Vec<(u16, String)> = answers
            .into_iter()
            .map(|(status, body)| (status, body.into()))
            .collect();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for (status, body) in answers {
                let Ok((stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let mut headers = HashMap::new();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        headers.insert(name.trim().to_lowercase(), value.trim().to_string());
                    }
                }
                let length = headers
                    .get("content-length")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let _ = sender.send(Received {
                    line: line.trim_end().to_string(),
                    headers,
                    body: String::from_utf8(bytes).unwrap(),
                });
                let mut stream = stream;
                let _ = write!(
                    stream,
                    "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    body.len(),
                    body
                );
            }
        });
        (base, receiver)
    }

    pub(crate) fn body_of(received: &Received) -> Value {
        serde_json::from_str(&received.body).unwrap()
    }

    #[tokio::test]
    async fn start_names_the_app_and_sends_the_challenge_and_computer() {
        let (base, received) = fake_api(vec![(
            200,
            r#"{"request":"3160d8e4-e8dd-43c7-a397-43b17ef46cbc","code":"M7A-JQF","expiresIn":600}"#,
        )]);
        let started = MyFiApi::new(&base)
            .unwrap()
            .start("ab".repeat(32).as_str(), "Desk")
            .await
            .unwrap();
        assert_eq!(started.code, "M7A-JQF");
        assert_eq!(started.expires_in, 600);
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /user/signin/app/start HTTP/1.1");
        assert_eq!(request.headers["x-app"], APP_KEY);
        assert_eq!(request.headers["user-agent"], "TaskProxy");
        assert!(!request.headers.contains_key("x-auth"));
        assert_eq!(
            body_of(&request),
            serde_json::json!({ "challenge": "ab".repeat(32), "name": "Desk" })
        );
    }

    #[tokio::test]
    async fn start_passes_on_the_reason_it_was_refused() {
        let (base, _received) = fake_api(vec![
            (429, "Too many sign-ins were started from here."),
            (500, ""),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        assert_eq!(
            api.start("c", "Desk").await.unwrap_err(),
            "Too many sign-ins were started from here."
        );
        assert_eq!(
            api.start("c", "Desk").await.unwrap_err(),
            "Signing in could not start. (api.myfi.ws answered 500.)"
        );
    }

    #[tokio::test]
    async fn collect_waits_then_returns_the_session() {
        let (base, received) = fake_api(vec![
            (202, "Waiting for approval"),
            (
                200,
                r#"{"session":"0f9eb2b1-01ce-422f-af58-d758144125c8","expiresIn":7776000}"#,
            ),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        assert_eq!(
            api.collect("req", "secret").await.unwrap(),
            Collected::Waiting
        );
        assert_eq!(
            api.collect("req", "secret").await.unwrap(),
            Collected::Session(String::from("0f9eb2b1-01ce-422f-af58-d758144125c8"))
        );
        let first = received.recv().unwrap();
        assert_eq!(first.line, "POST /user/signin/app/collect HTTP/1.1");
        assert_eq!(
            body_of(&first),
            serde_json::json!({ "request": "req", "secret": "secret" })
        );
    }

    #[tokio::test]
    async fn collect_ends_with_the_reason_for_a_refusal_or_expiry() {
        let (base, _received) = fake_api(vec![
            (
                400,
                "This sign-in has expired or was refused. Start signing in again.",
            ),
            (403, "This sign-in was started by another app."),
            (200, "not json"),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        assert_eq!(
            api.collect("r", "s").await.unwrap(),
            Collected::Ended(String::from(
                "This sign-in has expired or was refused. Start signing in again."
            ))
        );
        assert_eq!(
            api.collect("r", "s").await.unwrap(),
            Collected::Ended(String::from("This sign-in was started by another app."))
        );
        assert!(matches!(
            api.collect("r", "s").await.unwrap(),
            Collected::Ended(_)
        ));
    }

    #[tokio::test]
    async fn account_sends_the_session_and_reads_the_account() {
        let (base, received) = fake_api(vec![
            (200, r#"{"id":1,"displayName":"Test User"}"#),
            (401, ""),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        let account = api.account("the-session").await.unwrap().unwrap();
        assert_eq!(
            account,
            MyFiAccount {
                id: 1,
                display_name: String::from("Test User")
            }
        );
        let request = received.recv().unwrap();
        assert_eq!(request.line, "GET /app/account HTTP/1.1");
        assert_eq!(request.headers["x-auth"], "the-session");
        assert_eq!(request.headers["x-app"], APP_KEY);
        // A session the API refuses means signed out, not an error.
        assert_eq!(api.account("old-session").await.unwrap(), None);
    }

    #[tokio::test]
    async fn sign_out_ends_the_session() {
        let (base, received) = fake_api(vec![(200, "Signout Successful")]);
        MyFiApi::new(&base)
            .unwrap()
            .sign_out("the-session")
            .await
            .unwrap();
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /user/signout HTTP/1.1");
        assert_eq!(request.headers["x-auth"], "the-session");
    }

    #[tokio::test]
    async fn not_reaching_the_api_is_an_error() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let err = MyFiApi::new(&base).unwrap().account("s").await.unwrap_err();
        assert!(err.starts_with("Could not reach api.myfi.ws"), "{}", err);
    }

    #[test]
    fn the_challenge_is_the_secrets_sha256_in_hex() {
        let (secret, challenge) = new_secret();
        assert_eq!(secret.len(), 64);
        assert_eq!(challenge.len(), 64);
        assert!(
            challenge
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        );
        assert_eq!(challenge, hex::encode(Sha256::digest(secret.as_bytes())));
        assert_ne!(new_secret().0, secret);
    }

    #[test]
    fn computer_names_are_one_plain_line_of_at_most_100_characters() {
        assert_eq!(computer_name(Some(String::from("  desk-01  "))), "desk-01");
        assert_eq!(
            computer_name(Some(String::from("<b>Desk</b> & \"co\"\n"))),
            "bDesk/b  co"
        );
        assert_eq!(computer_name(Some("x".repeat(150))).len(), 100);
        assert_eq!(computer_name(None), "Task Proxy computer");
        assert_eq!(
            computer_name(Some(String::from("<>"))),
            "Task Proxy computer"
        );
    }

    #[test]
    fn the_approval_page_takes_only_a_request_id() {
        assert_eq!(
            sign_in_page_url("3160d8e4-e8dd-43c7-a397-43b17ef46cbc").unwrap(),
            "https://www.stoicdreams.com/signin?app=taskproxy&request=3160d8e4-e8dd-43c7-a397-43b17ef46cbc"
        );
        assert!(sign_in_page_url("x&domain=evil.example").is_err());
    }

    const SESSION: &str =
        r#"{"session":"0f9eb2b1-01ce-422f-af58-d758144125c8","expiresIn":7776000}"#;
    const FAST: Duration = Duration::from_millis(10);

    fn unreachable_api() -> MyFiApi {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        MyFiApi::new(&base).unwrap()
    }

    #[tokio::test]
    async fn waiting_returns_the_session_once_the_user_approves() {
        let (base, received) = fake_api(vec![(202, "Waiting"), (202, "Waiting"), (200, SESSION)]);
        let sign_ins = SignIns::default();
        sign_ins
            .begin("req".into(), "secret".into(), Duration::from_secs(60))
            .unwrap();
        let session = sign_ins
            .wait(&MyFiApi::new(&base).unwrap(), FAST)
            .await
            .unwrap();
        assert_eq!(
            session.as_deref(),
            Some("0f9eb2b1-01ce-422f-af58-d758144125c8")
        );
        assert_eq!(received.try_iter().count(), 3, "it asked until approved");
        assert_eq!(
            sign_ins
                .wait(&MyFiApi::new(&base).unwrap(), FAST)
                .await
                .unwrap(),
            None,
            "a sign-in is used once"
        );
    }

    #[tokio::test]
    async fn waiting_ends_with_the_reason_it_was_refused() {
        let (base, _received) =
            fake_api(vec![(202, "Waiting"), (400, "This sign-in was refused.")]);
        let sign_ins = SignIns::default();
        sign_ins
            .begin("req".into(), "secret".into(), Duration::from_secs(60))
            .unwrap();
        let err = sign_ins
            .wait(&MyFiApi::new(&base).unwrap(), FAST)
            .await
            .unwrap_err();
        assert_eq!(err, "This sign-in was refused.");
        assert_eq!(sign_ins.wait(&unreachable_api(), FAST).await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_sign_in_expires_even_while_the_api_cannot_be_reached() {
        let sign_ins = SignIns::default();
        sign_ins
            .begin("req".into(), "secret".into(), Duration::from_millis(150))
            .unwrap();
        let started = Instant::now();
        let err = sign_ins.wait(&unreachable_api(), FAST).await.unwrap_err();
        assert!(err.contains("expired"), "{}", err);
        assert!(
            started.elapsed() >= Duration::from_millis(150),
            "it kept asking until it expired"
        );
    }

    #[tokio::test]
    async fn cancelling_stops_the_wait_with_nothing_signed_in() {
        let sign_ins = Arc::new(SignIns::default());
        sign_ins
            .begin("req".into(), "secret".into(), Duration::from_secs(60))
            .unwrap();
        let waiting = {
            let sign_ins = sign_ins.clone();
            tokio::spawn(async move { sign_ins.wait(&unreachable_api(), FAST).await })
        };
        sleep(Duration::from_millis(50)).await;
        sign_ins.cancel().unwrap();
        assert_eq!(waiting.await.unwrap().unwrap(), None);
    }

    #[tokio::test]
    async fn a_new_sign_in_replaces_the_one_waiting() {
        let sign_ins = Arc::new(SignIns::default());
        sign_ins
            .begin("first".into(), "s1".into(), Duration::from_secs(60))
            .unwrap();
        let waiting = {
            let sign_ins = sign_ins.clone();
            tokio::spawn(async move { sign_ins.wait(&unreachable_api(), FAST).await })
        };
        sleep(Duration::from_millis(50)).await;
        sign_ins
            .begin("second".into(), "s2".into(), Duration::from_secs(60))
            .unwrap();
        assert_eq!(
            waiting.await.unwrap().unwrap(),
            None,
            "the first wait stops"
        );
        // The new one is still there to wait for.
        let (base, received) = fake_api(vec![(200, SESSION)]);
        assert!(
            sign_ins
                .wait(&MyFiApi::new(&base).unwrap(), FAST)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(body_of(&received.recv().unwrap())["request"], "second");
    }

    #[tokio::test]
    async fn waiting_with_no_sign_in_started_returns_at_once() {
        assert_eq!(
            SignIns::default()
                .wait(&unreachable_api(), FAST)
                .await
                .unwrap(),
            None
        );
    }
}
