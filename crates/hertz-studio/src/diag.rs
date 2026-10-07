// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! 开发者选项：播放链诊断日志。
//!
//! 默认关闭。开启后把「点了哪首、选了哪个音源与音质、走缓存还是现下载、地址是
//! 哪一个、为什么失败」逐条追加到 `<data_dir>/logs/playback.log`，用户把这一个
//! 文件发给开发者就够定位播放问题。
//!
//! 三条约束决定了这里的形状：
//!
//! - 关闭时 [`diaglog!`] 只做一次原子读，不格式化、不碰文件系统；
//! - 写失败一律吞掉——诊断日志不能把播放带崩；
//! - 在线流地址只留 `scheme://host/path`。网易 / QQ / 酷狗的 vkey、签名与临时
//!   token 都在 query 里，而这份文件注定要被转发给别人。
//!
//! 唯一的例外是崩溃：[`install_panic_hook`] 装的钩子**无视开关**写一条 `panic`
//! 行并给一个 `report` 编号。开关关着的时候进程照样会崩，而「它自己没了」是用户
//! 唯一能说的话 —— 没有编号和路径，这句反馈接不住。

use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// settings 表里的开关键。缺键即关闭，不需要迁移。
pub const SETTING_KEY: &str = "dev_diagnostics";
/// 唯一的日志文件名：交接时「把 logs 里那个文件发过来」不需要解释。
pub const FILE_NAME: &str = "playback.log";

/// 单文件上限。超出后裁掉最旧的一半，让这一个文件始终是完整的近期历史。
const MAX_BYTES: u64 = 2 * 1024 * 1024;
/// 单个字段值的上限：上游错误消息可能整段 HTML。
const MAX_VALUE_CHARS: usize = 220;

/// 一次性写入的会话头与环境，由 [`init`] 固定。
struct Meta {
    dir: PathBuf,
    backend: String,
}

/// 崩溃现场的一条记录（进程内只留最后一次，供诊断面板在开关关着时也读得到）。
#[derive(Debug, Clone)]
pub struct CrashRecord {
    pub report: String,
    pub at: String,
    pub location: String,
    pub message: String,
}

static ENABLED: AtomicBool = AtomicBool::new(false);
static META: OnceLock<Meta> = OnceLock::new();
/// 串行化追加与裁剪。只在一次小文件写入期间持有，不跨 await。
static WRITE_LOCK: Mutex<()> = Mutex::new(());
static LAST_CRASH: Mutex<Option<CrashRecord>> = Mutex::new(None);

/// 记录一条诊断。
///
/// 用宏而不是函数：关闭时参数必须完全不求值。`diaglog!("play.begin", idx = index)`
/// 展开成键名字面量加 Display 装箱，读起来就是最终落盘的样子。
#[macro_export]
macro_rules! diaglog {
    ($kind:literal $(, $key:ident = $value:expr)* $(,)?) => {
        if $crate::diag::enabled() {
            $crate::diag::event(
                $kind,
                &[$((stringify!($key), $crate::diag::value(&$value))),*],
            );
        }
    };
}

/// 供宏使用的取值桥：把任意 Display 变成待写入的字符串。
pub fn value(v: &dyn fmt::Display) -> String {
    v.to_string()
}

