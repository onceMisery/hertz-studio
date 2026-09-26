#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Real local service regression with disposable audio, database and token."""
import argparse
from contextlib import closing
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse
import wave

parser = argparse.ArgumentParser()
parser.add_argument('--keep', action='store_true', help='Keep the fixture service for browser QA')
parser.add_argument('--binary', type=Path, help='Use a separately named QA binary')
parser.add_argument('--maintenance', action='store_true', help='Verify saved roots and native file-change scanning')
parser.add_argument('--playlists', action='store_true', help='Verify mixed local/online playlists across a service restart')
parser.add_argument('--lyrics', action='store_true', help='Verify lyrics source priority, per-track offset and manual import')
parser.add_argument('--library', action='store_true', help='Verify library management: facets, filters, edits, cover replace, missing cleanup')
parser.add_argument('--backup', action='store_true', help='Verify backup export/restore and M3U import/export')
parser.add_argument('--cache', action='store_true', help='Verify online cache stats, clear and keep pinning')
parser.add_argument('--remote', action='store_true', help='Verify WebDAV remote roots: add/browse/import/direct-link play with a mini DAV server')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
data = Path(tempfile.mkdtemp(prefix='vmusic-library-')).resolve()
assert data.parent == Path(tempfile.gettempdir()).resolve()
music = data / 'music'
token = 'disposable-library-test-token'
binary = args.binary or repo / 'target/debug' / ('vmusicd.exe' if os.name == 'nt' else 'vmusicd')
NUL_FRAME = b'\x00' * 2
env = dict(os.environ, VMUSIC_BACKEND='null', VMUSIC_SECRETS='memory')
proc = None
base = None

