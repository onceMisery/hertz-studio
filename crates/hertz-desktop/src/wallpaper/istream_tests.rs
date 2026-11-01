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
    let stream: IStream = MediaIStream::open(&path, &pool).unwrap();
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
        stream.Seek(100, STREAM_SEEK_SET, Some(&mut position)).ok().unwrap();
        assert_eq!(position, 100);
        stream
            .Read(buffer.as_mut_ptr().cast(), 8, Some(&mut read))
            .ok()
            .unwrap();
        assert_eq!(read, 8);
        assert_eq!(&buffer[..8], &body[100..108]);
        assert_eq!(position, 100);

        // Seek CUR 相对推进。
        stream.Seek(2, STREAM_SEEK_CUR, Some(&mut position)).ok().unwrap();
        assert_eq!(position, 110);

        // Seek END -8 → 尾部。
        stream.Seek(-8, STREAM_SEEK_END, Some(&mut position)).ok().unwrap();
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
    let stream: IStream = MediaIStream::open(&path, &pool).unwrap();
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
    let (_dir, path, _body) = fixture("istream-write");
    let pool = StreamSlotPool::new();
    let stream: IStream = MediaIStream::open(&path, &pool).unwrap();
    unsafe {
        let mut written = 0u32;
        let hr = stream.Write("no".as_ptr().cast(), 2, Some(&mut written));
        assert!(hr.is_err(), "只读流的 Write 必须拒绝");

    }
}
