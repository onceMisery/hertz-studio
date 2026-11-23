// SPDX-License-Identifier: MIT
// Silent actual-output lifecycle probe. It does not establish audible quality.
use std::{
    io::{Cursor, Read, Seek, SeekFrom},
    time::{Duration, Instant},
};
use vmusic_audio::cpal_backend::CpalBackend;
use vmusic_core::{AudioBackend, AudioSource, DspParams, EqApplicationState};

struct SilentWave(Cursor<Vec<u8>>);
impl Read for SilentWave {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(b)
    }
}
impl Seek for SilentWave {
    fn seek(&mut self, p: SeekFrom) -> std::io::Result<u64> {
        self.0.seek(p)
    }
}
impl AudioSource for SilentWave {
    fn media_len(&self) -> Option<u64> {
        Some(self.0.get_ref().len() as u64)
    }
}

fn silence() -> SilentWave {
    let bytes = 48_000u32 * 2 * 2 * 10;
    let mut data = Vec::with_capacity(bytes as usize + 44);
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(&(bytes + 36).to_le_bytes());
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16u32.to_le_bytes());
    data.extend_from_slice(&1u16.to_le_bytes());
    data.extend_from_slice(&2u16.to_le_bytes());
    data.extend_from_slice(&48_000u32.to_le_bytes());
    data.extend_from_slice(&192_000u32.to_le_bytes());
    data.extend_from_slice(&4u16.to_le_bytes());
    data.extend_from_slice(&16u16.to_le_bytes());
    data.extend_from_slice(b"data");
    data.extend_from_slice(&bytes.to_le_bytes());
    data.resize(bytes as usize + 44, 0);
    SilentWave(Cursor::new(data))
}

fn wait(
    backend: &mut CpalBackend,
    predicate: impl Fn(&CpalBackend) -> bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let start = Instant::now();
    while !predicate(backend) {
        backend.maintain();
        if start.elapsed() > Duration::from_secs(3) {
            return Err("actual output did not reach requested state".into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut backend = CpalBackend::new()?;
    backend.set_volume(0.0)?;
    backend.load_source(Box::new(silence()), Some("wav".into()))?;
    backend.set_dsp(DspParams {
        eq_gains_db: [3.0; 6],
        ..Default::default()
    })?;
    assert_eq!(
        backend.eq_status().unwrap().state,
        EqApplicationState::Deferred
    );
    backend.play()?;
    wait(&mut backend, |b| {
        b.eq_status().unwrap().state == EqApplicationState::Applied && b.position_ms() > 180
    })?;
    let first = backend.eq_status().unwrap();
    backend.set_dsp(DspParams {
        eq_gains_db: [-3.0; 6],
        ..Default::default()
    })?;
    wait(&mut backend, |b| {
        b.eq_status().unwrap().state == EqApplicationState::Applied
    })?;
    backend.pause()?;
    wait(&mut backend, |b| !b.eq_status().unwrap().active)?;
    backend.set_dsp(DspParams::default())?;
    assert_eq!(
        backend.eq_status().unwrap().state,
        EqApplicationState::Deferred
    );
    backend.play()?;
    wait(&mut backend, |b| {
        b.eq_status().unwrap().state == EqApplicationState::Applied
    })?;
    backend.seek(1000)?;
    wait(&mut backend, |b| {
        b.eq_status().unwrap().state == EqApplicationState::Applied
    })?;
    let before_switch = backend.eq_status().unwrap();
    backend.select_device(None)?;
    wait(&mut backend, |b| {
        b.eq_status().unwrap().state == EqApplicationState::Applied
    })?;
    let after_switch = backend.eq_status().unwrap();
    assert_ne!(
        before_switch.render_generation,
        after_switch.render_generation
    );
    backend.pause()?;
    wait(&mut backend, |b| !b.eq_status().unwrap().active)?;
    println!(
        "{}",
        serde_json::json!({"silentActualOutputLifecycle":true,"audibleQualityVerified":false,
        "sampleRate":first.processing_rate,"firstGeneration":first.render_generation,
        "finalGeneration":after_switch.render_generation,
        "checks":["initial deferred","first PCM acknowledgement","EQ transition","pause deferred","resume","seek reset","default device reselect"]})
    );
    Ok(())
}
