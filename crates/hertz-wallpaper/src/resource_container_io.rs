// SPDX-License-Identifier: MIT
//! Fixed-memory reads shared by the two resource container inspectors.

use std::fmt::Write as _;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::{PackageError, Result};

/// Build one diagnostic from stored I/O scalars and the caller's known context.
/// Operation must be a fixed literal; path must be fixed or already validated
/// against MAX_PATH_BYTES. Offset is the known logical byte or seek target.
pub(crate) fn scalar_io_error(
    code: &'static str,
    operation: &'static str,
    path: Option<&str>,
    offset: Option<u64>,
    error: &io::Error,
) -> PackageError {
    // External Display/Debug/Source can allocate arbitrary text. Only built-in
    // ErrorKind and Option<i32> formatting runs here. Append bounded context to
    // the same final String; PackageError moves it without a diagnostic copy.
    let mut message = format!(
        "{operation}: kind={:?}, raw_os_error={:?}",
        error.kind(),
        error.raw_os_error(),
    );
    if let Some(path) = path {
        write!(message, " (path {path})").expect("writing to String cannot fail");
    }
    if let Some(offset) = offset {
        write!(message, " (byte {offset})").expect("writing to String cannot fail");
    }
    PackageError::new(code, message)
}

/// A borrowed flag adds no heap owner. All cancellation diagnostics fit the
/// original fixed diagnostic allowance.
pub(crate) fn check_cancel(cancel: Option<&AtomicBool>) -> Result<()> {
    if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
        return Err(cancel_error());
    }
    Ok(())
}

fn cancel_error() -> PackageError {
    PackageError::new("cancelled", "resource inspection cancelled")
}

pub(crate) struct ContainerReader<'c, R> {
    input: R,
    length: u64,
    offset: u64,
    code: &'static str,
    cancel: Option<&'c AtomicBool>,
}

impl<'c, R: Read> ContainerReader<'c, R> {
    pub(crate) fn new(input: R, length: u64, code: &'static str) -> Self {
        Self::new_with_cancel(input, length, code, None)
    }

    pub(crate) fn new_with_cancel(
        input: R,
        length: u64,
        code: &'static str,
        cancel: Option<&'c AtomicBool>,
    ) -> Self {
        Self {
            input,
            length,
            offset: 0,
            code,
            cancel,
        }
    }

    pub(crate) fn check_cancel(&self) -> Result<()> {
        check_cancel(self.cancel)
    }

    pub(crate) fn offset(&self) -> u64 {
        self.offset
    }
    pub(crate) fn remaining(&self) -> u64 {
        self.length - self.offset
    }

    pub(crate) fn error(&self, message: impl Into<String>) -> PackageError {
        PackageError::new(
            self.code,
            format!("{} (byte {})", message.into(), self.offset),
        )
    }

    fn io_error(&self, operation: &'static str, error: &io::Error) -> PackageError {
        // The original cancellable ZIP reader uses a typed Other error to
        // avoid automatic Interrupted retries. Preserve that known marker for
        // token callers without invoking external error formatting hooks.
        if self.cancel.is_some() && zip::read::is_payload_read_cancelled(error) {
            return cancel_error();
        }
        scalar_io_error(self.code, operation, None, Some(self.offset), error)
    }

    pub(crate) fn read_into(&mut self, output: &mut [u8]) -> Result<()> {
        self.check_cancel()?;
        if output.len() as u64 > self.remaining() {
            return Err(self.error("container range exceeds the verified entry length"));
        }
        // Keep the whole-operation logical offset until success, including
        // partial reads. Every synchronous bottom read is at most 64 KiB.
        let mut cursor = 0;
        while cursor < output.len() {
            self.check_cancel()?;
            let end = output.len().min(cursor + 64 * 1024);
            match self.input.read(&mut output[cursor..end]) {
                Ok(0) => {
                    self.check_cancel()?;
                    return Err(
                        self.io_error("short or failed read", &io::ErrorKind::UnexpectedEof.into())
                    );
                }
                Ok(count) => {
                    self.check_cancel()?;
                    cursor += count;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                    self.check_cancel()?;
                }
                // A real I/O failure wins a racing cancellation. Never format
                // the external error payload.
                Err(error) => return Err(self.io_error("short or failed read", &error)),
            }
        }
        self.check_cancel()?;
        self.offset += output.len() as u64;
        Ok(())
    }

