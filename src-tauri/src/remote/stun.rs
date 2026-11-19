//! Asking a STUN server what this computer's public address is (RFC 8489), so a browser on another network can
//! reach it. The server comes from `GET remote/servers`, read before each connection.
//!
//! Each socket a connection will use asks once, with a plain Binding request, since the address a router gives
//! differs for each socket. The server answers at most 40 times per address every 10 seconds, so nothing is asked
//! twice. Only an address passes through the server, never what the two sides then say to each other.

use crate::prelude::*;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use tokio::net::UdpSocket;

const MAGIC_COOKIE: [u8; 4] = [0x21, 0x12, 0xA4, 0x42];
const BINDING_REQUEST: [u8; 2] = [0x00, 0x01];
const BINDING_SUCCESS: [u8; 2] = [0x01, 0x01];
const MAPPED_ADDRESS: u16 = 0x0001;
const XOR_MAPPED_ADDRESS: u16 = 0x0020;
const HEADER: usize = 20;
const DEFAULT_PORT: u16 = 3478;
/// How long a socket waits for the server's answer. A connection is answered without it after that.
pub(crate) const WAIT: Duration = Duration::from_millis(1500);

/// A Binding request with no attributes: the type, a length of 0, the magic cookie, and the transaction's id.
pub(crate) fn binding_request(transaction: &[u8; 12]) -> [u8; HEADER] {
    let mut request = [0u8; HEADER];
    request[..2].copy_from_slice(&BINDING_REQUEST);
    request[4..8].copy_from_slice(&MAGIC_COOKIE);
    request[8..].copy_from_slice(transaction);
    request
}

/// The address a Binding success response to `transaction` gives. None for anything else, such as an error, a
/// response to another request, or a packet cut short.
pub(crate) fn parse_binding_response(packet: &[u8], transaction: &[u8; 12]) -> Option<SocketAddr> {
    if packet.len() < HEADER
        || packet[..2] != BINDING_SUCCESS
        || packet[4..8] != MAGIC_COOKIE
        || packet[8..HEADER] != transaction[..]
    {
        return None;
    }
    let length = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    if !length.is_multiple_of(4) {
        return None;
    }
    let mut attributes = packet.get(HEADER..HEADER + length)?;
    let mut plain = None;
    while attributes.len() >= 4 {
        let kind = u16::from_be_bytes([attributes[0], attributes[1]]);
        let size = u16::from_be_bytes([attributes[2], attributes[3]]) as usize;
        let value = attributes.get(4..4 + size)?;
        match kind {
            XOR_MAPPED_ADDRESS => return address(value, Some(transaction)),
            MAPPED_ADDRESS => plain = plain.or(address(value, None)),
            _ => {}
        }
        // Each attribute is padded to 4 bytes.
        attributes = attributes.get(4 + size.div_ceil(4) * 4..).unwrap_or(&[]);
    }
    plain
}

/// The address in a MAPPED-ADDRESS attribute, or in an XOR-MAPPED-ADDRESS one when `xor` gives the transaction.
fn address(value: &[u8], xor: Option<&[u8; 12]>) -> Option<SocketAddr> {
    let family = *value.get(1)?;
    let mut port = [*value.get(2)?, *value.get(3)?];
    let mut mask = [0u8; 16];
    if let Some(transaction) = xor {
        mask[..4].copy_from_slice(&MAGIC_COOKIE);
        mask[4..].copy_from_slice(transaction);
        port[0] ^= MAGIC_COOKIE[0];
        port[1] ^= MAGIC_COOKIE[1];
    }
    let port = u16::from_be_bytes(port);
    let ip = match family {
        1 => {
            let mut bytes: [u8; 4] = value.get(4..8)?.try_into().ok()?;
            bytes.iter_mut().zip(mask).for_each(|(byte, m)| *byte ^= m);
            IpAddr::V4(Ipv4Addr::from(bytes))
        }
        2 => {
            let mut bytes: [u8; 16] = value.get(4..20)?.try_into().ok()?;
            bytes.iter_mut().zip(mask).for_each(|(byte, m)| *byte ^= m);
            IpAddr::V6(Ipv6Addr::from(bytes))
        }
        _ => return None,
    };
    Some(SocketAddr::new(ip, port))
}

/// The STUN servers in what `GET remote/servers` returns, `{"iceServers": [{"urls": "stun:host:port"}]}`, each as
/// `host:port`. `urls` may be one address or a list, as WebRTC takes it, and the port is 3478 when left out.
pub(crate) fn servers(ice_servers: &Value) -> Vec<String> {
    let mut found = Vec::new();
    for server in ice_servers
        .get("iceServers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let urls = match server.get("urls") {
            Some(Value::String(url)) => vec![url.as_str()],
            Some(Value::Array(urls)) => urls.iter().filter_map(Value::as_str).collect(),
            _ => Vec::new(),
        };
        for url in urls {
            let Some(host) = url.strip_prefix("stun:") else {
                continue;
            };
            let host = host.split('?').next().unwrap_or_default();
            if host.is_empty() {
                continue;
            }
            // An IPv6 address is written in brackets, so only a colon after them starts a port.
            let has_port = host
                .rsplit_once(':')
                .is_some_and(|(_, port)| port.parse::<u16>().is_ok() && !port.contains(']'));
            found.push(if has_port {
                host.to_string()
            } else {
                format!("{}:{}", host, DEFAULT_PORT)
            });
        }
    }
    found
}

