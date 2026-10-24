// SPDX-License-Identifier: MIT
//! mDNS is a candidate source only. No discovered record grants trust or access.
use mdns_sd::{IfKind, ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::Serialize;
use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr, SocketAddrV6};
use std::sync::{Arc, Mutex};
use tokio::sync::watch;
use tokio::task::JoinHandle;
use uuid::Uuid;

pub const SERVICE_TYPE: &str = "_hertz-listen._tcp.local.";
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("network interface enumeration failed")]
    Interfaces,
    #[error("mDNS is unavailable on the selected network")]
    Mdns,
    #[error("invalid discovery metadata")]
    Metadata,
}
#[derive(Debug, Clone, Serialize)]
pub struct NetworkInterface {
    pub name: String,
    pub address: IpAddr,
    pub index: Option<u32>,
    pub loopback: bool,
}
pub fn interfaces() -> Result<Vec<NetworkInterface>, DiscoveryError> {
    let mut result: Vec<_> = if_addrs::get_if_addrs()
        .map_err(|_| DiscoveryError::Interfaces)?
        .into_iter()
        .filter(|i| i.is_oper_up() && !i.ip().is_unspecified() && !i.ip().is_multicast())
        .map(|i| NetworkInterface {
            address: i.ip(),
            loopback: i.is_loopback(),
            name: i.name,
            index: i.index,
        })
        .collect();
    result.sort_by(|a, b| (a.loopback, &a.name, a.address).cmp(&(b.loopback, &b.name, b.address)));
    Ok(result)
}
pub fn interface_present(address: SocketAddr) -> Result<bool, DiscoveryError> {
    Ok(interfaces()?.iter().any(|i| {
        i.address == address.ip()
            && match address {
                SocketAddr::V6(v6) if v6.scope_id() != 0 => i.index == Some(v6.scope_id()),
                _ => true,
            }
    }))
}

