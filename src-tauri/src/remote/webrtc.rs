//! This computer's side of a WebRTC connection to a browser, with `str0m`.
//!
//! `str0m` does no I/O itself. This binds one UDP socket for each of the computer's local addresses, so it knows
//! which address each packet arrived on, asks the STUN server what public address each socket has, offers all of
//! those addresses in its answer, and runs the connection: packets in and out, timers, and the data channel.
//!
//! There is one offer and one answer, with no later exchange of addresses, so every address goes into the answer's
//! SDP. Each message on the data channel is a frame of the protocol in `protocol.rs`. WebRTC encrypts the
//! connection, and the signed offer and answer (`signal.rs`) tie its certificates to the two keys.

use super::protocol::{Assembler, BrowserMessage, DesktopMessage, MAX_BROWSER_MESSAGE, split};
use super::stun;
use crate::prelude::*;
use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};
use std::time::Instant;
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc::{self, UnboundedReceiver};

/// The data channel a browser opens.
pub(crate) const CHANNEL: &str = "taskproxy";
/// How long a browser has, from its offer, for the data channel to open. The browser gives up after the same time.
const OPEN_WITHIN: Duration = Duration::from_secs(30);
/// A browser pings every 15 seconds, so one not heard from for this long is gone.
const SILENT_FOR: Duration = Duration::from_secs(45);
const MAX_DATAGRAM: usize = 2000;
/// Frames waiting for room in the data channel. While this many wait, no more messages are taken to send.
const MAX_WAITING_FRAMES: usize = 256;
/// How soon to try again when the data channel had no room for a frame.
const RETRY_WRITE: Duration = Duration::from_millis(5);

/// What a connection does in the app, so the loop can run without a window in tests.
pub(crate) trait Hooks: Send + 'static {
    /// The data channel opened. Returns the connection's id, and what to send the browser.
    fn open(&mut self, route: &str) -> (u64, UnboundedReceiver<DesktopMessage>);
    /// A message from the browser.
    fn message(&mut self, id: u64, message: BrowserMessage);
    /// The connection ended. `id` is None when the channel never opened.
    fn closed(&mut self, id: Option<u64>, reason: &str);
}

/// The computer's own addresses: every interface's IPv4 address except loopback. A browser on the same network or
/// VPN reaches these directly, and each one's public address comes from the STUN server.
pub(crate) fn local_addresses() -> Vec<IpAddr> {
    let Ok(networks) = sysinfo::Networks::new_with_refreshed_list() else {
        return Vec::new();
    };
    let mut addresses: Vec<IpAddr> = networks
        .values()
        .flat_map(|data| data.ip_networks().iter().map(|network| network.addr))
        .filter(|addr| matches!(addr, IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_unspecified() && !v4.is_link_local()))
        .collect();
    addresses.sort();
    addresses.dedup();
    addresses
}

/// A connection this computer answered, waiting for the browser to reach it.
pub(crate) struct Answered {
    rtc: Rtc,
    sockets: Vec<Arc<UdpSocket>>,
    /// The answer's SDP to send the browser.
    pub answer: String,
}

