// SPDX-License-Identifier: MIT
//! Pure KTX2 upload-plan decisions over declared capabilities.

use hertz_wallpaper::{
    ktx2_upload::{plan_ktx2_upload, Ktx2TranscodeTarget, Ktx2UploadCapabilities, Ktx2UploadPlan},
    texture_container::{inspect_ktx2, Ktx2Container, Ktx2DataFormat, Ktx2Level},
};
use std::io::Cursor;

const ALL: Ktx2UploadCapabilities = Ktx2UploadCapabilities {
    astc: true,
    etc1: true,
    etc2: true,
    dxt: true,
    bptc: true,
};
const NONE: Ktx2UploadCapabilities = Ktx2UploadCapabilities {
    astc: false,
    etc1: false,
    etc2: false,
    dxt: false,
    bptc: false,
};

fn texture(
    vk_format: u32,
    color_model: u8,
    transfer: u8,
    has_alpha: bool,
    supercompression: u32,
    level_count: usize,
) -> Ktx2Container {
    Ktx2Container {
        width: 4,
        height: 4,
        vk_format,
        type_size: 1,
        supercompression,
        generate_mipmaps: false,
        levels: (0..level_count)
            .map(|index| Ktx2Level {
                offset: 100 + index as u64,
                bytes: 8,
                uncompressed_bytes: if supercompression == 0 { 8 } else { 0 },
            })
            .collect(),
        data_format: Ktx2DataFormat {
            color_model,
            primaries: 1,
            transfer,
            flags: 0,
            texel_block: [1, 1, 1, 1],
            bytes_plane: [4, 0, 0, 0, 0, 0, 0, 0],
            sample_count: if has_alpha { 4 } else { 3 },
            has_alpha,
        },
        global_data: None,
    }
}

#[test]
fn rgba8_direct_is_capability_free_and_other_uncompressed_formats_are_refused() {
    let rgba8 = texture(37, 1, 1, true, 0, 1);
    assert_eq!(
        plan_ktx2_upload(&rgba8, NONE).unwrap(),
        Ktx2UploadPlan::Direct { vk_format: 37 }
    );
    assert_eq!(
        plan_ktx2_upload(&texture(9, 1, 1, false, 0, 1), ALL)
            .unwrap_err()
            .code,
        "texture_container_unavailable"
    );
    assert_eq!(
        plan_ktx2_upload(&texture(37, 1, 1, true, 3, 1), ALL)
            .unwrap_err()
            .code,
        "texture_container_unavailable"
    );
}

#[test]
fn precompressed_families_require_their_declared_capability() {
    let cases = [
        (157, Ktx2UploadCapabilities { astc: true, ..NONE }),
        (184, Ktx2UploadCapabilities { astc: true, ..NONE }),
        (131, Ktx2UploadCapabilities { dxt: true, ..NONE }),
        (138, Ktx2UploadCapabilities { dxt: true, ..NONE }),
        (143, Ktx2UploadCapabilities { bptc: true, ..NONE }),
        (146, Ktx2UploadCapabilities { bptc: true, ..NONE }),
        (147, Ktx2UploadCapabilities { etc2: true, ..NONE }),
        (152, Ktx2UploadCapabilities { etc2: true, ..NONE }),
    ];
    for (vk_format, capabilities) in cases {
        let container = texture(vk_format, 1, 1, false, 0, 1);
        assert_eq!(
            plan_ktx2_upload(&container, capabilities).unwrap(),
            Ktx2UploadPlan::Direct { vk_format }
        );
        assert_eq!(
            plan_ktx2_upload(&container, NONE).unwrap_err().code,
            "texture_container_unavailable",
            "vkFormat {vk_format}"
        );
    }
    for vk_format in [139u32, 142, 153, 156] {
        assert_eq!(
            plan_ktx2_upload(&texture(vk_format, 1, 1, false, 0, 1), ALL)
                .unwrap_err()
                .code,
            "texture_container_unavailable",
            "unsupported family {vk_format}"
        );
    }
}

