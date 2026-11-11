// SPDX-License-Identifier: MIT
//! Fixed-memory reads shared by the two resource container inspectors.

use std::fmt::Write as _;
use std::io::{self, Read};

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

pub(crate) struct ContainerReader<R> {
    input: R,
    length: u64,
    offset: u64,
    code: &'static str,
}

impl<R: Read> ContainerReader<R> {
    pub(crate) fn new(input: R, length: u64, code: &'static str) -> Self {
        Self {
            input,
            length,
            offset: 0,
            code,
        }
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
        scalar_io_error(self.code, operation, None, Some(self.offset), error)
    }

    pub(crate) fn read_into(&mut self, output: &mut [u8]) -> Result<()> {
        if output.len() as u64 > self.remaining() {
            return Err(self.error("container range exceeds the verified entry length"));
        }
        self.input
            .read_exact(output)
            .map_err(|error| self.io_error("short or failed read", &error))?;
        self.offset += output.len() as u64;
        Ok(())
    }

    pub(crate) fn fixed<const N: usize>(&mut self) -> Result<[u8; N]> {
        let mut bytes = [0; N];
        self.read_into(&mut bytes)?;
        Ok(bytes)
    }

    pub(crate) fn skip(&mut self, bytes: u64) -> Result<()> {
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
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<()> {
        if self.remaining() != 0 {
            return Err(self.error("unconsumed container bytes"));
        }
        let mut extra = [0; 1];
        match self.input.read(&mut extra) {
            Ok(0) => Ok(()),
            Ok(_) => Err(self.error("bytes follow the declared container length")),
            Err(error) => Err(self.io_error("end-of-entry read failed", &error)),
        }
    }
}
