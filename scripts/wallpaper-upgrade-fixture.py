#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Only isolated roots supplied by check-wallpaper-upgrade.js."""
import hashlib
import json
import pathlib
import sqlite3
import sys

request = json.loads(sys.stdin.readline())
data = pathlib.Path(request['data'])
database = data / 'wallpaper.db'
action = request['action']
if action == 'fixture':
    data.mkdir(parents=True, exist_ok=True)
    assert not database.exists()
    connection = sqlite3.connect(database)
    connection.execute('''CREATE TABLE _sqlx_migrations (
        version BIGINT PRIMARY KEY, description TEXT NOT NULL,
        installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)''')
    for migration in sorted(pathlib.Path(request['root'], 'crates/hertz-desktop/migrations/wallpaper').glob('*.sql'))[:request['count']]:
        text = migration.read_bytes().decode('utf-8')
        connection.executescript(text)
        version, description = migration.stem.split('_', 1)
        connection.execute('INSERT INTO _sqlx_migrations(version,description,success,checksum,execution_time) VALUES(?,?,1,?,0)',
                           (int(version), description.replace('_', ' '), hashlib.sha384(text.encode('utf-8')).digest()))
        connection.commit()
    connection.execute("INSERT INTO works(work_key,source_id,title,kind,created_at,updated_at) VALUES('fixture','local','Before','builtin',1,1)")
    if request.get('alteration'):
        connection.executescript(request['alteration'])
    connection.commit()
    connection.close()
    print('{}')
elif action == 'query':
    image = pathlib.Path(request.get('image', database))
    connection = sqlite3.connect(image.resolve().as_uri() + '?mode=ro' + ('&immutable=1' if 'image' in request else ''), uri=True)
    print(json.dumps(connection.execute(request['sql']).fetchall(), ensure_ascii=False))
    connection.close()
elif action == 'execute':
    connection = sqlite3.connect(database)
    connection.executescript(request['sql'])
    connection.close()
    print('{}')
elif action == 'writer':
    connection = sqlite3.connect(database)
    connection.execute('PRAGMA journal_mode=WAL')
    connection.execute('PRAGMA wal_autocheckpoint=0')
    connection.execute("UPDATE works SET title='Committed WAL' WHERE work_key='fixture'")
    connection.commit()
    print('ready', flush=True)
    sys.stdin.readline()
    connection.close()
else:
    raise ValueError(action)