/// Answers a browser's offer, offering a socket on each of `addresses`, and beside each the public address `stun`
/// (the STUN server) sees it at. Each socket asks the server once.
pub(crate) async fn answer_offer(
    offer: &str,
    addresses: &[IpAddr],
    stun: Option<SocketAddr>,
) -> Result<Answered, String> {
    if addresses.is_empty() {
        return Err(String::from(
            "This computer has no network address a browser can reach.",
        ));
    }
    let offer = SdpOffer::from_sdp_string(offer)
        .map_err(|err| format!("The browser's offer could not be read: {}", err))?;
    let mut rtc = Rtc::builder()
        .set_stats_interval(None)
        .build(Instant::now());
    let mut sockets = Vec::new();
    for address in addresses {
        let Ok(socket) = UdpSocket::bind(SocketAddr::new(*address, 0)).await else {
            continue;
        };
        let Ok(local) = socket.local_addr() else {
            continue;
        };
        if let Ok(candidate) = Candidate::host(local, "udp") {
            rtc.add_local_candidate(candidate);
            sockets.push(Arc::new(socket));
        }
    }
    if sockets.is_empty() {
        return Err(String::from(
            "No network address on this computer could take a connection.",
        ));
    }
    if let Some(server) = stun {
        // Every socket asks at the same time, so the answer waits for the slowest one, not for each in turn.
        let asking: Vec<_> = sockets
            .iter()
            .map(|socket| {
                let socket = socket.clone();
                tokio::spawn(async move {
                    let local = socket.local_addr().ok()?;
                    let public = stun::public_address(&socket, server, stun::WAIT).await?;
                    Some((public, local))
                })
            })
            .collect();
        for asked in asking {
            // A socket whose public address is its own has no router in the way, and is offered already.
            if let Ok(Some((public, local))) = asked.await
                && public != local
                && let Ok(candidate) = Candidate::server_reflexive(public, local, "udp")
            {
                rtc.add_local_candidate(candidate);
            }
        }
    }
    let answer = rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|err| format!("The browser's offer could not be answered: {}", err))?;
    Ok(Answered {
        rtc,
        sockets,
        answer: answer.to_sdp_string(),
    })
}

/// How a connection reached this computer, shown with its browser.
pub(crate) fn route(local: SocketAddr, remote: SocketAddr) -> &'static str {
    if is_local(local.ip()) && is_local(remote.ip()) {
        "Direct (same network)"
    } else {
        "Direct (internet)"
    }
}

