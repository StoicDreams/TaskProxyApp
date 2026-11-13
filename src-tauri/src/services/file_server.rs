//! A local HTTP server for the Git Controller's file preview, which streams files from the open project.
//!
//! Sending a file through a command means sending all of it as base64, which the window then decodes on its main
//! thread. For a video that froze the app and could run it out of memory. Here the webview asks for what it needs:
//! a video player asks for byte ranges as it plays, so even a large file loads a piece at a time.
//!
//! It is HTTP on 127.0.0.1 rather than a custom URI scheme, because WebKitGTK refuses to play media from a custom
//! scheme. Only this computer can connect, every address starts with a random token made at startup, and only files
//! inside the open project are served. The window gets the address from `get_file_server_base`.
use crate::prelude::*;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::OnceLock;
use tauri::http::{Response, StatusCode, header};

/// What a response sends: a short message, or part of a file, which is streamed from disk rather than read into
/// memory. A player's first request for a video usually asks for the whole file, and stops reading what it needs.
#[derive(Debug, PartialEq)]
pub(crate) enum Body {
    Bytes(Vec<u8>),
    File {
        path: PathBuf,
        start: u64,
        length: u64,
    },
}

/// The server's address and token, as `http://127.0.0.1:<port>/<token>`, once it has started.
static BASE: OnceLock<String> = OnceLock::new();

fn content_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mkv" => "video/x-matroska",
        "ogv" => "video/ogg",
        "avi" => "video/x-msvideo",
        "mpeg" | "mpg" => "video/mpeg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "aac" => "audio/aac",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        "pdf" => "application/pdf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

fn percent_decode(text: &str) -> Result<String, String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text
                .get(index + 1..index + 3)
                .and_then(|hex| u8::from_str_radix(hex, 16).ok())
                .ok_or_else(|| String::from("Invalid address"))?;
            out.push(hex);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| String::from("Invalid address"))
}

/// `bytes=start-end` or `bytes=start-` or `bytes=-suffix`, as an inclusive range within a file of `size` bytes.
fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    // Several ranges in one request are rare for media, so only the first is answered.
    let spec = spec.split(',').next()?.trim();
    let (start, end) = spec.split_once('-')?;
    if size == 0 {
        return None;
    }
    let (start, end) = if start.is_empty() {
        let suffix: u64 = end.parse().ok()?;
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            size - 1
        } else {
            end.parse::<u64>().ok()?.min(size - 1)
        };
        (start, end)
    };
    (start <= end && start < size).then_some((start, end))
}

fn error(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::CONTENT_LENGTH, message.len())
        .body(Body::Bytes(message.as_bytes().to_vec()))
        .unwrap_or_else(|_| Response::new(Body::Bytes(Vec::new())))
}

/// Answers a request for a file in the project at `root`. `path` is the address's path, still percent-encoded.
pub(crate) fn respond(
    root: Option<&Path>,
    method: &str,
    path: &str,
    range: Option<&str>,
) -> Response<Body> {
    let Some(root) = root else {
        return error(StatusCode::NOT_FOUND, "No project is open.");
    };
    if method != "GET" && method != "HEAD" {
        return error(StatusCode::METHOD_NOT_ALLOWED, "Only GET is supported.");
    }
    let relative = match percent_decode(path.trim_start_matches('/')) {
        Ok(relative) => relative,
        Err(message) => return error(StatusCode::BAD_REQUEST, &message),
    };
    let file = match project_file_path(root, &relative) {
        Ok(file) => file,
        Err(message) => return error(StatusCode::NOT_FOUND, &message),
    };
    let size = match fs::metadata(&file) {
        Ok(metadata) => metadata.len(),
        Err(err) => return error(StatusCode::NOT_FOUND, &err.to_string()),
    };
    let builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type(&file))
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        // The window's own origin differs by platform, and fetch from it is cross-origin here.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    let (status, start, length, builder) = match range {
        Some(range) => match parse_range(range, size) {
            Some((start, end)) => {
                let builder = builder.header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", start, end, size),
                );
                (StatusCode::PARTIAL_CONTENT, start, end - start + 1, builder)
            }
            None => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{}", size))
                    .header(header::CONTENT_LENGTH, 0)
                    .body(Body::Bytes(Vec::new()))
                    .unwrap_or_else(|_| Response::new(Body::Bytes(Vec::new())));
            }
        },
        None => (StatusCode::OK, 0, size, builder),
    };
    let body = if method == "HEAD" {
        Body::Bytes(Vec::new())
    } else {
        Body::File {
            path: file,
            start,
            length,
        }
    };
    builder
        .status(status)
        .header(header::CONTENT_LENGTH, length)
        .body(body)
        .unwrap_or_else(|_| Response::new(Body::Bytes(Vec::new())))
}

fn random_token() -> String {
    use rand::RngExt;
    let bytes: [u8; 24] = rand::rng().random();
    hex::encode(bytes)
}

