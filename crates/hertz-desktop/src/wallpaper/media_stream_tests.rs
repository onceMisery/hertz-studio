// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! §8.1 Range 表全行 + 有界流/槽池测试（C49/C59）。

use super::*;
use crate::wallpaper::library::tempfileish;

fn plan(header: Option<&str>, total: u64, head: bool) -> StreamPlan {
    plan_response(head, parse_range_header(header, total), total)
}

#[test]
fn range_table_full_and_head() {
    // GET 无 Range / HEAD：200；完整 Content-Length=N；HEAD 无响应体。
    let full = plan(None, 1000, false);
    assert_eq!((full.status, full.content_length, full.body), (200, 1000, true));
    assert!(full.content_range.is_none());
    let head = plan(None, 1000, true);
    assert_eq!((head.status, head.content_length, head.body), (200, 1000, false));
    // 非 bytes 单位：忽略（整文件）。
    assert_eq!(plan(Some("chunks=0-1"), 1000, false).status, 200);
}

#[test]
fn range_table_single_forms() {
    // 闭区间。
    let closed = plan(Some("bytes=0-499"), 1000, false);
    assert_eq!(closed.status, 206);
    assert_eq!(closed.content_length, 500);
    assert_eq!(closed.content_range.as_deref(), Some("bytes 0-499/1000"));
    // 开放末端。
    let open = plan(Some("bytes=500-"), 1000, false);
    assert_eq!(open.status, 206);
    assert_eq!(open.content_length, 500);
    assert_eq!(open.content_range.as_deref(), Some("bytes 500-999/1000"));
    // 后缀。
    let suffix = plan(Some("bytes=-100"), 1000, false);
    assert_eq!(suffix.status, 206);
    assert_eq!(suffix.content_range.as_deref(), Some("bytes 900-999/1000"));
    // 后缀超过总长 → 整个文件。
    let big_suffix = plan(Some("bytes=-5000"), 1000, false);
    assert_eq!(big_suffix.content_range.as_deref(), Some("bytes 0-999/1000"));
    // 末端裁剪至 N-1（§8.1：末端裁至 N−1）。
    let clipped = plan(Some("bytes=900-5000"), 1000, false);
    assert_eq!(clipped.content_range.as_deref(), Some("bytes 900-999/1000"));
    assert_eq!(clipped.content_length, 100);
}

#[test]
fn range_table_unsatisfiable_and_malformed() {
    // 有效但不可满足 → 416 + bytes */N，不创建文件流。
    let beyond = plan(Some("bytes=1000-"), 1000, false);
    assert_eq!(beyond.status, 416);
    assert_eq!(beyond.content_range.as_deref(), Some("bytes */1000"));
    assert_eq!(beyond.content_length, 0);
    let zero_total = plan(Some("bytes=0-"), 0, false);
    assert_eq!(zero_total.status, 416);
    // 语法错误/多范围/溢出 → 400。
    for bad in [
        "bytes=500-100",
        "bytes=-",
        "bytes=a-b",
        "bytes=0-499,500-999", // 多范围
        "bytes=+0-10",         // 符号前缀
        "bytes= 0-10",         // 空格
        "bytes=0-18446744073709551616", // u64 溢出
        "bytes=-0",            // 零长度后缀（非空文件）
    ] {
        let malformed = plan(Some(bad), 1000, false);
        assert_eq!(malformed.status, 400, "{bad}");
        assert!(malformed.content_range.is_none());
    }
    // "bytes=-0" 在空文件上属于「什么都要不到」→ 416。
    assert_eq!(plan(Some("bytes=-0"), 0, false).status, 416);
}

#[test]
fn bounded_stream_reads_and_real_eof() {
    let dir = tempfileish::temp_dir("media-stream");
    let path = dir.path().join("media.bin");
    let body: Vec<u8> = (0..3000u32).map(|i| (i % 251) as u8).collect();
    std::fs::write(&path, &body).unwrap();
    let pool = StreamSlotPool::new();
    let mut stream = MediaFileStream::open(&path, &pool).unwrap();
    assert_eq!(stream.total(), 3000);
    // 1 MiB 上限对 3000 字节无感；读两段验证游标。
    let mut out = [0u8; 2048];
    let first = stream.read_bounded(&mut out).unwrap();
    assert_eq!(first, 2048);
    assert_eq!(stream.position(), 2048);
    let second = stream.read_bounded(&mut out).unwrap();
    assert_eq!(second, 952);
    // 真实 EOF：位置在末尾 → 0；不返回伪 EOF 也不报错。
    let eof = stream.read_bounded(&mut out).unwrap();
    assert_eq!(eof, 0);
    // seek 越界拒绝；seek 回中段后可继续读（C59：EOF 后仍可 seek 回前部）。
    assert_eq!(stream.seek(3001).unwrap_err().code, "seek_out_of_range");
    stream.seek(10).unwrap();
    assert_eq!(stream.read_bounded(&mut out).unwrap(), 2048);
    assert_eq!(&out[..10], &body[10..20]);
    // 越过 total 的 read 不会读到垃圾。
    stream.seek(2999).unwrap();
    assert_eq!(stream.read_bounded(&mut out).unwrap(), 1);
}

#[test]
fn read_is_capped_at_one_mebibyte() {
    let dir = tempfileish::temp_dir("media-stream-cap");
    let path = dir.path().join("media.bin");
    std::fs::write(&path, vec![0xAB; 4096]).unwrap();
    let pool = StreamSlotPool::new();
    let mut stream = MediaFileStream::open(&path, &pool).unwrap();
    // 请求远超 1 MiB 的缓冲：实际读取被裁到 1 MiB（此处文件仅 4 KiB）。
    let mut out = vec![0u8; 8 * 1024 * 1024];
    assert_eq!(stream.read_bounded(&mut out).unwrap(), 4096);
}

#[test]
fn slot_pool_caps_concurrency_and_releases_on_drop() {
    let pool = StreamSlotPool::with_max(2);
    let slot_a = pool.acquire().unwrap();
    let slot_b = pool.acquire().unwrap();
    assert_eq!(pool.active(), 2);
    let error = pool.acquire().unwrap_err();
    assert_eq!(error.code, "stream_busy");
    drop(slot_a);
    assert_eq!(pool.active(), 1);
    let slot_c = pool.acquire().unwrap();
    assert_eq!(pool.active(), 2);
    drop(slot_c);
    drop(slot_b);
    assert_eq!(pool.active(), 0);
}

#[test]
fn stream_open_rejects_missing_file_and_slot_is_released_on_error() {
    let pool = StreamSlotPool::new();
    let before = pool.active();
    let error = MediaFileStream::open(Path::new("Z:/definitely/missing.hwpkg"), &pool)
        .unwrap_err();
    assert_eq!(error.code, "io");
    assert_eq!(pool.active(), before);
}
