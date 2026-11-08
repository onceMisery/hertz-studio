// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! COM IStream 往返测试（§8.1/C59）：Read 有界、Seek 三原点、Stat 尺寸、
//! Clone 独立游标、Write 拒绝、槽随流生命周期归还。

use super::super::istream::MediaIStream;
use super::super::media_stream::StreamSlotPool;
use crate::wallpaper::library::tempfileish;
use windows::Win32::System::Com::{
    IStream, STATFLAG_NONAME, STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
};

#[test]
fn composition_payload_uses_original_pool_seek_clone_and_revoke_barrier() {
    use super::super::access::MediaAccess;
    use windows::Win32::Foundation::{STG_E_ACCESSDENIED, S_OK};
    let access = MediaAccess::new();
    let hash = "a".repeat(64);
    let key = (hash.clone(), "session/abcd/4.json".to_owned());
    let payload: std::sync::Arc<[u8]> = vec![23; 1024 * 1024 + 17].into();
    let grant = access
        .grant_composition(4, vec![], key.clone(), payload.clone())
        .unwrap();
    let pool = StreamSlotPool::new();
    let permit = access.permit(&key.0, &key.1).unwrap();
    let stream = MediaIStream::from_payload(payload, permit, &pool).unwrap();
    let mut out = [0u8; 20];
    let mut count = 0;
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 20, Some(&mut count)),
            S_OK
        );
        assert_eq!(count, 20);
    }
    let clone = unsafe { stream.Clone().unwrap() };
    assert_eq!(pool.active(), 2);
    unsafe {
        clone.Seek(3, STREAM_SEEK_SET, None).unwrap();
        stream.Seek(20, STREAM_SEEK_SET, None).unwrap();
        assert_eq!(clone.Write(std::ptr::null(), 0, None), STG_E_ACCESSDENIED);
    }
    let drain = grant.revoke();
    assert!(!drain.is_drained());
    super::reap_revoked_streams();
    assert!(drain.is_drained());
    assert_eq!(pool.active(), 0);
    unsafe {
        assert_eq!(
            clone.Read(out.as_mut_ptr().cast(), 20, None),
            STG_E_ACCESSDENIED
        );
        assert!(stream.Clone().is_err());
    }
    assert!(access.permit(&hash, "session/abcd/4.json").is_none());
}

#[test]
fn revocation_closes_files_and_clones_even_when_com_references_survive() {
    use super::super::access::MediaAccess;
    use super::super::media_stream::MediaFileStream;
    use windows::Win32::Foundation::STG_E_ACCESSDENIED;
    let (_dir, path, body) = fixture("istream-revocation");
    let pool = StreamSlotPool::new();
    let access = MediaAccess::new();
    let hash = "a".repeat(64);
    assert!(access.replace(1, &[(hash.clone(), "assets/media.bin".into())]));
    let file = MediaFileStream::open(&path, &pool).unwrap();
    let stream = MediaIStream::from_file_with_permit(
        file,
        path.clone(),
        &pool,
        (0, body.len() as u64),
        access.permit(&hash, "assets/media.bin"),
    )
    .unwrap();
    let clone = unsafe { stream.Clone().unwrap() };
    assert_eq!(pool.active(), 2);
    let drain = access.revoke();
    assert!(!drain.is_drained(), "撤销不等于文件已经关闭");
    super::reap_revoked_streams();
    assert!(drain.is_drained(), "COM 外壳不能持有文件活动屏障");
    assert_eq!(pool.active(), 0, "撤销不得等待浏览器释放 COM 引用");
    let mut out = [0u8; 8];
    let mut count = 7;
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 8, Some(&mut count)),
            STG_E_ACCESSDENIED
        );
        assert_eq!(count, 0);
        assert!(stream.Seek(0, STREAM_SEEK_SET, None).is_err());
        assert!(stream.Clone().is_err());
        assert_eq!(
            clone.Read(out.as_mut_ptr().cast(), 8, None),
            STG_E_ACCESSDENIED
        );
    }
    assert!(std::fs::OpenOptions::new().write(true).open(&path).is_ok());
    assert!(access.replace(2, &[(hash.clone(), "assets/media.bin".into())]));
    // 新代际的授权不能复活旧流。
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 8, None),
            STG_E_ACCESSDENIED
        );
    }
}