#[test]
fn basis_images_select_the_best_available_transcode_target() {
    let etc1s = |has_alpha| texture(0, 163, 1, has_alpha, 1, 1);
    let transcode =
        |container: &Ktx2Container, capabilities| match plan_ktx2_upload(container, capabilities)
            .unwrap()
        {
            Ktx2UploadPlan::Transcode { target, srgb, .. } => (target, srgb),
            other => panic!("expected transcode, got {other:?}"),
        };
    assert_eq!(
        transcode(&etc1s(false), ALL),
        (Ktx2TranscodeTarget::Astc4x4, false)
    );
    assert_eq!(
        transcode(&etc1s(false), Ktx2UploadCapabilities { dxt: true, ..NONE }),
        (Ktx2TranscodeTarget::Bc1, false)
    );
    assert_eq!(
        transcode(&etc1s(true), Ktx2UploadCapabilities { dxt: true, ..NONE }),
        (Ktx2TranscodeTarget::Bc3, false)
    );
    assert_eq!(
        transcode(&etc1s(false), Ktx2UploadCapabilities { etc2: true, ..NONE }),
        (Ktx2TranscodeTarget::Etc2Rgb8, false)
    );
    assert_eq!(
        transcode(&etc1s(true), Ktx2UploadCapabilities { etc2: true, ..NONE }),
        (Ktx2TranscodeTarget::Etc2Rgba8, false)
    );
    assert_eq!(
        transcode(&etc1s(false), Ktx2UploadCapabilities { etc1: true, ..NONE }),
        (Ktx2TranscodeTarget::Etc1Rgb8, false)
    );
    assert_eq!(
        transcode(&etc1s(true), Ktx2UploadCapabilities { etc1: true, ..NONE }),
        (Ktx2TranscodeTarget::Rgba8, false)
    );
    assert_eq!(
        transcode(&etc1s(false), NONE),
        (Ktx2TranscodeTarget::Rgba8, false)
    );
    assert!(
        transcode(&texture(0, 163, 2, false, 1, 1), ALL).1,
        "sRGB transfer is carried"
    );
    let uastc = texture(0, 166, 2, true, 0, 1);
    assert_eq!(
        transcode(&uastc, Ktx2UploadCapabilities { bptc: true, ..NONE }),
        (Ktx2TranscodeTarget::Bc7, true)
    );
    assert_eq!(
        transcode(&uastc, Ktx2UploadCapabilities { dxt: true, ..NONE }),
        (Ktx2TranscodeTarget::Bc3, true)
    );
    assert_eq!(
        transcode(&uastc, Ktx2UploadCapabilities { etc2: true, ..NONE }),
        (Ktx2TranscodeTarget::Etc2Rgba8, true)
    );
    assert_eq!(
        transcode(&uastc, Ktx2UploadCapabilities { etc1: true, ..NONE }),
        (Ktx2TranscodeTarget::Rgba8, true)
    );
}

#[test]
fn rgba_fallback_covers_every_declared_mip_level() {
    let plan = plan_ktx2_upload(&texture(0, 163, 1, false, 1, 2), NONE).unwrap();
    match plan {
        Ktx2UploadPlan::Transcode { rgba_bytes, .. } => {
            assert_eq!(rgba_bytes, 4 * 4 * 4 + 2 * 2 * 4);
        }
        other => panic!("expected transcode, got {other:?}"),
    }
    let plan = plan_ktx2_upload(&texture(0, 163, 1, false, 1, 1), NONE).unwrap();
    match plan {
        Ktx2UploadPlan::Transcode { rgba_bytes, .. } => assert_eq!(rgba_bytes, 64),
        other => panic!("expected transcode, got {other:?}"),
    }
}

#[test]
fn real_basislz_fixture_selects_a_transcode_target() {
    let bytes = include_bytes!("fixtures/resource-containers/basislz.ktx2");
    let container = inspect_ktx2(Cursor::new(bytes), bytes.len() as u64).unwrap();
    assert!(!container.data_format.has_alpha);
    match plan_ktx2_upload(&container, ALL).unwrap() {
        Ktx2UploadPlan::Transcode {
            target, rgba_bytes, ..
        } => {
            assert_eq!(target, Ktx2TranscodeTarget::Astc4x4);
            assert_eq!(rgba_bytes, 64);
        }
        other => panic!("expected transcode, got {other:?}"),
    }
    let zlib = include_bytes!("fixtures/resource-containers/rgba8-zlib.ktx2");
    let container = inspect_ktx2(Cursor::new(zlib), zlib.len() as u64).unwrap();
    assert_eq!(
        plan_ktx2_upload(&container, ALL).unwrap_err().code,
        "texture_container_unavailable"
    );
}
