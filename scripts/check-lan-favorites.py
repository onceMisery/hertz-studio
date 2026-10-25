#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Personal LAN favorites over real HTTP/TLS using isolated, silent profiles.

Exercises persistence, owner identity, current sharing and queue authorization.
Test credentials use the existing in-memory backend. No invitation, credential,
private key or local music path is included in the resulting report.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import platform
import shutil
import tempfile


spec = importlib.util.spec_from_file_location("lan_acceptance", Path(__file__).with_name("check-lan-room.py"))
lan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lan)


def stop(app):
    if app.process.poll() is None:
        app.call("/v1/system/shutdown", {})
        app.process.wait(timeout=15)
    app.close()


def create(host, track_ids):
    host.room(dict(action="create", name="LAN favorites acceptance", address="127.0.0.1:0",
                   sample_rate=48000, local_output=False, discoverable=False))
    host.room(dict(action="share", track_ids=track_ids))
    return host.peer(action="library", offset=0, limit=32)["tracks"]


def join(host, guest):
    permissions = dict(listen=True, queue=True, transport=False, volume=False,
                       chat_read=True, chat_send=True, invite=False)
    invitation = host.room(dict(action="invite", permissions=permissions))["invitation"]
    guest.room(dict(action="join", invitation=invitation, name="Favorite receiver", listen=False))
    lan.wait_for(guest.connected, "favorite receiver connected", 20)
    return permissions


def expect_error(callback, code):
    try:
        callback()
    except lan.ApiError as error:
        assert error.code == code, str(error)
    else:
        raise AssertionError("expected rejection: " + code)


def favorites(app):
    return app.call("/v1/favorites?kind=track&limit=200")["favorites"]


