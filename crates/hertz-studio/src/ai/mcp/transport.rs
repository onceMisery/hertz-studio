// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! Keep the SDK's protocol/framing, with bounded input and stalled-output exit.

use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::Duration;

use rmcp::model::{ClientNotification, GetExtensions, JsonRpcMessage, RequestId};
use rmcp::service::{RxJsonRpcMessage, TxJsonRpcMessage};
use rmcp::transport::{async_rw::AsyncRwTransport, Transport};
use rmcp::RoleServer;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::watch;

/// Raw bytes before LF, including a possible CR. Larger frames close the session.
pub(super) const MAX_INPUT_LINE_BYTES: usize = 256 * 1024;
pub(super) const MAX_OUTPUT_LINE_BYTES: usize = 256 * 1024;
/// Includes SDK handlers, queued replies and writes waiting for stdout.
pub(super) const MAX_PENDING_REQUESTS: usize = 8;
const WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(1);

type Pending = Arc<Mutex<HashMap<RequestId, watch::Sender<bool>>>>;

/// A transport-owned cancellation signal in the SDK's non-wire extensions.
/// Keeping the SDK responder alive until the bounded reply is flushed makes
/// cancellation reclaimable without losing accounting of queued responses.
#[derive(Clone)]
pub(super) struct RequestCancellation(watch::Receiver<bool>);

impl RequestCancellation {
    pub(super) async fn cancelled(mut signal: Option<Self>) {
        match &mut signal {
            Some(Self(receiver)) => {
                let _ = receiver.wait_for(|cancelled| *cancelled).await;
            }
            None => std::future::pending::<()>().await,
        }
    }
}

fn response_id(item: &TxJsonRpcMessage<RoleServer>) -> Option<&RequestId> {
    match item {
        JsonRpcMessage::Response(reply) => Some(&reply.id),
        JsonRpcMessage::Error(reply) => reply.id.as_ref(),
        _ => None,
    }
}

/// Count the exact JSON encoding without allocating an unbounded frame. The
/// SDK remains the actual wire encoder. Its inline parse errors are small and
/// contain neither a peer ID nor the invalid input.
fn fits_output(item: &TxJsonRpcMessage<RoleServer>) -> bool {
    struct Count(usize);
    impl io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 = self
                .0
                .checked_add(bytes.len())
                .filter(|size| *size <= MAX_OUTPUT_LINE_BYTES)
                .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidData))?;
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Count(0), item).is_ok()
}

fn bounded_reply(item: TxJsonRpcMessage<RoleServer>) -> io::Result<TxJsonRpcMessage<RoleServer>> {
    if fits_output(&item) {
        return Ok(item);
    }
    let id = response_id(&item).cloned();
    let error = rmcp::model::ErrorData::internal_error(
        "MCP response exceeds byte limit; action may already have completed",
        Some(serde_json::json!({ "code": "mcp_response_too_large" })),
    );
    let reply = TxJsonRpcMessage::<RoleServer>::error(error, id);
    if fits_output(&reply) {
        Ok(reply)
    } else {
        Err(io::Error::from(io::ErrorKind::InvalidData))
    }
}

struct Input<R> {
    inner: R,
    line_bytes: usize,
    closed: watch::Sender<bool>,
}

struct Output<W> {
    inner: W,
    deadline: Option<Pin<Box<tokio::time::Sleep>>>,
    closed: watch::Sender<bool>,
}

impl<W> Output<W> {
    fn check_deadline(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        if *self.closed.borrow() {
            return Err(io::Error::from(io::ErrorKind::NotConnected));
        }
        let deadline = self
            .deadline
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(WRITE_TIMEOUT)));
        if deadline.as_mut().poll(cx).is_ready() {
            self.closed.send_replace(true);
            Err(io::Error::from(io::ErrorKind::TimedOut))
        } else {
            Ok(())
        }
    }
}

