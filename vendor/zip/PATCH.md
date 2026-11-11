# zip 2.6.1: bounded original metadata and payload owners

This is a repository patch of the published zip 2.6.1 source, VCS revision
`1d42731efcad72e9f653a5ca46ed8306f4a3ca72`. `UPSTREAM.json`, the original
`Cargo.toml.orig`, and the original license/provenance files identify the copied
source. The patch does not introduce a second ZIP parser. Root Cargo patch/lock
configuration selects this source for the workspace's ZIP consumers.

Independent Standard/Full edition wrappers inherit the root's single
`[patch.crates-io]` table, with paths resolved from the source repository.
`scripts/check-editions.js` checks the resolved ZIP manifest and compiles the
actual wallpaper contract in both wrappers. The original desktop build identity
owner includes this vendor manifest, provenance and source tree; parser repairs
therefore change desktop/plugin/studio identities. Standalone test locks and
compiler caches are excluded from that identity.

## API and compatibility

`ZipArchive::with_metadata_limits(config, reader, limits)` adds an opt-in original
parser path. `Config` retains its single field and `repr(transparent)`;
`ZipArchive::new`, `with_config`, and old Config literals still work. The patched
manifest accurately declares Rust 1.88.0, because the bounded decoder uses
standard UTF8Chunks and the window checks use `Option::is_none_or`.

The four file lookup return types explicitly spell the existing receiver lifetime
as `'_` for current Rust's `mismatched_lifetime_syntaxes` lint. This preserves
their borrowing behavior and keeps warning-denied builds compatible with the
Rust 1.88 minimum; it does not change the metadata or allocation controls.

The four usize limits are `max_raw_entries`, `max_variable_bytes` (raw central
name + extra + comment bytes), `max_zip64_extensible_bytes`, and
`max_eocd_comment_bytes`. Limits are checked, including checked arithmetic and
allocation layouts, before the affected allocation/read. ZIP64 u16 sentinels are
deferred until the genuine u64 count is available. Author counts cannot reserve
a Vec unless their fixed 46-byte records fit the real declared directory window.
Bounded parsing consumes that complete window: an optional APPNOTE central
digital signature is validated and skipped with fixed stack scratch, and other
unparsed tails are rejected all the way to the physical footer. The signature
may be wholly included in the declared directory size or wholly follow it;
partial signature inclusion and unexplained gaps are rejected. This prevents
jointly underreported count and size from hiding additional records.

`raw_file_count()` and the immutable `metadata_usage()` retain successfully
parsed raw records before IndexMap deduplication, on default and bounded paths.
Writer-finalized Shared also reports its actual serialized central record count
and variable lengths. Default name deduplication remains last-value-wins.
Bounded/default decoders produce the same CP437, lossy UTF-8, and CRC-validated
Unicode path/comment values for valid fields. The bounded branch rejects short
or escaping extra subfields and propagates their IO failures; the default branch
retains upstream's ignored-extra-IO behavior.

`MetadataLimits::checked_heap_bounds()` is usable before opening.
`MetadataLimits::checked_read_heap_bounds::<R>(method)` computes the concrete
original reader fee before opening, sharing the exact size_of factor with the
actual-usage archive API. It constructs no dummy archive or reader.
`ZipArchive::checked_metadata_heap_bounds()` uses actual immutable parser usage,
and refuses a default/writer opening whose capacities were not controlled.
`checked_metadata_read_heap_bounds(method)` adds one unencrypted concrete reader;
`checked_file_read_heap_bounds(index)` also validates the selected file's method
and rejects encryption. Opening bounds exclude the active file reader.

