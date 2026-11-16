// SPDX-License-Identifier: MIT
//! The single paired-loopback transport for bounded JSON and streamed artifacts.
use super::*;
use std::io::{Read, Write};
use std::net::TcpStream;

struct Response {
    stream: TcpStream,
    code: u16,
    length: usize,
    mime: Option<String>,
    initial: Vec<u8>,
    deadline: Instant,
}
struct Policy<'a> {
    maximum: usize,
    duration: Duration,
    cancel: Option<&'a AtomicBool>,
}

fn read_chunk(
    stream: &mut TcpStream,
    buffer: &mut [u8],
    deadline: Instant,
    cancel: Option<&AtomicBool>,
) -> Result<usize> {
    loop {
        if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
            return Err(error("cancelled", "候选接收已取消"));
        }
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or_else(|| error("service_unavailable", "读取响应已超时"))?;
        let interval = if cancel.is_some() {
            remaining.min(Duration::from_millis(200))
        } else {
            remaining
        };
        stream
            .set_read_timeout(Some(interval))
            .map_err(|_| error("service_unavailable", "无法设置响应期限"))?;
        match stream.read(buffer) {
            Ok(0) => return Err(error("invalid_response", "响应提前结束")),
            Ok(n) => return Ok(n),
            Err(e)
                if cancel.is_some()
                    && matches!(
                        e.kind(),
                        std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                    ) =>
            {
                continue
            }
            Err(_) => return Err(error("service_unavailable", "读取响应未完成，请查询原请求")),
        }
    }
}

fn start(
    connection: &Connection,
    port: u16,
    method: &str,
    path: &str,
    body: Option<Value>,
    policy: Policy<'_>,
) -> Result<Response> {
    let Policy {
        maximum,
        duration,
        cancel,
    } = policy;
    if !matches!(method, "GET" | "POST" | "DELETE") || path.bytes().any(|b| b <= b' ' || b == 127) {
        return Err(error("invalid_input", "请求无效"));
    }
    let bytes = body
        .map(|v| serde_json::to_vec(&v))
        .transpose()
        .map_err(|_| error("invalid_input", "请求无法编码"))?
        .unwrap_or_default();
    if bytes.len() > 16 * 1024 {
        return Err(error("invalid_input", "请求超过16 KiB"));
    }
    let deadline = Instant::now() + duration;
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(1))
        .map_err(|_| error("service_unavailable", "本机连接未完成"))?;
    hertz_desktop_ipc::windows::verify_loopback_peer(
        &stream,
        connection.binding.service_pid,
        &connection.service_generation,
    )
    .map_err(|_| error("service_identity_mismatch", "连接不属于已配对的播放器"))?;
    if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err(error("cancelled", "候选接收已取消"));
    }
    stream
        .set_write_timeout(Some(
            deadline
                .saturating_duration_since(Instant::now())
                .max(Duration::from_millis(1)),
        ))
        .map_err(|_| error("service_unavailable", "无法设置请求期限"))?;
    let auth = connection
        .bearer
        .as_ref()
        .map(|v| format!("Authorization: Bearer {v}\r\n"))
        .unwrap_or_default();
    let headers = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{auth}\r\n", bytes.len());
    stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(&bytes))
        .map_err(|_| error("service_unavailable", "请求回执未完成，请查询原请求"))?;
    let mut received = Vec::with_capacity(12 * 1024);
    let mut buffer = [0u8; 4096];
    let end = loop {
        let n = read_chunk(&mut stream, &mut buffer, deadline, cancel)?;
        received.extend_from_slice(&buffer[..n]);
        if let Some(index) = received.windows(4).position(|w| w == b"\r\n\r\n") {
            if index > 8192 {
                return Err(error("invalid_response", "响应头过大"));
            }
            break index + 4;
        }
        if received.len() > 8192 {
            return Err(error("invalid_response", "响应头过大"));
        }
    };
    let header = std::str::from_utf8(&received[..end])
        .map_err(|_| error("invalid_response", "响应头无效"))?;
    let mut lines = header.split("\r\n");
    let mut status = lines.next().unwrap_or("").split(' ');
    if status.next() != Some("HTTP/1.1") {
        return Err(error("invalid_response", "响应协议无效"));
    }
    let code = status
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|n| (200..=599).contains(n))
        .ok_or_else(|| error("invalid_response", "响应状态无效"))?;
    let mut length = None;
    let mut mime = None;
    for line in lines.filter(|s| !s.is_empty()) {
        let (name, value) = line
            .split_once(':')
            .ok_or_else(|| error("invalid_response", "响应头无效"))?;
        if name.eq_ignore_ascii_case("transfer-encoding")
            || name.eq_ignore_ascii_case("content-encoding")
        {
            return Err(error(
                "invalid_response",
                "本机响应必须提供未编码的明确长度",
            ));
        }
        if name.eq_ignore_ascii_case("content-length") {
            if length.is_some() {
                return Err(error("invalid_response", "响应长度重复"));
            }
            length = Some(
                value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| error("invalid_response", "响应长度无效"))?,
            );
        }
        if name.eq_ignore_ascii_case("content-type") {
            if mime.is_some() {
                return Err(error("invalid_response", "响应类型重复"));
            }
            mime = Some(value.trim().to_owned());
        }
    }
    let length = length.ok_or_else(|| error("invalid_response", "响应缺少长度"))?;
    if length > maximum {
        return Err(error("response_too_large", "响应超过上限"));
    }
    let initial = received.split_off(end);
    if initial.len() > length {
        return Err(error("invalid_response", "响应长度不匹配"));
    }
    Ok(Response {
        stream,
        code,
        length,
        mime,
        initial,
        deadline,
    })
}

