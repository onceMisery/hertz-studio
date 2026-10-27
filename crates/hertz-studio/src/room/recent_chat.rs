// SPDX-License-Identifier: MIT
//! Native notification cache survives browser closure. Server history remains
//! authoritative; a revision or gap asks the UI to refresh its cursor.
use serde_json::{json, Value};
use std::collections::VecDeque;
use vmusic_lan::protocol::ControlFrame;

#[derive(Default)]
pub(super) struct RecentChat {
    revision: Option<String>,
    sharing_revision: Option<String>,
    messages: VecDeque<Value>,
    bytes: usize,
    gap: bool,
}
impl RecentChat {
    pub fn clear(&mut self) {
        self.messages.clear();
        self.bytes = 0;
    }
    pub fn revision(&mut self, revision: Option<&str>) {
        if self.revision.as_deref() != revision {
            self.clear();
            self.gap = true;
            self.revision = revision.map(str::to_owned);
        }
    }
    pub fn sharing_revision(&mut self, revision: Option<&str>) {
        if self.sharing_revision.as_deref() != revision {
            self.clear();
            self.gap = true;
            self.sharing_revision = revision.map(str::to_owned);
        }
    }
    pub fn notification(&mut self, text: &str) {
        let Ok(ControlFrame::Notification { topic, body }) = ControlFrame::decode(text) else {
            return;
        };
        match topic.as_str() {
            "chat_gap" => self.gap = true,
            "chat_history_changed" => self.revision(body["history_revision"].as_str()),
            "chat_message" => {
                let message = &body["message"];
                let Some(id) = message["message_id"].as_str().filter(|id| canonical(id)) else {
                    return;
                };
                let Some(text) = message["text"]
                    .as_str()
                    .filter(|s| s.len() <= 800 && s.chars().count() <= 200)
                else {
                    return;
                };
                let Some(name) = message["name"]
                    .as_str()
                    .filter(|s| s.len() <= 128 && s.chars().count() <= 32)
                else {
                    return;
                };
                if self.messages.iter().any(|m| m["message_id"] == id) {
                    return;
                }
                let content_kind = if message["content_kind"] == "song" {
                    "song"
                } else {
                    "text"
                };
                if content_kind == "song"
                    && message["sharing_revision"].as_str() != self.sharing_revision.as_deref()
                {
                    self.gap = true;
                    return;
                }
                let song = if content_kind == "song" && !message["song"].is_null() {
                    let Ok(song) = serde_json::from_value::<super::resources::SharedTrack>(
                        message["song"].clone(),
                    ) else {
                        return;
                    };
                    if [&Some(song.title.clone()), &song.artist, &song.album]
                        .into_iter()
                        .flatten()
                        .any(|s| {
                            s.len() > 128
                                || s.chars().count() > 64
                                || s.chars().any(char::is_control)
                        })
                    {
                        return;
                    }
                    serde_json::to_value(song).unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                let clean = json!({"message_id":id,"chat_seq":id,"member_id":message["member_id"],"received_at_ms":message["received_at_ms"],"name":name,"text":text,"track_instance_id":message["track_instance_id"],"retained":message["retained"]==true,"content_kind":content_kind,"song":song,"sharing_revision":message["sharing_revision"]});
                let size = clean.to_string().len();
                if size > 2048 {
                    return;
                }
                while self.messages.len() >= 200 || self.bytes + size > 512 * 1024 {
                    if let Some(old) = self.messages.pop_front() {
                        self.bytes -= old.to_string().len();
                    } else {
                        break;
                    }
                }
                self.bytes += size;
                self.messages.push_back(clean);
            }
            _ => {}
        }
    }
    pub fn projection(&self) -> Value {
        json!({"history_revision":self.revision,"messages":self.messages,"gap":self.gap})
    }
}
fn canonical(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 20
        && !value.starts_with('0')
        && value.bytes().all(|b| b.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn song_notifications_keep_typed_bounded_cards_and_share_changes_invalidate_them() {
        let mut cache = RecentChat::default();
        cache.sharing_revision(Some("1"));
        let resource = uuid::Uuid::new_v4();
        let frame = ControlFrame::Notification {
            topic: "chat_message".into(),
            body: json!({"message":{
            "message_id":"1","name":"member","text":"分享歌曲","content_kind":"song","sharing_revision":"1","song":{
                "resource_id":resource,"title":"A real song","artist":null,"album":null,"duration_ms":1000,
                "sample_rate":48000,"channels":2,"has_cover":false,"path":"must not cross cache"}}}),
        };
        cache.notification(&frame.encode().unwrap());
        let view = cache.projection();
        assert_eq!(
            view["messages"][0]["song"]["resource_id"],
            resource.to_string()
        );
        assert_eq!(view["messages"][0]["content_kind"], "song");
        assert!(view["messages"][0]["song"].get("path").is_none());
        cache.sharing_revision(Some("2"));
        assert!(cache.messages.is_empty());
        assert!(cache.gap);
        cache.notification(&frame.encode().unwrap());
        assert!(
            cache.messages.is_empty(),
            "a delayed notification cannot restore a revoked card"
        );
    }
    #[test]
    fn notification_cache_is_bounded_and_revision_invalidates_old_messages() {
        let mut cache = RecentChat::default();
        cache.revision(Some("1"));
        for id in 1..=250 {
            let frame = ControlFrame::Notification {
                topic: "chat_message".into(),
                body: json!({"message":{"message_id":id.to_string(),"name":"member","text":"hello","retained":false}}),
            };
            cache.notification(&frame.encode().unwrap());
        }
        assert_eq!(cache.messages.len(), 200);
        assert_eq!(cache.messages.front().unwrap()["message_id"], "51");
        assert!(cache.bytes <= 512 * 1024);
        cache.revision(Some("2"));
        assert!(cache.messages.is_empty());
        assert_eq!(cache.bytes, 0);
    }
}