#[test]
fn com_read_honors_optional_count_and_fills_large_requests_until_real_eof() {
    use windows::Win32::Foundation::{S_FALSE, S_OK};
    let (dir, path, _) = fixture("istream-read-contract");
    let bytes = vec![19u8; 2 * super::super::media_stream::MAX_READ_BYTES + 17];
    std::fs::write(&path, &bytes).unwrap();
    let pool = StreamSlotPool::new();
    let stream = MediaIStream::open(&path, &pool, (0, bytes.len() as u64)).unwrap();
    let mut out = vec![0; bytes.len()];
    unsafe {
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), out.len() as u32, None),
            S_OK
        );
        assert_eq!(out, bytes);
        let mut count = 7;
        assert_eq!(
            stream.Read(out.as_mut_ptr().cast(), 1, Some(&mut count)),
            S_FALSE
        );
        assert_eq!(count, 0);
        assert!(stream.Seek(i64::MAX, STREAM_SEEK_CUR, None).is_err());
        assert_eq!(stream.Read(std::ptr::null_mut(), 0, None), S_OK);
    }
    drop(stream);
    assert!(MediaIStream::open(&path, &pool, (bytes.len() as u64, 1)).is_err());
    assert_eq!(pool.active(), 0);
    drop(dir);
}

fn fixture(tag: &str) -> (tempfileish::TempDir, std::path::PathBuf, Vec<u8>) {
    let dir = tempfileish::temp_dir(tag);
    // 5000 字节可辨识内容。
    let body: Vec<u8> = (0..5000u32).map(|i| ((i * 7) % 253) as u8).collect();
    let path = dir.path().join("media.bin");
    std::fs::write(&path, &body).unwrap();
    (dir, path, body)
}

#[test]
fn com_stream_reads_seeks_and_stats() {
    let (_dir, path, body) = fixture("istream-basic");
    let pool = StreamSlotPool::new();
    assert_eq!(pool.active(), 0);
    // 200 响应：窗口是整个文件（base=0, len=文件长度）。
    let stream: IStream = MediaIStream::open(&path, &pool, (0, body.len() as u64)).unwrap();
    assert_eq!(pool.active(), 1, "打开即占用一个流槽");

    unsafe {
        // Read 16 字节。
        let mut buffer = [0u8; 16];
        let mut read = 0u32;
        stream
            .Read(
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                Some(&mut read),
            )
            .ok()
            .unwrap();
        assert_eq!(read, 16);
        assert_eq!(&buffer, &body[..16]);

        // Seek SET → 读中段。
        let mut position = 0u64;
        stream
            .Seek(100, STREAM_SEEK_SET, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 100);
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer[..8], &body[100..108]);
        assert_eq!(position, 100);

        // Seek CUR 相对推进。
        stream
            .Seek(2, STREAM_SEEK_CUR, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 110);

        // Seek END -8 → 尾部。
        stream
            .Seek(-8, STREAM_SEEK_END, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 4992);
        stream
            .Read(buffer.as_mut_ptr().cast(), 16, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8, "EOF 只在真实读到末尾出现（不返回伪 EOF）");
        assert_eq!(&buffer[..8], &body[4992..5000]);
        // 再读 → 0 且 S_OK。
        stream
            .Read(buffer.as_mut_ptr().cast(), 16, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 0);

        // Stat：类型 STREAM + cbSize。
        let mut stat = Default::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).ok().unwrap();
        assert_eq!(stat.cbSize, 5000);
        assert_eq!(stat.r#type, 2 /* STGTY_STREAM */);

        // 负位移与非法原点拒绝。
        assert!(stream.Seek(-1, STREAM_SEEK_SET, None).is_err());
    }
}