`ZipArchive::by_index_with_cancel(index, &AtomicBool)` opts into cancellation at
the original by_index, plaintext CryptoReader and borrowed ZipFile owners. The
same borrowed token is polled before bottom reads and after successful reads,
including EOF and Deflate's zero-output input continuation. ZipFile also polls
buffered output/EOF and all bulk entries, including empty read_exact. Its original
read_exact/read_to_end/read_to_string delegation preserves Crc32Reader's
success-only bulk CRC state, partial-error retry behavior and UTF-8 precedence.
CryptoReader retains the original no-token Take/crypto bulk delegation. Opt-in
plaintext bulk methods traverse that original owner's polled read with a fixed
stack chunk. The String helper's stack guard borrows only the caller's existing
Vec backing through as_mut_vec: no str reference escapes while appended bytes
may be invalid, and the valid length advances only after complete UTF-8
validation. Drop truncates invalid appended bytes on an error or panic; valid
appended bytes survive a real I/O error, which takes precedence over UTF-8.
No additional heap backing or reader owner is introduced. Local-header operations remain synchronous
and bounded, with a post-return poll. A typed zero-sized PayloadReadCancelled
io::Error uses Other, avoiding std/flate2's automatic Interrupted retry loops;
is_payload_read_cancelled recognizes it without calling caller error hooks.
Real non-Interrupted errors win a token race unchanged. Old APIs use no token,
and decrypt/raw/owned streaming Drop behavior remains at the original owners.
No wrapper, broker, parser, Arc or new stream owner is introduced.

## Source and lock premises

All numbers are **requested allocation layouts**, excluding allocator bookkeeping,
RSS, caller-owned reader buffers, and allocations made by caller-supplied IO
errors. The checked equations use the private original ZipFileData, Shared,
CryptoReader, Decompressor and Crc32Reader layouts at their actual owners.

Supported source closure is the root lock: **indexmap 2.14.2, hashbrown 0.17.1,
flate2 1.1.10, miniz_oxide 0.9.1**, on the workspace's x86_64 target. Standalone
acceptance uses a local lock seeded from that same root lock. The indexmap
manifest range remains upstream's `2`; arbitrary independent future resolution
is not qualified by these equations. Updating this source closure requires
rechecking the equations and allocator witness. The optional miniz_oxide
dependency is exact `=0.9.1` and associated with the existing `deflate` feature;
it enables no additional backend.

Deflate's reader equation applies to the workspace's flate2 **rust_backend**
feature closure. Zip's zlib/zlib-ng features are explicitly excluded from that
API branch. Foreign feature unification can enable another flate2 backend
without a Zip feature; root feature-closure verification is therefore a required
premise. Other compression methods and encryption receive no reader-cost bound.
The metadata opening/retained equations do not depend on the decompressor
backend.

Rust 1.88 source authority is the official release rust-src component verified
in `output/design-final-followthrough/rust-188-official-source-alternatives-r10-20261111T011529433423Z/`.
Its tar.xz SHA256 is
`d6e7462e5b5e53bde515d8846ffdd4da246b79ba2d7b2872a33b46cc12cf76c7`.
Relevant original files are `alloc/raw_vec/mod.rs` (exact capacity/layout),
`alloc/vec/mod.rs` (with_capacity, boxing and exact clone), `alloc/string.rs`
(boxing), and `alloc/boxed.rs:1767–1805` (slice/str clone). Additional unchanged
files extracted from that same verified component into this implementation's
fresh evidence directory are `alloc/sync.rs:371–418` (repr(C) ArcInner counters
and Box), `alloc/slice.rs` (exact byte copies), and `core/str/lossy.rs`
(UTF8Chunks segmentation). No second CP437 table is copied: bounded decoding
calls the original `cp437::to_char`.

## Variable owners and the 8B bound

For one central record let `a`, `e`, `c` be its original raw name, extra, and
comment lengths. Every successful Unicode content lies in that record's extra
subrange, so its length is at most `e`. CP437 emits at most three UTF-8 bytes per
input byte. UTF8Chunks emits the valid bytes plus one three-byte replacement per
invalid chunk, at most three bytes per original input byte. The bounded decoder
first computes the exact output length with checked addition, reserves exactly
that length, then fills it. Its String cannot grow; length equals capacity when
boxing, so there is no shrinking allocation. Unicode replacement uses exact
Box byte copies and String::from_utf8 on an already exact Vec.