impl<W: AsyncWrite + Unpin> AsyncWrite for Output<W> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.check_deadline(cx)?;
        Pin::new(&mut self.inner).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check_deadline(cx)?;
        let result = Pin::new(&mut self.inner).poll_flush(cx);
        if matches!(result, Poll::Ready(Ok(()))) {
            self.deadline = None;
        }
        result
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check_deadline(cx)?;
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for Input<R> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(Ok(())) => {
                let bytes = &buf.filled()[before..];
                // A zero-capacity read is not EOF.
                if bytes.is_empty() && buf.remaining() > 0 {
                    self.closed.send_replace(true);
                }
                for &byte in bytes {
                    if byte == b'\n' {
                        self.line_bytes = 0;
                    } else if self.line_bytes == MAX_INPUT_LINE_BYTES {
                        self.closed.send_replace(true);
                        return Poll::Ready(Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "MCP input frame exceeds byte limit",
                        )));
                    } else {
                        self.line_bytes += 1;
                    }
                }
                Poll::Ready(Ok(()))
            }
            Poll::Ready(Err(error)) => {
                self.closed.send_replace(true);
                Poll::Ready(Err(error))
            }
            Poll::Pending => Poll::Pending,
        }
    }
}

pub(super) struct BoundedTransport<R: AsyncRead + Unpin, W: AsyncWrite + Unpin> {
    inner: AsyncRwTransport<RoleServer, Input<R>, Output<W>>,
    closed: watch::Sender<bool>,
    receiver: watch::Receiver<bool>,
    pending: Pending,
    initialized: bool,
}

pub(super) fn bounded<R, W>(read: R, write: W) -> (BoundedTransport<R, W>, watch::Receiver<bool>)
where
    R: AsyncRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let (closed, receiver) = watch::channel(false);
    let inner = AsyncRwTransport::new_server(
        Input {
            inner: read,
            line_bytes: 0,
            closed: closed.clone(),
        },
        Output {
            inner: write,
            deadline: None,
            closed: closed.clone(),
        },
    );
    (
        BoundedTransport {
            inner,
            closed,
            receiver: receiver.clone(),
            pending: Arc::new(Mutex::new(HashMap::new())),
            initialized: false,
        },
        receiver,
    )
}