/// The first of `servers` that has an IPv4 address, which is what this computer's sockets use.
pub(crate) async fn resolve(servers: &[String]) -> Option<SocketAddr> {
    for server in servers {
        if let Ok(addresses) = tokio::net::lookup_host(server.as_str()).await
            && let Some(address) = addresses.into_iter().find(SocketAddr::is_ipv4)
        {
            return Some(address);
        }
    }
    None
}

/// Asks `server` once, from `socket`, what address it sees the socket at. None when it doesn't answer within
/// `wait`.
pub(crate) async fn public_address(
    socket: &UdpSocket,
    server: SocketAddr,
    wait: Duration,
) -> Option<SocketAddr> {
    use rand::RngExt;
    let transaction: [u8; 12] = rand::rng().random();
    socket
        .send_to(&binding_request(&transaction), server)
        .await
        .ok()?;
    let answer = async {
        let mut buffer = [0u8; 512];
        loop {
            let (len, from) = socket.recv_from(&mut buffer).await.ok()?;
            if from == server
                && let Some(address) = parse_binding_response(&buffer[..len], &transaction)
            {
                return Some(address);
            }
        }
    };
    tokio::time::timeout(wait, answer).await.ok().flatten()
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    const TRANSACTION: [u8; 12] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    /// A Binding success response giving `address`, as XOR-MAPPED-ADDRESS, after `before` (other attributes).
    pub(crate) fn response(transaction: &[u8; 12], address: SocketAddr, before: &[u8]) -> Vec<u8> {
        let mut value = vec![0u8];
        let port = address.port() ^ 0x2112;
        match address.ip() {
            IpAddr::V4(ip) => {
                value.push(1);
                value.extend(port.to_be_bytes());
                value.extend(
                    ip.octets()
                        .iter()
                        .zip(MAGIC_COOKIE)
                        .map(|(byte, m)| byte ^ m),
                );
            }
            IpAddr::V6(ip) => {
                value.push(2);
                value.extend(port.to_be_bytes());
                let mask = [&MAGIC_COOKIE[..], &transaction[..]].concat();
                value.extend(ip.octets().iter().zip(mask).map(|(byte, m)| byte ^ m));
            }
        }
        let mut attributes = before.to_vec();
        attributes.extend(XOR_MAPPED_ADDRESS.to_be_bytes());
        attributes.extend((value.len() as u16).to_be_bytes());
        attributes.extend(value);
        let mut packet = BINDING_SUCCESS.to_vec();
        packet.extend((attributes.len() as u16).to_be_bytes());
        packet.extend(MAGIC_COOKIE);
        packet.extend(transaction);
        packet.extend(attributes);
        packet
    }

    #[test]
    fn a_binding_request_is_20_bytes_with_the_cookie_and_its_transaction() {
        let request = binding_request(&TRANSACTION);
        assert_eq!(
            request,
            [
                0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xA4, 0x42, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
                12
            ]
        );
    }

    #[test]
    fn the_rfc_5769_sample_response_gives_its_address() {
        // RFC 5769, 2.2: an IPv4 response with SOFTWARE, XOR-MAPPED-ADDRESS, MESSAGE-INTEGRITY and FINGERPRINT.
        let packet = hex::decode(concat!(
            "0101003c2112a442b7e7a701bc34d686fa87dfae",
            "8022000b7465737420766563746f7220",
            "002000080001a147e112a643",
            "000800142b91f599fd9e90c38c7489f92af9ba53f06be7d7",
            "80280004c07d4c96",
        ))
        .unwrap();
        let transaction: [u8; 12] = packet[8..20].try_into().unwrap();
        assert_eq!(
            parse_binding_response(&packet, &transaction),
            Some("192.0.2.1:32853".parse().unwrap())
        );
        // RFC 5769, 2.3: the same for IPv6.
        let packet = hex::decode(concat!(
            "010100482112a442b7e7a701bc34d686fa87dfae",
            "8022000b7465737420766563746f7220",
            "002000140002a1470113a9faa5d3f179bc25f4b5bed2b9d9",
            "00080014a382954e4be67bf11784c97c8292c275bfe3ed41",
            "80280004c8fb0b4c",
        ))
        .unwrap();
        assert_eq!(
            parse_binding_response(&packet, &transaction),
            Some(
                "[2001:db8:1234:5678:11:2233:4455:6677]:32853"
                    .parse()
                    .unwrap()
            )
        );
    }

    #[test]
    fn a_response_is_read_past_attributes_it_does_not_know() {
        let address: SocketAddr = "203.0.113.7:50123".parse().unwrap();
        // An unknown attribute of 5 bytes, padded to 8.
        let unknown = [
            0x80, 0x22, 0x00, 0x05, b'h', b'e', b'l', b'l', b'o', 0, 0, 0,
        ];
        assert_eq!(
            parse_binding_response(&response(&TRANSACTION, address, &unknown), &TRANSACTION),
            Some(address)
        );
        assert_eq!(
            parse_binding_response(&response(&TRANSACTION, address, &[]), &TRANSACTION),
            Some(address)
        );
    }

    #[test]
    fn an_older_servers_plain_mapped_address_is_read_when_there_is_no_xor_one() {
        let mut packet = BINDING_SUCCESS.to_vec();
        packet.extend(12u16.to_be_bytes());
        packet.extend(MAGIC_COOKIE);
        packet.extend(TRANSACTION);
        packet.extend([
            0x00, 0x01, 0x00, 0x08, 0x00, 0x01, 0x1F, 0x90, 198, 51, 100, 4,
        ]);
        assert_eq!(
            parse_binding_response(&packet, &TRANSACTION),
            Some("198.51.100.4:8080".parse().unwrap())
        );
    }

    #[test]
    fn anything_but_this_requests_success_response_gives_nothing() {
        let address: SocketAddr = "203.0.113.7:50123".parse().unwrap();
        let good = response(&TRANSACTION, address, &[]);
        let other_transaction = [9u8; 12];
        assert_eq!(parse_binding_response(&good, &other_transaction), None);
        let mut error = good.clone();
        error[..2].copy_from_slice(&[0x01, 0x11]);
        assert_eq!(parse_binding_response(&error, &TRANSACTION), None);
        let mut no_cookie = good.clone();
        no_cookie[4] = 0;
        assert_eq!(parse_binding_response(&no_cookie, &TRANSACTION), None);
        for cut in [0, 10, 19, 24, good.len() - 1] {
            assert_eq!(
                parse_binding_response(&good[..cut], &TRANSACTION),
                None,
                "cut at {}",
                cut
            );
        }
        // An attribute that says it is longer than the packet.
        let mut long = good.clone();
        long[23] = 200;
        assert_eq!(parse_binding_response(&long, &TRANSACTION), None);
        // A success response with no address in it.
        let empty = response(&TRANSACTION, address, &[])[..HEADER].to_vec();
        let mut empty = empty;
        empty[2..4].copy_from_slice(&[0, 0]);
        assert_eq!(parse_binding_response(&empty, &TRANSACTION), None);
        assert_eq!(
            parse_binding_response(&binding_request(&TRANSACTION), &TRANSACTION),
            None
        );
    }

    #[test]
    fn stun_servers_are_read_from_the_apis_list() {
        assert_eq!(
            servers(&json!({ "iceServers": [{ "urls": "stun:api.myfi.ws:3478" }] })),
            vec!["api.myfi.ws:3478"]
        );
        assert_eq!(
            servers(&json!({ "iceServers": [
                { "urls": ["stun:one.example", "turn:relay.example:3478", "stun:two.example:5349?transport=udp"] },
                { "urls": "stun:[2001:db8::1]" },
                { "urls": "stun:[2001:db8::1]:3479" },
                { "urls": 5 },
                {},
            ] })),
            vec![
                "one.example:3478",
                "two.example:5349",
                "[2001:db8::1]:3478",
                "[2001:db8::1]:3479"
            ]
        );
        assert!(servers(&json!({})).is_empty());
        assert!(servers(&json!({ "iceServers": "stun:x" })).is_empty());
    }

    /// A STUN server on this computer that answers each request with the address it came from.
    pub(crate) async fn fake_server() -> SocketAddr {
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let address = socket.local_addr().unwrap();
        tokio::spawn(async move {
            let mut buffer = [0u8; 512];
            while let Ok((len, from)) = socket.recv_from(&mut buffer).await {
                if len == HEADER && buffer[..2] == BINDING_REQUEST {
                    let transaction: [u8; 12] = buffer[8..HEADER].try_into().unwrap();
                    let _ = socket
                        .send_to(&response(&transaction, from, &[]), from)
                        .await;
                }
            }
        });
        address
    }

    #[tokio::test]
    async fn a_socket_learns_the_address_the_server_sees_it_at() {
        let server = fake_server().await;
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        assert_eq!(
            public_address(&socket, server, Duration::from_secs(5)).await,
            Some(socket.local_addr().unwrap())
        );
    }

    #[tokio::test]
    async fn a_server_that_does_not_answer_gives_nothing() {
        // Bound and never read, so nothing answers.
        let silent = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let socket = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        assert_eq!(
            public_address(
                &socket,
                silent.local_addr().unwrap(),
                Duration::from_millis(50)
            )
            .await,
            None
        );
    }

    #[tokio::test]
    async fn a_named_server_is_found_by_its_ipv4_address() {
        assert_eq!(
            resolve(&[String::from("127.0.0.1:3478")]).await,
            Some("127.0.0.1:3478".parse().unwrap())
        );
        assert_eq!(resolve(&[String::from("[::1]:3478")]).await, None);
        assert_eq!(resolve(&[]).await, None);
    }
}
