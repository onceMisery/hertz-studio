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