impl<R, W> Transport<RoleServer> for BoundedTransport<R, W>
where
    R: AsyncRead + Unpin + Send,
    W: AsyncWrite + Unpin + Send + 'static,
{
    type Error = io::Error;

    fn send(
        &mut self,
        item: TxJsonRpcMessage<RoleServer>,
    ) -> impl Future<Output = io::Result<()>> + Send + 'static {
        let closed = self.closed.clone();
        let pending = self.pending.clone();
        let id = response_id(&item).cloned();
        let send = bounded_reply(item).map(|item| self.inner.send(item));
        async move {
            if *closed.borrow() {
                return Err(io::Error::from(io::ErrorKind::NotConnected));
            }
            // Includes time waiting for other frame writes. After a partial
            // write times out the session must end, never append another frame.
            let result = match send {
                Ok(send) => tokio::time::timeout(WRITE_TIMEOUT, send)
                    .await
                    .unwrap_or_else(|_| Err(io::Error::from(io::ErrorKind::TimedOut))),
                Err(error) => Err(error),
            };
            if result.is_err() {
                closed.send_replace(true);
            } else if let Some(id) = id {
                // Not on handler completion or cancel notification: reply memory
                // and SDK tasks still occupy the slot until a full frame flush.
                pending.lock().expect("MCP pending poisoned").remove(&id);
            }
            result
        }
    }

    async fn receive(&mut self) -> Option<RxJsonRpcMessage<RoleServer>> {
        loop {
            let message = tokio::select! {
                biased;
                _ = self.receiver.wait_for(|closed| *closed) => return None,
                message = self.inner.receive() => message,
            };
            let Some(mut message) = message else {
                self.closed.send_replace(true);
                return None;
            };
            match &mut message {
                JsonRpcMessage::Request(request) => {
                    let mut pending = self.pending.lock().expect("MCP pending poisoned");
                    if pending.len() == MAX_PENDING_REQUESTS || pending.contains_key(&request.id) {
                        // Do not create another handler/error reply while already
                        // overloaded, or overwrite the SDK's request-ID owner.
                        self.closed.send_replace(true);
                        return None;
                    }
                    let (sender, receiver) = watch::channel(false);
                    pending.insert(request.id.clone(), sender);
                    request
                        .request
                        .extensions_mut()
                        .insert(RequestCancellation(receiver));
                }
                JsonRpcMessage::Notification(notification) => {
                    match &notification.notification {
                        ClientNotification::CancelledNotification(cancelled) => {
                            if let Some(id) = &cancelled.params.request_id {
                                if let Some(signal) =
                                    self.pending.lock().expect("MCP pending poisoned").get(id)
                                {
                                    signal.send_replace(true);
                                }
                            }
                        }
                        ClientNotification::InitializedNotification(_) if !self.initialized => {
                            self.initialized = true;
                            return Some(message);
                        }
                        // No roots/progress subscriptions or custom notification
                        // capabilities. Discard before the SDK spawns tasks.
                        _ => {}
                    }
                    // Do not let SDK cancellation drop a reply before send(): its
                    // occupied slot must follow the reply all the way to flush.
                    // A cancelled call receives a bounded error, which a client
                    // is free to ignore. No sent action is rolled back.
                    tokio::task::yield_now().await;
                    continue;
                }
                _ => {}
            }
            return Some(message);
        }
    }

    async fn close(&mut self) -> io::Result<()> {
        self.closed.send_replace(true);
        tokio::time::timeout(CLOSE_TIMEOUT, self.inner.close())
            .await
            .unwrap_or_else(|_| Err(io::Error::from(io::ErrorKind::TimedOut)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn input_limit_is_per_line_and_preserves_fragmented_reads() {
        let (closed, receiver) = watch::channel(false);
        let mut bytes = vec![b'x'; MAX_INPUT_LINE_BYTES];
        bytes.push(b'\n');
        bytes.extend_from_slice(&[b'y'; 123]);
        bytes.push(b'\n');
        let mut input = Input {
            inner: bytes.as_slice(),
            line_bytes: 0,
            closed,
        };
        let mut actual = Vec::new();
        // The byte count persists across fragmented reads.
        let mut first = [0; 7];
        input.read_exact(&mut first).await.unwrap();
        assert_eq!(&first, b"xxxxxxx");
        assert!(!*receiver.borrow());
        input.read_to_end(&mut actual).await.unwrap();
        assert_eq!([first.as_slice(), &actual].concat(), bytes);
        assert!(*receiver.borrow(), "EOF signals connection shutdown");
    }

    #[tokio::test]
    async fn unterminated_oversized_input_closes_without_waiting_for_newline() {
        let (write, read) = tokio::io::duplex(MAX_INPUT_LINE_BYTES + 1);
        let (mut transport, closed) = bounded(read, tokio::io::sink());
        let mut write = write;
        write
            .write_all(&vec![b'x'; MAX_INPUT_LINE_BYTES + 1])
            .await
            .unwrap();
        // Keep the producer open: rejection must not rely on EOF or a LF.
        assert!(
            tokio::time::timeout(Duration::from_secs(1), transport.receive())
                .await
                .unwrap()
                .is_none()
        );
        assert!(*closed.borrow());
    }

    #[tokio::test]
    async fn partial_request_survives_concurrent_response() {
        let (read, mut producer) = tokio::io::duplex(1024);
        let (mut consumer, write) = tokio::io::duplex(1024);
        let (mut transport, _) = bounded(read, write);
        producer
            .write_all(br#"{"jsonrpc":"2.0","id":7,"method":"ping""#)
            .await
            .unwrap();
        assert!(futures::poll!(Box::pin(transport.receive())).is_pending());
        let error = rmcp::model::ErrorData::invalid_request("test", None);
        transport
            .send(TxJsonRpcMessage::<RoleServer>::error(error, None))
            .await
            .unwrap();
        let mut line = String::new();
        tokio::io::BufReader::new(&mut consumer)
            .read_line(&mut line)
            .await
            .unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&line).is_ok());
        producer.write_all(b"}\n").await.unwrap();
        let received = transport.receive().await.unwrap();
        assert_eq!(serde_json::to_value(received).unwrap()["id"], 7);
    }

    #[tokio::test]
    async fn pending_output_resumes_as_one_complete_frame() {
        let (_producer, read) = tokio::io::duplex(64);
        let (mut consumer, write) = tokio::io::duplex(64);
        let (mut transport, closed) = bounded(read, write);
        let message = TxJsonRpcMessage::<RoleServer>::error(
            rmcp::model::ErrorData::invalid_request("x".repeat(8192), None),
            None,
        );
        let expected = serde_json::to_value(&message).unwrap();
        let mut send = Box::pin(transport.send(message));
        assert!(
            futures::poll!(send.as_mut()).is_pending(),
            "tiny output must back up"
        );
        let read_frame = async {
            let mut line = String::new();
            tokio::io::BufReader::new(&mut consumer)
                .read_line(&mut line)
                .await
                .unwrap();
            serde_json::from_str::<serde_json::Value>(&line).unwrap()
        };
        let (sent, actual) = tokio::join!(send, read_frame);
        sent.unwrap();
        assert_eq!(actual, expected);
        assert!(!*closed.borrow());
    }

    #[tokio::test]
    async fn stalled_stdout_ends_the_session_even_for_sdk_protocol_errors() {
        let (read, mut producer) = tokio::io::duplex(1024);
        let (_consumer, write) = tokio::io::duplex(1);
        let (mut transport, closed) = bounded(read, write);
        // Valid JSON with an invalid MCP shape: the SDK writes this error from
        // inside receive(), bypassing Transport::send(). Output still times out.
        producer
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":1}\n")
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(WRITE_TIMEOUT + Duration::from_secs(2), transport.receive())
                .await
                .unwrap()
                .is_none()
        );
        assert!(*closed.borrow());
        transport.close().await.unwrap();
    }

    fn request(id: i64) -> Vec<u8> {
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"method\":\"ping\"}}\n").into_bytes()
    }

    #[tokio::test]
    async fn capacity_includes_handlers_and_unflushed_replies_and_duplicate_ids_close() {
        for duplicate in [false, true] {
            let (read, mut producer) = tokio::io::duplex(4096);
            let (_consumer, write) = tokio::io::duplex(1);
            let (mut transport, closed) = bounded(read, write);
            for id in 0..MAX_PENDING_REQUESTS as i64 {
                producer.write_all(&request(id)).await.unwrap();
                assert!(transport.receive().await.is_some());
            }
            // Construct and start a response whose output cannot complete.
            let mut reply = Box::pin(transport.send(TxJsonRpcMessage::<RoleServer>::error(
                rmcp::model::ErrorData::invalid_request("fixture", None),
                Some(RequestId::Number(0)),
            )));
            assert!(futures::poll!(reply.as_mut()).is_pending());
            assert_eq!(
                transport.pending.lock().unwrap().len(),
                MAX_PENDING_REQUESTS
            );
            producer
                .write_all(&request(if duplicate {
                    0
                } else {
                    MAX_PENDING_REQUESTS as i64
                }))
                .await
                .unwrap();
            assert!(transport.receive().await.is_none());
            assert!(*closed.borrow());
            drop(reply);
        }
        // A duplicate is rejected even when the total is below capacity.
        let bytes = [request(7), request(7)].concat();
        let (mut transport, closed) = bounded(bytes.as_slice(), tokio::io::sink());
        assert!(transport.receive().await.is_some());
        assert!(transport.receive().await.is_none());
        assert!(*closed.borrow());
    }

    #[tokio::test]
    async fn cancellation_reclaims_only_after_reply_flush_and_does_not_leak_slots() {
        let (read, mut producer) = tokio::io::duplex(4096);
        let (mut transport, closed) = bounded(read, tokio::io::sink());
        for id in 0..(MAX_PENDING_REQUESTS * 3) as i64 {
            producer.write_all(&request(id)).await.unwrap();
            let Some(JsonRpcMessage::Request(request)) = transport.receive().await else {
                panic!("request");
            };
            let signal = request
                .request
                .extensions()
                .get::<RequestCancellation>()
                .cloned();
            producer.write_all(format!("{{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{{\"requestId\":{id}}}}}\n").as_bytes()).await.unwrap();
            // Processing the notification returns no SDK message/task. Polling
            // must remain cancellation-safe while awaiting subsequent input.
            assert!(futures::poll!(Box::pin(transport.receive())).is_pending());
            tokio::time::timeout(
                Duration::from_secs(1),
                RequestCancellation::cancelled(signal),
            )
            .await
            .unwrap();
            assert_eq!(transport.pending.lock().unwrap().len(), 1);
            transport
                .send(TxJsonRpcMessage::<RoleServer>::error(
                    rmcp::model::ErrorData::internal_error("cancelled", None),
                    Some(RequestId::Number(id)),
                ))
                .await
                .unwrap();
            assert_eq!(transport.pending.lock().unwrap().len(), 0);
        }
        assert!(!*closed.borrow());
    }

    #[tokio::test]
    async fn notification_flood_is_not_forwarded_as_sdk_tasks() {
        let mut bytes =
            b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n".to_vec();
        for _ in 0..500 {
            bytes.extend_from_slice(
                b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n",
            );
            bytes.extend_from_slice(
                b"{\"jsonrpc\":\"2.0\",\"method\":\"notifications/roots/list_changed\"}\n",
            );
        }
        bytes.extend(request(1));
        let (mut transport, _) = bounded(bytes.as_slice(), tokio::io::sink());
        assert!(matches!(
            transport.receive().await,
            Some(JsonRpcMessage::Notification(_))
        ));
        assert!(matches!(
            transport.receive().await,
            Some(JsonRpcMessage::Request(_))
        ));
    }

    #[tokio::test]
    async fn output_uses_exact_encoded_bytes_and_oversized_reply_is_replaced_before_writing() {
        let mut reply = TxJsonRpcMessage::<RoleServer>::error(
            rmcp::model::ErrorData::invalid_request("", None),
            Some(RequestId::Number(7)),
        );
        let overhead = serde_json::to_vec(&reply).unwrap().len();
        if let JsonRpcMessage::Error(error) = &mut reply {
            error.error.message = "x".repeat(MAX_OUTPUT_LINE_BYTES - overhead).into();
        }
        assert_eq!(
            serde_json::to_vec(&reply).unwrap().len(),
            MAX_OUTPUT_LINE_BYTES
        );
        assert!(fits_output(&reply));
        if let JsonRpcMessage::Error(error) = &mut reply {
            error.error.message.to_mut().push('x');
        }
        assert!(!fits_output(&reply));
        let oversized = TxJsonRpcMessage::<RoleServer>::error(
            rmcp::model::ErrorData::invalid_request(
                "\u{0001}".repeat(MAX_OUTPUT_LINE_BYTES / 6),
                None,
            ),
            Some(RequestId::Number(7)),
        );
        // Raw characters fit, their JSON escaping exceeds the wire bound.
        assert!(!fits_output(&oversized));
        let (mut consumer, write) = tokio::io::duplex(1024);
        let (mut transport, closed) = bounded(tokio::io::empty(), write);
        transport.send(oversized).await.unwrap();
        let mut line = String::new();
        tokio::io::BufReader::new(&mut consumer)
            .read_line(&mut line)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(value["id"], 7);
        assert_eq!(value["error"]["data"]["code"], "mcp_response_too_large");
        assert!(!*closed.borrow());
    }
}
