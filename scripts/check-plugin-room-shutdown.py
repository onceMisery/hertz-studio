#!/usr/bin/env python3
"""Real stdio sidecar EOF during an in-flight RPC must drain the Host End.

Uses two isolated profiles, loopback TLS and null audio; no system keyring,
soundcard, external service or third-party Python package is required.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time


lan_spec = importlib.util.spec_from_file_location("lan_room_checks", Path(__file__).with_name("check-lan-room.py"))
lan_checks = importlib.util.module_from_spec(lan_spec)
lan_spec.loader.exec_module(lan_checks)


class Sidecar:
    def __init__(self, binary, directory):
        self.log = (directory / "sidecar.log").open("wb")
        self.process = subprocess.Popen(
            [str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
            text=True, encoding="utf-8",
            env=dict(os.environ, DBX_PLUGIN_DATA_DIR=str(directory), VMUSIC_BACKEND="null",
                     VMUSIC_SECRETS="memory", VMUSIC_LOG="warn"),
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        self.next_id = 1
        self.replies = {}
        self.condition = threading.Condition()
        self.reader = threading.Thread(target=self.read, daemon=True)
        self.reader.start()

    def read(self):
        for line in self.process.stdout:
            message = json.loads(line)
            if "id" in message:
                with self.condition:
                    self.replies[message["id"]] = message
                    self.condition.notify_all()

    def send(self, method, params):
        request_id = self.next_id
        self.next_id += 1
        self.process.stdin.write(json.dumps(dict(jsonrpc="2.0", id=request_id, method=method, params=params)) + "\n")
        self.process.stdin.flush()
        return request_id

    def reply(self, request_id, timeout=15):
        deadline = time.monotonic() + timeout
        with self.condition:
            while request_id not in self.replies:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise AssertionError("sidecar RPC response timed out")
                self.condition.wait(min(remaining, .1))
            return self.replies[request_id]

    def room(self, body):
        response = self.reply(self.send("v1/room", dict(op="POST", body=body)))
        assert response.get("result", {}).get("status") == 200, "sidecar room request failed"
        return response["result"]["body"]

    def close(self):
        if self.process.stdin and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.reader.join(timeout=2)
        self.process.stdout.close()
        self.log.close()


def verify(plugin, service):
    with tempfile.TemporaryDirectory(prefix="hertz-plugin-room-shutdown-") as temporary:
        directory = Path(temporary)
        for binary in [plugin, service]:
            shutil.copy2(binary, directory / binary.name)
        host_dir, guest_dir = directory / "host", directory / "guest"
        host_dir.mkdir()
        guest_dir.mkdir()
        host = Sidecar(directory / plugin.name, host_dir)
        guest = None
        try:
            initialized = host.reply(host.send("plugin/initialize", {
                "host": {"hostApiVersion": "1.4.0", "protocolVersions": [1], "features": []}}))
            assert "result" in initialized
            host.room(dict(action="create", name="EOF barrier", address="127.0.0.1:0",
                           sample_rate=48000, local_output=False))
            invitation = host.room(dict(action="invite", permissions=dict(
                listen=False, queue=False, transport=False, volume=False, chat_read=False, chat_send=False)))["invitation"]
            guest = lan_checks.App(directory / service.name, guest_dir)
            guest.room(dict(action="join", invitation=invitation, name="EOF observer", listen=False))
            lan_checks.wait_for(guest.connected, "guest connected to sidecar Host", 20)
            assert guest.room(dict(action="saved_room"))["saved_room"] is not None

            slow = host.send("v1/room", dict(op="POST", body=dict(action="discover")))
            # The second discovery proves a worker still owns the first RPC,
            # rather than relying only on timing or a queued request count.
            time.sleep(.05)
            busy = host.reply(host.send("v1/room", dict(op="POST", body=dict(action="discover"))), timeout=.6)
            assert busy.get("result", {}).get("body", {}).get("error", {}).get("code") == "room_busy"
            with host.condition:
                assert slow not in host.replies, "slow RPC already completed before EOF"
            host.process.stdin.close()
            host.process.wait(timeout=8)
            assert host.process.returncode == 0, "sidecar did not exit cleanly"
            lan_checks.wait_for(lambda: guest.room()["mode"] == "local",
                                "EOF with an in-flight worker drains terminal End", 6)
            assert guest.room(dict(action="saved_room"))["saved_room"] is None
            assert not guest.call("/v1/state").get("playing", False)
            return {"passed": True, "checks": [
                "second discovery proves the first RPC is still in flight at stdin EOF",
                "sidecar exits normally after Host shutdown even while an SDK worker retains Plugin",
                "guest receives terminal End, restores silent local mode and forgets ended membership",
            ]}
        finally:
            if guest:
                guest.close()
            host.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", type=Path, required=True)
    parser.add_argument("--service", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()
    plugin, service = args.plugin.resolve(strict=True), args.service.resolve(strict=True)
    identity = dict(plugin_sha256=hashlib.sha256(plugin.read_bytes()).hexdigest(),
                    service_sha256=hashlib.sha256(service.read_bytes()).hexdigest())
    try:
        result = dict(identity, **verify(plugin, service))
    except Exception as error:
        result = dict(identity, passed=False, error=str(error))
        raise
    finally:
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
