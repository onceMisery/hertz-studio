-- SPDX-License-Identifier: MIT
CREATE TABLE root_authorization (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    generation INTEGER NOT NULL CHECK(generation BETWEEN 1 AND 128),
    body_digest TEXT NOT NULL CHECK(length(body_digest) = 64),
    chain_json TEXT NOT NULL CHECK(length(chain_json) <= 262144)
);
PRAGMA user_version = 2;
