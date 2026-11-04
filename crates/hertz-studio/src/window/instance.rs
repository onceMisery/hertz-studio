// SPDX-License-Identifier: MIT
//! Data-directory scoped native-window ownership. The OS lock is acquired before
//! bootstrap and is never unlinked. Discovery is replaced/removed only while
//! holding that lock; the listener and publication belong to the same guard.

use anyhow::{bail, ensure, Context as _};
use hmac::{Hmac, Mac};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const PROTOCOL: &str = "hertz-studio-window/1";
const MAX_FRAME: usize = 2048;
const IO_TIMEOUT: Duration = Duration::from_millis(500);
const DISCOVERY_WAIT: Duration = Duration::from_secs(3);

pub(super) struct Instance {
    pub data_dir: PathBuf,
    pub bind: String,
    requested_port: u16,
    identity: String,
    discovery: PathBuf,
    lock_path: PathBuf,
}

impl Instance {
    pub fn new(data_dir: &Path, edition: &str, bind: &str, port: u16) -> anyhow::Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let data_dir = std::fs::canonicalize(data_dir)?;
        let bind = normalize_bind(bind);
        let canonical_name = data_dir.to_string_lossy().into_owned();
        #[cfg(windows)]
        let canonical_name = canonical_name.to_lowercase();
        // Requested port (including zero), not the ephemeral service port, is
        // the identity. Serializing the tuple keeps field boundaries distinct.
        let identity = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(canonical_name, edition, &bind, port))?)
        );
        let directory = data_dir.join("window");
        std::fs::create_dir_all(&directory)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self {
            data_dir,
            bind,
            requested_port: port,
            discovery: directory.join(format!("{identity}.json")),
            lock_path: directory.join(format!("{identity}.lock")),
            identity,
        })
    }

    pub fn try_claim(&self) -> anyhow::Result<Option<Owner>> {
        let mut lock = fslock::LockFile::open(&self.lock_path)?;
        if !lock.try_lock()? {
            return Ok(None);
        }
        // A dead owner can leave metadata, but never a live OS lock. Contenders
        // must not delete metadata even if it is stale, corrupt or unreachable.
        match std::fs::remove_file(&self.discovery) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        if listener.local_addr()?.port() == self.requested_port {
            // Keep the first socket open until the replacement is bound, so
            // an ephemeral allocation cannot steal our configured service port.
            listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        }
        listener.set_nonblocking(true)?;
        let discovery = Discovery {
            protocol: PROTOCOL.into(),
            identity: self.identity.clone(),
            instance: uuid::Uuid::new_v4().to_string(),
            secret: format!(
                "{}{}",
                uuid::Uuid::new_v4().simple(),
                uuid::Uuid::new_v4().simple()
            ),
            port: listener.local_addr()?.port(),
        };
        Ok(Some(Owner {
            _lock: lock,
            path: self.discovery.clone(),
            discovery,
            listener: Some(listener),
            ready: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            worker: None,
        }))
    }

    pub fn focus_existing(&self) -> anyhow::Result<FocusOutcome> {
        let deadline = Instant::now() + DISCOVERY_WAIT;
        loop {
            if let Ok(discovery) = read_document::<Discovery>(&self.discovery) {
                if let Ok(outcome) = focus(&discovery, &self.identity) {
                    return Ok(outcome);
                }
            }
            if Instant::now() >= deadline {
                bail!("该配置的主窗口已持有实例锁，但尚未就绪或握手验证失败；请稍后重试");
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

fn normalize_bind(bind: &str) -> String {
    let bind = bind.trim();
    let address = bind
        .strip_prefix('[')
        .and_then(|v| v.strip_suffix(']'))
        .unwrap_or(bind);
    match address.parse::<IpAddr>() {
        Ok(ip) => ip.to_string(),
        Err(_) => bind.trim_end_matches('.').to_ascii_lowercase(),
    }
}

// Deliberately no Debug: the discovery secret must never enter logs.
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Discovery {
    protocol: String,
    identity: String,
    instance: String,
    secret: String,
    port: u16,
}

pub(super) struct Owner {
    path: PathBuf,
    discovery: Discovery,
    listener: Option<TcpListener>,
    ready: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    _lock: fslock::LockFile,
}

impl Owner {
    pub fn publish(&mut self, on_focus: impl Fn() -> bool + Send + 'static) -> anyhow::Result<()> {
        let listener = self.listener.take().context("主窗口握手通道已发布")?;
        let doc = self.discovery.clone();
        let ready = self.ready.clone();
        let stop = self.stop.clone();
        self.worker = Some(
            std::thread::Builder::new()
                .name("hertz-studio-handshake".into())
                .spawn(move || {
                    while !stop.load(Ordering::Acquire) {
                        match listener.accept() {
                            Ok((mut stream, _)) => {
                                // Invalid probes have no effect and reveal no credentials.
                                // Accepted sockets may inherit nonblocking mode
                                // on Windows. Fragments must wait up to the same
                                // bounded deadline used by the blocking client.
                                if stream.set_nonblocking(false).is_ok() {
                                    let _ = serve_request(&mut stream, &doc, &ready, &on_focus);
                                }
                            }
                            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                                std::thread::sleep(Duration::from_millis(20));
                            }
                            Err(_) => break,
                        }
                    }
                })?,
        );
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", self.discovery.instance));
        let result = (|| -> anyhow::Result<()> {
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&temporary)?;
            file.write_all(&serde_json::to_vec(&self.discovery)?)?;
            file.sync_all()?;
            drop(file);
            std::fs::rename(&temporary, &self.path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = std::fs::remove_file(temporary);
        }
        result.context("发布主窗口发现文件失败")
    }

    pub fn ready(&self) {
        self.ready.store(true, Ordering::Release);
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Ok(doc) = read_document::<Discovery>(&self.path) {
            if doc.instance == self.discovery.instance && doc.identity == self.discovery.identity {
                let _ = std::fs::remove_file(&self.path);
            }
        }
        // Lock closes last; its file must remain to prevent split lock inodes.
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum FocusOutcome {
    Focused,
    Starting,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: String,
    identity: String,
    instance: String,
    nonce: String,
    command: String,
    proof: String,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Status {
    Focused,
    Starting,
    Unavailable,
}

impl Status {
    fn as_str(self) -> &'static str {
        match self {
            Self::Focused => "focused",
            Self::Starting => "starting",
            Self::Unavailable => "unavailable",
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Response {
    protocol: String,
    identity: String,
    instance: String,
    nonce: String,
    status: Status,
    proof: String,
}

fn authentication(doc: &Discovery, nonce: &str, direction: &str, value: &str) -> Hmac<Sha256> {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(doc.secret.as_bytes()).expect("HMAC accepts any key size");
    for field in [
        PROTOCOL,
        &doc.identity,
        &doc.instance,
        nonce,
        direction,
        value,
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field.as_bytes());
    }
    mac
}

fn signature(doc: &Discovery, nonce: &str, direction: &str, value: &str) -> String {
    authentication(doc, nonce, direction, value)
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn verify(
    doc: &Discovery,
    nonce: &str,
    direction: &str,
    value: &str,
    proof: &str,
) -> anyhow::Result<()> {
    ensure!(
        proof.len() == 64 && proof.bytes().all(|b| b.is_ascii_hexdigit()),
        "握手认证失败"
    );
    let bytes: Vec<u8> = (0..64)
        .step_by(2)
        .map(|i| u8::from_str_radix(&proof[i..i + 2], 16))
        .collect::<Result<_, _>>()?;
    authentication(doc, nonce, direction, value)
        .verify_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("握手认证失败"))
}

fn focus(doc: &Discovery, identity: &str) -> anyhow::Result<FocusOutcome> {
    ensure!(
        doc.protocol == PROTOCOL && doc.identity == identity && doc.port != 0,
        "主窗口发现身份不匹配"
    );
    ensure!(
        uuid::Uuid::parse_str(&doc.instance).is_ok()
            && doc.secret.len() == 64
            && doc.secret.bytes().all(|b| b.is_ascii_hexdigit()),
        "主窗口发现格式无效"
    );
    let nonce = uuid::Uuid::new_v4().to_string();
    let request = Request {
        protocol: PROTOCOL.into(),
        identity: identity.into(),
        instance: doc.instance.clone(),
        nonce: nonce.clone(),
        command: "focus".into(),
        proof: signature(doc, &nonce, "request", "focus"),
    };
    // Transport is always IPv4 loopback, independent of the service bind.
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from((Ipv4Addr::LOCALHOST, doc.port)),
        IO_TIMEOUT,
    )?;
    write_frame(&mut stream, &request)?;
    let response: Response = read_frame(&mut stream)?;
    ensure!(
        response.protocol == PROTOCOL
            && response.identity == identity
            && response.instance == doc.instance
            && response.nonce == nonce,
        "主窗口握手响应身份不匹配"
    );
    verify(
        doc,
        &nonce,
        "response",
        response.status.as_str(),
        &response.proof,
    )?;
    match response.status {
        Status::Focused => Ok(FocusOutcome::Focused),
        Status::Starting => Ok(FocusOutcome::Starting),
        Status::Unavailable => bail!("主窗口当前不可用"),
    }
}

fn serve_request(
    stream: &mut TcpStream,
    doc: &Discovery,
    ready: &AtomicBool,
    on_focus: &impl Fn() -> bool,
) -> anyhow::Result<()> {
    let request: Request = read_frame(stream)?;
    ensure!(
        request.protocol == PROTOCOL
            && request.identity == doc.identity
            && request.instance == doc.instance
            && request.command == "focus"
            && uuid::Uuid::parse_str(&request.nonce).is_ok(),
        "主窗口握手请求无效"
    );
    verify(doc, &request.nonce, "request", "focus", &request.proof)?;
    let status = if !ready.load(Ordering::Acquire) {
        Status::Starting
    } else if on_focus() {
        Status::Focused
    } else {
        Status::Unavailable
    };
    write_frame(
        stream,
        &Response {
            protocol: PROTOCOL.into(),
            identity: doc.identity.clone(),
            instance: doc.instance.clone(),
            nonce: request.nonce.clone(),
            status,
            proof: signature(doc, &request.nonce, "response", status.as_str()),
        },
    )
}

fn read_document<T: DeserializeOwned>(path: &Path) -> anyhow::Result<T> {
    let mut bytes = Vec::new();
    File::open(path)?
        .take((MAX_FRAME + 1) as u64)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= MAX_FRAME, "主窗口发现文件过大");
    Ok(serde_json::from_slice(&bytes)?)
}

fn read_frame<T: DeserializeOwned>(stream: &mut TcpStream) -> anyhow::Result<T> {
    let deadline = Instant::now() + IO_TIMEOUT;
    let mut bytes = Vec::new();
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .context("主窗口握手读取超时")?;
        stream.set_read_timeout(Some(remaining))?;
        let mut byte = [0];
        stream.read_exact(&mut byte)?;
        if byte[0] == b'\n' {
            return Ok(serde_json::from_slice(&bytes)?);
        }
        ensure!(bytes.len() < MAX_FRAME, "主窗口握手消息过大");
        bytes.push(byte[0]);
    }
}

fn write_frame(stream: &mut TcpStream, value: &impl Serialize) -> anyhow::Result<()> {
    let mut bytes = serde_json::to_vec(value)?;
    ensure!(bytes.len() <= MAX_FRAME, "主窗口握手消息过大");
    bytes.push(b'\n');
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.write_all(&bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests;