/// An address on a private network: a home or office network, a VPN such as Tailscale, or this computer.
pub(crate) fn is_local(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let [a, b, ..] = ip.octets();
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                // 100.64.0.0/10, which Tailscale and carrier-grade NAT use.
                || (a == 100 && (64..128).contains(&b))
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            ip.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// A packet that arrived: its bytes, who sent it, and the local address it arrived on.
type Packet = (Vec<u8>, SocketAddr, SocketAddr);

/// Writes the frames waiting to the data channel, for as long as it has room. A frame it has no room for stays
/// first in line, since frames must arrive in order.
fn write_waiting(
    rtc: &mut Rtc,
    id: ChannelId,
    waiting: &mut VecDeque<Vec<u8>>,
) -> Result<(), String> {
    while let Some(frame) = waiting.front() {
        let mut data_channel = rtc
            .channel(id)
            .ok_or_else(|| String::from("The data channel closed."))?;
        if !data_channel
            .write(true, frame)
            .map_err(|err| err.to_string())?
        {
            break;
        }
        waiting.pop_front();
    }
    Ok(())
}

/// Runs a connection until it ends: the browser leaves or goes silent, this computer drops it, or it never opens.
pub(crate) async fn serve(answered: Answered, mut hooks: impl Hooks) {
    let Answered {
        mut rtc, sockets, ..
    } = answered;
    let (packets, mut incoming) = mpsc::channel::<Packet>(256);
    let mut readers = Vec::new();
    for socket in &sockets {
        let socket = socket.clone();
        let packets = packets.clone();
        readers.push(tokio::spawn(async move {
            let Ok(local) = socket.local_addr() else {
                return;
            };
            let mut buffer = vec![0u8; MAX_DATAGRAM];
            while let Ok((len, from)) = socket.recv_from(&mut buffer).await {
                if packets
                    .send((buffer[..len].to_vec(), from, local))
                    .await
                    .is_err()
                {
                    return;
                }
            }
        }));
    }
    drop(packets);

    let started = Instant::now();
    let mut heard = Instant::now();
    let mut open: Option<(u64, UnboundedReceiver<DesktopMessage>, ChannelId)> = None;
    let mut remote_addr: Option<(SocketAddr, SocketAddr)> = None;
    let mut assembler = Assembler::new(MAX_BROWSER_MESSAGE);
    let mut waiting: VecDeque<Vec<u8>> = VecDeque::new();
    let reason = loop {
        if let Some((_, _, id)) = &open
            && let Err(reason) = write_waiting(&mut rtc, *id, &mut waiting)
        {
            break reason;
        }
        // Everything str0m has to send or say, until it next needs time to pass.
        let wait_until = loop {
            match rtc.poll_output() {
                Ok(Output::Timeout(at)) => break Ok(at),
                Ok(Output::Transmit(transmit)) => {
                    if open.is_none() {
                        remote_addr = Some((transmit.source, transmit.destination));
                    }
                    if let Some(socket) = sockets.iter().find(|socket| {
                        socket
                            .local_addr()
                            .is_ok_and(|local| local == transmit.source)
                    }) {
                        let _ = socket
                            .send_to(&transmit.contents, transmit.destination)
                            .await;
                    }
                }
                Ok(Output::Event(Event::ChannelOpen(id, label)))
                    if open.is_none() && label == CHANNEL =>
                {
                    let route = remote_addr
                        .map(|(local, remote)| route(local, remote))
                        .unwrap_or("Direct (same network)");
                    let (connection, outgoing) = hooks.open(route);
                    heard = Instant::now();
                    open = Some((connection, outgoing, id));
                }
                Ok(Output::Event(Event::ChannelData(data))) => {
                    let Some((connection, _, id)) = &open else {
                        continue;
                    };
                    if data.id != *id {
                        continue;
                    }
                    heard = Instant::now();
                    if !data.binary {
                        break Err(String::from("The browser sent text where a frame belongs."));
                    }
                    match assembler.push(&data.data) {
                        Ok(Some(bytes)) => match serde_json::from_slice::<BrowserMessage>(&bytes) {
                            Ok(message) => hooks.message(*connection, message),
                            Err(_) => {
                                break Err(String::from(
                                    "The browser sent a message that isn't one.",
                                ));
                            }
                        },
                        Ok(None) => {}
                        Err(err) => break Err(err),
                    }
                }
                Ok(Output::Event(Event::ChannelClose(id)))
                    if open.as_ref().is_some_and(|(_, _, open)| *open == id) =>
                {
                    break Err(String::from("The browser closed the connection."));
                }
                Ok(Output::Event(Event::IceConnectionStateChange(
                    IceConnectionState::Disconnected,
                ))) => {
                    break Err(String::from("The browser's network went away."));
                }
                Ok(Output::Event(_)) => {}
                Err(err) => break Err(err.to_string()),
            }
        };
        let wait_until = match wait_until {
            Ok(at) => at,
            Err(reason) => break reason,
        };
        if open.is_none() && started.elapsed() > OPEN_WITHIN {
            break String::from(
                "The browser didn't reach this computer. The two networks may not allow a direct connection.",
            );
        }
        if open.is_some() && heard.elapsed() > SILENT_FOR {
            break String::from("The browser stopped answering.");
        }
        // Frames still waiting are tried again shortly, once str0m has sent what it holds.
        let longest = if waiting.is_empty() {
            Duration::from_secs(1)
        } else {
            RETRY_WRITE
        };
        let sleep_until = tokio::time::Instant::from_std(wait_until.min(Instant::now() + longest));
        let has_room = waiting.len() < MAX_WAITING_FRAMES;
        let outgoing = async {
            match open.as_mut() {
                Some((_, outgoing, _)) if has_room => outgoing.recv().await,
                _ => std::future::pending().await,
            }
        };
        tokio::select! {
            packet = incoming.recv() => {
                let Some((bytes, from, local)) = packet else {
                    break String::from("The network sockets closed.");
                };
                if let Ok(receive) = Receive::new(Protocol::Udp, from, local, &bytes) {
                    let _ = rtc.handle_input(Input::Receive(Instant::now(), receive));
                }
            }
            message = outgoing => {
                let Some(message) = message else {
                    break String::from("This computer ended the connection.");
                };
                match serde_json::to_vec(&message) {
                    Ok(bytes) => waiting.extend(split(&bytes)),
                    Err(err) => break err.to_string(),
                }
            }
            _ = tokio::time::sleep_until(sleep_until) => {
                let _ = rtc.handle_input(Input::Timeout(Instant::now()));
            }
        }
    };
    rtc.disconnect();
    for reader in readers {
        reader.abort();
    }
    hooks.closed(open.map(|(id, ..)| id), &reason);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote::Remote;
    use crate::remote::browsers::Level;
    use crate::remote::dispatch::Caller;
    use crate::remote::protocol::VERSION;
    use serde_json::json;
    use std::net::Ipv4Addr;
    use tokio::sync::mpsc::UnboundedSender;

    const BIG: usize = 3 * 1024 * 1024;

    /// The app's side of a connection, with commands answered by the test instead of dispatched.
    struct TestHooks {
        remote: Arc<Remote>,
        caller: Caller,
        events: UnboundedSender<String>,
    }

    impl Hooks for TestHooks {
        fn open(&mut self, route: &str) -> (u64, UnboundedReceiver<DesktopMessage>) {
            let _ = self.events.send(format!("open {}", route));
            self.remote.open(self.caller.clone())
        }
        fn message(&mut self, id: u64, message: BrowserMessage) {
            if let Some(command) = self.remote.handle(id, message) {
                let answer = match command.cmd.as_str() {
                    // As large as a file the app sends, in many frames.
                    "big" => json!("x".repeat(BIG)),
                    "echo" => command.args.clone(),
                    cmd => json!(format!("ran {}", cmd)),
                };
                self.remote.finish(id, &command, Ok(answer));
            }
        }
        fn closed(&mut self, id: Option<u64>, reason: &str) {
            if let Some(id) = id {
                self.remote.close(id);
            }
            let _ = self.events.send(format!("closed {}", reason));
        }
    }

    fn hooks(remote: &Arc<Remote>, events: UnboundedSender<String>) -> TestHooks {
        TestHooks {
            remote: remote.clone(),
            caller: Caller {
                key: "browser-key".into(),
                name: "Firefox".into(),
                level: Level::Work,
            },
            events,
        }
    }

    /// A browser's side: a WebRTC peer, as a page on www.taskproxy.com is, over real UDP on this computer.
    struct Browser {
        rtc: Rtc,
        socket: UdpSocket,
        assembler: Assembler,
        data: Option<ChannelId>,
        pending: Option<str0m::change::SdpPendingOffer>,
        /// Frames waiting for room in the data channel.
        waiting: VecDeque<Vec<u8>>,
    }

    impl Browser {
        async fn new(label: &str) -> (Self, String) {
            let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let mut rtc = Rtc::builder()
                .set_stats_interval(None)
                .build(Instant::now());
            rtc.add_local_candidate(Candidate::host(socket.local_addr().unwrap(), "udp").unwrap());
            let mut change = rtc.sdp_api();
            change.add_channel(label.into());
            let (offer, pending) = change.apply().unwrap();
            let browser = Self {
                rtc,
                socket,
                assembler: Assembler::new(usize::MAX),
                data: None,
                pending: Some(pending),
                waiting: VecDeque::new(),
            };
            (browser, offer.to_sdp_string())
        }

        fn accept(&mut self, answer: &str) {
            let answer = str0m::change::SdpAnswer::from_sdp_string(answer).unwrap();
            self.rtc
                .sdp_api()
                .accept_answer(self.pending.take().unwrap(), answer)
                .unwrap();
        }

        /// Runs the browser until `until` is true of a message from the computer (None when the channel opens), or
        /// `within` passes, or the connection fails.
        async fn run(
            &mut self,
            within: Duration,
            mut until: impl FnMut(&mut Self, Option<Value>) -> bool,
        ) -> bool {
            let started = Instant::now();
            let mut buffer = vec![0u8; MAX_DATAGRAM];
            while started.elapsed() < within {
                if let Some(id) = self.data {
                    write_waiting(&mut self.rtc, id, &mut self.waiting).unwrap();
                }
                let wait = loop {
                    let Ok(output) = self.rtc.poll_output() else {
                        return false;
                    };
                    match output {
                        Output::Timeout(at) => break at,
                        Output::Transmit(t) => {
                            let _ = self.socket.send_to(&t.contents, t.destination).await;
                        }
                        Output::Event(Event::ChannelOpen(id, _)) => {
                            self.data = Some(id);
                            if until(self, None) {
                                return true;
                            }
                        }
                        Output::Event(Event::ChannelData(data)) => {
                            assert!(data.binary, "every frame is binary");
                            assert!(data.data.len() <= 16 * 1024, "a frame is at most 16 KB");
                            if let Some(bytes) = self.assembler.push(&data.data).unwrap()
                                && until(self, Some(serde_json::from_slice(&bytes).unwrap()))
                            {
                                return true;
                            }
                        }
                        Output::Event(_) => {}
                    }
                };
                let wait = wait.min(Instant::now() + Duration::from_millis(5));
                let local = self.socket.local_addr().unwrap();
                tokio::select! {
                    received = self.socket.recv_from(&mut buffer) => {
                        let (len, from) = received.unwrap();
                        let receive = Receive::new(Protocol::Udp, from, local, &buffer[..len]).unwrap();
                        if self.rtc.handle_input(Input::Receive(Instant::now(), receive)).is_err() {
                            return false;
                        }
                    }
                    _ = tokio::time::sleep_until(tokio::time::Instant::from_std(wait)) => {
                        if self.rtc.handle_input(Input::Timeout(Instant::now())).is_err() {
                            return false;
                        }
                    }
                }
            }
            false
        }

        fn send(&mut self, message: Value) {
            self.waiting.extend(split(message.to_string().as_bytes()));
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_browser_connects_over_webrtc_and_runs_commands_in_frames() {
        let (mut browser, offer) = Browser::new(CHANNEL).await;
        let answered = answer_offer(&offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)], None)
            .await
            .unwrap();
        browser.accept(&answered.answer);

        let remote = Arc::new(Remote::default());
        let (events, mut seen) = mpsc::unbounded_channel();
        let desk = tokio::spawn(serve(answered, hooks(&remote, events)));

        // Once the channel opens, the browser says hello and runs commands, each message split into frames.
        let sent = "é".repeat(40_000);
        let mut replies = Vec::new();
        let done = browser
            .run(Duration::from_secs(60), |browser, message| {
                match message {
                    None => {
                        browser.send(json!({ "hello": { "version": VERSION } }));
                        browser.send(json!({ "id": 1, "cmd": "get_runs", "args": {} }));
                        browser.send(json!({ "id": 2, "cmd": "echo", "args": { "text": sent } }));
                        browser.send(json!({ "id": 3, "cmd": "big" }));
                        browser.send(json!({ "ping": 5 }));
                    }
                    Some(message) => replies.push(message),
                }
                replies.len() == 5
            })
            .await;
        assert!(done, "the browser heard back {} times", replies.len());
        assert_eq!(replies[0], json!({ "hello": { "version": 2 } }));
        assert_eq!(
            replies[1],
            json!({ "id": 1, "ok": true, "value": "ran get_runs" })
        );
        assert_eq!(
            replies[2],
            json!({ "id": 2, "ok": true, "value": { "text": sent } }),
            "a message of several frames arrives whole"
        );
        assert_eq!(replies[3]["id"], 3);
        assert_eq!(
            replies[3]["value"].as_str().map(str::len),
            Some(BIG),
            "a reply far larger than the channel's buffer arrives whole and in order"
        );
        assert_eq!(replies[4], json!({ "pong": 5 }));
        assert_eq!(seen.recv().await.unwrap(), "open Direct (same network)");
        assert!(remote.has_connections());
        assert_eq!(remote.log.lock().unwrap().latest().len(), 3);

        // Removing the browser ends its connection.
        remote.disconnect_browser("browser-key");
        let closed = tokio::time::timeout(Duration::from_secs(10), seen.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed, "closed This computer ended the connection.");
        desk.await.unwrap();
        assert!(!remote.has_connections());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_channel_by_another_name_is_not_served() {
        let (mut browser, offer) = Browser::new("something-else").await;
        let answered = answer_offer(&offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)], None)
            .await
            .unwrap();
        browser.accept(&answered.answer);
        let remote = Arc::new(Remote::default());
        let (events, mut seen) = mpsc::unbounded_channel();
        let desk = tokio::spawn(serve(answered, hooks(&remote, events)));
        // The browser's channel opens on its side, and nothing it sends there is answered.
        let opened = browser
            .run(Duration::from_secs(20), |browser, message| {
                if message.is_none() {
                    browser.send(json!({ "hello": { "version": VERSION } }));
                }
                true
            })
            .await;
        assert!(opened);
        let heard = browser
            .run(Duration::from_millis(500), |_, message| message.is_some())
            .await;
        assert!(!heard);
        assert!(seen.try_recv().is_err(), "the app was never told of it");
        assert!(!remote.has_connections());
        desk.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_answer_with_a_swapped_dtls_fingerprint_never_connects() {
        // Someone between the two swaps this computer's fingerprint for their own. The answer's signature covers
        // its SDP, so a browser refuses this before connecting, and even without that its DTLS refuses this
        // computer's real certificate.
        let (mut browser, offer) = Browser::new(CHANNEL).await;
        let answered = answer_offer(&offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)], None)
            .await
            .unwrap();
        let swapped = answered
            .answer
            .lines()
            .map(|line| match line.strip_prefix("a=fingerprint:sha-256 ") {
                Some(fingerprint) => format!(
                    "a=fingerprint:sha-256 {}",
                    fingerprint.chars().rev().collect::<String>()
                ),
                None => line.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\r\n")
            + "\r\n";
        assert_ne!(
            swapped, answered.answer,
            "the answer has a fingerprint to swap"
        );
        browser.accept(&swapped);
        let (events, _seen) = mpsc::unbounded_channel();
        let desk = tokio::spawn(serve(answered, hooks(&Arc::new(Remote::default()), events)));
        let opened = browser.run(Duration::from_secs(8), |_, _| true).await;
        assert!(!opened, "the data channel never opened");
        desk.abort();
    }

    /// A data channel offer from Chromium, as www.taskproxy.com's page makes it. Browsers name their local addresses
    /// with random `.local` hostnames rather than the address itself, and may have none at all.
    const CHROMIUM_OFFER: &str = "v=0\r\no=- 391879584622361032 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n\
        a=group:BUNDLE 0\r\na=extmap-allow-mixed\r\na=msid-semantic: WMS\r\n\
        m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n\
        a=ice-ufrag:RFpp\r\na=ice-pwd:4uqvs2DiTAWhcFeHjTPu9sHz\r\na=ice-options:trickle\r\n\
        a=fingerprint:sha-256 C0:7B:00:5C:E4:3F:FD:71:D2:AC:8E:13:53:30:99:6A:69:6C:BF:CC:1A:98:CA:72:89:28:3F:61:7B:FE:71:06\r\n\
        a=setup:actpass\r\na=mid:0\r\na=sctp-port:5000\r\na=max-message-size:262144\r\n";

    #[tokio::test]
    async fn a_browsers_offer_is_answered_with_this_computers_addresses() {
        let answered = answer_offer(CHROMIUM_OFFER, &[IpAddr::V4(Ipv4Addr::LOCALHOST)], None)
            .await
            .expect("an offer with no addresses of its own");
        assert!(
            answered.answer.contains("a=candidate:"),
            "{}",
            answered.answer
        );
        assert!(answered.answer.contains("typ host"));
        assert!(!answered.answer.contains("typ srflx"));
        assert!(answered.answer.contains("a=fingerprint:sha-256 "));
        assert!(
            answered.answer.len() < 16 * 1024,
            "the answer fits what the API takes"
        );
    }

    #[tokio::test]
    async fn a_browsers_offer_naming_its_address_by_mdns_or_stun_is_answered() {
        let offer = CHROMIUM_OFFER.replace(
            "a=ice-options:trickle\r\n",
            "a=ice-options:trickle\r\n\
             a=candidate:3651283711 1 udp 2113937151 0a4e46b0-1f0e-4a4e-9a49-58c6d3e2a1b7.local 54321 typ host generation 0 network-cost 999\r\n\
             a=candidate:842163049 1 udp 1677729535 203.0.113.9 61234 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999\r\n\
             a=end-of-candidates\r\n",
        );
        answer_offer(&offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)], None)
            .await
            .expect("an offer with a .local candidate and a public one");
    }

    /// A STUN server that tells every socket it is seen at `public`, as one behind a router would be, and counts
    /// what it was asked.
    async fn stun_server(public: SocketAddr) -> (SocketAddr, Arc<std::sync::atomic::AtomicUsize>) {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = socket.local_addr().unwrap();
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = asked.clone();
        tokio::spawn(async move {
            let mut buffer = [0u8; 512];
            while let Ok((len, from)) = socket.recv_from(&mut buffer).await {
                assert_eq!(len, 20, "a plain Binding request");
                count.fetch_add(1, Ordering::SeqCst);
                let transaction: [u8; 12] = buffer[8..20].try_into().unwrap();
                let _ = socket
                    .send_to(&stun::tests::response(&transaction, public, &[]), from)
                    .await;
            }
        });
        (address, asked)
    }

    #[tokio::test]
    async fn the_public_address_from_stun_is_offered_beside_the_local_one() {
        let public: SocketAddr = "203.0.113.7:40000".parse().unwrap();
        let (server, asked) = stun_server(public).await;
        let answered = answer_offer(
            CHROMIUM_OFFER,
            &[IpAddr::V4(Ipv4Addr::LOCALHOST)],
            Some(server),
        )
        .await
        .unwrap();
        let candidates: Vec<&str> = answered
            .answer
            .lines()
            .filter(|line| line.starts_with("a=candidate:"))
            .collect();
        assert_eq!(candidates.len(), 2, "{:?}", candidates);
        let local = answered.sockets[0].local_addr().unwrap();
        assert!(
            candidates.iter().any(|line| line.contains("typ host")
                && line.contains(&format!(" 127.0.0.1 {} ", local.port()))),
            "{:?}",
            candidates
        );
        assert!(
            candidates
                .iter()
                .any(|line| line.contains("typ srflx") && line.contains(" 203.0.113.7 40000 ")),
            "{:?}",
            candidates
        );
        assert_eq!(
            asked.load(Ordering::SeqCst),
            1,
            "each socket asks the server once"
        );
    }

    #[tokio::test]
    async fn a_socket_with_no_router_in_the_way_or_no_stun_answer_offers_its_local_address_alone() {
        // The server sees the socket at its own address.
        let server = stun::tests::fake_server().await;
        let answered = answer_offer(
            CHROMIUM_OFFER,
            &[IpAddr::V4(Ipv4Addr::LOCALHOST)],
            Some(server),
        )
        .await
        .unwrap();
        assert!(!answered.answer.contains("typ srflx"));
        assert!(answered.answer.contains("typ host"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_connection_still_opens_after_its_socket_asked_stun() {
        // The socket that asked the STUN server is the one the connection then runs on.
        let (server, _asked) = stun_server("203.0.113.7:40000".parse().unwrap()).await;
        let (mut browser, offer) = Browser::new(CHANNEL).await;
        let answered = answer_offer(&offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)], Some(server))
            .await
            .unwrap();
        browser.accept(&answered.answer);
        let remote = Arc::new(Remote::default());
        let (events, _seen) = mpsc::unbounded_channel();
        let desk = tokio::spawn(serve(answered, hooks(&remote, events)));
        let mut reply = None;
        let done = browser
            .run(Duration::from_secs(30), |browser, message| {
                match message {
                    None => browser.send(json!({ "hello": { "version": VERSION } })),
                    Some(message) => reply = Some(message),
                }
                reply.is_some()
            })
            .await;
        assert!(done);
        assert_eq!(reply, Some(json!({ "hello": { "version": 2 } })));
        desk.abort();
    }

    #[test]
    fn a_route_is_the_same_network_only_when_both_ends_are_private() {
        let at = |text: &str| text.parse::<SocketAddr>().unwrap();
        assert_eq!(
            route(at("192.168.1.5:1000"), at("192.168.1.9:2000")),
            "Direct (same network)"
        );
        assert_eq!(
            route(at("100.64.3.1:1000"), at("100.101.2.3:2000")),
            "Direct (same network)"
        );
        assert_eq!(
            route(at("192.168.1.5:1000"), at("203.0.113.9:2000")),
            "Direct (internet)"
        );
    }

    #[test]
    fn this_computer_has_an_address_to_offer() {
        // CI machines and desktops have at least one network interface; none of them is loopback.
        assert!(local_addresses().iter().all(|addr| !addr.is_loopback()));
    }
}
