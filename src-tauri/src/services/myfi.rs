//! Signing Task Proxy in to a MyFi account (api.myfi.ws).
//!
//! The app never sees a password. It starts a sign-in with the SHA-256 of a secret only it knows, opens
//! www.stoicdreams.com in the user's browser, and shows a code. The user signs in there, checks the code matches,
//! and approves. The app then collects its sign-in with the secret, and the API sets the session cookie.
//!
//! The session is only ever in that cookie. The app keeps its cookies as a browser does, in `ApiCookies`, sends them
//! with every call, and saves them in the OS keychain. It never reads or checks the session in them, and the window
//! gets the account's id and name, never the cookies. Apps belong to client companies, so MyFi gives them no more
//! than that, never the user's email.
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
    /// Whether the browser opened the page. When it didn't, the dialog shows the address to open.
    pub opened: bool,
}

/// What the keychain holds: the API's cookies, and the account, which is shown while api.myfi.ws can't be reached.
/// A sign-in saved before the session moved to a cookie has no cookies, so it reads as signed out.
#[derive(Serialize, Deserialize, Clone, Debug)]
struct StoredSignIn {
    cookies: Vec<String>,
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
    /// Approved: the API set the session cookie, which the client now keeps.
    SignedIn,
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

    /// Waits for the user to approve the sign-in, asking the API every `poll`. True once signed in, when `api` holds
    /// the session cookie. False when it was cancelled or replaced by a new sign-in. A refusal or expiry is an error
    /// with the reason.
    pub(crate) async fn wait(&self, api: &MyFiApi, poll: Duration) -> Result<bool, String> {
        let Some(id) = self
            .pending
            .lock()
            .map_err(|_| "Failed to acquire lock")?
            .as_ref()
            .map(|p| p.id)
        else {
            return Ok(false);
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
                    _ => return Ok(false),
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
                Ok(Collected::SignedIn) => {
                    // A sign-in cancelled while the API answered is not kept.
                    let current = self
                        .pending
                        .lock()
                        .map_err(|_| "Failed to acquire lock")?
                        .as_ref()
                        .map(|p| p.id);
                    if current != Some(id) {
                        return Ok(false);
                    }
                    take();
                    return Ok(true);
                }
            }
        }
    }
}

/// The cookies api.myfi.ws sets, kept as a browser keeps a site's cookies: each as the `name=value` the API sent,
/// sent back with every call, until the API replaces it or ends it with `Max-Age=0`. The session is one of them.
/// Nothing here reads or checks what a cookie holds.
#[derive(Default)]
pub(crate) struct ApiCookies {
    pairs: Mutex<std::collections::BTreeMap<String, String>>,
}

impl ApiCookies {
    fn from_saved(saved: &[String]) -> Self {
        let pairs = saved
            .iter()
            .filter_map(|pair| Some((pair.split_once('=')?.0.trim().to_string(), pair.clone())))
            .collect();
        Self {
            pairs: Mutex::new(pairs),
        }
    }

    fn saved(&self) -> Vec<String> {
        self.pairs
            .lock()
            .map(|pairs| pairs.values().cloned().collect())
            .unwrap_or_default()
    }
}

impl reqwest::cookie::CookieStore for ApiCookies {
    fn set_cookies(
        &self,
        cookie_headers: &mut dyn Iterator<Item = &reqwest::header::HeaderValue>,
        _url: &reqwest::Url,
    ) {
        let Ok(mut pairs) = self.pairs.lock() else {
            return;
        };
        for header in cookie_headers {
            let Ok(text) = header.to_str() else {
                continue;
            };
            let mut parts = text.split(';');
            let pair = parts.next().unwrap_or_default().trim();
            let Some((name, _)) = pair.split_once('=') else {
                continue;
            };
            let ended = parts.any(|attribute| {
                attribute
                    .trim()
                    .to_ascii_lowercase()
                    .strip_prefix("max-age=")
                    .is_some_and(|age| age.trim().parse::<i64>().is_ok_and(|age| age <= 0))
            });
            if ended {
                pairs.remove(name.trim());
            } else {
                pairs.insert(name.trim().to_string(), pair.to_string());
            }
        }
    }

    fn cookies(&self, _url: &reqwest::Url) -> Option<reqwest::header::HeaderValue> {
        let pairs = self.pairs.lock().ok()?;
        if pairs.is_empty() {
            return None;
        }
        let joined = pairs.values().cloned().collect::<Vec<_>>().join("; ");
        reqwest::header::HeaderValue::from_str(&joined).ok()
    }
}