| Owner family | Simultaneous requested byte upper bound | Original owner/control |
| --- | ---: | --- |
| Initial raw/decoded name | `a + 3a` | raw Box retained; two-pass exact decoded Box |
| Initial raw/decoded comment | `c + 3c` | raw Box explicitly dropped after bounded decode |
| Name family during Unicode replacement | `4a + 3e` | raw name ≤ `a+e`, decoded name ≤ `3a+e`, incoming content or decoded copy ≤ `e`; old raw drops before new raw's clone |
| Comment family during Unicode replacement | `3c + 2e` | old decoded comment ≤ `3c+e`, incoming replacement ≤ `e`; raw comment has already dropped |
| Extra byte family during parsing/removal | `3e` | original Vec, previous processed Vec, incoming processed Vec; each exact capacity ≤ `e` |
| Retained record buffers | `4a + 3c + 4e` | raw name ≤ `a+e`, decoded name ≤ `3a+e`, comment ≤ `3c+e`, processed extra ≤ `e` |
| Retained buffers plus cloned IndexMap key | `7a + 3c + 5e` | one exact name clone ≤ `3a+e` during conversion |
| Typed extra Vec | `size_of::<ExtraField>() * floor(e/5)` | exact initial reservation; guard before every push |
| Extra Arc owners | at most three `Arc<Vec<u8>>` allocations per current record | Arc clones share an allocation; new processed Arc may overlap old processed and original |
| Skipped unknown/ZIP64 surplus/digital signature | zero heap bytes | bounded fixed 256-byte stack scratch |

The initial phase is at most `4a+4c+e`. A deliberately conservative simultaneous
replacement/removal envelope is `(4a+3e) + (3c+2e) + 3e = 4a+3c+8e`.
The conversion envelope is `7a+3c+5e`. Each is at most `8(a+e+c)`.
Summing across completed and partial records gives **8B**, where
`B = sum(a+e+c)`. Earlier records and the current partial record share this same
sum; historical replacement allocations are dropped, not accumulated. This
coefficient follows the original lifetimes plus the exact-capacity controls,
and is not an empirical slope. Allocator tests assert no bounded reallocations.

A successful ExtendedTimestamp consumes at least five source bytes (four-byte
header plus its minimum one-byte body); NTFS consumes 36. The typed Vec reserves
`floor(e/5)` even for unknown fields, and cannot grow on push. Summed reservations
are at most `floor(E/5)`, where `E = sum(e)`. Partial parsing failures keep those
reserved capacities in the same equation until destructors run.

## Structural layouts and executable equations

On the pinned x86_64 closure, ZipFileData is 208 bytes and ExtraField is 32.
The source witness for indexmap's private Bucket is `{ usize hash, Box<str> key,
ZipFileData value }`: 232 bytes. Its fields' alignments make field-order
permutation immaterial to this total; the equation computes `size_of` rather
than substituting 232. Source is `indexmap/src/lib.rs:137–151` and
`inner.rs:120–124`. IndexMap preallocates for the **raw** Vec length, so duplicates
cannot reduce the reservation or cause subsequent growth.

`hashbrown/src/raw.rs:104–161,179–239` determines the usize index table:

```text
buckets(0)=0
buckets(n)=4 for 1..3; 8 for 4..7; 16 for 8..14
buckets(n)=next_power_of_two(floor(checked(n*8)/7)) for n>=15
H(0)=0
H(n)=align_up(checked(size_of::<usize>()*buckets(n)),16)+buckets(n)+16
IM(R)=checked(size_of::<SourceBucket>()*R)+H(R)
```

The locked SSE2 group width/alignment is 16 (the scalar widths are smaller).
Every operation is checked, including hashbrown's `isize::MAX - 15` layout
constraint. The original Vec backing remains live through `into_iter` while the
IndexMap bucket and hash-table allocations and cloned keys are built.

Arc's repr(C) layout is two AtomicUsize counters followed by its aligned value.
The executable witness `ArcLayout<T>` follows official `alloc/sync.rs`.
`A = size_of::<ArcLayout<Vec<u8>>>()` is 40 on this target;
`S = size_of::<ArcLayout<Shared>>()` is evaluated from the private **patched**
Shared (including immutable usage), and is not the old r9 layout.

The implementation in `src/read/metadata_limits.rs` computes:

```text
V=checked(8*B) + checked(size_of::<ExtraField>()*floor(E/5)) + X + C
Zlive=IM(R) + V + checked(R*A) + S
Zparse=checked(R*size_of::<ZipFileData>()) + V + checked(3*R*A)
Zconvert=checked(R*size_of::<ZipFileData>()) + Zlive
Zfind=4096 + X + C
Zopen=max(Zfind,Zparse,Zconvert)
```

`R` is raw count, `X` is ZIP64 extensible bytes, and `C` is EOCD comment bytes.
The two original MagicFinder buffers are 2048 bytes each. They drop before
central parsing. ZIP32 comment and ZIP64 extensible buffers can coexist and are
counted in every phase. Shared Arc is actually made after the old Vec drops;
including it in Zconvert is a conservative source-derived overlap. For the
pre-opening limits API, `E<=B` is substituted; actual usage preserves E separately.

One reader's additional cost is evaluated at the original private make_reader:

```text
D(method,R)=8192
  + size_of::<Crc32Reader<Decompressor<BufReader<CryptoReader<'_,R>>>>>()
  + (0 for Stored; size_of::<miniz_oxide::inflate::stream::InflateState>() for Deflate)
