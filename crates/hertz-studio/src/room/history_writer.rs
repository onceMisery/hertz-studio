// SPDX-License-Identifier: MIT
//! Playback history has a bounded owner independent of the presentation loop.
use crate::state::AppState;
use std::sync::Arc;
use tokio::sync::{mpsc, watch};

pub(super) struct HistoryWriter {
    send: Option<mpsc::Sender<String>>,
    task: Option<tokio::task::JoinHandle<()>>,
    pub error: watch::Receiver<Option<String>>,
}
impl HistoryWriter {
    pub fn spawn(state: Arc<AppState>) -> Self {
        let (send, mut receive) = mpsc::channel::<String>(256);
        let (error, status) = watch::channel(None);
        let task = tokio::spawn(async move {
            while let Some(track) = receive.recv().await {
                match tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    state.write_history(&track),
                )
                .await
                {
                    Ok(Ok(())) => {}
                    _ => {
                        error.send_replace(Some(
                            "播放历史写入失败或超时，部分记录可能未保存".into(),
                        ));
                    }
                }
            }
        });
        Self {
            send: Some(send),
            task: Some(task),
            error: status,
        }
    }
    pub fn record(&self, track: String) -> Result<(), ()> {
        self.send
            .as_ref()
            .ok_or(())?
            .try_send(track)
            .map_err(|_| ())
    }
    pub async fn shutdown(&mut self) {
        self.send.take();
        if let Some(mut task) = self.task.take() {
            if tokio::time::timeout(std::time::Duration::from_secs(5), &mut task)
                .await
                .is_err()
            {
                task.abort();
                let _ = task.await;
            }
        }
    }
}
impl Drop for HistoryWriter {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
