// SPDX-License-Identifier: MIT
//! Disposable independent component. No UI, player, network service or persistent state.
use hertz_desktop_ipc::{
    windows::{
        read_private_bounded, request_blocking, write_private_atomic, Cancellation, Identity,
    },
    Request,
};
use serde_json::{json, Value};
use std::{io, path::PathBuf, time::Duration};

fn main() -> io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|arg| arg == "--descendant") {
        // A safety ceiling ensures a failed/old host cannot leave this disposable child running.
        std::thread::sleep(Duration::from_secs(45));
        return Ok(());
    }
    let discovery = PathBuf::from(
        args.get(1)
            .ok_or_else(|| io::Error::other("missing probe source"))?,
    );
    let output = PathBuf::from(
        args.get(2)
            .ok_or_else(|| io::Error::other("missing probe output"))?,
    );
    let source: Value = serde_json::from_slice(&read_private_bounded(&discovery, 65_536)?)?;
    let request: Request = serde_json::from_value(source["request"].clone())?;
    let result = request_blocking(
        source["pipe"].as_str().unwrap(),
        source["pid"].as_u64().unwrap() as u32,
        &request,
        &Cancellation::new(),
    );
    let result = match result {
        Ok(response) => {
            json!({"ok":true,"pid":std::process::id(),"identity":Identity::current()?,"response":response})
        }
        Err(error) => json!({"ok":false,"pid":std::process::id(),"error":error.to_string()}),
    };
    write_private_atomic(&output, &serde_json::to_vec_pretty(&result)?, 65_536)?;
    std::thread::sleep(Duration::from_secs(45));
    Ok(())
}
