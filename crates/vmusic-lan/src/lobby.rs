// SPDX-License-Identifier: MIT
//! Public room artwork only. This contract grants no room membership or media access.
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::io::Cursor;
use uuid::Uuid;

pub const COVER_BYTES: usize = 24 * 1024;
pub const COVER_PREFIX: &str = "data:image/png;base64,";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LobbyProfile {
    pub room_id: Uuid,
    pub cover: Option<String>,
}

/// Decode the complete bounded bitmap, rather than trusting a MIME label or header.
pub fn valid_cover(cover: &str) -> bool {
    let Some(encoded) = cover.strip_prefix(COVER_PREFIX) else {
        return false;
    };
    if encoded.len() > COVER_BYTES.div_ceil(3) * 4 {
        return false;
    }
    let Ok(bytes) = STANDARD.decode(encoded) else {
        return false;
    };
    if bytes.len() > COVER_BYTES {
        return false;
    }
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 2 * 1024 * 1024,
    });
    let Ok(mut reader) = decoder.read_info() else {
        return false;
    };
    let info = reader.info();
    if info.width == 0
        || info.height == 0
        || info.width > 512
        || info.height > 512
        || info.animation_control.is_some()
    {
        return false;
    }
    let Some(size) = reader.output_buffer_size().filter(|s| *s <= 1024 * 1024) else {
        return false;
    };
    reader.next_frame(&mut vec![0; size]).is_ok() && reader.finish().is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bitmap(width: u32, height: u32) -> String {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder
                .write_header()
                .unwrap()
                .write_image_data(&vec![128; width as usize * height as usize * 4])
                .unwrap();
        }
        format!("{COVER_PREFIX}{}", STANDARD.encode(bytes))
    }
    #[test]
    fn lobby_cover_requires_complete_bounded_static_bitmap() {
        assert!(valid_cover(&bitmap(320, 180)));
        assert!(!valid_cover(&bitmap(513, 1)));
        assert!(!valid_cover("data:image/svg+xml;base64,PHN2Zz4="));
        assert!(!valid_cover(&format!(
            "{COVER_PREFIX}{}",
            "A".repeat(COVER_BYTES * 2)
        )));
        let good = bitmap(2, 2);
        assert!(!valid_cover(&good[..good.len() - 12]));
    }
}