def verify(host, guest, alternate, music, executable, guest_profile, apps):
    checks = []
    host.call("/v1/library/scan", dict(root=str(music)))
    tracks = lan.wait_for(lambda: (lambda rows: rows if len(rows) == 3 else None)(
        host.call("/v1/tracks?limit=32")["tracks"]), "three shared source tracks")
    ids = [track["id"] for track in tracks]
    library = create(host, ids)
    permissions = join(host, guest)
    public = guest.peer(action="library", offset=0, limit=32)["tracks"]
    assert public == library
    pin = host.room()["fingerprint"]
    assert guest.room()["fingerprint"] == pin
    song = public[0]
    key, resource = song["favorite_key"], song["resource_id"]
    private_id = host.room()["favorite_local_ids"][key]
    reference = pin + ":" + key
    private_views = json.dumps([guest.room(), public, guest.peer(action="snapshot")])
    assert "favorite_local_ids" not in private_views
    assert all(track_id not in private_views for track_id in ids)
    assert "path" not in song and "id" not in song
    checks.append("native projection supplies pinned host identity; public metadata excludes host paths and original track IDs")

    local = dict(kind="track", source="local", ref_id=private_id, favorited=True)
    first = host.call("/v1/favorites/toggle", local)["favorite"]
    second = host.call("/v1/favorites/toggle", local)["favorite"]
    assert first["id"] == second["id"] and len(favorites(host)) == 1
    checks.append("host room target uses the existing local favorite identity without duplication")

    body = dict(kind="track", source="lan", ref_id=reference, title=song["title"],
                artist=song.get("artist"), album=song.get("album"),
                duration_ms=song.get("duration_ms"), cover="blob:must-not-persist", favorited=True)
    first = guest.call("/v1/favorites/toggle", body)["favorite"]
    second = guest.call("/v1/favorites/toggle", body)["favorite"]
    assert first["id"] == second["id"] and first["cover"] is None
    assert len(favorites(guest)) == 1 and len(favorites(host)) == 1
    assert guest.call("/v1/favorites/membership", dict(kind="track", source="lan", ids=[reference]))["ids"] == [reference]
    checks.append("guest personal favorite is private, desired-state idempotent and excludes ephemeral cover capabilities")

    resolved = guest.peer(action="resolve_favorites", keys=[key])["tracks"]
    assert len(resolved) == 1 and resolved[0]["resource_id"] == resource
    guest.control("queue", items=[dict(instance_id=None, resource_id=resource)] * 2)
    queue = host.peer(action="queue_page", offset=0, limit=32)["queue"]
    assert len(queue) == 2 and queue[0]["instance_id"] != queue[1]["instance_id"]
    assert len(favorites(guest)) == 1
    checks.append("favorite resolves to currently authorized resource; repeated queue occurrences share one personal favorite")

    # Retire queue entries first: this acceptance isolates resource revocation
    # from the separate playing/frozen-prefix behavior covered by room tests.
    host.control("queue", items=[])
    host.room(dict(action="share", track_ids=[]))
    assert guest.peer(action="resolve_favorites", keys=[key])["tracks"] == []
    assert favorites(guest)[0]["ref_id"] == reference
    expect_error(lambda: guest.control("queue", items=[dict(instance_id=None, resource_id=resource)]), "room_denied")
    host.room(dict(action="share", track_ids=ids))
    renewed = guest.peer(action="resolve_favorites", keys=[key])["tracks"][0]
    assert renewed["favorite_key"] == key and renewed["resource_id"] != resource
    checks.append("revoked sharing removes live resolution and rejects old resource; reshare preserves bookmark with a fresh capability")

    denied = dict(permissions, queue=False)
    member = guest.room()["member_id"]
    host.room(dict(action="permissions", member_id=member, permissions=denied))
    # Permission changes rotate the native session. Observe the new authorized
    # connection before testing a denied request, without retrying that request.
    lan.wait_for(lambda: (lambda state: state and not state["permissions"]["queue"])(guest.connected()),
                 "reconnected receiver observes revoked queue permission", 20)
    expect_error(lambda: guest.peer(action="resolve_favorites", keys=[key]), "room_denied")
    assert len(favorites(guest)) == 1
    host.room(dict(action="permissions", member_id=member, permissions=permissions))
    lan.wait_for(lambda: (lambda state: state and state["permissions"]["queue"])(guest.connected()),
                 "reconnected receiver observes restored queue permission", 20)
    checks.append("personal favorite does not grant queue permission or lose stored metadata after permission revocation")

    assert len(guest.peer(action="resolve_favorites", keys=[key] * 32)["tracks"]) == 1
    expect_error(lambda: guest.peer(action="resolve_favorites", keys=[key] * 33), "room_invalid")
    expect_error(lambda: guest.call("/v1/favorites/toggle", dict(body, ref_id=resource)), "bad_request")
    checks.append("bounded reference resolution and malformed LAN favorite rejection")

    guest.room(dict(action="leave"))
    stop(guest)
    apps.remove(guest)
    guest = lan.App(executable, guest_profile)
    apps.append(guest)
    assert favorites(guest)[0]["ref_id"] == reference
    join(host, guest)
    assert guest.peer(action="resolve_favorites", keys=[key])["tracks"][0]["favorite_key"] == key
    checks.append("guest service restart preserves the SQLite favorite and resolves after fresh authenticated join")

    guest.room(dict(action="leave"))
    host.room(dict(action="leave"))
    recreated = create(host, ids)
    assert host.room()["fingerprint"] == pin
    after = next(track for track in recreated if track["favorite_key"] == key)
    assert after["resource_id"] != renewed["resource_id"]
    join(host, guest)
    assert guest.peer(action="resolve_favorites", keys=[key])["tracks"][0]["favorite_key"] == key
    checks.append("room recreation retains host-scoped favorite identity while replacing session resource IDs")

    alternate.call("/v1/library/scan", dict(root=str(music)))
    other_tracks = lan.wait_for(lambda: (lambda rows: rows if len(rows) == 3 else None)(
        alternate.call("/v1/tracks?limit=32")["tracks"]), "alternate source tracks")
    create(alternate, [track["id"] for track in other_tracks])
    assert alternate.room()["fingerprint"] != pin
    assert alternate.peer(action="resolve_favorites", keys=[key])["tracks"] == []
    checks.append("another host sharing the same music cannot resolve the original host's favorite identity")

    guest.call("/v1/favorites/toggle", dict(body, favorited=False))
    guest.call("/v1/favorites/toggle", dict(body, favorited=False))
    assert not favorites(guest) and len(favorites(host)) == 1
    checks.append("repeated un-favorite is idempotent and cannot mutate the host's personal favorites")
    return checks


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    result = dict(binary_sha256=hashlib.sha256(binary.read_bytes()).hexdigest(), platform=platform.platform(),
                  limits="Isolated loopback HTTP/TLS, null audio and in-memory test credentials. Guest DB restart and same-process room recreation; persistent host-key reconstruction is covered by Rust tests.")
    apps = []
    with tempfile.TemporaryDirectory(prefix="hertz-lan-favorites-") as temporary:
        directory = Path(temporary)
        executable = directory / binary.name
        shutil.copy2(binary, executable)
        try:
            for name in ["host", "guest", "alternate"]:
                profile = directory / name
                profile.mkdir()
                apps.append(lan.App(executable, profile))
            lan.fixtures(directory / "music")
            checks = verify(*apps, directory / "music", executable, directory / "guest", apps)
            result.update(passed=True, checks=checks)
        except Exception as error:
            # Deliberately exclude request bodies, invitations and credentials.
            result.update(passed=False, error_type=type(error).__name__)
            raise
        finally:
            for app in reversed(apps):
                try:
                    stop(app)
                except Exception:
                    app.close()
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
