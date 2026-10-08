# Original compressed audio fixtures

SPDX-License-Identifier: MIT

All waveforms, encoded derivatives, and the generator are original synthetic
project test material, distributed under the repository's MIT license. There are
no third-party recordings. `generate.py` creates mono, 44,100 Hz, signed 16-bit PCM
with `round(12000 * sin(2 * pi * frequency * frame / 44100))`:

| Source | PCM frames | Frequency |
| --- | ---: | ---: |
| a | 10,000 | 440 Hz |
| b | 12,345 | 733 Hz |

The initial six MP3/AAC fixtures were independently probed on 2026-10-08 in
`output/review-audio-compressed-20261008`. Regenerating them here produced the same
SHA-256 values as that probe's `fixture-sha256.json`. The FLAC and ALAC assets
were added from the same waveform recipe. `sha256.json` records
the hashes of every checked-in asset; the tests do not depend on the probe folder.

## Reproduction

Run from this directory with Python 3 and FFmpeg containing `libmp3lame`:

```sh
python generate.py --ffmpeg /path/to/ffmpeg
```

The checked-in files use FFmpeg `7.1-essentials_build-www.gyan.dev`, supplied by the
local `imageio_ffmpeg` package. The generator records the exact arguments: MP3
uses `libmp3lame` at 192 kbit/s; AAC uses FFmpeg's native AAC encoder at 192 kbit/s;
FLAC and ALAC use the corresponding lossless encoders. All commands discard
input metadata. AAC and ALAC MP4 containers use `-movie_timescale 44100` so movie
timescale rounding does not obscure the sample count. Other FFmpeg versions may
produce different hashes; inspect metadata and decoded lengths before updating.

`a-no-xing.mp3` uses `-write_xing 0`. `a-xing-no-lame.mp3` retains the `a.mp3`
Xing/Info frame and every audio frame but replaces the 36-byte encoder extension
at offset 185 with zeroes. The generator asserts the expected `Lavc` prefix
before applying that mutation.

## Decoder evidence and contract

With Symphonia 0.5.5 and `FormatOptions::enable_gapless = true`:

| Asset | Decoded frames | Codec delay / padding | Exact gapless |
| --- | ---: | --- | --- |
| a.mp3 | 10,000 | 1105 / 415 | yes |
| b.mp3 | 12,345 | 1105 / 374 | yes |
| a-no-xing.mp3 | 11,520 | absent / absent | bypass |
| a-xing-no-lame.mp3 | 11,520 | 0 / 0 | bypass |
| a-exact-timescale.m4a | 11,264 | absent / absent | bypass |
| b-exact-timescale.m4a | 14,336 | absent / absent | bypass |
| a.flac | 10,000 | absent / absent | yes |
| a-alac.m4a | 10,000 | absent / absent | yes |

The native `MpaReader` reads LAME-compatible encoder delay/padding, adjusts
`n_frames`, and calls `trim_packet`; the MP3 decoder applies those packet trims.
The presence of `Some(0)` alone is insufficient: the unrecognized encoder
extension reports zero delay and padding. Conversely, legitimate zero tail
padding must remain accepted when nonzero delay and a valid frame count establish
trim support. A metadata boundary test checks this independently of the two
encoded fixtures (whose tail padding is nonzero). A 10,415-frame libmp3lame
candidate produced 1,152 padding frames, so it is not retained as false evidence
of naturally emitted zero padding.

PCM does not prime or pad the signal. FLAC uses each block's sample count and ALAC
uses its encoded frame size, including the short final frame; both lossless
fixtures decode exactly to the original 10,000 frames.

`IsoMp4Reader` and the AAC decoder in 0.5.5 do not apply MP4 edit/priming trims.
The AAC a-file really presents 10,000 PCM frames: its first packet has PTS -1024
and skip_samples 1024, its presentation duration is 10,000, and its last packet
duration is 784. Symphonia reports `n_frames = 11024` and decodes 11,264 frames.
The regression uses known generated lengths, not a hardcoded AAC trimming fix or
FFmpeg's raw output length (which can itself retain tail padding).

Run `cargo test -p vmusic-audio` from the repository root. Tests use the checked-in
files through production `open_media`, `decode_loop_opened`, `prepare_next`, and
`write_samples`, with headless backend construction. They verify ordinary decode,
unequal MP3 sample concatenation, both transition directions for each bypassed
format, positive crossfade, and capability propagation at source replacement.
Neither FFmpeg nor an audio device is needed at test runtime. Hardware listening
and other codec/container combinations remain separate acceptance work.