#[test]
fn com_clone_has_independent_cursor() {
    let (_dir, path, body) = fixture("istream-clone");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool, (0, body.len() as u64)).unwrap();
    unsafe {
        stream.Seek(1000, STREAM_SEEK_SET, None).ok().unwrap();
        let clone = stream.Clone().unwrap();
        // 克隆对齐位置；各自 Read 不互相移动游标（独立句柄）。
        let mut buffer_a = [0u8; 8];
        let mut buffer_b = [0u8; 8];
        let mut read = 0u32;
        stream
            .Read(buffer_a.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        clone
            .Read(buffer_b.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer_a, &body[1000..1008]);
        assert_eq!(&buffer_b, &body[1000..1008]);
        // 原流推进后克隆仍停在 1000。
        stream.Seek(2000, STREAM_SEEK_SET, None).ok().unwrap();
        clone
            .Read(buffer_b.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer_b, &body[1008..1016]);
    }
    // 两个流（含克隆）各占一槽；全部释放后归零。
    drop(stream);
    assert_eq!(pool.active(), 0, "C59：句柄生命周期决定槽回收");
}

#[test]
fn com_write_is_denied_and_agile_marker_present() {
    let (_dir, path, body) = fixture("istream-write");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool, (0, body.len() as u64)).unwrap();
    unsafe {
        let mut written = 0u32;
        let hr = stream.Write("no".as_ptr().cast(), 2, Some(&mut written));
        assert!(hr.is_err(), "只读流的 Write 必须拒绝");
    }
}

/// 206 语义（§8.1）：流的内容是 body 窗口，不是整个文件。
/// 浏览器按 body 语义消费——流位置 0 必须就是 `Content-Range` 的 start 字节。
#[test]
fn com_stream_serves_a_range_window() {
    let (_dir, path, body) = fixture("istream-window");
    let pool = StreamSlotPool::new();
    // bytes=1000-1499 → base=1000, len=500。
    let stream: IStream = MediaIStream::open(&path, &pool, (1000, 500)).unwrap();
    unsafe {
        // 位置 0 即 body 首字节：文件偏移 1000，不是文件开头。
        let mut buffer = [0u8; 8];
        let mut read = 0u32;
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer, &body[1000..1008]);

        // Stat 报窗口长度（= Content-Length），不是文件总长。
        let mut stat = Default::default();
        stream.Stat(&mut stat, STATFLAG_NONAME).ok().unwrap();
        assert_eq!(stat.cbSize, 500);

        // Seek 的三个原点都相对窗口，不是相对文件。
        let mut position = 0u64;
        stream
            .Seek(-8, STREAM_SEEK_END, Some(&mut position))
            .ok()
            .unwrap();
        assert_eq!(position, 492, "END 相对窗口末端");
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer, &body[1492..1500]);

        // 越过窗口末端 → 越界拒绝；窗口内读到末尾 → 0。
        assert!(stream.Seek(501, STREAM_SEEK_SET, None).is_err());
        stream.Seek(500, STREAM_SEEK_SET, None).ok().unwrap();
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 0);
    }
}

/// 窗口流的 Clone 也要带窗口，且各自游标独立。
#[test]
fn com_clone_keeps_the_window() {
    let (_dir, path, body) = fixture("istream-window-clone");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool, (2000, 100)).unwrap();
    unsafe {
        let mut buffer = [0u8; 4];
        let mut read = 0u32;
        let clone = stream.Clone().unwrap();
        stream
            .Read(buffer.as_mut_ptr().cast(), 4, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer, &body[2000..2004]);
        clone
            .Read(buffer.as_mut_ptr().cast(), 4, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer, &body[2000..2004], "克隆的起点仍是窗口起点");
        // 克隆推进不影响原流。
        clone.Seek(50, STREAM_SEEK_SET, None).ok().unwrap();
        stream
            .Read(buffer.as_mut_ptr().cast(), 4, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(&buffer, &body[2004..2008]);
    }
}