/// api.myfi.ws, as the app uses it, with the cookies it set. The address can change for tests.
pub(crate) struct MyFiApi {
    base: String,
    client: reqwest::Client,
    cookies: Arc<ApiCookies>,
}

impl MyFiApi {
    /// A client with no cookies, as before signing in.
    pub fn new(base: &str) -> Result<Self, String> {
        Self::with_cookies(base, ApiCookies::default())
    }

    /// A client with the cookies saved when it last signed in.
    pub fn signed_in(base: &str, saved: &[String]) -> Result<Self, String> {
        Self::with_cookies(base, ApiCookies::from_saved(saved))
    }

    fn with_cookies(base: &str, cookies: ApiCookies) -> Result<Self, String> {
        // The updater sets this up the same way, and whichever runs first installs it.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let cookies = Arc::new(cookies);
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(15))
            .cookie_provider(cookies.clone())
            .build()
            .map_err(|err| err.to_string())?;
        Ok(Self {
            base: base.trim_end_matches('/').to_string(),
            client,
            cookies,
        })
    }

    /// The cookies to save, so the next start is still signed in.
    pub fn saved_cookies(&self) -> Vec<String> {
        self.cookies.saved()
    }

    /// The status and text of a response. Only failing to reach the API is an error.
    pub(crate) async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<(u16, String), String> {
        let mut request = self
            .client
            .request(method, format!("{}/{}", self.base, path))
            .header("x-app", APP_KEY);
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
            .send(reqwest::Method::POST, "user/signin/app/start", Some(body))
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
            .send(reqwest::Method::POST, "user/signin/app/collect", Some(body))
            .await?;
        Ok(match status {
            202 => Collected::Waiting,
            // Signed in means the API set a cookie, which the session is in.
            200 if !self.saved_cookies().is_empty() => Collected::SignedIn,
            200 => Collected::Ended(String::from(
                "api.myfi.ws answered with something unexpected.",
            )),
            _ => Collected::Ended(failure(status, &text, "The sign-in ended.")),
        })
    }

    /// The account the app is signed in to, or None when the API no longer accepts its session.
    pub async fn account(&self) -> Result<Option<MyFiAccount>, String> {
        let (status, text) = self.send(reqwest::Method::GET, "app/account", None).await?;
        match status {
            200 => serde_json::from_str(&text)
                .map(Some)
                .map_err(|_| String::from("api.myfi.ws answered with something unexpected.")),
            401 => Ok(None),
            _ => Err(failure(status, &text, "Your account could not be read.")),
        }
    }

    pub async fn sign_out(&self) -> Result<(), String> {
        let (status, text) = self
            .send(
                reqwest::Method::POST,
                "user/signout",
                Some(serde_json::json!({})),
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

pub(crate) fn api() -> Result<MyFiApi, String> {
    MyFiApi::new(API)
}

/// The signed-in account, or None when signed out. A session the API no longer accepts is forgotten.
#[tauri::command]
pub(crate) async fn myfi_account() -> Result<Option<MyFiStatus>, String> {
    let Some(mut stored) = read_stored().await else {
        return Ok(None);
    };
    let api = MyFiApi::signed_in(API, &stored.cookies)?;
    match api.account().await {
        Ok(Some(account)) => {
            // The API renews the cookie as it is used, so what it set last is what is kept.
            let cookies = api.saved_cookies();
            if stored.account.as_ref() != Some(&account) || stored.cookies != cookies {
                stored.account = Some(account.clone());
                stored.cookies = cookies;
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
pub(crate) async fn myfi_sign_in_start() -> Result<SignInStarted, String> {
    let (secret, challenge) = new_secret();
    let name = computer_name(sysinfo::System::host_name().ok());
    let started = api()?.start(&challenge, &name).await?;
    let url = sign_in_page_url(&started.request)?;
    SIGN_INS.begin(
        started.request,
        secret,
        Duration::from_secs(started.expires_in.min(3600)),
    )?;
    // The dialog shows the page's address when the browser doesn't open, so that is not the end of it.
    let opened = crate::services::browser::open_in_browser(&url)
        .await
        .is_ok();
    Ok(SignInStarted {
        code: started.code,
        url,
        opened,
    })
}

/// Waits for the user to approve the sign-in, then saves the cookies the API set. None when it was cancelled or
/// replaced by a new sign-in. A refusal or expiry is an error with the reason.
#[tauri::command]
pub(crate) async fn myfi_sign_in_wait() -> Result<Option<MyFiStatus>, String> {
    let api = api()?;
    if !SIGN_INS.wait(&api, POLL).await? {
        return Ok(None);
    }
    let account = api.account().await.ok().flatten();
    write_stored(StoredSignIn {
        cookies: api.saved_cookies(),
        account: account.clone(),
    })
    .await?;
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

/// Ends the session with the API, when it can be reached, and forgets the cookies here either way.
#[tauri::command]
pub(crate) async fn myfi_sign_out() -> Result<(), String> {
    if let Some(stored) = read_stored().await
        && let Ok(api) = MyFiApi::signed_in(API, &stored.cookies)
    {
        let _ = api.sign_out().await;
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

    /// CI runs this before every release, so Task Proxy never ships without its key, as it once did: every sign-in
    /// then failed with "Unknown app".
    #[test]
    fn the_app_key_is_set() {
        let key = uuid::Uuid::parse_str(APP_KEY).expect("APP_KEY is a UUID");
        assert!(
            !key.is_nil(),
            "set APP_KEY to the key from the Stoic Dreams company's Apps page"
        );
    }

    /// A request the fake API received: its first line, headers in lowercase, and body.
    #[derive(Debug)]
    pub(crate) struct Received {
        pub line: String,
        pub headers: HashMap<String, String>,
        pub body: String,
    }

    /// One answer from the fake API: its status, body, and a Set-Cookie header when it sets one.
    pub(crate) struct Answer(u16, String, Option<String>);

    impl From<(u16, &str)> for Answer {
        fn from((status, body): (u16, &str)) -> Self {
            Answer(status, body.into(), None)
        }
    }

    impl From<(u16, &str, &str)> for Answer {
        fn from((status, body, cookie): (u16, &str, &str)) -> Self {
            Answer(status, body.into(), Some(cookie.into()))
        }
    }

    /// An API that answers each connection with the next of `answers`, and reports what it received.
    pub(crate) fn fake_api<A: Into<Answer>>(answers: Vec<A>) -> (String, mpsc::Receiver<Received>) {
        let answers: Vec<Answer> = answers.into_iter().map(Into::into).collect();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for Answer(status, body, cookie) in answers {
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
                let set_cookie = cookie
                    .map(|cookie| format!("Set-Cookie: {}\r\n", cookie))
                    .unwrap_or_default();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {} X\r\n{}Content-Length: {}\r\nConnection: close\r\n\r\n{}",
                    status,
                    set_cookie,
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
        assert!(!request.headers.contains_key("cookie"));
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
    async fn collect_waits_then_keeps_the_session_cookie_the_api_sets() {
        let (base, received) = fake_api(vec![
            Answer::from((202, "Waiting for approval")),
            Answer::from(SIGNED_IN),
        ]);
        let api = MyFiApi::new(&base).unwrap();
        assert_eq!(
            api.collect("req", "secret").await.unwrap(),
            Collected::Waiting
        );
        assert!(api.saved_cookies().is_empty());
        assert_eq!(
            api.collect("req", "secret").await.unwrap(),
            Collected::SignedIn
        );
        // Kept as the API sent it, without its attributes, to send back and to save.
        assert_eq!(
            api.saved_cookies(),
            vec![String::from("__Host-myfi-session=token-1")]
        );
        let first = received.recv().unwrap();
        assert_eq!(first.line, "POST /user/signin/app/collect HTTP/1.1");
        assert_eq!(
            body_of(&first),
            serde_json::json!({ "request": "req", "secret": "secret" })
        );
    }

    #[tokio::test]
    async fn collect_without_a_cookie_is_not_signed_in() {
        let (base, _received) = fake_api(vec![(200, r#"{"expiresIn":7776000}"#)]);
        assert!(matches!(
            MyFiApi::new(&base)
                .unwrap()
                .collect("r", "s")
                .await
                .unwrap(),
            Collected::Ended(_)
        ));
    }

    #[tokio::test]
    async fn collect_ends_with_the_reason_for_a_refusal_or_expiry() {
        let (base, _received) = fake_api(vec![
            (
                400,
                "This sign-in has expired or was refused. Start signing in again.",
            ),
            (403, "This sign-in was started by another app."),
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
    }

    #[tokio::test]
    async fn account_sends_the_saved_cookie_and_keeps_the_one_the_api_renews() {
        let (base, received) = fake_api(vec![
            Answer::from((
                200,
                r#"{"id":1,"displayName":"Test User"}"#,
                "__Host-myfi-session=token-2; Path=/; Secure; HttpOnly; Max-Age=1800",
            )),
            Answer::from((401, "")),
        ]);
        let api =
            MyFiApi::signed_in(&base, &[String::from("__Host-myfi-session=token-1")]).unwrap();
        let account = api.account().await.unwrap().unwrap();
        assert_eq!(
            account,
            MyFiAccount {
                id: 1,
                display_name: String::from("Test User")
            }
        );
        let request = received.recv().unwrap();
        assert_eq!(request.line, "GET /app/account HTTP/1.1");
        assert_eq!(request.headers["cookie"], "__Host-myfi-session=token-1");
        assert_eq!(request.headers["x-app"], APP_KEY);
        assert!(!request.headers.contains_key("x-auth"));
        assert_eq!(
            api.saved_cookies(),
            vec![String::from("__Host-myfi-session=token-2")]
        );
        // A session the API refuses means signed out, not an error, and the next call sends the renewed cookie.
        assert_eq!(api.account().await.unwrap(), None);
        assert_eq!(
            received.recv().unwrap().headers["cookie"],
            "__Host-myfi-session=token-2"
        );
    }

    #[tokio::test]
    async fn sign_out_sends_the_cookie_and_a_cookie_the_api_ends_is_dropped() {
        let (base, received) = fake_api(vec![Answer::from((
            200,
            "Signout Successful",
            "__Host-myfi-session=gone; Max-Age=0",
        ))]);
        let api =
            MyFiApi::signed_in(&base, &[String::from("__Host-myfi-session=token-1")]).unwrap();
        api.sign_out().await.unwrap();
        let request = received.recv().unwrap();
        assert_eq!(request.line, "POST /user/signout HTTP/1.1");
        assert_eq!(request.headers["cookie"], "__Host-myfi-session=token-1");
        assert!(api.saved_cookies().is_empty());
    }

    #[tokio::test]
    async fn not_reaching_the_api_is_an_error() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let err = MyFiApi::new(&base).unwrap().account().await.unwrap_err();
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

    const COOKIE: &str = "__Host-myfi-session=token-1; Path=/; Secure; SameSite=None; HttpOnly; Max-Age=1800; Partitioned";
    const SIGNED_IN: (u16, &str, &str) = (200, r#"{"expiresIn":7776000}"#, COOKIE);
    const FAST: Duration = Duration::from_millis(10);

    fn unreachable_api() -> MyFiApi {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        MyFiApi::new(&base).unwrap()
    }

    #[tokio::test]
    async fn waiting_signs_in_once_the_user_approves() {
        let (base, received) = fake_api(vec![
            Answer::from((202, "Waiting")),
            Answer::from((202, "Waiting")),
            Answer::from(SIGNED_IN),
        ]);
        let sign_ins = SignIns::default();
        sign_ins
            .begin("req".into(), "secret".into(), Duration::from_secs(60))
            .unwrap();
        let api = MyFiApi::new(&base).unwrap();
        assert!(sign_ins.wait(&api, FAST).await.unwrap());
        assert_eq!(
            api.saved_cookies(),
            vec![String::from("__Host-myfi-session=token-1")]
        );
        assert_eq!(received.try_iter().count(), 3, "it asked until approved");
        assert!(
            !sign_ins
                .wait(&MyFiApi::new(&base).unwrap(), FAST)
                .await
                .unwrap(),
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
        assert!(!sign_ins.wait(&unreachable_api(), FAST).await.unwrap());
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
        assert!(!waiting.await.unwrap().unwrap());
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
        assert!(!waiting.await.unwrap().unwrap(), "the first wait stops");
        // The new one is still there to wait for.
        let (base, received) = fake_api(vec![Answer::from(SIGNED_IN)]);
        assert!(
            sign_ins
                .wait(&MyFiApi::new(&base).unwrap(), FAST)
                .await
                .unwrap()
        );
        assert_eq!(body_of(&received.recv().unwrap())["request"], "second");
    }

    #[tokio::test]
    async fn waiting_with_no_sign_in_started_returns_at_once() {
        assert!(
            !SignIns::default()
                .wait(&unreachable_api(), FAST)
                .await
                .unwrap()
        );
    }
}