// A scoped address selects one NIC. Matching only the IP would enable every
// link with an identical link-local address and advertise an unreachable port.
fn selected_interface(
    address: SocketAddr,
    interfaces: &[NetworkInterface],
) -> Result<&NetworkInterface, DiscoveryError> {
    let mut matches = interfaces.iter().filter(|interface| {
        interface.address == address.ip()
            && match address {
                SocketAddr::V6(v6) if v6.scope_id() != 0 => interface.index == Some(v6.scope_id()),
                _ => true,
            }
    });
    let selected = matches.next().ok_or(DiscoveryError::Metadata)?;
    if matches.any(|other| other.name != selected.name || other.index != selected.index) {
        return Err(DiscoveryError::Metadata);
    }
    Ok(selected)
}
/// RAII registration advertises only the explicitly selected interface address.
pub struct Advertisement {
    daemon: ServiceDaemon,
    fullname: String,
}
impl Advertisement {
    pub fn start(
        name: &str,
        address: SocketAddr,
        room_id: Uuid,
        fingerprint: crate::tls::Fingerprint,
    ) -> Result<Self, DiscoveryError> {
        if !valid_name(name) || room_id.is_nil() || address.port() == 0 {
            return Err(DiscoveryError::Metadata);
        }
        let available = interfaces()?;
        let interface = selected_interface(address, &available)?;
        let daemon = ServiceDaemon::new().map_err(|_| DiscoveryError::Mdns)?;
        let setup = || {
            daemon
                .disable_interface(IfKind::All)
                .map_err(|_| DiscoveryError::Mdns)?;
            daemon
                .enable_interface(IfKind::Name(interface.name.clone()))
                .map_err(|_| DiscoveryError::Mdns)?;
            let room = room_id.to_string();
            let port = address.port().to_string();
            let fingerprint = fingerprint.hex();
            let version = crate::protocol::VERSION.to_string();
            let code = crate::admission::room_code(room_id);
            let properties = [
                ("name", name),
                ("version", version.as_str()),
                ("room_id", &room),
                ("port", &port),
                ("room_code", code.as_str()),
                ("fingerprint", fingerprint.as_str()),
            ];
            let info = ServiceInfo::new(
                SERVICE_TYPE,
                &format!("hertz-{room}"),
                &format!("hertz-{room}.local."),
                address.ip(),
                address.port(),
                &properties[..],
            )
            .map_err(|_| DiscoveryError::Metadata)?;
            let fullname = info.get_fullname().to_owned();
            daemon.register(info).map_err(|_| DiscoveryError::Mdns)?;
            Ok(fullname)
        };
        match setup() {
            Ok(fullname) => Ok(Self { daemon, fullname }),
            Err(e) => {
                let _ = daemon.shutdown();
                Err(e)
            }
        }
    }
}
impl Drop for Advertisement {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Candidate {
    pub name: String,
    pub room_id: Uuid,
    pub version: u16,
    pub addresses: Vec<SocketAddr>,
    pub room_code: String,
    /// A discovery claim, not authority: callers must confirm the host pin.
    pub fingerprint: String,
}
pub struct Discovery {
    daemon: ServiceDaemon,
    candidates: Arc<Mutex<BTreeMap<String, Candidate>>>,
    stop: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Discovery {
    pub fn start() -> Result<Self, DiscoveryError> {
        let daemon = ServiceDaemon::new().map_err(|_| DiscoveryError::Mdns)?;
        let receiver = match daemon.browse(SERVICE_TYPE) {
            Ok(rx) => rx,
            Err(_) => {
                let _ = daemon.shutdown();
                return Err(DiscoveryError::Mdns);
            }
        };
        let candidates = Arc::new(Mutex::new(BTreeMap::<String, Candidate>::new()));
        let shared = candidates.clone();
        let (stop, mut stopped) = watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stopped.changed() => break,
                    event = receiver.recv_async() => {
                        let Ok(event) = event else { break; };
                        let mut cache = shared.lock().unwrap_or_else(|e| e.into_inner());
                        match event {
                            ServiceEvent::ServiceResolved(info) => {
                                if let Some(candidate) = candidate(&info) {
                                    if cache.len() < 64 || cache.contains_key(&info.fullname) { cache.insert(info.fullname, candidate); }
                                }
                            },
                            ServiceEvent::ServiceRemoved(_, fullname) => { cache.remove(&fullname); },
                            _ => {},
                        }
                    }
                }
            }
        });
        Ok(Self {
            daemon,
            candidates,
            stop,
            task,
        })
    }
    pub fn candidates(&self) -> Vec<Candidate> {
        self.candidates
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .cloned()
            .collect()
    }
}
impl Drop for Discovery {
    fn drop(&mut self) {
        self.stop.send_replace(true);
        self.task.abort();
        let _ = self.daemon.stop_browse(SERVICE_TYPE);
        let _ = self.daemon.shutdown();
    }
}
fn valid_name(name: &str) -> bool {
    !name.trim().is_empty()
        && name.len() <= 128
        && name.chars().count() <= 64
        && !name.chars().any(char::is_control)
}
fn candidate(info: &mdns_sd::ResolvedService) -> Option<Candidate> {
    if info.ty_domain != SERVICE_TYPE || info.fullname.len() > 256 || info.port == 0 {
        return None;
    }
    let name = info.get_property_val_str("name")?;
    if !valid_name(name) {
        return None;
    }
    let room_id: Uuid = info.get_property_val_str("room_id")?.parse().ok()?;
    let version = info.get_property_val_str("version")?.parse().ok()?;
    if room_id.is_nil() {
        return None;
    }
    let room_code = info.get_property_val_str("room_code")?;
    if room_code != crate::admission::room_code(room_id) {
        return None;
    }
    let fingerprint = crate::tls::Fingerprint::parse(info.get_property_val_str("fingerprint")?)
        .ok()?
        .hex();
    let addresses = info
        .addresses
        .iter()
        .filter_map(|a| {
            let ip = a.to_ip_addr();
            if ip.is_unspecified() || ip.is_multicast() {
                return None;
            }
            match a {
                mdns_sd::ScopedIp::V6(v6) => Some(SocketAddr::V6(SocketAddrV6::new(
                    *v6.addr(),
                    info.port,
                    0,
                    v6.scope_id().index,
                ))),
                _ => Some(SocketAddr::new(ip, info.port)),
            }
        })
        .take(16)
        .collect::<Vec<_>>();
    if addresses.is_empty() {
        return None;
    }
    Some(Candidate {
        name: name.into(),
        room_id,
        version,
        addresses,
        room_code: room_code.to_owned(),
        fingerprint,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn advertisements_contain_only_discovery_metadata_and_validate_names() {
        assert!(valid_name("客厅"));
        assert!(!valid_name(" "));
        assert!(!valid_name("name\n"));
        assert!(!valid_name(&"文".repeat(65)));
        assert!(Advertisement::start(
            "room",
            "0.0.0.0:1234".parse().unwrap(),
            Uuid::new_v4(),
            crate::tls::Fingerprint::of(b"test")
        )
        .is_err());
    }

    #[test]
    fn scoped_addresses_select_one_interface_and_bare_duplicates_are_rejected() {
        let ip: IpAddr = "fe80::1234".parse().unwrap();
        let interfaces: Vec<_> = [("ethernet", 4), ("wifi", 7)]
            .into_iter()
            .map(|(name, index)| NetworkInterface {
                name: name.into(),
                address: ip,
                index: Some(index),
                loopback: false,
            })
            .collect();
        assert_eq!(
            selected_interface("[fe80::1234%7]:17000".parse().unwrap(), &interfaces)
                .unwrap()
                .name,
            "wifi"
        );
        assert!(selected_interface("[fe80::1234]:17000".parse().unwrap(), &interfaces).is_err());
        assert!(selected_interface("[fe80::1234%3]:17000".parse().unwrap(), &interfaces).is_err());
    }
}