/// 记录日志目录与音频后端。启动时调用一次；没调用过（测试里）写入静默跳过。
pub fn init(data_dir: &Path, backend: &str) {
    let _ = META.set(Meta {
        dir: data_dir.join("logs"),
        backend: backend.to_string(),
    });
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// 日志文件的应然路径。即使从未开启过也返回，界面好把「写到哪里」讲清楚。
pub fn log_path() -> Option<PathBuf> {
    META.get().map(|m| m.dir.join(FILE_NAME))
}

/// 今天的日期（UTC，`2026-10-01`），用于导出文件名。
pub fn today() -> String {
    stamp(SystemTime::now())[..10].to_string()
}

/// 开 / 关。开启即写一条会话头（版本、系统、后端、时间基准），这样发来的文件
/// 能自证是在什么环境上录的；关闭也留一行，免得日志尾部看起来像戛然而止。
pub fn set_enabled(on: bool) {
    if ENABLED.swap(on, Ordering::Relaxed) == on {
        return;
    }
    if !on {
        // 此刻 ENABLED 已经是 false，走 event() 会被自己的开关检查挡掉——
        // 收尾行必须绕过开关直接写。
        write_line("session.end", &[]);
        return;
    }
    let (backend, dir) = match META.get() {
        Some(m) => (m.backend.clone(), m.dir.display().to_string()),
        None => (String::new(), String::new()),
    };
    write_line(
        "session.begin",
        &[
            ("version", value(&env!("CARGO_PKG_VERSION"))),
            ("os", value(&std::env::consts::OS)),
            ("arch", value(&std::env::consts::ARCH)),
            ("backend", backend),
            ("dir", dir),
            (
                "note",
                value(&"times are UTC (北京时间 +8); 播放地址已隐去 query"),
            ),
        ],
    );
}

/// 写一条诊断。关闭或未初始化时直接返回，任何 IO 失败都不向上抛。
pub fn event(kind: &str, fields: &[(&str, String)]) {
    if enabled() {
        write_line(kind, fields);
    }
}

/// 记一次崩溃：**无视开关**写一行 `panic`，并把现场留在进程内供诊断面板读。
/// 写完仍要走默认钩子 —— 终端里的原始 panic 输出是给开发者自己的。
pub fn crash(report: &str, location: &str, message: &str) {
    let now = stamp(SystemTime::now());
    let path = log_path()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| String::from("未初始化"));
    write_line(
        "panic",
        &[
            ("report", value(&report)),
            ("where", value(&location)),
            ("msg", value(&message)),
            ("log", value(&path)),
        ],
    );
    let mut last = LAST_CRASH.lock().unwrap_or_else(|e| e.into_inner());
    *last = Some(CrashRecord {
        report: report.to_string(),
        at: now,
        location: location.to_string(),
        message: message.to_string(),
    });
}

/// 最后一次崩溃（没有则 None）。诊断面板即使开关关着也要显示它：「它自己没了」
/// 这种反馈必须先有一个可交接的编号，否则下一次崩溃仍然无从对上。
pub fn last_crash() -> Option<serde_json::Value> {
    let guard = LAST_CRASH.lock().ok()?;
    let record = guard.as_ref()?;
    Some(serde_json::json!({
        "report": record.report,
        "at": record.at,
        "where": record.location,
        "message": record.message,
    }))
}

/// 装 panic 钩子（在 `init` 之后调用一次）。钩子自己绝不能再 panic：只走
/// `to_string` / 忽略 IO 失败的写法，且写完交回默认钩子。
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = if let Some(s) = payload.downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            String::from("panicked（载荷不是字符串）")
        };
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| String::from("未知位置"));
        crash(&new_report(), &location, &message);
        previous(info);
    }));
}

/// 八位十六进制编号：够一次会话里区分几次崩溃，又短到口头报得出来。
fn new_report() -> String {
    let full = uuid::Uuid::new_v4().simple().to_string();
    full[..8].to_string()
}

/// 供 `diagnostics_json` 用：测试里可复位，避免用例之间互相看到对方的崩溃。
#[cfg(test)]
pub(crate) fn forget_last_crash() {
    let mut last = LAST_CRASH.lock().unwrap_or_else(|e| e.into_inner());
    *last = None;
}

fn write_line(kind: &str, fields: &[(&str, String)]) {
    let mut line = String::with_capacity(96);
    line.push_str(&stamp(SystemTime::now()));
    line.push(' ');
    line.push_str(kind);
    for (key, raw) in fields {
        line.push(' ');
        line.push_str(key);
        line.push('=');
        push_value(&mut line, raw);
    }
    line.push('\n');
    let _ = append(&line);
}

/// 概况：是否存在、字节数、最后修改时间（epoch ms）。除了路径再给一句「有多少
/// 内容」，用户就知道该不该导出发出去。
pub fn stat() -> (bool, u64, i64) {
    let Some(path) = log_path() else {
        return (false, 0, 0);
    };
    let Ok(md) = std::fs::metadata(&path) else {
        return (false, 0, 0);
    };
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (true, md.len(), mtime)
}

