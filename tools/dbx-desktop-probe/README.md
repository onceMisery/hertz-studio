# DBX desktop D0 native runtime probe

This Windows-only harness builds **the real external `dbx-plugin-runtime` source** and uses
`PluginRegistry::new_with_app_version` / `PluginHost::invoke` / `PluginHost::stop`.
It does not launch DBX's graphical application, install a plugin in the user's DBX store,
run Hertz playback, or start a network listener. Production behavior is not changed.

Set `DBX_SOURCE` to a local DBX source checkout, then run from the Hertz repository:

```powershell
pwsh -NoProfile -File tools/dbx-desktop-probe/run.ps1 -DbxSource $env:DBX_SOURCE -Label current
pwsh -NoProfile -File tools/dbx-desktop-probe/run.ps1 -DbxSource $env:DBX_SOURCE -Revision v0.6.35 -Label minimum
cargo test -p hertz-desktop-ipc -- --nocapture
cargo clippy -p hertz-desktop-ipc --all-targets -- -D warnings
```

The script generates an isolated Cargo workspace under ignored `output/<label>-<timestamp>/`.
Only its generated manifest contains local source dependency paths. A requested historical
revision is copied with `git archive` into that output directory; the original checkout is
never switched, edited, or reset. Binaries share `output/target/`; run the two probes
sequentially. The external runtime's dependencies are resolved by the generated lockfile,
which is also retained with the evidence. `source.json`, build/run logs and `evidence.json`
are local artifacts; no disposable credentials belong in Git.

The host activates a disposable sidecar with a versioned manifest and the actual runtime's
`DBX_PLUGIN_DATA_DIR`. The sidecar starts a production-primitive named pipe and a disposable
child. An independently launched component uses the production bounded synchronous client
to exchange a frame; the sidecar reports the actual client PID, token SID and session.
The host also cancels a pending real pipe request and observes a five-second handler being
dropped by the two-second server deadline. It then stops the real runtime, observes the
sidecar/descendant/independent processes through retained process handles, reclaims the pipe
name, and explicitly terminates/reaps every disposable child. Components have a 45-second
safety ceiling in addition to explicit cleanup. No UI is opened.

## Recorded on 2026-10-28

| Actual runtime source | External pipe and identity | Client cancellation | Server deadline/reclaimed work | Host stop |
| --- | --- | --- | --- | --- |
| `41698ac708812d176ba7cd0593e921bd744b2186`, app 0.6.47 | passed | 61 ms | 2028 ms, active connections 0 | sidecar + descendant stopped; independent component survived |
| `v0.6.35` / `8b2bc1708b8f3625ece17f879708f43e9f27e00f`, app 0.6.35 | passed | 63 ms | 2022 ms, active connections 0 | sidecar + descendant stopped; independent component survived |

Evidence directories are `output/d0-current-20261028-211017-030/` and
`output/d0-minimum-20261028-211104-468/`. Each records pipe reclamation, explicit process
cleanup and `stop_all` success; adjacent `source.json` records SHA256 hashes of the tested
crate/probe sources. The shared crate's 16 native focused checks additionally
cover actual SID-only protected pipe DACL, actual server PID mismatch, directory junction /
case / extended-prefix equivalence, private atomic file ACLs, malformed/truncated/oversized
frames, queued multiple frames across Mio's 8 KiB read boundary, bounded serialization,
complete replacement errors, send admission, absent-listener connect timeout, cancellation,
slow-reader write cancellation while the client remains open, and actual endpoint disconnect
before send-registration Drop on both timeout and task abort.

**Integration decision: `launchMode = "manual"`.** Both supported runtime observations kill
sidecar descendants. The user must independently start the separately installed component;
DBX may connect to that component without spawning a desktop process beneath the sidecar.

## Boundaries and remaining native acceptance

`evidence.passed` means the checks this headless runtime harness executes passed. Each record
explicitly marks second-user rejection, second-session rejection and DBX graphical-workbench
close/reopen as skipped: this machine did not supply disposable credentials/sessions, and
this harness does not open the graphical host. Those are still native acceptance items;
this evidence does not declare the entire desktop integration or release accepted.

The D0 shared crate owns typed source identities, bounded framing, discovery envelopes,
SID/session/PID checks and cancelable Windows transport. The next bridge owner must enforce
authorization/key rotation, per-scope 2 / global 4 admission, rate limits, discovery ownership,
and shutdown generations. `Connection::serve_with_admission` invokes a synchronous final
send-registration callback after bounded serialization, before the first write. Its guard
outlives cancellation of the owned pipe. No business lock may be held across pipe I/O.

The transport explicitly calls `CancelIoEx` before dropping a pipe, because Mio intentionally
leaves pending writes alive in its default Drop implementation. A frame boundary cancels
and consumes the outstanding read completion so bytes in Mio's prefetch buffer or a queued
IOCP completion cannot evade multiple-frame detection. The server drains response delivery
by waiting for the client's close within the same two-second deadline; it never invokes
synchronous `FlushFileBuffers` on a pipe. A later second request is rejected during this
drain and cannot invoke another projection. This same-user boundary does not isolate
mutually malicious processes belonging to the same Windows user.
