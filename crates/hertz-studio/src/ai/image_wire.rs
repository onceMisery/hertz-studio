// SPDX-License-Identifier: MIT
//! Bounded image-body primitives. An adapter must select a qualified response
//! field before using them; these functions do not parse model text or URLs.
use std::{
    io::{Read, Write},
    sync::atomic::{AtomicBool, Ordering},
};
pub(super) const MAX_WIRE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_DECODED_BYTES: u64 = 32 * 1024 * 1024;

struct Wire<R> {
    input: R,
    remaining: u64,
    cancel: std::sync::Arc<AtomicBool>,
}
impl<R: Read> Read for Wire<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(std::io::Error::other("image receive cancelled"));
        }
        // Read one byte beyond the bound only to reject it, never publish it.
        let count = buffer.len().min(self.remaining.saturating_add(1) as usize);
        let got = self.input.read(&mut buffer[..count])?;
        if got as u64 > self.remaining {
            return Err(std::io::Error::other("image wire exceeds bound"));
        }
        self.remaining -= got as u64;
        Ok(got)
    }
}
/// Stream only the qualified base64 field into an owned staging file. The
/// complete JSON and encoded string must never be buffered by its caller.
pub(super) fn base64_file(
    input: impl Read,
    file: &mut std::fs::File,
    cancel: std::sync::Arc<AtomicBool>,
) -> std::io::Result<u64> {
    let wire = Wire {
        input,
        remaining: MAX_WIRE_BYTES,
        cancel: cancel.clone(),
    };
    let decoder =
        base64::read::DecoderReader::new(wire, &base64::engine::general_purpose::STANDARD);
    copy_file(decoder, file, MAX_DECODED_BYTES, &cancel)
}
fn copy_file(
    mut input: impl Read,
    mut output: impl Write,
    bound: u64,
    cancel: &AtomicBool,
) -> std::io::Result<u64> {
    let mut total = 0u64;
    let mut buffer = [0u8; 16 * 1024];
    loop {
        if cancel.load(Ordering::Acquire) {
            return Err(std::io::Error::other("image receive cancelled"));
        }
        let got = input.read(&mut buffer)?;
        if got == 0 {
            break;
        }
        total = total
            .checked_add(got as u64)
            .filter(|n| *n <= bound)
            .ok_or_else(|| std::io::Error::other("decoded image exceeds bound"))?;
        output.write_all(&buffer[..got])?;
    }
    if total == 0 {
        return Err(std::io::Error::other("empty image response"));
    }
    output.flush()?;
    Ok(total)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn decode_is_streamed_and_rejects_padding_truncation_and_size_bounds() {
        let target = super::super::image_provider::ImageFile::create().unwrap();
        let mut file = target.open().unwrap();
        let cancel = Arc::new(AtomicBool::new(false));
        assert_eq!(
            base64_file(&b"aGVsbG8="[..], &mut file, cancel.clone()).unwrap(),
            5
        );
        assert_eq!(std::fs::read(target.path()).unwrap(), b"hello");
        for invalid in [
            b"aGVsbG8".as_slice(),
            b"aG=VsbG8=",
            b"aGVsbG8=AAAA",
            b"!",
            b"",
        ] {
            assert!(base64_file(invalid, &mut file, cancel.clone()).is_err());
        }
        let wire = Wire {
            input: &b"12345"[..],
            remaining: 4,
            cancel: cancel.clone(),
        };
        assert!(copy_file(wire, std::io::sink(), 100, &cancel).is_err());
        assert!(copy_file(&b"12345"[..], std::io::sink(), 4, &cancel).is_err());
        cancel.store(true, Ordering::Release);
        assert!(base64_file(&b"aGVsbG8="[..], &mut file, cancel).is_err());
    }
}