/// Writes an HTTP/1.1 response and closes the connection. A file is copied from disk a piece at a time, and a
/// player that has what it needs simply closes the connection, which ends the copy.
fn write_response(stream: &mut TcpStream, response: Response<Body>) -> io::Result<()> {
    let status = response.status();
    let mut text = format!(
        "HTTP/1.1 {} {}\r\nConnection: close\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for (name, value) in response.headers() {
        text.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap_or("")));
    }
    text.push_str("\r\n");
    stream.write_all(text.as_bytes())?;
    match response.into_body() {
        Body::Bytes(bytes) => stream.write_all(&bytes)?,
        Body::File {
            path,
            start,
            length,
        } => {
            let mut file = fs::File::open(path)?;
            file.seek(SeekFrom::Start(start))?;
            io::copy(&mut file.take(length), stream)?;
        }
    }
    stream.flush()
}

/// Reads one request and answers it. Requests without the token are refused before anything is read from disk.
fn serve_connection(
    mut stream: TcpStream,
    token: &str,
    root: impl Fn() -> Option<PathBuf>,
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    let mut range = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.trim().eq_ignore_ascii_case("range")
        {
            range = Some(value.trim().to_string());
        }
    }
    let path = target.split(['?', '#']).next().unwrap_or("");
    let prefix = format!("/{}/", token);
    let response = match path.strip_prefix(&prefix) {
        Some(file) => respond(root().as_deref(), &method, file, range.as_deref()),
        None => error(StatusCode::NOT_FOUND, "Not found"),
    };
    write_response(&mut stream, response)
}

/// The open project's root folder.
fn open_project_root(app: &AppHandle) -> Option<PathBuf> {
    get_state_data::<ProjectData>(app)
        .ok()
        .filter(|project| !project.path.is_empty())
        .map(|project| PathBuf::from(project.path.replace('\\', "/")))
}

/// Starts the server on a free port. Each connection gets its own thread, since a video player opens several.
pub(crate) fn start(app: AppHandle) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|err| err.to_string())?;
    let port = listener.local_addr().map_err(|err| err.to_string())?.port();
    let token = random_token();
    let _ = BASE.set(format!("http://127.0.0.1:{}/{}", port, token));
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || {
                let _ = serve_connection(stream, &token, || open_project_root(&app));
            });
        }
    });
    Ok(())
}

