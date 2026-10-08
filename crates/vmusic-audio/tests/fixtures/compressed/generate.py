# SPDX-License-Identifier: MIT
# Copyright (c) 2026 hertz-studio contributors
"""Regenerate original synthetic regression assets; tests need no FFmpeg."""

import argparse
import hashlib
import json
import math
from pathlib import Path
import struct
import subprocess
import tempfile
import wave


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--output", type=Path, default=Path(__file__).parent)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    rate = 44100
    assets = []

    with tempfile.TemporaryDirectory(prefix="hertz-gapless-") as temporary:
        sources = Path(temporary)
        for name, frames, frequency in [
            ("a", 10000, 440),
            ("b", 12345, 733),
        ]:
            samples = b"".join(
                struct.pack("<h", round(12000 * math.sin(2 * math.pi * frequency * i / rate)))
                for i in range(frames)
            )
            with wave.open(str(sources / (name + ".wav")), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(rate)
                wav.writeframes(samples)

        def encode(source, target, *options):
            subprocess.run(
                [args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
                 "-i", str(sources / (source + ".wav")), "-map_metadata", "-1",
                 *options, str(args.output / target)],
                check=True,
            )
            assets.append(target)

        for name in ["a", "b"]:
            encode(name, name + ".mp3", "-c:a", "libmp3lame", "-b:a", "192k")
        encode("a", "a-no-xing.mp3", "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "0")
        for name in ["a", "b"]:
            encode(name, name + "-exact-timescale.m4a", "-c:a", "aac", "-b:a", "192k",
                   "-movie_timescale", str(rate))
        encode("a", "a.flac", "-c:a", "flac")
        encode("a", "a-alac.m4a", "-c:a", "alac", "-movie_timescale", str(rate))

    # Keep the Xing/Info duration and audio packets, erase its encoder extension.
    # This offset is specific to the reproducible FFmpeg 7.1 command above.
    data = bytearray((args.output / "a.mp3").read_bytes())
    assert data[185:189] == b"Lavc", "encoder header changed; inspect before regenerating"
    data[185:221] = bytes(36)
    target = "a-xing-no-lame.mp3"
    (args.output / target).write_bytes(data)
    assets.append(target)
    hashes = {name: hashlib.sha256((args.output / name).read_bytes()).hexdigest()
              for name in sorted(assets)}
    (args.output / "sha256.json").write_text(json.dumps(hashes, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
