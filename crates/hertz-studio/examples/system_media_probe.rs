// SPDX-License-Identifier: MIT
// Independent Windows system-media client, restricted to isolated fixture titles.
#[cfg(not(all(windows, feature = "native-window")))]
fn main() {
    eprintln!("Requires Windows and native-window");
    std::process::exit(1);
}

#[cfg(all(windows, feature = "native-window"))]
fn main() -> anyhow::Result<()> {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager;
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED)?;
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
    let args: Vec<_> = std::env::args().collect();
    let title = args
        .get(1)
        .ok_or_else(|| anyhow::anyhow!("fixture title required"))?;
    anyhow::ensure!(
        title.starts_with("smtc-fixture-"),
        "only fixture media may be controlled"
    );
    let action = args.get(2).map(String::as_str).unwrap_or("read");
    let manager = GlobalSystemMediaTransportControlsSessionManager::RequestAsync()?.get()?;
    let mut matches = Vec::new();
    for session in manager.GetSessions()? {
        // Only inspect our executable's metadata, never another app's session.
        let app = session.SourceAppUserModelId()?.to_string();
        if !app.to_ascii_lowercase().contains("hertz-studio") {
            continue;
        }
        let media = session.TryGetMediaPropertiesAsync()?.get()?;
        if media.Title()? == title.as_str() {
            matches.push((session, media, app));
        }
    }
    if matches.is_empty() {
        println!("{{\"count\":0}}");
        return Ok(());
    }
    anyhow::ensure!(matches.len() == 1, "ambiguous fixture media session");
    let (session, media, app) = matches.remove(0);
    let applied = match action {
        "read" => None,
        "play" => Some(session.TryPlayAsync()?.get()?),
        "pause" => Some(session.TryPauseAsync()?.get()?),
        "stop" => Some(session.TryStopAsync()?.get()?),
        "next" => Some(session.TrySkipNextAsync()?.get()?),
        "previous" => Some(session.TrySkipPreviousAsync()?.get()?),
        "seek" => {
            let ms: u64 = args
                .get(3)
                .ok_or_else(|| anyhow::anyhow!("seek milliseconds required"))?
                .parse()?;
            anyhow::ensure!(ms < 600_000, "fixture seek outside ten minutes");
            Some(
                session
                    .TryChangePlaybackPositionAsync(ms as i64 * 10_000)?
                    .get()?,
            )
        }
        _ => anyhow::bail!("unsupported probe action"),
    };
    let playback = session.GetPlaybackInfo()?;
    let controls = playback.Controls()?;
    let timeline = session.GetTimelineProperties()?;
    let thumbnail = media
        .Thumbnail()
        .ok()
        .and_then(|image| image.OpenReadAsync().ok())
        .and_then(|read| read.get().ok())
        .and_then(|stream| stream.Size().ok());
    println!(
        "{}",
        serde_json::json!({"count":1,"app":app,"title":media.Title()?.to_string(),
        "artist":media.Artist()?.to_string(),"album":media.AlbumTitle()?.to_string(),"thumbnailBytes":thumbnail,
        "status":playback.PlaybackStatus()?.0,"positionMs":timeline.Position()?.Duration/10_000,
        "durationMs":timeline.EndTime()?.Duration/10_000,"play":controls.IsPlayEnabled()?,
        "pause":controls.IsPauseEnabled()?,"next":controls.IsNextEnabled()?,
        "seek":controls.IsPlaybackPositionEnabled()?,"accepted":applied})
    );
    Ok(())
}