/// The address files are served from, as `http://127.0.0.1:<port>/<token>`. Add a percent-encoded project path.
#[tauri::command]
pub(crate) fn get_file_server_base() -> Result<String, String> {
    BASE.get()
        .cloned()
        .ok_or_else(|| String::from("The file preview server did not start."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("media")).unwrap();
        fs::write(
            dir.path().join("media/clip one.mp4"),
            (0..=255u8).collect::<Vec<u8>>(),
        )
        .unwrap();
        dir
    }

    fn bytes(response: &Response<Body>) -> Vec<u8> {
        match response.body() {
            Body::Bytes(bytes) => bytes.clone(),
            Body::File {
                path,
                start,
                length,
            } => {
                let mut file = fs::File::open(path).unwrap();
                file.seek(SeekFrom::Start(*start)).unwrap();
                let mut out = Vec::new();
                file.take(*length).read_to_end(&mut out).unwrap();
                out
            }
        }
    }

    fn header_of(response: &Response<Body>, name: header::HeaderName) -> String {
        response
            .headers()
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
            .unwrap_or_default()
    }

    #[test]
    fn a_range_is_served_as_partial_content() {
        let dir = setup();
        let response = respond(
            Some(dir.path()),
            "GET",
            "/media%2Fclip%20one.mp4",
            Some("bytes=10-19"),
        );
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(bytes(&response), (10..=19u8).collect::<Vec<u8>>());
        assert_eq!(
            header_of(&response, header::CONTENT_RANGE),
            "bytes 10-19/256"
        );
        assert_eq!(header_of(&response, header::CONTENT_TYPE), "video/mp4");
        assert_eq!(header_of(&response, header::ACCEPT_RANGES), "bytes");
        let open = respond(
            Some(dir.path()),
            "GET",
            "/media/clip%20one.mp4",
            Some("bytes=250-"),
        );
        assert_eq!(bytes(&open), (250..=255u8).collect::<Vec<u8>>());
        let suffix = respond(
            Some(dir.path()),
            "GET",
            "/media/clip%20one.mp4",
            Some("bytes=-4"),
        );
        assert_eq!(
            header_of(&suffix, header::CONTENT_RANGE),
            "bytes 252-255/256"
        );
    }

    #[test]
    fn without_a_range_the_whole_file_is_sent() {
        let dir = setup();
        let response = respond(Some(dir.path()), "GET", "/media/clip%20one.mp4", None);
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(bytes(&response).len(), 256);
        assert_eq!(header_of(&response, header::CONTENT_LENGTH), "256");
    }

    #[test]
    fn a_large_file_is_streamed_rather_than_read_into_memory() {
        let dir = setup();
        let file = fs::File::create(dir.path().join("big.mp4")).unwrap();
        file.set_len(3 * 1024 * 1024 * 1024).unwrap();
        let whole = respond(Some(dir.path()), "GET", "/big.mp4", None);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(
            header_of(&whole, header::CONTENT_LENGTH),
            (3u64 * 1024 * 1024 * 1024).to_string()
        );
        assert!(matches!(whole.body(), Body::File { start: 0, .. }));
        let rest = respond(Some(dir.path()), "GET", "/big.mp4", Some("bytes=1000-"));
        assert!(matches!(rest.body(), Body::File { start: 1000, .. }));
    }

    #[test]
    fn ranges_past_the_end_are_refused() {
        let dir = setup();
        let response = respond(
            Some(dir.path()),
            "GET",
            "/media/clip%20one.mp4",
            Some("bytes=300-"),
        );
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(header_of(&response, header::CONTENT_RANGE), "bytes */256");
    }

    #[test]
    fn only_files_in_the_open_project_are_served() {
        let dir = setup();
        fs::write(dir.path().parent().unwrap().join("secret.txt"), "no").ok();
        for path in [
            "/..%2Fsecret.txt",
            "/../secret.txt",
            "/media",
            "/missing.mp4",
            "/%2Fetc%2Fpasswd",
            "/bad%zz",
        ] {
            let status = respond(Some(dir.path()), "GET", path, None).status();
            assert!(status.is_client_error(), "{} -> {}", path, status);
        }
        assert_eq!(
            respond(None, "GET", "/media/clip%20one.mp4", None).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            respond(Some(dir.path()), "POST", "/media/clip%20one.mp4", None).status(),
            StatusCode::METHOD_NOT_ALLOWED
        );
    }

    fn start_test_server(root: PathBuf) -> (u16, String) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = random_token();
        let server_token = token.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let root = root.clone();
                let token = server_token.clone();
                std::thread::spawn(move || serve_connection(stream, &token, || Some(root.clone())));
            }
        });
        (port, token)
    }

    fn get(port: u16, path: &str, range: Option<&str>) -> (String, Vec<u8>) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let range = range
            .map(|range| format!("Range: {}\r\n", range))
            .unwrap_or_default();
        write!(
            stream,
            "GET {} HTTP/1.1\r\nHost: 127.0.0.1\r\n{}\r\n",
            path, range
        )
        .unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = response
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .unwrap();
        (
            String::from_utf8_lossy(&response[..split]).to_string(),
            response[split + 4..].to_vec(),
        )
    }

    #[test]
    fn the_server_streams_ranges_and_needs_its_token() {
        let dir = setup();
        let (port, token) = start_test_server(dir.path().to_path_buf());
        let (head, body) = get(
            port,
            &format!("/{}/media%2Fclip%20one.mp4", token),
            Some("bytes=0-3"),
        );
        assert!(head.starts_with("HTTP/1.1 206"), "{}", head);
        assert!(head.contains("content-range: bytes 0-3/256"), "{}", head);
        assert_eq!(body, vec![0, 1, 2, 3]);
        let (head, body) = get(port, "/media%2Fclip%20one.mp4", None);
        assert!(head.starts_with("HTTP/1.1 404"), "{}", head);
        assert_eq!(body, b"Not found");
        let (head, _) = get(port, &format!("/{}x/media%2Fclip%20one.mp4", token), None);
        assert!(head.starts_with("HTTP/1.1 404"), "{}", head);
    }

    #[test]
    fn tokens_are_long_and_random() {
        let (a, b) = (random_token(), random_token());
        assert_eq!(a.len(), 48);
        assert_ne!(a, b);
    }

    #[test]
    fn head_answers_without_a_body() {
        let dir = setup();
        let response = respond(Some(dir.path()), "HEAD", "/media/clip%20one.mp4", None);
        assert_eq!(response.status(), StatusCode::OK);
        assert!(bytes(&response).is_empty());
        assert_eq!(header_of(&response, header::CONTENT_LENGTH), "256");
    }
}

#[cfg(test)]
mod manual {
    use super::*;

    /// Serves FILE_SERVER_ROOT for three minutes and prints its address, to try the real server in a real webview.
    /// Run with: FILE_SERVER_ROOT=<folder> cargo test -p taskproxy -- --ignored --nocapture serve_a_folder
    #[test]
    #[ignore = "manual check with a webview"]
    fn serve_a_folder() {
        let root = PathBuf::from(std::env::var("FILE_SERVER_ROOT").expect("set FILE_SERVER_ROOT"));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = random_token();
        println!("SERVING http://127.0.0.1:{}/{}", port, token);
        let started = std::time::Instant::now();
        listener.set_nonblocking(true).unwrap();
        while started.elapsed() < Duration::from_secs(180) {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).unwrap();
                    let (root, token) = (root.clone(), token.clone());
                    std::thread::spawn(move || serve_connection(stream, &token, || Some(root.clone())));
                }
                Err(_) => std::thread::sleep(Duration::from_millis(20)),
            }
        }
    }
}