fn body(response: &mut Response, out: &mut impl Write, cancel: Option<&AtomicBool>) -> Result<()> {
    out.write_all(&response.initial)
        .map_err(|e| JobError::io(e.to_string()))?;
    let mut remaining = response.length - response.initial.len();
    let mut buffer = [0u8; 16 * 1024];
    while remaining > 0 {
        let capacity = remaining.min(buffer.len());
        let n = read_chunk(
            &mut response.stream,
            &mut buffer[..capacity],
            response.deadline,
            cancel,
        )?;
        out.write_all(&buffer[..n])
            .map_err(|e| JobError::io(e.to_string()))?;
        remaining -= n;
    }
    if cancel.is_some_and(|c| c.load(Ordering::Acquire)) {
        return Err(error("cancelled", "候选接收已取消"));
    }
    Ok(())
}

pub(super) fn request(
    connection: &Connection,
    port: u16,
    method: &str,
    path: &str,
    input: Option<Value>,
) -> Result<(bool, Vec<u8>)> {
    let mut response = start(
        connection,
        port,
        method,
        path,
        input,
        Policy {
            maximum: 64 * 1024,
            duration: Duration::from_secs(2),
            cancel: None,
        },
    )?;
    let mut bytes = Vec::with_capacity(response.length);
    body(&mut response, &mut bytes, None)?;
    Ok(((200..300).contains(&response.code), bytes))
}

pub(super) fn artifact(
    connection: &Connection,
    port: u16,
    artifact: &hertz_wallpaper::generation::WallpaperArtifact,
    target: &std::path::Path,
    cancel: &AtomicBool,
) -> Result<()> {
    artifact.validate().map_err(|e| error(e.code, &e.message))?;
    if uuid::Uuid::parse_str(&artifact.artifact_id).is_err() {
        return Err(error("invalid_input", "候选标识无效"));
    }
    let mut response = start(
        connection,
        port,
        "GET",
        &format!("/v1/ai/wallpaper/artifacts/{}", artifact.artifact_id),
        None,
        Policy {
            maximum: hertz_wallpaper::generation::MAX_ARTIFACT_BYTES as usize,
            duration: Duration::from_secs(30),
            cancel: Some(cancel),
        },
    )?;
    if response.code != 200 {
        return Err(error(
            "ai_artifact_unavailable",
            "候选接收失败，可重取同一候选",
        ));
    }
    if response.length as u64 != artifact.bytes
        || response.mime.as_deref() != Some(artifact.mime.as_str())
    {
        return Err(error("ai_output_rejected", "候选长度或类型与原回执不符"));
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|e| JobError::io(e.to_string()))?;
    struct Hashed<'a> {
        file: &'a mut std::fs::File,
        hash: sha2::Sha256,
    }
    impl Write for Hashed<'_> {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            use sha2::Digest;
            let n = self.file.write(bytes)?;
            self.hash.update(&bytes[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            self.file.flush()
        }
    }
    use sha2::Digest;
    let mut output = Hashed {
        file: &mut file,
        hash: sha2::Sha256::new(),
    };
    body(&mut response, &mut output, Some(cancel))?;
    if format!("{:x}", output.hash.finalize()) != artifact.sha256 {
        return Err(error("ai_output_rejected", "候选哈希与原回执不符"));
    }
    file.sync_all().map_err(|e| JobError::io(e.to_string()))?;
    Ok(())
}
