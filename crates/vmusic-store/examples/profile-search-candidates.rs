// SPDX-License-Identifier: MIT
// Explicit local diagnostic: only accepts a ui-browser-fixture data directory.
use std::{path::PathBuf, time::Instant};

const CANDIDATES: &str = "SELECT candidate FROM (
         SELECT rowid AS candidate FROM track_search WHERE title LIKE ?1 LIMIT ?2
     )
     UNION SELECT candidate FROM (
         SELECT rowid AS candidate FROM track_search WHERE artist LIKE ?1 LIMIT ?2
     )
     UNION SELECT candidate FROM (
         SELECT rowid AS candidate FROM track_search WHERE album LIKE ?1 LIMIT ?2
     )
     LIMIT ?2";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("fixture data directory required")?,
    )
    .canonicalize()?;
    if dir.file_name().and_then(|s| s.to_str()) != Some("data")
        || !dir
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .is_some_and(|s| s.starts_with("hertz-ui-check-"))
        || !dir.join("vmusic.db").is_file()
    {
        return Err("only an existing isolated ui-browser-fixture is accepted".into());
    }
    let db = vmusic_store::open(&dir).await?;
    let aggregate = format!("SELECT json_group_array(candidate) FROM ({CANDIDATES})");
    let mut observations = Vec::new();
    let mut store_observations = Vec::new();
    for round in -2..8 {
        for pattern in [
            "%Track%",
            "%静谧星河%",
            "%NeverMatchNeedle%",
            "%Track 01234%",
        ] {
            let mut expected = None;
            // Alternate order, use the same pool and exact bounded candidate SQL.
            for mode in if round % 2 == 0 {
                ["rows", "json"]
            } else {
                ["json", "rows"]
            } {
                let started = Instant::now();
                let ids: Vec<i64> = if mode == "rows" {
                    sqlx::query_scalar(CANDIDATES)
                        .bind(pattern)
                        .bind(2001_i64)
                        .fetch_all(&db)
                        .await?
                } else {
                    let encoded: String = sqlx::query_scalar(&aggregate)
                        .bind(pattern)
                        .bind(2001_i64)
                        .fetch_one(&db)
                        .await?;
                    serde_json::from_str(&encoded)?
                };
                let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
                if let Some(previous) = &expected {
                    assert_eq!(previous, &ids);
                } else {
                    expected = Some(ids.clone());
                }
                observations.push(
                    serde_json::json!({"round":round,"pattern":pattern,"mode":mode,
                    "count":ids.len(),"elapsedMs":elapsed_ms}),
                );
            }
        }
    }
    let predicate = "(?1 = '' OR COALESCE(NULLIF(TRIM(e.title), ''), t.title) LIKE ?2 OR COALESCE(NULLIF(TRIM(e.artist), ''), t.artist) LIKE ?2 OR COALESCE(NULLIF(TRIM(e.album), ''), t.album) LIKE ?2)";
    let selection =
        format!("FROM tracks t LEFT JOIN track_edits e ON e.track_id = t.id WHERE {predicate}");
    let order = "COALESCE(NULLIF(TRIM(e.title), ''), t.title) COLLATE NOCASE, t.id";
    let columns = format!("t.id, t.path, t.source, {}, t.duration_ms, t.bitrate, t.sample_rate, t.channels, t.has_cover, t.cover_key, t.file_mtime, t.file_size, t.added_at", vmusic_store::TRACK_COALESCE_COLS);
    let window_sql = format!("SELECT {columns}, page.search_total FROM (SELECT t.rowid AS track_rowid, COUNT(*) OVER() AS search_total {selection} ORDER BY {order} LIMIT 20) page JOIN tracks t ON t.rowid = page.track_rowid LEFT JOIN track_edits e ON e.track_id = t.id ORDER BY {order}");
    #[derive(sqlx::FromRow)]
    struct PageRow {
        #[sqlx(flatten)]
        track: vmusic_store::TrackRow,
        search_total: i64,
    }
    let mut window_observations = Vec::new();
    for round in -2..8 {
        for query in ["Track", "静谧星河", "晴天", "%", ""] {
            for mode in if round % 2 == 0 {
                ["separate", "page"]
            } else {
                ["page", "separate"]
            } {
                if mode == "separate" {
                    let started = Instant::now();
                    let rows = vmusic_store::list_tracks_sorted(
                        &db,
                        Some(query),
                        vmusic_store::TrackSort::Title,
                        20,
                        0,
                    )
                    .await?;
                    let list_ms = started.elapsed().as_secs_f64() * 1000.;
                    let started = Instant::now();
                    let total = vmusic_store::count_tracks(&db, Some(query)).await?;
                    let count_ms = started.elapsed().as_secs_f64() * 1000.;
                    store_observations.push(serde_json::json!({"round":round,"query":query,
                        "listMs":list_ms,"countMs":count_ms,"total":total,"ids":rows.iter().map(|t| &t.id).collect::<Vec<_>>()}));
                } else {
                    let started = Instant::now();
                    let rows: Vec<PageRow> = sqlx::query_as(&window_sql)
                        .bind(query)
                        .bind(format!("%{query}%"))
                        .fetch_all(&db)
                        .await?;
                    let elapsed_ms = started.elapsed().as_secs_f64() * 1000.;
                    window_observations.push(
                        serde_json::json!({"round":round,"query":query,"elapsedMs":elapsed_ms,
                        "total":rows.first().map(|r|r.search_total).unwrap_or(0),
                        "ids":rows.iter().map(|r|&r.track.id).collect::<Vec<_>>()}),
                    );
                }
            }
        }
    }
    for row in &window_observations {
        let expected = store_observations
            .iter()
            .find(|s| s["query"] == row["query"] && s["round"] == row["round"])
            .unwrap();
        assert_eq!(row["total"], expected["total"]);
        assert_eq!(row["ids"], expected["ids"]);
    }
    let mut plans = serde_json::Map::new();
    for (name, sql) in [
        ("count", format!("SELECT COUNT(*) AS n {selection}")),
        ("page", window_sql),
        ("list", format!("SELECT t.*, {} {selection} ORDER BY COALESCE(NULLIF(TRIM(e.title), ''), t.title) COLLATE NOCASE, t.id LIMIT 20", vmusic_store::TRACK_COALESCE_COLS)),
    ] {
        let rows: Vec<(i64, i64, i64, String)> = sqlx::query_as(&format!("EXPLAIN QUERY PLAN {sql}"))
            .bind("Track").bind("%Track%").fetch_all(&db).await?;
        plans.insert(name.into(), serde_json::json!(rows));
    }
    db.close().await;
    println!(
        "{}",
        serde_json::json!({"diagnosticOnly":true,"releaseEligible":false,
        "candidateSql":CANDIDATES,"observations":observations,"storeObservations":store_observations,"plans":plans,"windowObservations":window_observations})
    );
    Ok(())
}
