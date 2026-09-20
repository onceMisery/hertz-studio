// SPDX-License-Identifier: MIT
// Copyright (c) 2026 mmusic-studio contributors

//! Custom playlist CRUD. Positions are dense integers maintained on write, so
//! the UI can render a playlist with a single ordered query.

use sqlx::SqlitePool;
use vmusic_core::{Playlist, PlaylistId, StoreError, TrackId};

use crate::now_ms;

pub async fn create(pool: &SqlitePool, name: &str) -> Result<Playlist, StoreError> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = now_ms();
    sqlx::query("INSERT INTO playlists (id, name, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)")
        .bind(&id)
        .bind(name)
        .bind(now)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    Ok(Playlist {
        id,
        name: name.to_string(),
        created_at: now,
        updated_at: now,
        track_count: 0,
    })
}

pub async fn rename(pool: &SqlitePool, id: &PlaylistId, name: &str) -> Result<(), StoreError> {
    sqlx::query("UPDATE playlists SET name = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(name)
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn delete(pool: &SqlitePool, id: &PlaylistId) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM playlist_tracks WHERE playlist_id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    sqlx::query("DELETE FROM playlists WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

/// Appends the given tracks, skipping ids already present.
pub async fn add_tracks(
    pool: &SqlitePool,
    id: &PlaylistId,
    track_ids: &[TrackId],
) -> Result<(), StoreError> {
    let existing = crate::get_playlist_track_ids(pool, id).await?;
    let mut position = existing.len() as i64;

    for track_id in track_ids {
        if existing.contains(track_id) {
            continue;
        }
        sqlx::query(
            "INSERT OR IGNORE INTO playlist_tracks (playlist_id, track_id, position) VALUES (?1, ?2, ?3)",
        )
        .bind(id)
        .bind(track_id)
        .bind(position)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
        position += 1;
    }

    sqlx::query("UPDATE playlists SET updated_at = ?1 WHERE id = ?2")
        .bind(now_ms())
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}

pub async fn remove_track(
    pool: &SqlitePool,
    id: &PlaylistId,
    track_id: &TrackId,
) -> Result<(), StoreError> {
    sqlx::query("DELETE FROM playlist_tracks WHERE playlist_id = ?1 AND track_id = ?2")
        .bind(id)
        .bind(track_id)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;

    // Re-pack positions so ordering stays dense.
    let remaining = crate::get_playlist_track_ids(pool, id).await?;
    for (index, tid) in remaining.iter().enumerate() {
        sqlx::query(
            "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        )
        .bind(index as i64)
        .bind(id)
        .bind(tid)
        .execute(pool)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    }
    Ok(())
}

/// Replaces the whole track order in one transaction.
///
/// The submitted list must contain exactly the playlist's current membership
/// (same set, any permutation): accepting arbitrary ids here would let the UI
/// silently add or drop tracks through an endpoint whose only job is ordering.
/// All position updates run in one transaction so a failure halfway can't leave
/// gaps or duplicated positions.
pub async fn reorder(
    pool: &SqlitePool,
    id: &PlaylistId,
    track_ids: &[TrackId],
) -> Result<(), StoreError> {
    let existing = crate::get_playlist_track_ids(pool, id).await?;
    if existing.len() != track_ids.len() {
        return Err(StoreError::Database(
            "submitted order does not match playlist contents".to_string(),
        ));
    }
    let mut have = existing.clone();
    have.sort();
    let mut want = track_ids.to_vec();
    want.sort();
    if have != want {
        return Err(StoreError::Database(
            "submitted order does not match playlist contents".to_string(),
        ));
    }

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    for (position, tid) in track_ids.iter().enumerate() {
        sqlx::query(
            "UPDATE playlist_tracks SET position = ?1 WHERE playlist_id = ?2 AND track_id = ?3",
        )
        .bind(position as i64)
        .bind(id)
        .bind(tid)
        .execute(&mut *tx)
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    }
    tx.commit()
        .await
        .map_err(|e| StoreError::Database(e.to_string()))?;
    Ok(())
}