/// 读出内容供复制 / 下载。`limit` 是上限，超出只给最新的部分；第二个返回值是
/// 被省略的字节数（0 表示给全了）。
pub fn read(limit: u64) -> io::Result<(String, u64)> {
    let Some(path) = log_path() else {
        return Ok((String::new(), 0));
    };
    let mut file = match File::open(&path) {
        Ok(f) => f,
        // 没开启过 / 刚清空：空文件不是错误，界面按「暂无日志」处理。
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok((String::new(), 0)),
        Err(e) => return Err(e),
    };
    let len = file.metadata()?.len();
    let skipped = len.saturating_sub(limit);
    if skipped > 0 {
        file.seek(SeekFrom::Start(skipped))?;
    }
    let mut buf = Vec::with_capacity((len - skipped) as usize);
    file.read_to_end(&mut buf)?;
    Ok((String::from_utf8_lossy(&buf).into_owned(), skipped))
}

/// 清空：删掉日志文件。目录留着，下次写入会重建文件。
pub fn clear() -> io::Result<()> {
    let Some(path) = log_path() else {
        return Ok(());
    };
    let _lock = lock();
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// 在线流地址只留 `scheme://host[:port]/path`，丢掉 query 与 userinfo。
pub fn redact_url(raw: &str) -> String {
    let head = raw.split(['?', '#']).next().unwrap_or(raw);
    let scheme_end = head.find("://").map(|i| i + 3).unwrap_or(0);
    match head[scheme_end..].find('@') {
        // `https://user:pass@host/x.mp3` 里的凭据同样不留。
        Some(skip) => format!("{}{}", &head[..scheme_end], &head[scheme_end + skip + 1..]),
        None => head.to_string(),
    }
}

fn append(text: &str) -> io::Result<()> {
    let meta = META
        .get()
        .ok_or_else(|| io::Error::other("diag 未初始化（未调用 init）"))?;
    let _lock = lock();
    std::fs::create_dir_all(&meta.dir)?;
    let path = meta.dir.join(FILE_NAME);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?
        .write_all(text.as_bytes())?;
    trim_if_over(&path)
}

/// 超上限时保留最新一半并重写整文件（从第一个完整行切起）。宁可丢最旧的记录，
/// 也不要用户面对 playback.log / playback.log.1 两套编号去猜哪个是当前的。
fn trim_if_over(path: &Path) -> io::Result<()> {
    let len = std::fs::metadata(path)?.len();
    if len <= MAX_BYTES {
        return Ok(());
    }
    let skip = len - MAX_BYTES / 2;
    let mut buf = Vec::with_capacity((len - skip) as usize);
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(skip))?;
    file.read_to_end(&mut buf)?;
    let dropped = match buf.iter().position(|b| *b == b'\n') {
        Some(n) => {
            buf.drain(..=n);
            n + 1
        }
        None => 0,
    };
    let mut out = format!(
        "{} trimmed dropped_bytes={}\n",
        stamp(SystemTime::now()),
        skip + dropped as u64
    );
    out.push_str(&String::from_utf8_lossy(&buf));
    // 两阶段：先写同目录临时文件再 rename 覆盖。原先直接 `File::create(path)`
    // 会先把当前日志截断成 0 再写，进程（或杀软、或磁盘满）正卡在这中间时，
    // 用户发来的就是一份被裁掉的日志**加上**丢失的现场 —— 而裁剪恰恰发生在
    // 日志最长、最可能有内容的那一刻。
    let tmp = path.with_extension("log.trim.tmp");
    File::create(&tmp)?.write_all(out.as_bytes())?;
    std::fs::rename(&tmp, path)
}

