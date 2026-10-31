# Room cover fixture

`lobby-cover.jpg` is a 512×288 JPEG generated locally by the detailed-photo upload case in `scripts/check-room-flow-browser.js`: a deterministic textured gradient and the text “NIGHT RADIO”. It contains no external media or personal data.

The fixture is the production browser encoder's output, within the 24 KiB room cover limit. Native tests use it to verify complete JPEG decoding, MIME validation, dimension and byte limits, and the pinned TLS lobby-profile round trip.
