// SPDX-License-Identifier: MIT
use std::{path::Path, sync::Arc, time::Duration};

use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::Mutex,
    task::JoinSet,
    time::timeout,
};

use crate::{
    config::Config,
    ledger::Ledger,
    platform,
    protocol::{self, Error, Request, Response, Result, MAX_FRAME},
};

const IO_DEADLINE: Duration = Duration::from_secs(5);
const RESPONSE_DEADLINE: Duration = Duration::from_secs(30);
const MAX_CONNECTIONS: usize = 4;

pub async fn serve(config: Config, recovery_proof: Option<&Path>) -> Result<()> {
    let mut ledger = Ledger::open(config.clone(), recovery_proof).await?;
    // Recovery only signs immutable, already registered intents. Proof checks
    // above happen before any recovery signature can be produced.
    ledger.finish_pending().await?;
    let ledger = Arc::new(Mutex::new(ledger));
    let mut listener = platform::Listener::bind(&config)?;
    let mut workers = JoinSet::new();
    let mut stopping = Box::pin(shutdown());
    let result = loop {
        tokio::select! {
            signal = &mut stopping => { break signal; }
            result = workers.join_next(), if !workers.is_empty() => {
                if result.is_some_and(|result| result.is_err()) { break Err(Error("signer_worker_failed")); }
            }
            accepted = listener.accept(), if workers.len() < MAX_CONNECTIONS => {
                match accepted {
                    Ok(stream) => {
                        let ledger = Arc::clone(&ledger);
                        workers.spawn(async move { connection(stream, ledger).await });
                    }
                    Err(error) => break Err(error),
                }
            }
        }
    };
    drop(listener);
    // Once a valid request is accepted the service owns its outcome. Losing a
    // client or shutting down does not cancel a registered signing transaction.
    while let Some(worker) = workers.join_next().await {
        if worker.is_err() {
            eprintln!("hertz-wallpaper-signer: signer_worker_failed");
        }
    }
    ledger.lock().await.close().await;
    result
}

async fn connection(mut stream: platform::ServerStream, ledger: Arc<Mutex<Ledger>>) -> Result<()> {
    let mut mutation = false;
    let result: Result<Response> = async {
        #[cfg(unix)]
        let peer = platform::peer_identity(&stream)?;
        #[cfg(unix)]
        if !ledger.lock().await.peer_allowed(&peer) {
            return Err(Error("unauthorized_peer"));
        }
        let size = timeout(IO_DEADLINE, read_header(&mut stream))
            .await
            .map_err(|_| Error("frame_read_timeout"))??;
        // Windows derives the peer token after this header read; Unix derives
        // credentials from the socket. Request fields never supply an identity.
        #[cfg(windows)]
        let peer = platform::peer_identity(&stream)?;
        #[cfg(windows)]
        if !ledger.lock().await.peer_allowed(&peer) {
            return Err(Error("unauthorized_peer"));
        }
        let bytes = timeout(IO_DEADLINE, read_body(&mut stream, size))
            .await
            .map_err(|_| Error("frame_read_timeout"))??;
        let request: Request = protocol::parse(&bytes)?;
        mutation = !matches!(request, Request::Query { .. });
        ledger.lock().await.handle(&peer, request).await
    }
    .await;
    let response = match result {
        Ok(response) => response,
        Err(error)
            if mutation
                && matches!(
                    error.0,
                    "ledger_unavailable"
                        | "storage_or_transport_unavailable"
                        | "operation_outcome_unknown"
                ) =>
        {
            let mut response = Response::error(Error("operation_outcome_unknown"));
            response.state = "unknown".into();
            response
        }
        Err(error) => Response::error(error),
    };
    timeout(
        IO_DEADLINE,
        write_frame(&mut stream, protocol::encode(&response)?.as_bytes()),
    )
    .await
    .map_err(|_| Error("frame_write_timeout"))??;
    Ok(())
}

pub async fn call(endpoint: &str, expected_service: &str, request: Request) -> Result<Response> {
    let mutation = !matches!(request, Request::Query { .. });
    let bytes = protocol::encode(&request)?;
    if bytes.len() > MAX_FRAME {
        return Err(Error("frame_too_large"));
    }
    let mut stream = timeout(IO_DEADLINE, platform::connect(endpoint, expected_service))
        .await
        .map_err(|_| Error("signer_connect_timeout"))??;
    let sent = timeout(IO_DEADLINE, write_frame(&mut stream, bytes.as_bytes())).await;
    match sent {
        Ok(Ok(())) => {}
        _ => {
            return Err(Error(if mutation {
                "operation_outcome_unknown"
            } else {
                "signer_transport_unavailable"
            }))
        }
    }
    let response = timeout(RESPONSE_DEADLINE, async {
        let size = read_header(&mut stream).await?;
        let bytes = read_body(&mut stream, size).await?;
        protocol::parse(&bytes)
    })
    .await;
    match response {
        Ok(Ok(response)) => Ok(response),
        _ => Err(Error(if mutation {
            "operation_outcome_unknown"
        } else {
            "signer_transport_unavailable"
        })),
    }
}

async fn read_header(stream: &mut (impl AsyncRead + Unpin)) -> Result<usize> {
    let mut header = [0u8; 4];
    stream.read_exact(&mut header).await?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(Error("frame_too_large"));
    }
    Ok(size)
}

async fn read_body(stream: &mut (impl AsyncRead + Unpin), size: usize) -> Result<Vec<u8>> {
    let mut bytes = vec![0u8; size];
    stream.read_exact(&mut bytes).await?;
    Ok(bytes)
}

async fn write_frame(stream: &mut (impl AsyncWrite + Unpin), bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() || bytes.len() > MAX_FRAME {
        return Err(Error("frame_too_large"));
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .await?;
    stream.write_all(bytes).await?;
    stream.flush().await?;
    Ok(())
}

async fn shutdown() -> Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result?,
            _ = terminate.recv() => {},
        }
    }
    #[cfg(windows)]
    tokio::signal::ctrl_c().await?;
    Ok(())
}
