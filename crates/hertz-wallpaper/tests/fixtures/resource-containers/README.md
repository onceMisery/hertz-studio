# Resource container fixtures

`rgba8-zlib.ktx2` is a generated 4×4 RGBA8_UNORM ordinary 2D texture with
two genuine Zlib-compressed mip levels. It was written using the pinned Three
0.186.0 `examples/jsm/libs/ktx-parse.module.js` writer and decoded with its reader
and Node `inflateSync`; the decoded levels contain 64 and 16 bytes. All pixel
data is generated for this test (CC0-1.0).

SHA-256: `beca00bc32c72bb559df378b4888d45f1f3e3edcd1788ccee243133b5d346716`.
The first level begins at byte 263: the KTX specification excludes mip padding
for supercompressed levels. This fixture protects against applying the ordinary
uncompressed level alignment to Zlib/Zstd/BasisLZ. It proves container framing,
not runtime KTX2/Basis decoder or GPU admission.

`basislz.ktx2` is a generated 4×4 BasisLZ (ETC1S) ordinary 2D texture with one
8-byte level and a 56-byte supercompression global data section (two endpoints,
one selector, one image descriptor). It was written and read back with the
pinned Three 0.186.0 `ktx-parse.module.js`; descriptor/level/global-data facts
were confirmed by the same reader. SHA-256:
`ca653a8f6c759573787716f90dc0a5873fb9aa23da28586742ebce988d7b4340`. It proves
BasisLZ framing and RGB/alpha slice bounds, not ETC1S decode or GPU admission.
