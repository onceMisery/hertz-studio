// SPDX-License-Identifier: MIT
//! Latest successful source-bound loudness results; failures never overwrite them.
use serde::{Deserialize, Serialize};
use sqlx::{Connection, SqlitePool};
use vmusic_core::StoreError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Member {
    pub track_id: String,
    pub sha256: String,
    pub byte_length: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackMeasurement {
    pub track_id: String,
    pub sha256: String,
    pub byte_length: u64,
    pub algorithm: String,
    pub state: String,
    pub integrated_lufs: Option<f64>,
    pub sample_peak: f64,
    pub true_peak: f64,
    pub sample_rate: u32,
    pub channels: u32,
    pub channel_mask: u32,
    pub frames: u64,
    pub gated_blocks: u64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlbumMeasurement {
    pub album_key: String,
    pub algorithm: String,
    pub members: Vec<Member>,
    pub state: String,
    pub integrated_lufs: Option<f64>,
    pub sample_peak: f64,
    pub true_peak: f64,
    pub gated_blocks: u64,
}

fn db(error: sqlx::Error) -> StoreError {
    StoreError::Database(error.to_string())
}
fn invalid() -> StoreError {
    StoreError::Serialization("invalid loudness measurement".into())
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}
fn valid_result(state: &str, lufs: Option<f64>, sample: f64, peak: f64) -> bool {
    matches!(
        state,
        "measured" | "silence" | "insufficient_blocks" | "below_gate"
    ) && ((state == "measured") == lufs.is_some())
        && lufs.is_none_or(f64::is_finite)
        && sample.is_finite()
        && sample >= 0.0
        && peak.is_finite()
        && peak >= sample
}
fn encode<T: Serialize>(value: &T) -> Result<String, StoreError> {
    serde_json::to_string(value).map_err(|e| StoreError::Serialization(e.to_string()))
}

pub async fn get_track(
    pool: &SqlitePool,
    track_id: &str,
) -> Result<Option<TrackMeasurement>, StoreError> {
    let row: Option<String> =
        sqlx::query_scalar("SELECT result_json FROM loudness_tracks WHERE track_id=?1")
            .bind(track_id)
            .fetch_optional(pool)
            .await
            .map_err(db)?;
    row.map(|json| {
        serde_json::from_str(&json).map_err(|e| StoreError::Serialization(e.to_string()))
    })
    .transpose()
}
pub async fn get_album_for_track(
    pool: &SqlitePool,
    track_id: &str,
) -> Result<Option<AlbumMeasurement>, StoreError> {
    let row: Option<String> = sqlx::query_scalar("SELECT a.result_json FROM loudness_albums a JOIN loudness_album_members m ON m.album_key=a.album_key WHERE m.track_id=?1 ORDER BY a.measured_at DESC, a.album_key LIMIT 1")
        .bind(track_id).fetch_optional(pool).await.map_err(db)?;
    row.map(|json| {
        serde_json::from_str(&json).map_err(|e| StoreError::Serialization(e.to_string()))
    })
    .transpose()
}

/// Atomically publish complete results. Caller retains analysis permits through
/// commit/rollback, even if its HTTP observer has left. A failed album keeps all
/// previous track and album results, including their old membership binding.
pub async fn save_success(
    pool: &SqlitePool,
    tracks: &[TrackMeasurement],
    album: Option<&AlbumMeasurement>,
) -> Result<(), StoreError> {
    if tracks.is_empty() || tracks.len() > 128 {
        return Err(invalid());
    }
    let mut ids = std::collections::BTreeSet::new();
    for t in tracks {
        if t.track_id.is_empty()
            || t.track_id.len() > 256
            || !ids.insert(&t.track_id)
            || !valid_hash(&t.sha256)
            || t.algorithm.is_empty()
            || !matches!(t.sample_rate, 44_100 | 48_000 | 96_000)
            || !matches!((t.channels, t.channel_mask), (1, 1 | 4) | (2, 3))
            || !valid_result(&t.state, t.integrated_lufs, t.sample_peak, t.true_peak)
        {
            return Err(invalid());
        }
    }
    if let Some(a) = album {
        if !valid_hash(&a.album_key)
            || a.members.len() != tracks.len()
            || !valid_result(&a.state, a.integrated_lufs, a.sample_peak, a.true_peak)
            || a.members
                .iter()
                .map(|m| &m.track_id)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                != tracks.len()
            || a.members.iter().any(|m| {
                !tracks.iter().any(|t| {
                    t.track_id == m.track_id
                        && t.sha256 == m.sha256
                        && t.byte_length == m.byte_length
                        && t.algorithm == a.algorithm
                })
            })
        {
            return Err(invalid());
        }
    }
    // Keep the connection after the Transaction is consumed: a failed commit
    // can enqueue rollback from Drop. The final ping fences that worker queue
    // before the caller may release its analysis permits.
    let mut connection = pool.acquire().await.map_err(db)?;
    let mut tx = connection.begin_with("BEGIN IMMEDIATE").await.map_err(db)?;
    let writes: Result<(), StoreError> = async {
    for track in tracks {
        // A newly successful identity invalidates every affected old album.
        sqlx::query("DELETE FROM loudness_albums WHERE album_key IN (SELECT album_key FROM loudness_album_members WHERE track_id=?1 AND sha256<>?2) OR (algorithm<>?3 AND album_key IN (SELECT album_key FROM loudness_album_members WHERE track_id=?1))")
            .bind(&track.track_id).bind(&track.sha256).bind(&track.algorithm).execute(&mut *tx).await.map_err(db)?;
        sqlx::query("INSERT INTO loudness_tracks(track_id,sha256,algorithm,result_json,measured_at) VALUES(?1,?2,?3,?4,unixepoch()) ON CONFLICT(track_id) DO UPDATE SET sha256=excluded.sha256,algorithm=excluded.algorithm,result_json=excluded.result_json,measured_at=excluded.measured_at")
            .bind(&track.track_id).bind(&track.sha256).bind(&track.algorithm).bind(encode(track)?)
            .execute(&mut *tx).await.map_err(db)?;
    }
    if let Some(album) = album {
        // A changed complete member set supersedes the old album atomically.
        // Keep only one latest successful album binding for each member.
        for member in &album.members {
            sqlx::query("DELETE FROM loudness_albums WHERE album_key IN (SELECT album_key FROM loudness_album_members WHERE track_id=?1)")
                .bind(&member.track_id).execute(&mut *tx).await.map_err(db)?;
        }
        sqlx::query("DELETE FROM loudness_albums WHERE album_key=?1")
            .bind(&album.album_key)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        sqlx::query("INSERT INTO loudness_albums(album_key,algorithm,result_json,measured_at) VALUES(?1,?2,?3,unixepoch())")
            .bind(&album.album_key).bind(&album.algorithm).bind(encode(album)?).execute(&mut *tx).await.map_err(db)?;
        for member in &album.members {
            sqlx::query(
                "INSERT INTO loudness_album_members(album_key,track_id,sha256) VALUES(?1,?2,?3)",
            )
            .bind(&album.album_key)
            .bind(&member.track_id)
            .bind(&member.sha256)
            .execute(&mut *tx)
            .await
            .map_err(db)?;
        }
    }
    // Online identities have no tracks FK. Bound their retained measurements
    // without deleting library-owned rows; failed work never reaches this path.
    sqlx::query("DELETE FROM loudness_albums WHERE album_key IN (SELECT m.album_key FROM loudness_album_members m JOIN loudness_tracks l ON l.track_id=m.track_id WHERE l.track_id NOT IN (SELECT id FROM tracks) AND l.track_id IN (SELECT track_id FROM loudness_tracks WHERE track_id NOT IN (SELECT id FROM tracks) ORDER BY measured_at DESC, track_id LIMIT -1 OFFSET 512))")
        .execute(&mut *tx).await.map_err(db)?;
    sqlx::query("DELETE FROM loudness_tracks WHERE track_id IN (SELECT track_id FROM loudness_tracks WHERE track_id NOT IN (SELECT id FROM tracks) ORDER BY measured_at DESC, track_id LIMIT -1 OFFSET 512)")
        .execute(&mut *tx).await.map_err(db)?;
        Ok(())
    }.await;
    let result = match writes {
        Ok(()) => tx.commit().await.map_err(db),
        Err(error) => {
            let _ = tx.rollback().await;
            Err(error)
        }
    };
    let drained = connection.ping().await.map_err(db);
    result.and(drained)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn success_replacement_is_atomic_and_invalidates_bound_album() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE tracks(id TEXT PRIMARY KEY)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::raw_sql(include_str!("../../../migrations/0034_loudness.sql"))
            .execute(&pool)
            .await
            .unwrap();
        let mut track = TrackMeasurement {
            track_id: "t".into(),
            sha256: "a".repeat(64),
            byte_length: 10,
            algorithm: "v1".into(),
            state: "measured".into(),
            integrated_lufs: Some(-20.0),
            sample_peak: 0.2,
            true_peak: 0.3,
            sample_rate: 48_000,
            channels: 2,
            channel_mask: 3,
            frames: 48_000,
            gated_blocks: 7,
        };
        let album = AlbumMeasurement {
            album_key: "b".repeat(64),
            algorithm: "v1".into(),
            members: vec![Member {
                track_id: track.track_id.clone(),
                sha256: track.sha256.clone(),
                byte_length: 10,
            }],
            state: "measured".into(),
            integrated_lufs: Some(-20.0),
            sample_peak: 0.2,
            true_peak: 0.3,
            gated_blocks: 7,
        };
        save_success(&pool, &[track.clone()], Some(&album))
            .await
            .unwrap();
        track.integrated_lufs = Some(f64::NAN);
        assert!(save_success(&pool, &[track.clone()], None).await.is_err());
        assert_eq!(
            get_track(&pool, "t")
                .await
                .unwrap()
                .unwrap()
                .integrated_lufs,
            Some(-20.0)
        );
        assert!(get_album_for_track(&pool, "t").await.unwrap().is_some());
        sqlx::query("CREATE TRIGGER reject_test_measurement BEFORE INSERT ON loudness_tracks WHEN NEW.track_id='reject' BEGIN SELECT RAISE(ABORT,'forced write failure'); END")
            .execute(&pool).await.unwrap();
        let mut replacement = track.clone();
        replacement.integrated_lufs = Some(-19.0);
        replacement.sha256 = "d".repeat(64);
        let mut rejected = replacement.clone();
        rejected.track_id = "reject".into();
        assert!(save_success(&pool, &[replacement, rejected], None)
            .await
            .is_err());
        assert_eq!(
            get_track(&pool, "t")
                .await
                .unwrap()
                .unwrap()
                .integrated_lufs,
            Some(-20.0)
        );
        assert!(get_album_for_track(&pool, "t").await.unwrap().is_some());
        track.integrated_lufs = Some(-19.0);
        track.sha256 = "c".repeat(64);
        save_success(&pool, &[track], None).await.unwrap();
        assert!(get_album_for_track(&pool, "t").await.unwrap().is_none());
        sqlx::query("INSERT INTO tracks(id) VALUES('t')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("DELETE FROM tracks WHERE id='t'")
            .execute(&pool)
            .await
            .unwrap();
        assert!(get_track(&pool, "t").await.unwrap().is_none());
        pool.close().await;
    }
}
