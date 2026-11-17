//! The desktop's side of a WebRTC connection to a paired device, with `str0m` (Docs/RemoteAccess.md, 2.3).
//!
//! `str0m` does no I/O itself. This binds one UDP socket for each of the computer's local addresses, so the desktop
//! knows which address each packet arrived on, offers those addresses in its answer, and runs the connection:
//! packets in and out, timers, and the data channel. Each message on the data channel is a frame of the Noise
//! channel from `connect.rs`, carrying the protocol in `protocol.rs`.
//!
//! Only local addresses are offered for now: the same network, or a VPN such as Tailscale or WireGuard. A STUN
//! server's address, for connections across the internet, comes later as a setting.

use super::noise::Channel;
use super::protocol::{DesktopMessage, DeviceMessage};
use crate::prelude::*;
use std::net::{IpAddr, SocketAddr};
use std::time::Instant;
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc::{self, UnboundedReceiver};

/// How long a device has, from its offer, for the data channel to open.
const OPEN_WITHIN: Duration = Duration::from_secs(30);
/// A device pings every 15 seconds, so one not heard from for this long is gone.
const SILENT_FOR: Duration = Duration::from_secs(45);
const MAX_DATAGRAM: usize = 2000;

/// What a connection does in the app, so the loop can run without a window in tests.
pub(crate) trait Hooks: Send + 'static {
    /// The data channel opened. Returns the connection's id, and what to send the device.
    fn open(&mut self, route: &str) -> (u64, UnboundedReceiver<DesktopMessage>);
    /// A message from the device.
    fn message(&mut self, id: u64, message: DeviceMessage);
    /// The connection ended. `id` is None when the channel never opened.
    fn closed(&mut self, id: Option<u64>, reason: &str);
}

/// The computer's addresses a device on the same network or VPN can reach: every interface's IPv4 address
/// except loopback. IPv6 comes with STUN, since most home networks route IPv4 between devices.
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

/// A connection the desktop answered, waiting for the device to reach it.
pub(crate) struct Answered {
    rtc: Rtc,
    sockets: Vec<Arc<UdpSocket>>,
    /// The answer to send the device.
    pub answer: String,
}

/// Answers a device's offer, offering a socket on each of `addresses`.
pub(crate) async fn answer_offer(offer: &str, addresses: &[IpAddr]) -> Result<Answered, String> {
    if addresses.is_empty() {
        return Err(String::from(
            "This computer has no network address a device can reach.",
        ));
    }
    let offer = SdpOffer::from_sdp_string(offer)
        .map_err(|err| format!("The device's offer could not be read: {}", err))?;
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
    let answer = rtc
        .sdp_api()
        .accept_offer(offer)
        .map_err(|err| format!("The device's offer could not be answered: {}", err))?;
    Ok(Answered {
        rtc,
        sockets,
        answer: answer.to_sdp_string(),
    })
}

/// A packet that arrived: its bytes, who sent it, and the local address it arrived on.
type Packet = (Vec<u8>, SocketAddr, SocketAddr);