read_phase=Zlive+D
```

The explicit original BufReader capacity is 8192. Locked flate2
`ffi/miniz_oxide.rs:40–44,79–87` owns exactly one boxed InflateState;
miniz_oxide `inflate/stream.rs:121–124` allocates that same Box. Its 43,296-byte
1.88 layout is computed, not hardcoded. The outer reader Box varies with active
features and the compiler's actual private type layout, and is computed on each
build. Neither this API nor ZIP metadata tests qualifies full ModelInput,
manifest/composition/typed JSON overlap, native 320 MiB admission, or GPU work.

## Fatal errors and cleanup

All quota/layout rejections use `ZipError::MetadataLimitExceeded(&'static str)`.
They propagate directly from EOCD, EOCD64 and central candidate catches, the
extra parser, and Shared construction. They never become an ignored IO error or
a fallback candidate. Canonical may retain its existing too_many_files mapping
for exactly `"raw entry limit exceeded"`; other reasons are metadata rejection:

```text
raw entry limit exceeded
raw entry count does not fit usize
central variable byte limit exceeded
ZIP64 extensible byte limit exceeded
ZIP64 extensible length does not fit usize
EOCD comment limit exceeded
central record capacity exceeded
typed extra field capacity exceeded
metadata size arithmetic overflow
metadata allocation layout overflow
metadata hash table layout overflow
```

Format/window violations remain format errors. Candidate-local completed and
partial records, comments/sectors, exact scratch owners, and all three possible
extra Arc owners drop before another candidate or before return on fatal error.
The allocator witness tracks both old/new requests during realloc and verifies
zero remaining tracked bytes after success and partial failure destruction.

## Acceptance and retirement

`src/metadata_limits_tests.rs` is an explicit integration target. It exercises
the actual ZipArchive parser with a fixed-table System allocator and Read/Seek
spy; fixture construction and caller-owned payloads occur outside measurement.
Fixtures cover false huge author counts before reserve, genuine small/huge
ZIP64 counts with sentinel fields, X+comment boundaries, central variable and
subfield ranges, exact limits/one-over, CP437/all byte values/invalid UTF-8,
CRC-valid repeated Unicode replacements, typed and removed extra overlap, raw
duplicates and last-value-wins, underreported count/tail, digital signature,
fatal candidate fallback, partial-record IO cleanup, and concrete Stored/Deflate
readers. A virtual 256 MiB Stored payload with two short records performs only
2168 bytes of opening reads and retains the same 802 bytes / 4096-byte opening
peak as the zero-payload fixture. No large real fixture or OOM test is used.

Fresh evidence is under
`output/design-final-followthrough/zip-metadata-impl-r11-20261111T0152055586576Z/`.
Rust 1.88 and stable test the root's same core source versions, both the
no-default-features+deflate and default feature sets. The original upstream
`read::test::test_is_symlink` fails on this Windows host with OS error 1314
(missing symlink privilege). Its source is unchanged; successful acceptance
commands explicitly use `--skip read::test::test_is_symlink`, and the initial
unfiltered failure logs are preserved. Stable also reports existing upstream
lifetime/deprecation warnings; none are suppressed by this patch.

Retire this repo patch when an upstream release provides equivalently verifiable
pre-allocation metadata controls, fatal rejection propagation, complete raw
record provenance, exact decoder/typed capacity controls, and executable
requested-layout bounds. Verify default compatibility, the same allocator/Read
fixtures, and the workspace feature closure before replacing the patched source.