def wait_for(predicate, message, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        if proc.poll() is not None:
            raise RuntimeError('fixture service exited')
        time.sleep(0.05)
    raise AssertionError(message)

def api(path, method='GET', body=None):
    is_blob = method.endswith('_BLOB')
    real_method = method[:-5] if is_blob else method
    req = urllib.request.Request(base + path, method=real_method,
        headers={'Authorization': f'Bearer {token}',
                 'Content-Type': 'image/png' if is_blob else 'application/json'},
        data=body if is_blob and body is not None else
             (json.dumps(body).encode() if body is not None else None))
    with urllib.request.urlopen(req, timeout=15) as response:
        return json.load(response)

passed = False
try:
    music.mkdir()
    (data / 'token').write_text(token, encoding='utf8')
    for i in range(205):
        with wave.open(str(music / f'Song {i:03}.wav'), 'wb') as audio:
            audio.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
            audio.writeframes(b'\0\0' * 8000)
    proc = subprocess.Popen([str(binary), '--port', '0', '--data-dir', str(data)], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    discovery = data / 'vmusicd.json'
    wait_for(discovery.exists, 'service discovery missing')
    info = json.loads(discovery.read_text(encoding='utf8'))
    base = f"http://127.0.0.1:{info['port']}"
    api('/v1/library/scan', 'POST', {'root': str(music)})
    wait_for(lambda: api('/v1/tracks?limit=1')['total'] == 205 and not api('/v1/library/status')['running'],
             'scan did not register all 205 tracks')
    with closing(sqlite3.connect(data / 'vmusic.db')) as db:
        with db:
            db.execute("UPDATE tracks SET artist = 'Artist ' || printf('%03d', 204 - CAST(substr(title, 6) AS INTEGER))")
            if args.maintenance and os.name == 'nt':
                # Older manual scans retained user-entered slash spellings.
                # A canonical scan must keep these IDs and playlist references.
                db.execute("UPDATE tracks SET path = replace(path, ?, ?)", ('\\', '/'))
            rows = db.execute('SELECT id, title FROM tracks ORDER BY title').fetchall()
    first = api('/v1/tracks?sort=artist&limit=200')
    second = api('/v1/tracks?sort=artist&limit=200&offset=200')
    assert first['tracks'][0]['title'] == 'Song 204'
    assert second['tracks'][-1]['title'] == 'Song 000'
    ids = api('/v1/tracks/ids?sort=artist')['track_ids']
    assert ids == [t['id'] for t in first['tracks'] + second['tracks']]
    assert len(api('/v1/tracks/ids?q=Artist%2000&sort=artist')['track_ids']) == 10
    try:
        api('/v1/tracks?sort=invalid')
        raise AssertionError('invalid sort accepted')
    except urllib.error.HTTPError as error:
        assert error.code == 400
    for track_id, title in rows:
        api('/v1/favorites', 'POST', {'kind': 'track', 'source': 'local', 'ref_id': track_id, 'title': title})
    assert len(api('/v1/favorites?kind=track&limit=200')['favorites']) == 200
    assert len(api('/v1/favorites?kind=track&limit=200&offset=200')['favorites']) == 5
    api('/v1/player/load', 'POST', {'track_id': ids[0], 'queue': ids})
    assert api('/v1/player/queue')['queue'] == ids
    api('/v1/player/pause', 'POST')
    daily = api('/v1/recommend/daily?limit=12')['tracks']
    assert daily and all(row['id'] in ids and row['title'].startswith('Song ') for row in daily)
    if args.playlists:
        playlist = api('/v1/playlists', 'POST', {'name': '混合回归'})
        local_id, local_title = rows[0][0], rows[0][1]
        online_input = {'id': '999999', 'source': 'netease', 'title': '网歌',
                        'artist': '网歌手', 'duration_ms': 180000, 'cover': 'http://example.invalid/c.jpg'}
        api(f"/v1/playlists/{playlist['id']}/tracks", 'POST',
            {'track_ids': [local_id], 'tracks': [online_input]})
        # 重复入单不产生重复行，也不改写已存快照。
        api(f"/v1/playlists/{playlist['id']}/tracks", 'POST',
            {'tracks': [dict(online_input, title='改名不生效')]})
        content = api(f"/v1/playlists/{playlist['id']}/tracks")
        vid = 'online:netease:999999'
        assert content['track_ids'] == [local_id, vid], content['track_ids']
        assert content['tracks'][0]['title'] == local_title, '本地行必须实时解析'
        snap = content['tracks'][1]
        assert snap['title'] == '网歌' and snap['source'] == 'netease'
        assert snap['cover'] == 'http://example.invalid/c.jpg' and snap['duration_ms'] == 180000
        # 整单播放：混合队列按存入顺序占队，起播位置落在本地点到的那首。
        api('/v1/player/load', 'POST', {'track_id': local_id, 'queue': content['track_ids'],
                                        'meta': {vid: {'title': '网歌', 'artist': '网歌手'}}})
        assert api('/v1/player/queue')['queue'] == content['track_ids']
        api(f"/v1/playlists/{playlist['id']}/tracks/order", 'PUT',
            {'track_ids': [vid, local_id]})
        assert api(f"/v1/playlists/{playlist['id']}/tracks")['track_ids'] == [vid, local_id]
        proc.terminate()
        proc.wait(timeout=10)
        discovery.unlink(missing_ok=True)
        proc = subprocess.Popen([str(binary), '--port', '0', '--data-dir', str(data)], env=env,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        def restarted():
            # --port 0 每次启动都换端口：从发现文件取新端口再探活。
            global base
            try:
                info = json.loads(discovery.read_text(encoding='utf8'))
            except (OSError, ValueError):
                return False
            base = f"http://127.0.0.1:{info['port']}"
            try:
                return api('/v1/tracks?limit=1')['total'] == 205
            except (urllib.error.HTTPError, urllib.error.URLError, ConnectionError, OSError):
                return False
        wait_for(restarted, 'restart did not come back')
        after = api(f"/v1/playlists/{playlist['id']}/tracks")
        assert after['track_ids'] == [vid, local_id], 'restart lost playlist order'
        assert after['tracks'][0]['title'] == '网歌', 'restart lost online snapshot'
        print('PASS: mixed playlist snapshot, idempotent add, mixed queue, reorder, restart persistence')
    if args.lyrics:
        # sidecar 回归：同名 .lrc 带 [offset:200]，未加用户偏移时按文件偏移应用。
        lyric_song = music / 'Lyric Song.wav'
        shutil.copyfile(music / 'Song 000.wav', lyric_song)
        lrc_text = '[offset:200]' + chr(10) + '[00:01.00]sidecar line' + chr(10)
        (music / 'Lyric Song.lrc').write_text(lrc_text, encoding='utf-8')
        api('/v1/library/scan', 'POST', {'root': str(music)})
        wait_for(lambda: api('/v1/tracks?limit=1')['total'] == 206 and not api('/v1/library/status')['running'],
                 'lyrics fixture scan did not settle')
        lyric_track = api('/v1/tracks?q=Lyric%20Song&limit=1')['tracks'][0]
        lid = lyric_track['id']
        doc = api(f'/v1/tracks/{lid}/lyrics')
        assert doc['source'] == 'sidecar' and doc['lines'][0]['start_ms'] == 1200, doc
        assert doc['user_offset_ms'] == 0
        # 每曲偏移：-500ms 与文件偏移叠加，重启不丢由 store 测试与 --playlists 覆盖。
        api(f'/v1/tracks/{lid}/lyrics/offset', 'PUT', {'offset_ms': -500})
        doc = api(f'/v1/tracks/{lid}/lyrics')
        assert doc['lines'][0]['start_ms'] == 700 and doc['user_offset_ms'] == -500, doc
        # 手动导入最优先：source=imported，偏移继续叠加。
        api(f'/v1/tracks/{lid}/lyrics', 'PUT',
            {'content': '[00:03.00]imported line' + chr(10)})
        doc = api(f'/v1/tracks/{lid}/lyrics')
        assert doc['source'] == 'imported' and doc['lines'][0]['start_ms'] == 2500, doc
        assert doc['lines'][0]['text'] == 'imported line'
        # 清除导入后回退 sidecar，且偏移一并删除（整行覆盖清除）。
        api(f'/v1/tracks/{lid}/lyrics', 'DELETE')
        doc = api(f'/v1/tracks/{lid}/lyrics')
        assert doc['source'] == 'sidecar' and doc['lines'][0]['start_ms'] == 1200, doc
        lyric_song.unlink()
        (music / 'Lyric Song.lrc').unlink()
        print('PASS: lyrics sidecar, per-track offset, manual import priority, clear fallback')
    if args.library:
        # 浏览面：所有曲目都有 'Artist NNN' 形式的歌手，专辑为空。
        facets = api('/v1/tracks/facets?kind=artist')['facets']
        assert len(facets) == 205, len(facets)
        top = facets[0]
        assert top['count'] == 1, '每位歌手一首'
        albums = api('/v1/tracks/facets?kind=album')['facets']
        assert albums == [], '专辑未编辑时浏览面为空'
        # 按歌手筛选
        artist_name = facets[0]['name']
        page = api('/v1/tracks?artist=' + urllib.parse.quote(artist_name))
        assert page['total'] == 1 and page['tracks'][0]['artist'] == artist_name
        assert api('/v1/tracks/ids?artist=' + urllib.parse.quote(artist_name))['track_ids'] == [page['tracks'][0]['id']]
        # 单曲编辑：标题/专辑进覆盖层，重扫保留
        tid = page['tracks'][0]['id']
        api('/v1/tracks/batch-edit', 'POST',
            {'track_ids': [tid], 'title': '用户名', 'album': '用户专辑'})
        edited = api(f'/v1/tracks/{tid}')
        assert edited['title'] == '用户名' and edited['album'] == '用户专辑', edited['title']
        assert api('/v1/tracks/facets?kind=album')['facets'][0]['name'] == '用户专辑'
        # 重扫（文件未变，全跳过）：编辑必须保留
        api('/v1/library/scan', 'POST', {'root': str(music)})
        wait_for(lambda: not api('/v1/library/status')['running'], 'rescan did not settle')
        edited = api(f'/v1/tracks/{tid}')
        assert edited['title'] == '用户名' and edited['album'] == '用户专辑', 'rescan wiped edits'
        # 批量编辑歌手：两首选中行同时改
        second = api('/v1/tracks?limit=2&offset=100')['tracks']
        ids = [t['id'] for t in second]
        api('/v1/tracks/batch-edit', 'POST',
            {'track_ids': ids, 'artist': '合辑歌手'})
        got = api('/v1/tracks?artist=' + urllib.parse.quote('合辑歌手'))
        assert got['total'] == 2, got['total']
        # 重置编辑：回到文件标签
        api(f'/v1/tracks/{tid}/edit', 'DELETE')
        reverted = api(f'/v1/tracks/{tid}')
        assert reverted['title'].startswith('Song '), reverted['title']
        assert reverted['album'] is None
        # 封面替换：has_cover 成立；重扫后仍保留（cover_edited 跳过内嵌落盘）
        cover_id = ids[1]
        cover_blob = bytes([0x89]) + b'PNG-fake-cover-bytes'
        api(f'/v1/tracks/{cover_id}/cover', 'POST_BLOB', cover_blob)
        assert api(f'/v1/tracks/{cover_id}')['has_cover'] == 1
        api('/v1/library/scan', 'POST', {'root': str(music)})
        wait_for(lambda: not api('/v1/library/status')['running'], 'cover rescan did not settle')
        assert api(f'/v1/tracks/{cover_id}')['has_cover'] == 1, 'rescan lost user cover'
        # 失效整理：文件消失但不触发扫描（扫描自身会清理；缺失列表服务的
        # 正是「最后一次扫描之后文件又没了」的场景）→ 列出 → 批量删除。
        victim = api('/v1/tracks?limit=1&offset=204')['tracks'][0]
        (music / (victim['title'] + '.wav')).unlink()
        (music / 'Song 000.wav').unlink()
        miss = api('/v1/tracks/missing')
        assert miss['total'] >= 1 and any(m['id'] == victim['id'] for m in miss['missing']), miss
        removed = api('/v1/tracks/batch-delete', 'POST',
                      {'track_ids': [m['id'] for m in miss['missing']]})
        assert removed['deleted'] == miss['total'], removed
        assert api('/v1/tracks/missing')['total'] == 0
        print('PASS: library facets, filters, edit overlay survives rescan, cover replace, missing cleanup')
    if args.backup:
        # 备份模式下先造一份最小数据（歌单 + 收藏），导出恢复才有断言对象。
        pl0 = api('/v1/playlists', 'POST', {'name': '备份样例歌单'})
        api(f"/v1/playlists/{pl0['id']}/tracks", 'POST', {'track_ids': [ids[0]]})
        # 导出：包含全部收藏与既有歌单，不含凭据域。
        backup = api('/v1/backup')
        assert backup['version'] == 1 and len(backup['favorites']) >= 205, backup['version']
        assert 'credentials' not in backup and not any('credential' in k for k in backup)
        fav_count_before = len(backup['favorites'])
        # 幂等恢复：重复导入不产生重复数据。
        report = api('/v1/backup/restore', 'POST', backup)
        assert report['playlists_created'] + report['playlists_merged'] >= 1
        assert report['favorites_added'] == 0, report
        assert len(api('/v1/backup')['favorites']) == fav_count_before
        # 新建数据后恢复：收藏计数增长一次，再恢复不再增长。
        api('/v1/favorites', 'POST', {'kind': 'track', 'source': 'netease',
                                      'ref_id': 'backup-case', 'title': '备份样例'})
        report2 = api('/v1/backup/restore', 'POST', backup)
        assert report2['favorites_added'] == 0, '恢复后多出的收藏不被删，也不重复加'
        # 格式校验：未知版本 400。
        try:
            bad = dict(backup, version=99)
            api('/v1/backup/restore', 'POST', bad)
            raise AssertionError('unknown version accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 400
        # M3U：导出本地歌单 → 文本含 #EXTM3U 与路径；导入新歌单计数正确。
        pl_id = api('/v1/playlists')['playlists'][0]['id']
        req = urllib.request.Request(base + f'/v1/playlists/{pl_id}/m3u',
                                     headers={'Authorization': f'Bearer {token}'})
        m3u_text = urllib.request.urlopen(req, timeout=10).read().decode('utf-8')
        assert m3u_text.startswith('#EXTM3U'), m3u_text[:40]
        first_line = [l for l in m3u_text.splitlines() if l and not l.startswith('#')][0]
        m3u_import = m3u_text + '/nowhere/missing.mp3' + chr(10)
        imported = api('/v1/playlists/import-m3u', 'POST',
                       {'name': 'M3U 导入回归', 'content': m3u_import})
        assert imported['added'] >= 1 and imported['skipped'] == 1, imported
        names = [p['name'] for p in api('/v1/playlists')['playlists']]
        assert 'M3U 导入回归' in names
        assert first_line  # 使用变量避免 lint
        print('PASS: backup export/restore idempotent, version check, M3U round trip with skip count')
    if args.cache:
        # 预置缓存文件（data_dir/cache/online），验证统计/清理/保留。
        cache_dir = data / 'cache' / 'online'
        cache_dir.mkdir(parents=True, exist_ok=True)
        def put(name, size):
            (cache_dir / name).write_bytes(b'x' * size)
        put('netease-1-standard.mp3', 100)
        put('netease-1-higher.mp3', 120)
        put('netease-2-standard.mp3', 200)
        put('qq-9-standard.mp3', 50)
        put('qq-9-standard.mp3.part', 10)
        stats = api('/v1/online/cache')
        assert stats['total_bytes'] == 470 and stats['files'] == 4, stats
        sources = dict(stats['by_source'])
        assert sources['netease'] == 420 and sources['qq'] == 50, sources
        # 保留 netease-1（全部音质档），清理 qq → 50+10 删除
        api('/v1/online/cache/keep', 'POST', {'source': 'netease', 'id': '1', 'keep': True})
        assert any('netease-1-' in k for k in api('/v1/online/cache')['keep'])
        cleared = api('/v1/online/cache/clear', 'POST', {'source': 'qq'})
        assert cleared['removed_bytes'] == 60, cleared
        assert (cache_dir / 'netease-1-standard.mp3').exists()
        assert not (cache_dir / 'qq-9-standard.mp3').exists()
        # 全量清理：保留项豁免
        cleared = api('/v1/online/cache/clear', 'POST', {})
        assert cleared['removed_bytes'] == 200, cleared
        assert (cache_dir / 'netease-1-standard.mp3').exists()
        assert not (cache_dir / 'netease-2-standard.mp3').exists()
        # 取消保留后再全清 → 目录只剩 .part 之外的空集
        api('/v1/online/cache/keep', 'POST', {'source': 'netease', 'id': '1', 'keep': False})
        api('/v1/online/cache/clear', 'POST', {})
        stats = api('/v1/online/cache')
        assert stats['total_bytes'] == 0 and stats['files'] == 0, stats
        # 保留名单持久化在 settings，重启恢复由 store 层测试覆盖
        print('PASS: online cache stats, per-source clear, keep pinning honored by clear')
    if args.remote:
        import base64
        import http.server
        import re as _re
        import threading
        from io import BytesIO

        buf = BytesIO()
        with wave.open(buf, 'wb') as audio:
            audio.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
            audio.writeframes(NUL_FRAME * 8000)
        wav_bytes = buf.getvalue()
        propfind_xml = (
            '<?xml version="1.0"?>'
            '<D:multistatus xmlns:D="DAV:">'
            '<D:response><D:href>/dav/</D:href>'
            '<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>'
            '<D:response><D:href>/dav/demo.wav</D:href>'
            '<D:propstat><D:prop><D:resourcetype/><D:getcontentlength>'
            + str(len(wav_bytes)) + '</D:getcontentlength></D:prop></D:propstat></D:response>'
            '</D:multistatus>'
        ).encode()

        class DavHandler(http.server.BaseHTTPRequestHandler):
            def _authed(self):
                expected = 'Basic ' + base64.b64encode(b'u:p').decode()
                return self.headers.get('Authorization') == expected

            def _send(self, code, body=b'', ctype='application/xml', extra=None):
                self.send_response(code)
                self.send_header('Content-Type', ctype)
                self.send_header('Content-Length', str(len(body)))
                for k, v in (extra or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                if self.command != 'HEAD' and body:
                    self.wfile.write(body)

            def do_PROPFIND(self):
                if not self._authed():
                    self._send(401, b'auth', extra={'WWW-Authenticate': 'Basic realm="dav"'})
                    return
                self._send(207, propfind_xml)

            def do_HEAD(self):
                if not self._authed():
                    self._send(401)
                    return
                self._send(200, ctype='audio/wav')

            def do_GET(self):
                if not self._authed():
                    self._send(401)
                    return
                rng = self.headers.get('Range')
                if rng:
                    m = _re.match(r'bytes=(\d+)-(\d*)', rng)
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else len(wav_bytes) - 1
                    end = min(end, len(wav_bytes) - 1)
                    chunk = wav_bytes[start:end + 1]
                    self._send(206, chunk, ctype='audio/wav', extra={
                        'Content-Range': 'bytes %d-%d/%d' % (start, end, len(wav_bytes))})
                else:
                    self._send(200, wav_bytes, ctype='audio/wav')

            def log_message(self, *a):
                pass

        srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), DavHandler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        dav_port = srv.server_address[1]

        api('/v1/remote/roots', 'POST', {
            'name': '测试 NAS', 'base_url': 'http://127.0.0.1:%d/dav' % dav_port,
            'username': 'u', 'password': 'p'})
        roots = api('/v1/remote/roots')['roots']
        assert len(roots) == 1 and roots[0]['base_url'].endswith('/dav'), roots
        rid = roots[0]['id']
        entries = api('/v1/remote/roots/%s/browse?path=/' % rid)['entries']
        assert [e['name'] for e in entries] == ['demo.wav'], entries
        assert entries[0]['is_audio'] and entries[0]['size'] == len(wav_bytes), entries
        # 错误密码：浏览如实报鉴权失败
        api('/v1/remote/roots', 'POST', {
            'name': '坏凭据', 'base_url': 'http://127.0.0.1:%d/dav' % dav_port,
            'username': 'u', 'password': 'WRONG'})
        bad = [r for r in api('/v1/remote/roots')['roots'] if r['name'] == '坏凭据'][0]
        try:
            api('/v1/remote/roots/%s/browse?path=/' % bad['id'])
            raise AssertionError('wrong password accepted')
        except urllib.error.HTTPError as error:
            assert error.code == 400
        api('/v1/remote/roots/%s' % bad['id'], 'DELETE')
        # 导入（幂等）→ 曲库出现 remote 曲目 → 直链播放走 Range 探测
        imp = api('/v1/remote/roots/%s/import' % rid, 'POST', {'paths': ['/dav/demo.wav']})
        assert imp['imported'] == 1, imp
        imp2 = api('/v1/remote/roots/%s/import' % rid, 'POST', {'paths': ['/dav/demo.wav']})
        assert imp2['skipped'] == 1, imp2
        tracks = api('/v1/tracks?q=demo&limit=5')['tracks']
        assert tracks and tracks[0]['source'] == 'remote', tracks
        tid = tracks[0]['id']
        api('/v1/player/load', 'POST', {'track_id': tid})
        assert api('/v1/player/queue')['queue'] == [tid]
        api('/v1/remote/roots/%s' % rid, 'DELETE')
        srv.shutdown()
        print('PASS: webdav add/browse/401/import idempotent/direct-link play')
    if args.maintenance:
        result = api('/v1/library/roots', 'POST', {'path': str(music), 'enabled': True})
        saved = result['roots'][0]['path']
        def settled():
            status = api('/v1/library/status')
            roots = api('/v1/library/roots')['roots']
            return roots and roots[0]['last_scanned_at'] and not status['running'] and status
        initial = wait_for(settled, 'saved root initial scan did not finish')
        assert initial['skipped'] == 205
        assert set(api('/v1/tracks/ids')['track_ids']) == set(ids), 'legacy path normalization changed track IDs'
        shutil.copyfile(music / 'Song 000.wav', music / 'Added automatically.wav')
        wait_for(lambda: api('/v1/tracks?limit=1')['total'] == 206, 'file creation was not detected')
        wait_for(lambda: not api('/v1/library/status')['running'], 'auto scan did not settle')
        (music / 'Added automatically.wav').unlink()
        wait_for(lambda: api('/v1/tracks?limit=1')['total'] == 205, 'file deletion was not detected')
        wait_for(lambda: not api('/v1/library/status')['running'], 'delete scan did not settle')
        # A failed metadata parse must preserve the previously registered track.
        (music / 'Song 000.wav').write_bytes(b'invalid audio')
        error_status = wait_for(lambda: (s if (s := api('/v1/library/status'))['failed'] and not s['running'] else None),
                                'metadata failure was not reported')
        assert error_status['errors'] and api('/v1/tracks?limit=1')['total'] == 205
        api('/v1/library/roots', 'PUT', {'path': saved, 'enabled': False})
        time.sleep(2.5)
        shutil.copyfile(music / 'Song 001.wav', music / 'While disabled.wav')
        time.sleep(2)
        assert api('/v1/tracks?limit=1')['total'] == 205
        api('/v1/library/roots', 'PUT', {'path': saved, 'enabled': True})
        wait_for(lambda: api('/v1/tracks?limit=1')['total'] == 206, 're-enabling did not catch up')
        wait_for(lambda: not api('/v1/library/status')['running'], 're-enable scan did not settle')
        api('/v1/library/roots?path=' + urllib.parse.quote(saved), 'DELETE')
        assert not api('/v1/library/roots')['roots']
        assert api('/v1/tracks?limit=1')['total'] == 206 and music.exists()
        print('PASS: saved roots, incremental skip, native add/delete events, failed-file preservation, disable/re-enable, remove retains music')
    passed = True
    print('PASS: 205 real audio files; sorted API pages, complete/filter queues, invalid sort, favorites pagination' +
          ('' if args.maintenance or args.playlists else ''))
    if args.keep:
        print(json.dumps({'pid': proc.pid, 'data': str(data), 'url': base + '/?token=' + token}))
finally:
    if not (passed and args.keep):
        if proc is not None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=5)
        assert data.parent == Path(tempfile.gettempdir()).resolve() and data.name.startswith('vmusic-library-')
        shutil.rmtree(data)
