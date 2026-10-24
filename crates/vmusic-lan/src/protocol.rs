// SPDX-License-Identifier: MIT
//! Versioned wire contracts; all parsing and allocation happens off audio callbacks.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::sync::Arc;
use uuid::Uuid;

pub const VERSION: u16 = 1;
pub const MAX_MESSAGE: usize = 65_536;
pub const PCM_HEADER: usize = 96;
pub const CAPABILITIES: &[&str] = &["pcm_f32le", "plan_commit", "clock_v1"];

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ProtocolError {
    #[error("unsupported protocol or required capability")]
    Version,
    #[error("invalid PCM header, size or frame alignment")]
    InvalidPcm,
    #[error("non-finite PCM sample")]
    NonFinite,
    #[error("stream identity does not match")]
    Identity,
    #[error("invalid control message")]
    Control,
}

/// JSON uses decimal strings; binary frame counters retain native u64 precision.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Counter(pub u64);
impl Serialize for Counter {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0.to_string())
    }
}
impl<'de> Deserialize<'de> for Counter {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        if text.is_empty()
            || !text.bytes().all(|b| b.is_ascii_digit())
            || (text.len() > 1 && text.starts_with('0'))
        {
            return Err(serde::de::Error::custom(
                "expected canonical unsigned decimal string",
            ));
        }
        text.parse().map(Self).map_err(serde::de::Error::custom)
    }
}
impl From<u64> for Counter {
    fn from(value: u64) -> Self {
        Self(value)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamIdentity {
    pub room_id: Uuid,
    pub instance_id: Uuid,
    pub session_id: Uuid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AudioFormat {
    pub id: u32,
    pub sample_rate: u32,
    pub channels: u16,
}
impl AudioFormat {
    pub fn validate(self) -> Result<Self, ProtocolError> {
        if self.id == 0
            || ![44_100, 48_000, 88_200, 96_000, 176_400, 192_000].contains(&self.sample_rate)
            || !(1..=2).contains(&self.channels)
        {
            return Err(ProtocolError::InvalidPcm);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone)]
pub struct PcmBlock {
    pub identity: StreamIdentity,
    pub epoch: u64,
    pub sequence: u64,
    pub frame_index: u64,
    pub format_id: u32,
    pub channels: u16,
    pub samples: Arc<[f32]>,
}
impl PcmBlock {
    pub fn frame_count(&self) -> u32 {
        (self.samples.len() / usize::from(self.channels.max(1))) as u32
    }
    pub fn byte_len(&self) -> usize {
        self.samples.len() * 4 + PCM_HEADER
    }
    pub fn end_frame(&self) -> u64 {
        self.frame_index
            .saturating_add(u64::from(self.frame_count()))
    }
    pub fn encode(&self) -> Result<Vec<u8>, ProtocolError> {
        let payload = self
            .samples
            .len()
            .checked_mul(4)
            .ok_or(ProtocolError::InvalidPcm)?;
        validate_payload(self.frame_count(), self.channels, payload)?;
        if !self
            .samples
            .len()
            .is_multiple_of(usize::from(self.channels))
            || self.format_id == 0
            || self
                .frame_index
                .checked_add(u64::from(self.frame_count()))
                .is_none()
        {
            return Err(ProtocolError::InvalidPcm);
        }
        if self.samples.iter().any(|v| !v.is_finite()) {
            return Err(ProtocolError::NonFinite);
        }
        let mut bytes = Vec::with_capacity(PCM_HEADER + payload);
        bytes.extend_from_slice(b"HZLA");
        bytes.extend_from_slice(&VERSION.to_le_bytes());
        bytes.extend_from_slice(&(PCM_HEADER as u16).to_le_bytes());
        for id in [
            self.identity.room_id,
            self.identity.instance_id,
            self.identity.session_id,
        ] {
            bytes.extend_from_slice(id.as_bytes());
        }
        for value in [self.epoch, self.sequence, self.frame_index] {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        bytes.extend_from_slice(&self.format_id.to_le_bytes());
        bytes.extend_from_slice(&self.frame_count().to_le_bytes());
        bytes.extend_from_slice(&self.channels.to_le_bytes());
        bytes.extend_from_slice(&0u16.to_le_bytes());
        bytes.extend_from_slice(&(payload as u32).to_le_bytes());
        for sample in self.samples.iter() {
            bytes.extend_from_slice(&sample.to_bits().to_le_bytes());
        }
        Ok(bytes)
    }
    pub fn decode(bytes: &[u8], expected: StreamIdentity) -> Result<Self, ProtocolError> {
        if bytes.len() < PCM_HEADER || bytes.len() > MAX_MESSAGE || &bytes[..4] != b"HZLA" {
            return Err(ProtocolError::InvalidPcm);
        }
        let u16_at = |at| u16::from_le_bytes(bytes[at..at + 2].try_into().unwrap());
        let u32_at = |at| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
        let u64_at = |at| u64::from_le_bytes(bytes[at..at + 8].try_into().unwrap());
        if u16_at(4) != VERSION {
            return Err(ProtocolError::Version);
        }
        if usize::from(u16_at(6)) != PCM_HEADER || u16_at(90) != 0 {
            return Err(ProtocolError::InvalidPcm);
        }
        let identity = StreamIdentity {
            room_id: Uuid::from_slice(&bytes[8..24]).unwrap(),
            instance_id: Uuid::from_slice(&bytes[24..40]).unwrap(),
            session_id: Uuid::from_slice(&bytes[40..56]).unwrap(),
        };
        if identity != expected {
            return Err(ProtocolError::Identity);
        }
        let count = u32_at(84);
        let channels = u16_at(88);
        validate_payload(count, channels, bytes.len() - PCM_HEADER)?;
        if u32_at(92) as usize != bytes.len() - PCM_HEADER
            || u32_at(80) == 0
            || u64_at(72).checked_add(u64::from(count)).is_none()
        {
            return Err(ProtocolError::InvalidPcm);
        }
        let mut samples = Vec::with_capacity((bytes.len() - PCM_HEADER) / 4);
        for sample in bytes[PCM_HEADER..].as_chunks::<4>().0 {
            let value = f32::from_bits(u32::from_le_bytes(*sample));
            if !value.is_finite() {
                return Err(ProtocolError::NonFinite);
            }
            samples.push(value);
        }
        Ok(Self {
            identity,
            epoch: u64_at(56),
            sequence: u64_at(64),
            frame_index: u64_at(72),
            format_id: u32_at(80),
            channels,
            samples: samples.into(),
        })
    }
}

pub fn validate_payload(frames: u32, channels: u16, bytes: usize) -> Result<(), ProtocolError> {
    let expected = u64::from(frames)
        .checked_mul(u64::from(channels))
        .and_then(|v| v.checked_mul(4));
    if frames == 0
        || !(1..=2).contains(&channels)
        || expected != Some(bytes as u64)
        || bytes > MAX_MESSAGE - PCM_HEADER
    {
        return Err(ProtocolError::InvalidPcm);
    }
    Ok(())
}

/// Media descriptors become immutable after Commit. All times use the host monotonic domain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub epoch: Counter,
    pub plan_id: Counter,
    pub anchor_ns: Counter,
    pub join_frame: Counter,
    pub format: AudioFormat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ControlFrame {
    Hello {
        version: u16,
        identity: StreamIdentity,
        required: Vec<String>,
    },
    TimeRequest {
        sequence: Counter,
        t1: Counter,
    },
    TimeResponse {
        sequence: Counter,
        t1: Counter,
        t2: Counter,
        t3: Counter,
    },
    Prepare {
        plan: Plan,
    },
    Ready {
        epoch: Counter,
        plan_id: Counter,
    },
    Commit {
        epoch: Counter,
        plan_id: Counter,
        effective_at: Counter,
    },
    Heartbeat {
        output_ready: bool,
        played_frame: Counter,
        underrun_frames: Counter,
    },
    Resync {
        reason: String,
    },
    End {
        reason: String,
    },
}
impl ControlFrame {
    pub fn encode(&self) -> Result<String, ProtocolError> {
        let text = serde_json::to_string(self).map_err(|_| ProtocolError::Control)?;
        if text.len() > MAX_MESSAGE {
            return Err(ProtocolError::Control);
        }
        Ok(text)
    }
    pub fn decode(text: &str) -> Result<Self, ProtocolError> {
        if text.len() > MAX_MESSAGE {
            return Err(ProtocolError::Control);
        }
        let frame: Self = serde_json::from_str(text).map_err(|_| ProtocolError::Control)?;
        if let Self::Hello {
            version, required, ..
        } = &frame
        {
            if *version != VERSION
                || required.len() > 16
                || required.iter().any(|c| !CAPABILITIES.contains(&c.as_str()))
            {
                return Err(ProtocolError::Version);
            }
        }
        if let Self::Prepare { plan } = &frame {
            plan.format.validate()?;
        }
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identity() -> StreamIdentity {
        StreamIdentity {
            room_id: Uuid::new_v4(),
            instance_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
        }
    }
    fn block() -> PcmBlock {
        PcmBlock {
            identity: identity(),
            epoch: 3,
            sequence: 2,
            frame_index: 9_007_199_254_740_993,
            format_id: 1,
            channels: 2,
            samples: vec![0.0, -0.0, 0.75, -0.25].into(),
        }
    }
    #[test]
    fn pcm_roundtrip_preserves_bits_and_large_counters() {
        let original = block();
        let encoded = original.encode().unwrap();
        assert_eq!(encoded.len(), PCM_HEADER + 16);
        let decoded = PcmBlock::decode(&encoded, original.identity).unwrap();
        assert_eq!(decoded.frame_index, original.frame_index);
        assert_eq!(
            decoded
                .samples
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>(),
            original
                .samples
                .iter()
                .map(|x| x.to_bits())
                .collect::<Vec<_>>()
        );
    }
    #[test]
    fn malformed_pcm_and_wrong_session_are_rejected() {
        let original = block();
        let valid = original.encode().unwrap();
        for length in 0..valid.len() {
            assert!(PcmBlock::decode(&valid[..length], original.identity).is_err());
        }
        assert!(matches!(
            PcmBlock::decode(&valid, identity()),
            Err(ProtocolError::Identity)
        ));
        for (at, byte) in [(4, 9), (6, 0), (80, 0), (84, 0), (88, 0), (90, 1), (92, 0)] {
            let mut bytes = valid.clone();
            bytes[at] = byte;
            assert!(PcmBlock::decode(&bytes, original.identity).is_err());
        }
        assert!(validate_payload(u32::MAX, 2, 0).is_err());
        assert!(validate_payload(960, 2, 7680).is_ok());
    }
    #[test]
    fn nonfinite_alignment_and_oversize_rejected() {
        let mut pcm = block();
        pcm.samples = vec![f32::NAN, 0.0].into();
        assert_eq!(pcm.encode().unwrap_err(), ProtocolError::NonFinite);
        pcm.samples = vec![0.0; 3].into();
        assert!(pcm.encode().is_err());
        pcm.samples = vec![0.0; MAX_MESSAGE].into();
        assert!(pcm.encode().is_err());
        pcm.channels = 0;
        assert!(pcm.encode().is_err());
    }
    #[test]
    fn counters_remain_exact_and_require_strings() {
        let value = Counter(u64::MAX);
        let text = serde_json::to_string(&value).unwrap();
        assert_eq!(serde_json::from_str::<Counter>(&text).unwrap(), value);
        for bad in [
            "1",
            "\"01\"",
            "\"-1\"",
            "\"+1\"",
            "\"18446744073709551616\"",
        ] {
            assert!(serde_json::from_str::<Counter>(bad).is_err());
        }
    }
}
