# SPDX-License-Identifier: MIT
"""Seed only a fresh, isolated ui-browser-fixture DB; compute LIKE truth separately."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

path = Path(sys.argv[1]).resolve(strict=True)
if path.name != "vmusic.db" or path.parent.name != "data" or not path.parent.parent.name.startswith("hertz-ui-check-"):
    raise ValueError("Only the benchmark's isolated temporary database may be seeded")

db = sqlite3.connect(path, timeout=10)
if db.execute("SELECT COUNT(*) FROM tracks").fetchone()[0] != 0:
    raise ValueError("Benchmark requires an empty library")

names = ["夜雨归途", "晴天漫步", "静谧星河", "都市节奏", "深海回声", "山间风语", "晨光序曲", "暮色小径"]
corpus_hash = hashlib.sha256()
db.execute("BEGIN IMMEDIATE")
insert = """INSERT INTO tracks
(id,path,source,title,artist,album,duration_ms,sample_rate,channels,has_cover,added_at,updated_at)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"""
for i in range(50000):
    serial = f"{i:05d}"
    row = (
        "bench-" + serial, "fixture://search-benchmark/" + serial + ".wav", "local",
        f"{names[i % 8]} Track {serial}" + (" Live" if i % 11 == 0 else ""),
        f"Artist {i % 500:03d} 艺人{i % 500}", f"Album {i % 1250} 专辑{i % 1250}",
        180000 + i % 60000, 44100, 2, 0, 1700000000000 + i, 1700000000000 + i,
    )
    db.execute(insert, row)
    corpus_hash.update((json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
    if i % 100 == 0:
        edit = (row[0], f"Edited Tide {serial} 用户编辑", 1700000000000 + i)
        db.execute("INSERT INTO track_edits(track_id,title,updated_at) VALUES (?,?,?)", edit)
        corpus_hash.update((json.dumps(edit, ensure_ascii=False, separators=(",", ":")) + "\n").encode())
db.commit()

cases = [
    {"id": "ascii-rare", "q": "Track 01234"},
    {"id": "chinese-indexed", "q": "专辑123"},
    {"id": "chinese-broad", "q": "静谧星河"},
    {"id": "short-chinese", "q": "晴天"},
    {"id": "wildcard", "q": "Track 01_34"},
    {"id": "broad-ascii", "q": "Track"},
    {"id": "no-match", "q": "NeverMatchNeedle"},
    {"id": "edited-title", "q": "用户编辑"},
    {"id": "spaced-pattern", "q": "夜雨归途 Track 00008"},
    {"id": "all-wildcard", "q": "%"},
    {"id": "trimmed-artist", "q": "   Artist 042   "},
    {"id": "artist-filter", "q": "", "artist": "Artist 042 艺人42"},
    {"id": "album-filter", "q": "", "album": "Album 123 专辑123"},
    {"id": "browse-added", "q": "", "sort": "added"},
]
columns = [f"COALESCE(NULLIF(TRIM(e.{c}), ''), t.{c})" for c in ["title", "artist", "album"]]
for case in cases:
    query = case["q"].strip()
    clause = "(? = '' OR " + " OR ".join(c + " LIKE ?" for c in columns) + ")"
    binds = [query] + ["%" + query + "%"] * 3
    for key in ["artist", "album"]:
        if key in case:
            clause += f" AND COALESCE(NULLIF(TRIM(e.{key}), ''), t.{key}) = ?"
            binds.append(case[key])
    selection = " FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id WHERE " + clause
    order = ("t.added_at DESC, " if case.get("sort") == "added" else "") + columns[0] + " COLLATE NOCASE, t.id"
    # This oracle intentionally does not use track_search or production query builders.
    case["expectedTotal"] = db.execute("SELECT COUNT(*)" + selection, binds).fetchone()[0]
    case["expectedIds"] = [row[0] for row in db.execute("SELECT t.id" + selection + " ORDER BY " + order + " LIMIT 20", binds)]

if db.execute("SELECT COUNT(*) FROM track_search").fetchone()[0] != 50000:
    raise ValueError("Production triggers did not populate the search index")
db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
db.close()
# ASCII JSON escapes keep the pipe independent of Windows' GBK stdout default.
print(json.dumps({"version": 1, "tracks": 50000, "edits": 500, "contentHash": corpus_hash.hexdigest(), "cases": cases}))
