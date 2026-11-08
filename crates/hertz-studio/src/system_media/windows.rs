// SPDX-License-Identifier: MIT
// Copyright (c) 2026 hertz-studio contributors

//! HWND-bound Windows adapter. All COM work is confined to one MTA thread.
//! Callbacks enqueue one identity-bound request and never wait on the service.

use super::{Action, Identity, PlaybackState, Projection, SystemMedia};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::{factory, HSTRING};
use windows::Foundation::{TimeSpan, TypedEventHandler};
use windows::Media::{
    MediaPlaybackStatus, MediaPlaybackType, PlaybackPositionChangeRequestedEventArgs,
    SystemMediaTransportControls, SystemMediaTransportControlsButton,
    SystemMediaTransportControlsButtonPressedEventArgs,
    SystemMediaTransportControlsTimelineProperties,
};
use windows::Storage::Streams::{
    DataWriter, InMemoryRandomAccessStream, RandomAccessStreamReference,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::{
    ISystemMediaTransportControlsInterop, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
};

const POLL: Duration = Duration::from_millis(500);
const ACTION_TTL: Duration = Duration::from_secs(2);
const MAX_COVER: u64 = 2 * 1024 * 1024;
type Request = (Instant, Identity, Action);

fn timespan(ms: u64) -> TimeSpan {
    TimeSpan {
        Duration: ms.min(i64::MAX as u64 / 10_000) as i64 * 10_000,
    }
}

fn admit(
    owner: &SystemMedia,
    published: &Mutex<Projection>,
    sender: &tokio::sync::mpsc::Sender<Request>,
    action: Action,
) {
    if owner.stopped.load(Ordering::Acquire) {
        return;
    }
    let projection = published.lock().unwrap_or_else(|error| error.into_inner());
    if projection.controls.allows(action) {
        if let Some(identity) = &projection.identity {
            let _ = sender.try_send((Instant::now(), identity.clone(), action));
        }
    }
}

struct Session {
    controls: SystemMediaTransportControls,
    buttons: Option<i64>,
    seek: Option<i64>,
    cover_stamp: Option<(std::path::PathBuf, u64, std::time::SystemTime)>,
}

impl Session {
    fn new(
        hwnd: isize,
        owner: Arc<SystemMedia>,
        published: Arc<Mutex<Projection>>,
        sender: tokio::sync::mpsc::Sender<Request>,
    ) -> windows::core::Result<Self> {
        let factory: ISystemMediaTransportControlsInterop =
            factory::<SystemMediaTransportControls, _>()?;
        let controls =
            unsafe { factory.GetForWindow::<SystemMediaTransportControls>(HWND(hwnd as _))? };
        let mut session = Self {
            controls,
            buttons: None,
            seek: None,
            cover_stamp: None,
        };
        session.controls.SetIsEnabled(false)?;
        let (button_owner, button_projection, button_sender) =
            (owner.clone(), published.clone(), sender.clone());
        session.buttons =
            Some(session.controls.ButtonPressed(&TypedEventHandler::<
                SystemMediaTransportControls,
                SystemMediaTransportControlsButtonPressedEventArgs,
            >::new(move |_, args| {
                let Some(args) = args.as_ref() else {
                    return Ok(());
                };
                let action = match args.Button()? {
                    SystemMediaTransportControlsButton::Play => Action::Play,
                    SystemMediaTransportControlsButton::Pause => Action::Pause,
                    SystemMediaTransportControlsButton::Stop => Action::Stop,
                    SystemMediaTransportControlsButton::Next => Action::Next,
                    SystemMediaTransportControlsButton::Previous => Action::Previous,
                    _ => return Ok(()),
                };
                admit(&button_owner, &button_projection, &button_sender, action);
                Ok(())
            }))?);
        session.seek = Some(session.controls.PlaybackPositionChangeRequested(
            &TypedEventHandler::<
                SystemMediaTransportControls,
                PlaybackPositionChangeRequestedEventArgs,
            >::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let position = args.RequestedPlaybackPosition()?.Duration;
                    if position >= 0 {
                        admit(
                            &owner,
                            &published,
                            &sender,
                            Action::Seek {
                                position_ms: position as u64 / 10_000,
                            },
                        );
                    }
                }
                Ok(())
            }),
        )?);
        Ok(session)
    }

    fn update(
        &mut self,
        next: &Projection,
        previous: &Projection,
        cover_dir: &std::path::Path,
    ) -> windows::core::Result<()> {
        let c = &self.controls;
        let cover_stamp = next
            .cover_key
            .as_deref()
            .and_then(|key| cover_stamp(cover_dir, key));
        let metadata_changed = next
            .identity
            .as_ref()
            .map(|id| (&id.mode, &id.track_id, &id.track_instance))
            != previous
                .identity
                .as_ref()
                .map(|id| (&id.mode, &id.track_id, &id.track_instance))
            || next.title != previous.title
            || next.artist != previous.artist
            || next.album != previous.album
            || next.cover_key != previous.cover_key
            || cover_stamp != self.cover_stamp;
        if metadata_changed {
            let updater = c.DisplayUpdater()?;
            updater.ClearAll()?;
            if next.identity.is_some() {
                updater.SetType(MediaPlaybackType::Music)?;
                let music = updater.MusicProperties()?;
                music.SetTitle(&HSTRING::from(&next.title))?;
                music.SetArtist(&HSTRING::from(&next.artist))?;
                music.SetAlbumTitle(&HSTRING::from(&next.album))?;
                if let Some(bytes) = cover_stamp.as_ref().and_then(|(path, _, _)| cover(path)) {
                    // The thumbnail is optional; failure cannot retain the old artwork.
                    if let Ok(stream) = thumbnail(&bytes) {
                        let _ = updater.SetThumbnail(&stream);
                    }
                }
            }
            updater.Update()?;
            self.cover_stamp = cover_stamp;
        }
        c.SetIsPlayEnabled(next.controls.play)?;
        c.SetIsPauseEnabled(next.controls.pause)?;
        c.SetIsStopEnabled(next.controls.stop)?;
        c.SetIsNextEnabled(next.controls.next)?;
        c.SetIsPreviousEnabled(next.controls.previous)?;
        c.SetIsFastForwardEnabled(false)?;
        c.SetIsRewindEnabled(false)?;
        c.SetPlaybackStatus(if next.buffering {
            MediaPlaybackStatus::Changing
        } else {
            match next.playback {
                PlaybackState::Playing => MediaPlaybackStatus::Playing,
                PlaybackState::Paused => MediaPlaybackStatus::Paused,
                PlaybackState::Stopped => MediaPlaybackStatus::Stopped,
            }
        })?;
        let timeline = SystemMediaTransportControlsTimelineProperties::new()?;
        timeline.SetStartTime(timespan(0))?;
        timeline.SetEndTime(timespan(next.duration_ms.unwrap_or(0)))?;
        timeline.SetMinSeekTime(timespan(0))?;
        timeline.SetMaxSeekTime(timespan(if next.controls.seek {
            next.duration_ms.unwrap_or(0)
        } else {
            0
        }))?;
        timeline.SetPosition(timespan(
            next.position_ms.min(next.duration_ms.unwrap_or(0)),
        ))?;
        c.UpdateTimelineProperties(&timeline)?;
        c.SetIsEnabled(next.identity.is_some())?;
        Ok(())
    }

    fn close(&mut self) -> bool {
        let disabled = self.controls.SetIsEnabled(false).is_ok();
        if let Some(token) = self.buttons.take() {
            let _ = self.controls.RemoveButtonPressed(token);
        }
        if let Some(token) = self.seek.take() {
            let _ = self.controls.RemovePlaybackPositionChangeRequested(token);
        }
        if let Ok(updater) = self.controls.DisplayUpdater() {
            let _ = updater.ClearAll();
            let _ = updater.Update();
        }
        disabled
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

fn cover_stamp(
    dir: &std::path::Path,
    key: &str,
) -> Option<(std::path::PathBuf, u64, std::time::SystemTime)> {
    let id = uuid::Uuid::parse_str(key).ok()?;
    for ext in ["jpg", "png", "webp", "gif"] {
        let path = dir.join(format!("{id}.{ext}"));
        let Ok(info) = std::fs::metadata(&path) else {
            continue;
        };
        if info.is_file() && info.len() <= MAX_COVER {
            return Some((path, info.len(), info.modified().ok()?));
        }
    }
    None
}

fn cover(path: &std::path::Path) -> Option<Vec<u8>> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut bytes = Vec::new();
    file.take(MAX_COVER + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= MAX_COVER).then_some(bytes)
}