/// 值写法：折行压成空格、限长、只在必要时加引号并转义。裸值让日志能直接 grep。
fn push_value(out: &mut String, raw: &str) {
    let clipped = clip(raw.trim(), MAX_VALUE_CHARS);
    let flat: String = clipped
        .chars()
        .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
        .collect();
    let needs_quotes = flat.is_empty() || flat.chars().any(|c| matches!(c, ' ' | '=' | '"' | '\\'));
    if !needs_quotes {
        out.push_str(&flat);
        return;
    }
    out.push('"');
    for c in flat.chars() {
        match c {
            '"' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out.push('"');
}

/// 按字符数截断（不是字节），保证不切在 UTF-8 中间。
fn clip(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

fn lock() -> MutexGuard<'static, ()> {
    // 诊断写入失败不该 panic，更不该因为一次 poisoned 锁永久失声。
    WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// `2026-10-01T06:32:11.883Z`。只用 std：为一个时间格式拉 chrono 不划算，
/// 统一 UTC 并写进会话头，避免「用户说 14:32、日志差 8 小时」。
fn stamp(now: SystemTime) -> String {
    let Ok(elapsed) = now.duration_since(UNIX_EPOCH) else {
        return "1970-01-01T00:00:00.000Z".to_string();
    };
    let secs = elapsed.as_secs();
    let millis = elapsed.subsec_millis();
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let day = secs % 86_400;
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        day / 3600,
        (day % 3600) / 60,
        day % 60,
    )
}

/// Howard Hinnant 的 civil_from_days：从 unix 天数还原年月日。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m as u32, d as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ts(secs: u64) -> SystemTime {
        UNIX_EPOCH + std::time::Duration::from_secs(secs)
    }

    /// 每个用例一个独立临时目录；OnceLock 只能 init 一次，所以涉及落盘的断言
    /// 全部并到一个用例里按顺序走完整生命周期。
    struct Tmp(PathBuf);

    impl Tmp {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "vmusic-diag-{tag}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let _ = std::fs::remove_dir_all(&dir);
            Self(dir)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn stamp_formats_utc_wall_clock() {
        assert_eq!(stamp(ts(0)), "1970-01-01T00:00:00.000Z");
        assert_eq!(stamp(ts(1_700_000_000)), "2023-11-14T22:13:20.000Z");
        // 闰日：2024-02-29T03:59:59Z。
        assert_eq!(stamp(ts(1_709_179_199)), "2024-02-29T03:59:59.000Z");
    }

    #[test]
    fn redact_url_drops_query_and_credentials() {
        assert_eq!(
            redact_url("https://music.163.com/song/1.flac?signature=abc&uid=9&t=1"),
            "https://music.163.com/song/1.flac"
        );
        assert_eq!(
            redact_url("http://user:pass@cdn.example.com:8080/a.mp3#frag"),
            "http://cdn.example.com:8080/a.mp3"
        );
        // 没有 query 的地址原样保留；空串不是 panic。
        assert_eq!(
            redact_url("https://a.example/x.mp3"),
            "https://a.example/x.mp3"
        );
        assert_eq!(redact_url(""), "");
    }

    #[test]
    fn values_are_quoted_only_when_needed_and_clipped() {
        let mut line = String::new();
        push_value(&mut line, "晴天");
        assert_eq!(line, "晴天");

        let mut line = String::new();
        push_value(&mut line, "bad status: 403 Forbidden");
        assert_eq!(line, r#""bad status: 403 Forbidden""#);

        let mut line = String::new();
        push_value(&mut line, "第一行\n第二行");
        assert_eq!(line, "\"第一行 第二行\"");

        let long = "啊".repeat(MAX_VALUE_CHARS + 10);
        assert_eq!(
            clip(&long, MAX_VALUE_CHARS).chars().count(),
            MAX_VALUE_CHARS + 1
        );
    }

    #[test]
    fn lifecycle_disabled_then_enabled_read_and_clear() {
        let tmp = Tmp::new("lifecycle");
        // 关闭时：event 早退，目录都不该被建出来。
        ENABLED.store(false, Ordering::Relaxed);
        init(&tmp.0, "cpal");
        event("play.begin", &[("idx", value(&1usize))]);
        assert!(!tmp.0.join("logs").exists(), "关闭时不应写盘");

        // 开启：会话头 + 条目落盘，字段按 kind=value 排布。
        set_enabled(true);
        event(
            "play.begin",
            &[
                ("idx", value(&3usize)),
                ("title", value(&"晴天 周杰伦")),
                ("source", value(&"netease")),
            ],
        );
        let (text, skipped) = read(MAX_BYTES).unwrap();
        assert_eq!(skipped, 0);
        assert!(text.contains("session.begin version="), "{text}");
        assert!(text.contains("backend=cpal"), "{text}");
        assert!(
            text.contains(r#"play.begin idx=3 title="晴天 周杰伦" source=netease"#),
            "{text}"
        );
        let (exists, size, _) = stat();
        assert!(exists && size > 0);

        // 清空：文件没了，开关不受影响（用户还会继续录）。
        clear().unwrap();
        assert!(!log_path().unwrap().exists());
        assert!(enabled());
        let (text, _) = read(MAX_BYTES).unwrap();
        assert!(text.is_empty());

        // 关闭：ENABLED 已经先落到 false，收尾行仍必须写出去（绕过开关检查），
        // 否则日志尾部看起来像进程被杀，而不是用户关掉了它。
        set_enabled(false);
        let (text, _) = read(MAX_BYTES).unwrap();
        assert!(text.contains("session.end"), "{text}");
        assert!(!enabled());

        // 关闭后新事件不再落盘。
        event("play.begin", &[("idx", value(&9usize))]);
        let (text, _) = read(MAX_BYTES).unwrap();
        assert!(!text.contains("play.begin"), "{text}");

        // 崩溃是唯一的例外：开关关着也必须留下编号与现场，否则「它自己没了」这句
        // 反馈没有任何可交接的东西，下一次崩溃还是对不上。
        forget_last_crash();
        crash(
            "abcd1234",
            "crates/hertz-studio/src/state.rs:42",
            "index 越界",
        );
        let (text, _) = read(MAX_BYTES).unwrap();
        assert!(
            text.contains(
                r#"panic report=abcd1234 where=crates/hertz-studio/src/state.rs:42 msg="index 越界""#
            ),
            "{text}"
        );
        // 同一份现场还要能被诊断面板读到（进程内缓存，不依赖文件被打开过）。
        let last = last_crash().expect("记过崩溃就该查得到");
        assert_eq!(last["report"], "abcd1234");
        assert_eq!(last["where"], "crates/hertz-studio/src/state.rs:42");
        assert!(last["at"].as_str().unwrap_or_default().starts_with("20"));
        assert!(!enabled(), "记崩溃不许顺手把诊断开关打开");
    }

    /// 编号短到口头报得出来，且每次不同（一次会话里可能崩好几回）。
    #[test]
    fn crash_reports_are_short_and_distinct() {
        let a = new_report();
        let b = new_report();
        assert_eq!(a.len(), 8, "{a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()), "{a}");
        assert_ne!(a, b);
    }

    #[test]
    fn trim_keeps_the_newest_half_on_one_line_boundary() {
        let tmp = Tmp::new("trim");
        std::fs::create_dir_all(&tmp.0).unwrap();
        let path = tmp.0.join(FILE_NAME);
        // 造一个超限文件：每行 100 字节左右，行数足够多到跨过 MAX_BYTES。
        let mut big = String::new();
        while big.len() < (MAX_BYTES as usize + 4096) {
            big.push_str(&format!(
                "2026-10-01T00:00:00.000Z play.begin idx={:<6} {}\n",
                big.len(),
                "x".repeat(80)
            ));
        }
        std::fs::write(&path, &big).unwrap();

        trim_if_over(&path).unwrap();

        let kept = std::fs::read_to_string(&path).unwrap();
        assert!(kept.len() < MAX_BYTES as usize / 2 + 4096, "{}", kept.len());
        assert!(kept.starts_with(&stamp(SystemTime::now())[..11]), "{kept}");
        assert!(kept.contains("trimmed dropped_bytes="));
        // 保留段必须从完整行开始：首行仍是可解析的一条记录。
        let first = kept.lines().nth(1).unwrap_or_default();
        assert!(first.contains("play.begin idx="), "{first}");
        // 未超限时不动文件。
        std::fs::write(&path, "short\n").unwrap();
        trim_if_over(&path).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "short\n");
        // 两阶段写完不许留残骸：logs 里多出一个 .tmp，用户就会对着两个文件猜
        // 哪个是当前的（这个目录的全部意义是「把这一个文件发过来」）。
        let leftovers: Vec<String> = std::fs::read_dir(&tmp.0)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件: {leftovers:?}");
    }
}
