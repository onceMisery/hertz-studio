// SPDX-License-Identifier: MIT
use serde::{Deserialize, Serialize};
/// Prepared correction coefficients. The actor copies them into fixed render slots.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImpulseKernel {
    pub resource_id: String,
    pub sample_rate: u32,
    pub channels: Vec<Vec<f32>>,
    pub delay_frames: usize,
    pub attenuation_db: f32,
}
impl ImpulseKernel {
    pub fn validate(&self) -> Result<(), crate::AudioError> {
        if self.resource_id.len() != 64
            || !self.resource_id.bytes().all(|b| b.is_ascii_hexdigit())
            || !matches!(self.sample_rate, 44_100 | 48_000 | 96_000)
            || !(1..=2).contains(&self.channels.len())
            || self.channels.iter().any(|ch| {
                ch.is_empty()
                    || ch.len() > 257
                    || ch.len() % 2 == 0
                    || ch.iter().any(|v| !v.is_finite())
            })
        {
            return Err(crate::AudioError::Other(
                "校正核需要已验证格式、单/双声道及不超过 257 的奇数 taps".into(),
            ));
        }
        let n = self.channels[0].len();
        if self.channels.iter().any(|c| {
            c.len() != n
                || c.iter()
                    .zip(c.iter().rev())
                    .any(|(a, b)| (a - b).abs() > 1e-6)
        }) || self.delay_frames != (n - 1) / 2
            || !self.attenuation_db.is_finite()
            || self.attenuation_db > 0.0
        {
            return Err(crate::AudioError::Other(
                "正式校正只接受对称线性相位核及准确延迟".into(),
            ));
        }
        Ok(())
    }
}