fn thumbnail(bytes: &[u8]) -> windows::core::Result<RandomAccessStreamReference> {
    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(bytes)?;
    writer.StoreAsync()?.get()?;
    writer.DetachStream()?;
    stream.Seek(0)?;
    RandomAccessStreamReference::CreateFromStream(&stream)
}

pub(super) fn run(owner: Arc<SystemMedia>, hwnd: isize) {
    if let Err(error) = unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        tracing::warn!(code = ?error.code(), "SMTC initialization failed");
        owner.publish("failed", false, Some("smtc_initialize_failed"));
        return;
    }
    struct Apartment;
    impl Drop for Apartment {
        fn drop(&mut self) {
            unsafe {
                RoUninitialize();
            }
        }
    }
    let _apartment = Apartment;
    let published = Arc::new(Mutex::new(Projection::default()));
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<Request>(1);
    let dispatch_owner = owner.clone();
    let dispatch_task = owner.runtime.spawn(async move {
        while let Some((received, identity, action)) = receiver.recv().await {
            if dispatch_owner.stopped.load(Ordering::Acquire) {
                break;
            }
            if received.elapsed() > ACTION_TTL {
                continue;
            }
            let Some(state) = dispatch_owner.state.upgrade() else {
                break;
            };
            if let Err(error) = super::dispatch(state, identity, action).await {
                tracing::debug!(%error, "system media action not applied");
            }
        }
    });
    let mut session = match Session::new(hwnd, owner.clone(), published.clone(), sender) {
        Ok(session) => session,
        Err(error) => {
            tracing::warn!(code = ?error.code(), "SMTC attachment failed");
            dispatch_task.abort();
            owner.publish("failed", false, Some("smtc_attach_failed"));
            return;
        }
    };
    owner.publish("ready", true, None);
    let mut previous = Projection::default();
    let mut failed = false;
    while !owner.stopped.load(Ordering::Acquire) {
        let Some(state) = owner.state.upgrade() else {
            break;
        };
        if *state.exiting.borrow() {
            break;
        }
        let next = owner.runtime.block_on(async {
            tokio::time::timeout(Duration::from_secs(1), super::snapshot(&state))
                .await
                .unwrap_or_default()
        });
        // No callback can capture the new identity while Windows still displays
        // the old metadata; callbacks during publication are refused.
        *published.lock().unwrap_or_else(|error| error.into_inner()) = Projection::default();
        if let Err(error) = session.update(&next, &previous, &state.cover_dir()) {
            tracing::warn!(code = ?error.code(), "SMTC publication failed");
            failed = true;
            break;
        }
        *published.lock().unwrap_or_else(|error| error.into_inner()) = next.clone();
        previous = next;
        std::thread::sleep(POLL);
    }
    owner.stopped.store(true, Ordering::Release);
    *published.lock().unwrap_or_else(|error| error.into_inner()) = Projection::default();
    let released = session.close();
    dispatch_task.abort();
    owner.publish(
        if failed { "failed" } else { "stopped" },
        !released,
        if !released {
            Some("smtc_release_failed")
        } else if failed {
            Some("smtc_update_failed")
        } else {
            None
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_time_never_wraps() {
        assert_eq!(timespan(12).Duration, 120_000);
        assert!(timespan(u64::MAX).Duration > 0);
        assert_eq!(timespan(u64::MAX).Duration % 10_000, 0);
    }
}
