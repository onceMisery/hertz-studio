// SPDX-License-Identifier: MIT
//! Standalone service, started only by an explicitly configured operator.
use hertz_wallpaper_hub::{config::Config, Hub};
use std::{net::SocketAddr, path::PathBuf, time::Duration};
use tokio::io::AsyncReadExt;

#[tokio::main]
async fn main() {
    if let Err(message) = run().await {
        // Never print configuration, OIDC bodies, bearer tokens or SQL errors.
        eprintln!("hertz-wallpaper-hub: {message}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), &'static str> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--config")) {
        return Err("usage: hertz-wallpaper-hub --config <absolute-config.toml>");
    }
    let path = PathBuf::from(args.next().ok_or("configuration path is required")?);
    if !path.is_absolute() || args.next().is_some() {
        return Err("one absolute configuration path is required");
    }
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|_| "cannot open configuration")?;
    let mut bytes = Vec::new();
    file.take(65_537)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| "cannot read configuration")?;
    if bytes.len() > 65_536 {
        return Err("configuration exceeds 64KiB");
    }
    let config: Config =
        toml::from_str(std::str::from_utf8(&bytes).map_err(|_| "configuration must be UTF-8")?)
            .map_err(|_| "configuration fields are invalid")?;
    config
        .validate()
        .map_err(|_| "configuration violates deployment requirements")?;
    let address = config.listen;
    let (hub, lease) = Hub::open(config)
        .await
        .map_err(|_| "cannot open independent Hub store")?;
    let listener = match tokio::net::TcpListener::bind(address).await {
        Ok(listener) => listener,
        Err(_) => {
            hub.close().await;
            return Err("cannot bind configured listener");
        }
    };
    let (stop, mut stopped) = tokio::sync::watch::channel(false);
    let maintenance_hub = hub.clone();
    let maintenance = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut failed = false;
        loop {
            tokio::select! {
                biased;
                _ = stopped.changed() => break,
                _ = interval.tick() => {
                    let next_failed = maintenance_hub.maintain().await.is_err();
                    if next_failed != failed {
                        eprintln!("hertz-wallpaper-hub: maintenance {}", if next_failed { "unavailable" } else { "recovered" });
                    }
                    failed = next_failed;
                }
            }
        }
    });
    let server = axum::serve(
        listener,
        hub.router()
            .into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await;
    let _ = stop.send(true);
    let maintained = maintenance.await;
    // Finish owned transfers/validation before releasing DB/content leases.
    hub.close().await;
    drop(lease);
    maintained.map_err(|_| "maintenance task failed")?;
    server.map_err(|_| "HTTP server stopped unexpectedly")
}
async fn shutdown() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
