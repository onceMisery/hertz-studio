// SPDX-License-Identifier: MIT
//! Latest-value persistence: slider traffic cannot create an unbounded DB queue.
use super::contract::{OutputSettings, RoomError, RoomResult};
use tokio::sync::watch;
const KEY: &str = "room.output.v1";
pub(super) async fn load(db: &sqlx::SqlitePool) -> RoomResult<OutputSettings> {
    let raw: Option<Option<String>> = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        sqlx::query_scalar("SELECT CASE WHEN length(CAST(value AS BLOB))<=4096 THEN value ELSE NULL END FROM settings WHERE key=?").bind(KEY).fetch_optional(db),
    ).await.map_err(|_| RoomError::storage())?.map_err(|_| RoomError::storage())?;
    match raw {
        None => Ok(OutputSettings::default()),
        Some(Some(raw)) => {
            let settings: OutputSettings = serde_json::from_str(&raw).map_err(|_| {
                RoomError::new("room_output_preferences", "输出设置损坏，请在设置中重置")
            })?;
            super::host::validate_output(&settings)?;
            Ok(settings)
        }
        Some(None) => Err(RoomError::new(
            "room_output_preferences",
            "输出设置超过限额",
        )),
    }
}
pub(super) struct Preferences {
    send: Option<watch::Sender<Option<OutputSettings>>>,
    task: Option<tokio::task::JoinHandle<()>>,
    pub error: watch::Receiver<Option<String>>,
}
impl Preferences {
    pub fn spawn(db: sqlx::SqlitePool) -> Self {
        let (send, mut receive) = watch::channel::<Option<OutputSettings>>(None);
        let (error, status) = watch::channel(None);
        let task = tokio::spawn(async move {
            while receive.changed().await.is_ok() {
                let settings = receive.borrow_and_update().clone();
                if let Some(settings) = settings {
                    let value = serde_json::to_value(settings).expect("output settings");
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(3),
                        vmusic_store::settings::set(&db, KEY, &value),
                    )
                    .await
                    {
                        Ok(Ok(())) => {
                            error.send_replace(None);
                        }
                        _ => {
                            error.send_replace(Some("本机输出已应用，但设置未能保存".into()));
                        }
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
    pub fn save(&self, settings: &OutputSettings) {
        if let Some(send) = &self.send {
            send.send_replace(Some(settings.clone()));
        }
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
impl Drop for Preferences {
    fn drop(&mut self) {
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}
