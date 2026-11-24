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
    let output = backend.output_status();
    let mut quality = vmusic_core::audio_quality::QualityParams {
        configuration_revision: 1,
        ..Default::default()
    };
    quality.eq.enabled = true;
    quality.eq.bands[0].frequency_hz = 80.0;
    quality.eq.bands[0].q = 3.0;
    quality.eq.bands[0].gain_db = 3.0;
    quality.headroom_mode = vmusic_core::audio_quality::HeadroomMode::Auto;
    quality.limiter = vmusic_core::audio_quality::LimiterMode::TruePeak;
    quality.tone.crossfeed = true;
    quality.tone.saturation = true;
    backend.set_quality(quality)?;
    backend.seek(1000)?;
    backend.play()?;
    wait(&mut backend, |b| {
        b.quality_status()
            .is_some_and(|s| s.applied == Some(quality))
    })?;
    backend.set_volume(0.0)?;
    backend.pause()?;
    wait(&mut backend, |b| !b.eq_status().unwrap().active)?;
    let processing = backend.quality_status();
    let mut exclusive = Vec::new();
    if std::env::var_os("HERTZ_PROBE_EXCLUSIVE").is_some() {
        use vmusic_core::output::{OutputMode, OutputPreferences, OutputSampleFormat};
        for format in [
            OutputSampleFormat::F32,
            OutputSampleFormat::S16,
            OutputSampleFormat::S24,
        ] {
            backend.stop()?;
            wait(&mut backend, |b| !b.eq_status().unwrap().active)?;
            match backend.configure_output(OutputPreferences {mode:OutputMode::Exclusive,sample_format:format,..Default::default()}) {
                Ok(()) => {
                    backend.load_source(Box::new(silence()),Some("wav".into()))?;
                    backend.play()?;
                    wait(&mut backend, |b| b.position_ms()>100)?;
                    exclusive.push(serde_json::json!({"requested_format":format,"opened":true,"output":backend.output_status()}));
                    backend.stop()?;
                    wait(&mut backend, |b| !b.eq_status().unwrap().active)?;
                }
                Err(error) => exclusive.push(serde_json::json!({"requested_format":format,"opened":false,"error":error.to_string(),"output":backend.output_status()})),
            }
        }
        backend.configure_output(OutputPreferences::default())?;
    }
    println!(
        "{}",
        serde_json::json!({"silentActualOutputLifecycle":true,"audibleQualityVerified":false,
        "output":output,"quality":processing,"exclusive_silent_attempts":exclusive,"sampleRate":first.processing_rate,"firstGeneration":first.render_generation,
        "finalGeneration":after_switch.render_generation,
        "checks":["initial deferred","first PCM acknowledgement","EQ transition","pause deferred","resume","seek reset","default device reselect","parametric EQ and headroom","true peak/saturation delay adoption after seek","hard mute"]})
    );
    Ok(())
}