/// Runs a connection until it ends: the device leaves or goes silent, the desktop drops it, or it never opens.
pub(crate) async fn serve(answered: Answered, mut channel: Channel, mut hooks: impl Hooks) {
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
    let reason = loop {
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
                Ok(Output::Event(Event::ChannelOpen(id, _))) if open.is_none() => {
                    let route = remote_addr
                        .map(|(local, remote)| super::connect::route(local, remote))
                        .unwrap_or("Direct (same network)");
                    let (connection, outgoing) = hooks.open(route);
                    heard = Instant::now();
                    open = Some((connection, outgoing, id));
                }
                Ok(Output::Event(Event::ChannelData(data))) => {
                    heard = Instant::now();
                    let Some((connection, ..)) = &open else {
                        continue;
                    };
                    match channel.open(&data.data) {
                        Ok(Some(bytes)) => match serde_json::from_slice::<DeviceMessage>(&bytes) {
                            Ok(message) => hooks.message(*connection, message),
                            Err(_) => {
                                break Err(String::from(
                                    "The device sent a message that isn't one.",
                                ));
                            }
                        },
                        Ok(None) => {}
                        Err(err) => break Err(err),
                    }
                }
                Ok(Output::Event(Event::ChannelClose(_))) => {
                    break Err(String::from("The device closed the connection."));
                }
                Ok(Output::Event(Event::IceConnectionStateChange(
                    IceConnectionState::Disconnected,
                ))) => {
                    break Err(String::from("The device's network went away."));
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
                "The device didn't reach this desktop. Check it is on the same network or VPN.",
            );
        }
        if open.is_some() && heard.elapsed() > SILENT_FOR {
            break String::from("The device stopped answering.");
        }
        let sleep_until =
            tokio::time::Instant::from_std(wait_until.min(Instant::now() + Duration::from_secs(1)));
        let outgoing = async {
            match open.as_mut() {
                Some((_, outgoing, _)) => outgoing.recv().await,
                None => std::future::pending().await,
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
                    break String::from("The desktop ended the connection.");
                };
                let Some((_, _, id)) = &open else { continue };
                let sent = serde_json::to_vec(&message)
                    .map_err(|err| err.to_string())
                    .and_then(|bytes| channel.seal(&bytes))
                    .and_then(|packets| {
                        let mut data_channel = rtc.channel(*id).ok_or_else(|| String::from("The data channel closed."))?;
                        for packet in packets {
                            data_channel.write(true, &packet).map_err(|err| err.to_string())?;
                        }
                        Ok(())
                    });
                if let Err(reason) = sent {
                    break reason;
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
    use crate::remote::devices::{DeviceStore, Level};
    use crate::remote::dispatch::Caller;
    use crate::remote::mailbox::{Inbound, Kind, decode, encode};
    use crate::remote::noise::{Handshake, generate_keys, prologue};
    use crate::remote::pairing::Desktop;
    use crate::remote::protocol::VERSION;
    use crate::remote::{Remote, connect};
    use serde_json::json;
    use std::net::Ipv4Addr;
    use tokio::sync::mpsc::UnboundedSender;

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
        fn message(&mut self, id: u64, message: DeviceMessage) {
            if let Some(command) = self.remote.handle(id, message) {
                let answer = json!(format!("ran {}", command.cmd));
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

    /// A paired device's side: a WebRTC peer, as a browser on taskproxy.com is, over real UDP on this computer.
    struct Phone {
        rtc: Rtc,
        socket: UdpSocket,
        channel: Option<Channel>,
        data: Option<ChannelId>,
    }

    impl Phone {
        async fn new() -> (Self, String) {
            let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
            let mut rtc = Rtc::builder()
                .set_stats_interval(None)
                .build(Instant::now());
            rtc.add_local_candidate(Candidate::host(socket.local_addr().unwrap(), "udp").unwrap());
            let mut change = rtc.sdp_api();
            change.add_channel("taskproxy".into());
            let (offer, pending) = change.apply().unwrap();
            let phone = Self {
                rtc,
                socket,
                channel: None,
                data: None,
            };
            // The pending change is kept by applying the answer later.
            PENDING.with(|cell| *cell.borrow_mut() = Some(pending));
            (phone, offer.to_sdp_string())
        }

        fn accept(&mut self, answer: &str) {
            let pending = PENDING.with(|cell| cell.borrow_mut().take()).unwrap();
            let answer = str0m::change::SdpAnswer::from_sdp_string(answer).unwrap();
            self.rtc.sdp_api().accept_answer(pending, answer).unwrap();
        }

        /// Runs the phone until `until` is true of a message from the desktop, or `within` passes, or the
        /// connection fails.
        async fn run(
            &mut self,
            within: Duration,
            mut until: impl FnMut(&mut Self, Option<Value>) -> bool,
        ) -> bool {
            let started = Instant::now();
            let mut buffer = vec![0u8; MAX_DATAGRAM];
            while started.elapsed() < within {
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
                            let opened = self.channel.as_mut().unwrap().open(&data.data).unwrap();
                            if let Some(bytes) = opened
                                && until(self, Some(serde_json::from_slice(&bytes).unwrap()))
                            {
                                return true;
                            }
                        }
                        Output::Event(_) => {}
                    }
                };
                let wait = wait.min(Instant::now() + Duration::from_millis(50));
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
            let packets = self
                .channel
                .as_mut()
                .unwrap()
                .seal(message.to_string().as_bytes())
                .unwrap();
            let id = self.data.unwrap();
            for packet in packets {
                self.rtc.channel(id).unwrap().write(true, &packet).unwrap();
            }
        }
    }

    thread_local! {
        static PENDING: std::cell::RefCell<Option<str0m::change::SdpPendingOffer>> = const { std::cell::RefCell::new(None) };
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_paired_device_connects_over_webrtc_and_runs_a_command() {
        // Pairing saved the device, which kept the desktop's key.
        let desktop_keys = generate_keys().unwrap();
        let device_keys = generate_keys().unwrap();
        let mut store = DeviceStore {
            enabled: true,
            ..Default::default()
        };
        let device = store.pair_as("Pixel", &device_keys.public, "12", Level::Work, 30, 0);

        // The phone's first message carries its offer, and the desktop answers through the mailbox.
        let (mut phone, offer) = Phone::new().await;
        let mut noise = Handshake::connect_device(
            &device_keys,
            &desktop_keys.public,
            &prologue("desk-1", "r-1"),
        )
        .unwrap();
        let first = noise
            .write(json!({ "offer": offer }).to_string().as_bytes())
            .unwrap();
        let inbound = Inbound {
            reply: "r-1".into(),
            from: 12,
            message: encode(Kind::Connect1, &first),
        };
        let desktop = Desktop {
            keys: &desktop_keys,
            id: "desk-1",
            name: "Desk",
            account: "12",
        };
        let accepted = connect::accept(&desktop, &inbound, &store, 1).unwrap();
        assert_eq!(accepted.device.id, device.id);
        let answered = answer_offer(&accepted.offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)])
            .await
            .unwrap();
        let (body, channel) = accepted.answer(&answered.answer).unwrap();
        let (_, second) = decode(&body).unwrap();
        let payload: Value = serde_json::from_slice(&noise.read(&second).unwrap()).unwrap();
        phone.accept(payload["answer"].as_str().unwrap());
        phone.channel = Some(noise.finish(usize::MAX).unwrap());

        let remote = Arc::new(Remote::default());
        let (events, mut seen) = mpsc::unbounded_channel();
        let caller = Caller {
            device_id: device.id.clone(),
            name: device.name.clone(),
            level: device.level,
        };
        let hooks = TestHooks {
            remote: remote.clone(),
            caller,
            events,
        };
        let desk = tokio::spawn(serve(answered, channel, hooks));

        // Once the channel opens, the phone says hello and runs a command, all encrypted by the Noise channel.
        let mut replies = Vec::new();
        let done = phone
            .run(Duration::from_secs(20), |phone, message| {
                match message {
                    None => {
                        phone.send(json!({ "hello": { "version": VERSION } }));
                        phone.send(json!({ "id": 1, "cmd": "get_runs", "args": {} }));
                    }
                    Some(message) => replies.push(message),
                }
                replies.len() == 2
            })
            .await;
        assert!(done, "the phone heard back: {:?}", replies);
        assert_eq!(
            replies[0],
            json!({ "welcome": { "version": VERSION, "reload": false } })
        );
        assert_eq!(
            replies[1],
            json!({ "id": 1, "ok": true, "value": "ran get_runs" })
        );
        assert_eq!(seen.recv().await.unwrap(), "open Direct (same network)");
        assert!(remote.has_connections());
        assert_eq!(remote.log.lock().unwrap().latest()[0].cmd, "get_runs");

        // The desktop dropping the device ends the connection.
        remote.disconnect_device(&device.id);
        let closed = tokio::time::timeout(Duration::from_secs(10), seen.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(closed, "closed The desktop ended the connection.");
        desk.await.unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn an_answer_with_a_swapped_dtls_fingerprint_never_connects() {
        // Someone between the two swaps the desktop's fingerprint for their own. Noise authenticates the real answer,
        // so this could only happen without it, and then the phone's DTLS refuses the desktop's real certificate.
        let (mut phone, offer) = Phone::new().await;
        let answered = answer_offer(&offer, &[IpAddr::V4(Ipv4Addr::LOCALHOST)])
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
        phone.accept(&swapped);
        let keys = generate_keys().unwrap();
        let mut device =
            Handshake::connect_device(&generate_keys().unwrap(), &keys.public, &prologue("d", "r"))
                .unwrap();
        let mut desk = Handshake::connect_desktop(&keys, &prologue("d", "r")).unwrap();
        desk.read(&device.write(b"").unwrap()).unwrap();
        let _ = device.read(&desk.write(b"").unwrap());
        let (events, _seen) = mpsc::unbounded_channel();
        let hooks = TestHooks {
            remote: Arc::new(Remote::default()),
            caller: Caller {
                device_id: "d".into(),
                name: "D".into(),
                level: Level::View,
            },
            events,
        };
        let desk = tokio::spawn(serve(answered, desk.finish(usize::MAX).unwrap(), hooks));
        let opened = phone.run(Duration::from_secs(8), |_, _| true).await;
        assert!(!opened, "the data channel never opened");
        desk.abort();
    }

    #[test]
    fn this_computer_has_an_address_to_offer() {
        // CI machines and desktops have at least one network interface; none of them is loopback.
        assert!(local_addresses().iter().all(|addr| !addr.is_loopback()));
    }
}
