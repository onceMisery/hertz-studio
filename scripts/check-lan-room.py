#!/usr/bin/env python3
"""Two independent app profiles, real HTTP/TLS and optional muted native PCM.

Build first. --native-output opens the default soundcard at local volume zero;
it verifies scheduling, not acoustic synchronization between two computers.
Only the Python standard library is needed. Credentials never enter the report.
"""
import argparse
from collections import deque
import hashlib
import json
import math
import os
import platform
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import wave


class ApiError(Exception):
    def __init__(self, status, body):
        self.status = status
        self.code = body.get("error", {}).get("code", "unknown")
        self.message = body.get("error", {}).get("message", "")
        super().__init__(f"HTTP {status}: {self.code}")


class App:
    def __init__(self, binary, directory):
        self.directory = directory
        self.log = (directory / "service.log").open("wb")
        environment = dict(os.environ, VMUSIC_BACKEND="null", VMUSIC_SECRETS="memory")
        self.process = subprocess.Popen(
            [str(binary), "--data-dir", str(directory), "--bind", "127.0.0.1", "--port", "0"],
            env=environment, stdout=self.log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.url = None
        self.token = None
        self.operation_highwater = {False: 0, True: 0}
        self.pair_credit = 3.0
        self.pair_updated = time.monotonic()
        try:
            wait_for(self._discovered, "application startup", 20)
        except Exception:
            self.close()
            raise

    def _discovered(self):
        if self.process.poll() is not None:
            raise RuntimeError("application exited during startup")
        try:
            info = json.loads((self.directory / "vmusicd.json").read_text(encoding="utf-8"))
            if info["pid"] != self.process.pid:
                return False
            self.url = f"http://127.0.0.1:{info['port']}"
            self.token = info["token"]
            return True
        except (OSError, ValueError, KeyError):
            return False

    def call(self, path, body=None):
        request = urllib.request.Request(
            self.url + path,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
        )
        try:
            # These profiles bind only to loopback. A user's system HTTP proxy
            # must not receive native-service credentials or alter this test.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=12) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise ApiError(error.code, json.load(error)) from None

    def room(self, body=None):
        if body and body.get("action") == "join":
            # Admission/revocation coverage deliberately attempts invalid
            # invitations too. Pace new attempts to the production source
            # quota (burst 3, one per 5s); never retry an uncertain Join.
            now = time.monotonic()
            credit = min(3.0, self.pair_credit + (now - self.pair_updated) * .2)
            if credit < 1:
                time.sleep((1 - credit) / .2 + .1)
                now = time.monotonic()
                credit = min(3.0, self.pair_credit + (now - self.pair_updated) * .2)
            self.pair_credit = credit - 1
            self.pair_updated = now
        return self.call("/v1/room", body)

    def peer(self, **request):
        return self.room({"action": "peer", "request": request})

    def connected(self):
        snapshot = self.room()
        if snapshot.get("mode") != "guest":
            return False
        try:
            return self.peer(action="snapshot")
        except ApiError as error:
            if error.code == "room_reconnecting":
                return False
            raise

    def control(self, action, **content):
        snapshot = self.peer(action="snapshot")
        return self.peer(action=action, operation_id=self.operation(snapshot=snapshot),
                         expected_revision=snapshot["revision"], **content)

    def operation(self, chat=False, snapshot=None):
        # Guest snapshots arrive asynchronously. Treat the advertised next ID
        # as a lower bound, just as the real controller's monotonic allocator.
        snapshot = snapshot or (self.peer(action="chat_history", before=None, revision=None)
                                if chat else self.peer(action="snapshot"))
        value = max(self.operation_highwater[chat] + 1, int(snapshot["next_operation_id"]))
        self.operation_highwater[chat] = value
        return str(value)

    def play(self, action, **content):
        return self.control("playback", command={"action": action, **content})

    def close(self):
        if self.process.poll() is None:
            if self.url:
                try:
                    self.room({"action": "leave"})
                except Exception:
                    pass
            self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
        self.log.close()


def wait_for(predicate, description, timeout=10):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError("timed out: " + description)


def fixtures(directory):
    directory.mkdir()
    for index, rate in enumerate([44100, 48000, 96000]):
        path = directory / f"LAN fixture {index + 1}.wav"
        with wave.open(str(path), "wb") as stream:
            stream.setparams((2, 2, rate, 0, "NONE", "not compressed"))
            # Eight seconds each, with deliberately different source rates.
            second = bytearray()
            for frame in range(rate):
                sample = round(400 * math.sin(2 * math.pi * (220 + index * 110) * frame / rate))
                second.extend(struct.pack("<hh", sample, sample))
            for _ in range(8):
                stream.writeframes(second)
        path.with_suffix(".lrc").write_text("[00:00.00]LAN fixture\n[00:03.00]Shared timeline\n", encoding="utf-8")


def verify(host, guest, music, native, duration, samples, output_device=None):
    checks = []
    host.call("/v1/library/scan", {"root": str(music)})
    tracks = wait_for(lambda: (lambda rows: rows if len(rows) == 3 else None)(
        host.call("/v1/tracks?limit=32").get("tracks", [])), "three local tracks")
    host.room({"action": "create", "name": "LAN acceptance", "address": "127.0.0.1:0",
               "sample_rate": 48000, "local_output": False})
    host.room({"action": "share", "track_ids": [track["id"] for track in tracks]})
    library = host.peer(action="library", offset=0, limit=32)["tracks"]
    assert len(library) == 3
    assert all("path" not in row and "id" not in row for row in library)
    def new_item(resource):
        return {"instance_id": None, "resource_id": resource}

    def queue_items():
        return [{"instance_id": item["instance_id"], "resource_id": item["resource_id"]}
                for item in host.peer(action="queue_page", offset=0, limit=32)["queue"]]

    # Real HTTP preparation and Owner commits, including repeated resources.
    first, second = library[0]["resource_id"], library[1]["resource_id"]
    host.control("queue", items=[new_item(first), new_item(first), new_item(second)])
    duplicated = queue_items()
    assert len({q["instance_id"] for q in duplicated}) == 3
    host.control("queue", items=duplicated[1:])
    assert queue_items() == duplicated[1:]
    host.control("queue", items=list(reversed(duplicated[1:])))
    assert queue_items() == list(reversed(duplicated[1:]))
    unchanged = queue_items()
    revision = host.room()["revision"]
    invalid = [
        (unchanged + [unchanged[0]], revision, "room_invalid"),
        ([dict(unchanged[0], resource_id=first)], revision, "room_invalid"),
        ([duplicated[0]], revision, "room_invalid"),
        (unchanged, str(int(revision) - 1), "revision_conflict"),
    ]
    for items, expected, code in invalid:
        before = host.room()
        try:
            host.peer(action="queue", operation_id=before["next_operation_id"],
                      expected_revision=expected, items=items)
            raise AssertionError("invalid queue identity was accepted")
        except ApiError as error:
            assert error.code == code, error
        assert host.room()["revision"] == revision
        assert queue_items() == unchanged
    host.control("queue", items=[new_item(track["resource_id"]) for track in library])
    checks.append("duplicate queue occurrences retain identity; duplicate, mismatched, removed and stale writes are atomic")
    permissions = dict(listen=True, queue=True, transport=True, volume=True, chat_read=True, chat_send=True)
    # Exercise the complete local API -> pinned TLS admission path before a
    # member exists. Public lookup metadata must never grant membership.
    host.room({"action": "discoverable", "enabled": False})
    assert host.room()["discoverable"] is False
    assert host.room()["discovery_available"] is False
    room = host.room()
    target = dict(address=room["address"], fingerprint=room["fingerprint"], room_id=room["room_id"])

    def apply(name):
        result = guest.room(dict(action="apply", **target,
                                 room_code=room["admission"]["room_code"], name=name))
        assert result["state"] == "pending" and guest.room()["mode"] == "local"
        return dict(application_id=result["application_id"], applicant_secret=result["applicant_secret"])

    def status(application):
        return guest.room(dict(action="admission_status", **target, **application))

    rejected = apply("Rejected applicant")
    assert status(rejected)["state"] == "pending"
    host.room(dict(action="admission_review", application_id=rejected["application_id"],
                   approve=False, permissions=permissions))
    assert status(rejected)["state"] == "rejected"
    revoked = apply("Revoked approval")
    host.room(dict(action="admission_review", application_id=revoked["application_id"],
                   approve=True, permissions=permissions))
    approved = status(revoked)
    assert approved["state"] == "approved"
    host.room(dict(action="admission_revoke", application_id=revoked["application_id"]))
    assert status(revoked)["state"] == "rejected"
    try:
        guest.room(dict(action="join", invitation=approved["invitation"], name="Revoked", listen=False))
        raise AssertionError("revoked admission invitation was accepted")
    except ApiError:
        assert guest.room()["mode"] == "local"
    consumed = apply("Approved applicant")
    host.room(dict(action="admission_review", application_id=consumed["application_id"],
                   approve=True, permissions=permissions))
    approved = status(consumed)
    guest.room(dict(action="join", invitation=approved["invitation"], name="Approved", listen=False))
    wait_for(guest.connected, "approved applicant becomes a member", 20)
    receipt = status(consumed)
    assert receipt["state"] == "consumed" and receipt["member_id"] == guest.room()["member_id"]
    try:
        host.room(dict(action="admission_revoke", application_id=consumed["application_id"]))
        raise AssertionError("consumed admission was falsely reported revoked")
    except ApiError as error:
        assert error.code == "room_denied", error
    guest.room({"action": "leave"})
    checks.append("public room-code admission stays unauthenticated until approval; rejection, approval revocation and atomic consumption round-trip over TLS")
    issued = host.room({"action": "invite", "permissions": permissions})
    host.room(dict(action="revoke_invitation", invitation_id=issued["invitation_id"]))
    try:
        guest.room(dict(action="join", invitation=issued["invitation"], name="Revoked invite", listen=False))
        raise AssertionError("revoked direct invitation was accepted")
    except ApiError:
        assert guest.room()["mode"] == "local"
    assert not host.room()["discovery_available"]
    checks.append("discovery publication can be disabled and direct invitations can be revoked before pairing")
    invitation = host.room({"action": "invite", "permissions": permissions})["invitation"]
    guest.room({"action": "join", "invitation": invitation, "name": "Acceptance desktop", "listen": native and output_device is None})
    wait_for(guest.connected, "guest connected with current permissions", 20)
    if native and output_device is None:
        wait_for(lambda: guest.connected() and guest.room().get("output", {}).get("ready"), "native device and clocks", 20)
    assert guest.peer(action="library", offset=0, limit=32)["tracks"] == library
    checks.append("independent profiles, pinned TLS pairing, restricted shared library and queue")
    # Collaborative queue state is authoritative and scoped to occurrences,
    # including repeated resources contributed by the same member.
    def guest_control(action, **content):
        snapshot = guest.peer(action="snapshot")
        return guest.peer(action=action, operation_id=guest.operation(snapshot=snapshot),
                          expected_revision=snapshot["revision"], **content)

    guest_control("queue", items=queue_items() + [new_item(first), new_item(first)])
    projected = host.peer(action="queue_page", offset=0, limit=32)["queue"]
    added = projected[-2:]
    assert all(item["requester"]["member_id"] == guest.room()["member_id"] for item in added)
    assert added[0]["instance_id"] != added[1]["instance_id"]
    target = added[-1]["instance_id"]
    vote = dict(action="vote", operation_id=guest.operation(),
                expected_revision=host.room()["revision"], instance_id=target, voted=True)
    guest.peer(**vote)
    guest.peer(**vote)  # Retry the exact receipt; never count a second vote.
    projected = host.peer(action="queue_page", offset=0, limit=32)["queue"]
    assert next(item for item in projected if item["instance_id"] == target)["votes"] == 1
    assert next(item for item in projected if item["instance_id"] == added[0]["instance_id"])["votes"] == 0
    host.control("queue_order", mode="votes")
    ranked = host.peer(action="queue_page", offset=0, limit=32)["queue"]
    assert next(i for i, item in enumerate(ranked) if item["instance_id"] == target) < next(
        i for i, item in enumerate(ranked) if item["instance_id"] == added[0]["instance_id"])
    try:
        guest_control("queue_order", mode="manual")
        raise AssertionError("guest changed the host-owned ordering policy")
    except ApiError as error:
        assert error.code == "room_denied", error
    guest_control("vote", instance_id=target, voted=False)
    assert next(item for item in host.peer(action="queue_page", offset=0, limit=32)["queue"]
                if item["instance_id"] == target)["votes"] == 0
    host.control("queue_order", mode="manual")
    host.control("queue", items=[new_item(track["resource_id"]) for track in library])
    checks.append("real member attribution, occurrence-bound idempotent votes and host-owned authoritative ranking")
    for app in [host, guest]:
        try:
            app.call("/v1/player/play", {})
            raise AssertionError("legacy playback bypassed room ownership")
        except ApiError as error:
            assert error.status == 400 and "room_mode_requires_room_command" in error.message, error
    checks.append("legacy local playback rejects room-mode writes")
    text = "一起听 <script>alert(1)</script> 🎵"
    guest.peer(action="chat_send", operation_id=guest.operation(chat=True), text=text)
    history = host.peer(action="chat_history", before=None, revision=None)
    assert any(message["text"] == text for message in history["messages"])
    checks.append("native chat persists and returns exact plain text")
    song_request = dict(action="chat_song", operation_id=guest.operation(chat=True), resource_id=first)
    guest.peer(**song_request)
    guest.peer(**song_request)
    songs = [message for message in host.peer(action="chat_history", before=None, revision=None)["messages"]
             if message.get("content_kind") == "song"]
    assert len(songs) == 1 and songs[0]["song"]["resource_id"] == first
    assert "path" not in songs[0]["song"]
    checks.append("structured song chat is durable, resource-scoped and idempotent")
    # The host profile starts with a deterministic online cache fixture. This
    # covers the public API and real pinned TLS without platform credentials.
    shared = host.room({"action": "share_online", "tracks": [{
        "source": "ccmixter", "id": "acceptance-online", "title": "Online acceptance fixture",
        "artist": "Fixture", "album": None, "duration_ms": 8000, "cover": None, "ref": {},
    }]})
    online = next(track for track in shared["tracks"] if track["title"] == "Online acceptance fixture")
    peer_library = guest.peer(action="library", offset=0, limit=32)["tracks"]
    assert len(peer_library) == 4 and online in peer_library
    assert shared["favorite_local_ids"][online["favorite_key"]] == "online:ccmixter:acceptance-online"
    assert "favorite_local_ids" not in guest.peer(action="snapshot")
    guest_control("queue", items=[new_item(online["resource_id"])] + [new_item(track["resource_id"]) for track in library])
    assert host.peer(action="queue_page", offset=0, limit=32)["queue"][0]["resource_id"] == online["resource_id"]
    checks.append("host shares cached online song; account-free guest sees restricted metadata and queues a mixed online/local program")
    output = None
    transitions = set()
    if native:
        settings = guest.room()["output"]["settings"]
        settings["volume"] = 0
        if output_device is not None:
            settings["device_id"] = output_device
        guest.room({"action": "output", "settings": settings, "enabled": True})
        def selected_ready():
            output = guest.room().get("output", {})
            return output.get("ready") and (output_device is None or output.get("binding", {}).get("device") == output_device)
        wait_for(selected_ready, "selected native device clock", 20)
        guest.room({"action": "test_output"})
        time.sleep(.6)
        wait_for(lambda: guest.room()["output"].get("ready"), "clock after native diagnostic")
        assert int(guest.room()["output"]["underrun_frames"]) == 0
        checks.append("native output diagnostic finishes without an underrun")
        # Include a full heartbeat cycle before the first user playback.
        time.sleep(1.2)
        host.play("play")
        wait_for(lambda: host.room().get("playing"), "first committed playback", 8)
        wait_for(lambda: (host.room().get("current_track") or {}).get("resource_id") == online["resource_id"], "cached online song reaches presentation", 8)
        wait_for(lambda: guest.room()["output"].get("current_epoch"), "native audible epoch", 8)
        output = guest.room()["output"]["binding"]
        start = time.monotonic()
        baseline = None
        continuous_epoch = guest.room()["output"]["current_epoch"]
        resync_baseline = int(guest.room()["output"]["resync_count"])
        while time.monotonic() - start < duration:
            h, g = host.room(), guest.room()
            o = g.get("output", {})
            row = {"elapsed_seconds": round(time.monotonic() - start, 3), "playing": h.get("playing"),
                   "instance": h.get("track_instance_id"), "position_ms": h.get("position_ms"),
                   "mode": g.get("mode"), "epoch": o.get("current_epoch"), "error": o.get("error"),
                   "played_frame": o.get("played_frame"), "underrun_frames": o.get("underrun_frames"),
                   "input_frames": o.get("buffered_input_frames"), "ready": o.get("ready"),
                   "clock": o.get("clock"), "device": o.get("device")}
            row["resync_count"] = o.get("resync_count")
            row["last_resync_reason"] = o.get("last_resync_reason")
            samples.append(row)
            assert row["playing"] and row["mode"] == "guest", row
            assert row["epoch"] and row["error"] is None, row
            assert row["epoch"] == continuous_epoch, row
            assert int(row["resync_count"]) == resync_baseline, row
            assert int(row["underrun_frames"]) == 0, row
            assert row["input_frames"] <= 192000 * 3, row
            baseline = baseline or int(row["played_frame"])
            transitions.add(row["instance"])
            time.sleep(.2)
        assert int(samples[-1]["played_frame"]) > baseline + 48000 * (duration - 2)
        assert len(transitions) >= 3, transitions
        checks.append(f"{duration}s native muted PCM, three source rates, natural transitions, zero underrun/resync")

        def settled():
            snapshot = host.room()
            return snapshot if snapshot.get("playing") and not snapshot.get("pending") and not snapshot.get("scheduled") else None

        def healthy_output():
            snapshot = guest.room()
            receiver = snapshot["output"]
            assert snapshot["mode"] == "guest", snapshot["mode"]
            assert receiver.get("error") is None, receiver.get("error")
            assert int(receiver["underrun_frames"]) == 0, receiver["underrun_frames"]
            assert int(receiver["resync_count"]) == resync_baseline, receiver.get("last_resync_reason")
            return receiver

        def presented_after(previous_epoch, label):
            def presented():
                receiver = healthy_output()
                epoch = receiver.get("current_epoch")
                return receiver if receiver.get("ready") and epoch and int(epoch) > int(previous_epoch) else None

            receiver = wait_for(presented, label)
            epoch, frame = receiver["current_epoch"], int(receiver["played_frame"])

            def advanced():
                receiver = healthy_output()
                return receiver if (receiver.get("ready") and receiver.get("current_epoch") == epoch
                                    and int(receiver["played_frame"]) > frame) else None

            return wait_for(advanced, label + " advances native presented frames")

        before = wait_for(settled, "playback settled before next")
        previous_epoch = healthy_output()["current_epoch"]
        host.play("next")
        wait_for(lambda: (lambda s: s if s and s["track_instance_id"] != before["track_instance_id"] else None)(settled()), "next presented on native timeline")
        previous_epoch = presented_after(previous_epoch, "next reaches a new native epoch")["current_epoch"]
        before = host.room()
        host.play("seek", instance_id=before["track_instance_id"], position_ms="1000")
        wait_for(lambda: (lambda s: s if s and 1000 <= int(s["position_ms"]) < 3000 else None)(settled()), "seek presented at requested position")
        presented_after(previous_epoch, "seek reaches a new native epoch")
        checks.append("next and instance-bound seek commit on the native receiver without underruns")

        before = wait_for(settled, "playback settled before duplicate insertion")
        epoch = healthy_output()["current_epoch"]
        queue = queue_items()
        current = next(q for q in queue if q["instance_id"] == before["track_instance_id"])
        host.control("queue", items=[new_item(current["resource_id"])] + queue)
        duplicate_queue = queue_items()
        assert duplicate_queue[0]["instance_id"] != current["instance_id"]
        host.control("queue", items=duplicate_queue[1:])
        after = host.room()
        assert after["track_instance_id"] == current["instance_id"] and after["playing"]
        assert not after.get("pending") and not after.get("scheduled")
        assert healthy_output()["current_epoch"] == epoch
        checks.append("removing an earlier duplicate preserves the playing instance and native epoch without a pause")

        before = wait_for(settled, "playback settled before reorder")
        epoch = healthy_output()["current_epoch"]
        queue = queue_items()
        host.control("queue", items=list(reversed(queue)))
        time.sleep(.3)
        assert host.room()["track_instance_id"] == before["track_instance_id"]
        assert healthy_output()["current_epoch"] == epoch
        params = dict(before["dsp"], preamp_db=-3)
        host.room({"action": "dsp", "params": params, "crossfade_ms": 500, "loudness_mode": "off"})
        wait_for(lambda: (lambda s: not s.get("pending_mix") and s["dsp"]["preamp_db"] == -3 and s["crossfade_ms"] == 500)(host.room()), "mixer settings reach a PCM presentation boundary")
        assert healthy_output()["current_epoch"] == epoch
        checks.append("playing queue reorder and shared DSP changes preserve the current native epoch")
        host.room({"action": "sleep_timer", "seconds": 1})
        wait_for(lambda: not host.room().get("playing") and not host.room().get("scheduled"), "host-owned sleep timer pause")
        assert host.room().get("sleep_timer_remaining_seconds") is None
        checks.append("host-owned sleep timer schedules pause without an open UI")
        paused = host.room()
        time.sleep(.4)
        assert host.room()["position_ms"] == paused["position_ms"]
        queue = queue_items()
        host.control("queue", items=list(reversed(queue)))
        assert host.room()["track_instance_id"] == paused["track_instance_id"]
        host.play("play")
        wait_for(lambda: host.room().get("playing"), "resume after paused reorder")
        guest.room({"action": "output", "settings": settings, "enabled": False})
        wait_for(lambda: not host.room().get("playing"), "last audio output grace halts playback", 10)
        checks.append("scheduled pause, paused queue reorder, resume and last-output halt")
    host.room({"action": "share", "track_ids": [track["id"] for track in tracks]})
    assert online not in guest.peer(action="library", offset=0, limit=32)["tracks"]
    checks.append("online sharing revokes through the same authoritative share replacement")
    member = guest.room()["member_id"]
    permissions["transport"] = False
    host.room({"action": "permissions", "member_id": member, "permissions": permissions})
    # Permission changes invalidate both channels. Wait for the new authorized
    # control session before testing its denied operation, without retrying it.
    wait_for(lambda: (lambda s: s and not s["permissions"]["transport"])(guest.connected()),
             "reconnected control session observes revoked transport", 20)
    try:
        guest.play("next")
        raise AssertionError("revoked transport permission was accepted")
    except ApiError as error:
        assert error.code == "room_denied", error
    checks.append("server rechecks revoked playback permission")
    guest.room({"action": "leave"})
    assert guest.room()["mode"] == "local"
    assert not guest.call("/v1/state").get("playing", False)
    checks.append("explicit guest leave restores silent local mode")
    invitation = host.room({"action": "invite", "permissions": permissions})["invitation"]
    guest.room({"action": "join", "invitation": invitation, "name": "End observer", "listen": False})
    wait_for(guest.connected, "control-only rejoin before host ends", 20)
    host.room({"action": "leave"})
    assert host.room()["mode"] == "local"
    wait_for(lambda: guest.room()["mode"] == "local", "host End restores guest local mode", 8)
    assert not guest.call("/v1/state").get("playing", False)
    checks.append("host End restores the connected guest to silent local mode")
    host.room({"action": "create", "name": "Service shutdown", "address": "127.0.0.1:0",
               "sample_rate": 48000, "local_output": False})
    invitation = host.room({"action": "invite", "permissions": permissions})["invitation"]
    guest.room({"action": "join", "invitation": invitation, "name": "Shutdown observer", "listen": False})
    wait_for(guest.connected, "connected before service shutdown", 20)
    host.call("/v1/system/shutdown", {})
    wait_for(lambda: guest.room()["mode"] == "local", "service shutdown drains terminal End", 8)
    assert guest.room({"action": "saved_room"})["saved_room"] is None
    wait_for(lambda: host.process.poll() is not None, "host service exits after room cleanup", 8)
    assert not (host.directory / "vmusicd.json").exists()
    checks.append("host service shutdown drains End, forgets ended guest membership and removes discovery before exit")
    return {"checks": checks, "native_output_tested": native, "output_binding": output,
            "duration_seconds": duration if native else 0, "requested_output_device": output_device, "samples": list(samples),
            "sample_retention": "Last 600 observations; every observation is checked during the run.",
            "limits": "Single Windows machine / two processes when run locally. No acoustic or cross-OS claim."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--guest-binary", type=Path, help="Optional different guest edition for compatibility coverage")
    parser.add_argument("--native-output", action="store_true")
    parser.add_argument("--duration", type=int, default=60)
    parser.add_argument("--output-device", help="Exact output device name; requires --native-output and never changes the system default")
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    if args.duration < 26 or args.duration > 28800:
        parser.error("--duration must be between 26 and 28800 seconds")
    if args.output_device is not None and not args.native_output:
        parser.error("--output-device requires --native-output")
    binary = args.binary.resolve(strict=True)
    guest_binary = args.guest_binary.resolve(strict=True) if args.guest_binary else binary
    apps = []
    samples = deque(maxlen=600)
    identity = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest(), "platform": platform.platform()}
    identity["guest_binary_sha256"] = hashlib.sha256(guest_binary.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix="hertz-lan-acceptance-") as temporary:
        directory = Path(temporary)
        # Windows locks running executables; verify a copy so rebuilding the
        # workspace remains possible while the acceptance run owns its process.
        executable = directory / binary.name
        shutil.copy2(binary, executable)
        guest_executable = directory / ("guest-" + guest_binary.name)
        shutil.copy2(guest_binary, guest_executable)
        fixtures(directory / "music")
        cache = directory / "host" / "cache" / "online"
        cache.mkdir(parents=True)
        shutil.copy2(directory / "music" / "LAN fixture 1.wav", cache / "ccmixter-acceptance-online-standard.wav")
        try:
            for name, app_binary in [("host", executable), ("guest", guest_executable)]:
                profile = directory / name
                profile.mkdir(exist_ok=True)
                apps.append(App(app_binary, profile))
            result = {**identity, "passed": True, **verify(*apps, directory / "music", args.native_output, args.duration, samples, args.output_device)}
            if args.report:
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps({key: value for key, value in result.items() if key != "samples"}, ensure_ascii=False))
        except Exception as error:
            if args.report:
                states = []
                for app in apps:
                    try:
                        snapshot = app.room()
                        states.append({key: snapshot.get(key) for key in [
                            "mode", "playing", "position_ms", "pending", "scheduled", "error", "local_error", "output"
                        ]})
                    except Exception:
                        states.append({"unavailable": True})
                args.report.parent.mkdir(parents=True, exist_ok=True)
                args.report.write_text(json.dumps({**identity, "passed": False, "error": str(error), "states": states, "samples": list(samples)[-300:]}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            raise
        finally:
            for app in reversed(apps):
                app.close()


if __name__ == "__main__":
    main()
