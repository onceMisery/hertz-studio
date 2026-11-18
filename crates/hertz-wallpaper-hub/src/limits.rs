// SPDX-License-Identifier: MIT
use crate::error::{HubError, Result};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

struct Client {
    window: Instant,
    requests: u16,
    downloads: Arc<Semaphore>,
}
pub(crate) struct Limits {
    clients: Mutex<HashMap<IpAddr, Client>>,
}
impl Limits {
    pub fn new() -> Self {
        Self {
            clients: Mutex::new(HashMap::new()),
        }
    }
    pub fn request(&self, ip: IpAddr) -> Result<()> {
        let mut clients = self.clients.lock().map_err(|_| HubError::unavailable())?;
        let now = Instant::now();
        clients.retain(|_, client| {
            now.duration_since(client.window) < Duration::from_secs(60)
                || client.downloads.available_permits() != 4
        });
        if !clients.contains_key(&ip) && clients.len() >= 8192 {
            return Err(HubError::limited("服务访问槽暂满"));
        }
        let client = clients.entry(ip).or_insert_with(|| Client {
            window: now,
            requests: 0,
            downloads: Arc::new(Semaphore::new(4)),
        });
        if now.duration_since(client.window) >= Duration::from_secs(60) {
            client.window = now;
            client.requests = 0;
        }
        if client.requests >= 120 {
            return Err(HubError::limited("每个IP每分钟最多120次请求"));
        }
        client.requests += 1;
        Ok(())
    }
    pub fn download(&self, ip: IpAddr) -> Result<OwnedSemaphorePermit> {
        let clients = self.clients.lock().map_err(|_| HubError::unavailable())?;
        clients
            .get(&ip)
            .ok_or_else(HubError::unavailable)?
            .downloads
            .clone()
            .try_acquire_owned()
            .map_err(|_| HubError::limited("每个IP最多4个并发下载"))
    }
}