    pub(crate) fn fixed<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut bytes = [0; N];
        self.read_into(&mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn skip(&mut self, bytes: u64) -> Result<()> {
        self.check_cancel()?;
        if bytes > self.remaining() {
            return Err(self.error("container body exceeds the verified entry length"));
        }
        let mut remaining = bytes;
        let mut buffer = [0; 64 * 1024];
        while remaining > 0 {
            let count = remaining.min(buffer.len() as u64) as usize;
            self.read_into(&mut buffer[..count])?;
            remaining -= count as u64;
        }
        self.check_cancel()
    }

    pub(crate) fn finish(mut self) -> Result<()> {
        self.check_cancel()?;
        if self.remaining() != 0 {
            return Err(self.error("unconsumed container bytes"));
        }
        let mut extra = [0; 1];
        match self.input.read(&mut extra) {
            Ok(0) => self.check_cancel(),
            Ok(_) => {
                self.check_cancel()?;
                Err(self.error("bytes follow the declared container length"))
            }
            Err(error) => {
                if error.kind() == io::ErrorKind::Interrupted {
                    self.check_cancel()?;
                }
                // Preserve the original immediate footer failure policy,
                // including uncancelled Interrupted.
                Err(self.io_error("end-of-entry read failed", &error))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::Cell,
        io::{Cursor, Write},
    };

    struct Counted<'a> {
        calls: &'a Cell<usize>,
    }
    impl Read for Counted<'_> {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            self.calls.set(self.calls.get() + 1);
            Ok(0)
        }
    }

    #[test]
    fn empty_read_skip_and_finish_poll_without_bottom_io() {
        let token = AtomicBool::new(false);
        let calls = Cell::new(0);
        let mut reader = ContainerReader::new_with_cancel(
            Counted { calls: &calls },
            0,
            "invalid_model_container",
            Some(&token),
        );
        reader.read_into(&mut []).unwrap();
        reader.fixed::<0>().unwrap();
        reader.skip(0).unwrap();
        assert_eq!(calls.get(), 0);
        token.store(true, Ordering::Release);
        assert_eq!(reader.read_into(&mut []).unwrap_err().code, "cancelled");
        assert_eq!(reader.skip(0).unwrap_err().code, "cancelled");
        assert_eq!(reader.finish().unwrap_err().code, "cancelled");
        assert_eq!(calls.get(), 0);
    }

    #[test]
    fn range_check_precedes_consumption_and_partial_eof_keeps_start_offset() {
        let mut reader = ContainerReader::new(Cursor::new([1, 2, 3]), 4, "invalid_model_container");
        assert!(reader.read_into(&mut [0; 5]).is_err());
        assert_eq!(reader.input.position(), 0);
        let error = reader.read_into(&mut [0; 4]).unwrap_err();
        assert_eq!(reader.offset(), 0);
        assert_eq!(reader.input.position(), 3);
        assert_eq!(
            error.message,
            "short or failed read: kind=UnexpectedEof, raw_os_error=None (byte 0)"
        );
    }

    struct OneError(Option<io::Error>);
    impl Read for OneError {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(self.0.take().expect("one read only"))
        }
    }

    fn original_zip_cancel_error(token: &AtomicBool) -> io::Error {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file(
                "payload",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .unwrap();
        writer.write_all(b"data").unwrap();
        let mut archive = zip::ZipArchive::new(writer.finish().unwrap()).unwrap();
        let mut file = archive.by_index_with_cancel(0, token).unwrap();
        token.store(true, Ordering::Release);
        let error = file.read(&mut [0; 1]).unwrap_err();
        assert!(zip::read::is_payload_read_cancelled(&error));
        // Isolate the error mapper from the pre-read atomic poll.
        token.store(false, Ordering::Release);
        error
    }

    #[test]
    fn original_zip_cancel_marker_maps_in_read_and_finish_only_with_token() {
        for finish in [false, true] {
            for with_token in [false, true] {
                let token = AtomicBool::new(false);
                let input = OneError(Some(original_zip_cancel_error(&token)));
                let mut reader = ContainerReader::new_with_cancel(
                    input,
                    u64::from(!finish),
                    "invalid_model_container",
                    with_token.then_some(&token),
                );
                let error = if finish {
                    reader.finish().unwrap_err()
                } else {
                    reader.read_into(&mut [0; 1]).unwrap_err()
                };
                assert_eq!(
                    error.code,
                    if with_token {
                        "cancelled"
                    } else {
                        "invalid_model_container"
                    }
                );
            }
        }
    }
}
