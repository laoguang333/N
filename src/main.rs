mod api;
mod app_error;
mod config;
mod db;
mod library;
mod models;

use std::{net::SocketAddr, path::Path, sync::Arc};

use anyhow::Context;
use api::router;
use axum::http::HeaderValue;
use axum_server::tls_rustls::RustlsConfig;
use config::Config;
use db::{connect_db, migrate};
use library::scan_library;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[derive(Clone)]
pub struct AppState {
    pub config: Config,
    pub db: sqlx::SqlitePool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "txt_reader=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::load("config.toml")?;
    let db = connect_db(&config.database_path).await?;
    migrate(&db).await?;

    if config.scan_on_startup {
        let result = scan_library(&db, &config.library_dirs, config.scan_recursive).await?;
        tracing::info!(
            scanned = result.scanned,
            added = result.added,
            updated = result.updated,
            skipped = result.skipped,
            removed = result.removed,
            errors = result.errors.len(),
            "startup library scan complete"
        );
    }

    let state = Arc::new(AppState {
        config: config.clone(),
        db,
    });

    let cors = CorsLayer::new().allow_methods(Any).allow_headers(Any);
    let cors = if let Some(origins) = &config.cors_allowed_origins {
        let origins = origins
            .iter()
            .map(|origin| {
                origin
                    .parse::<HeaderValue>()
                    .with_context(|| format!("invalid CORS origin: {origin}"))
            })
            .collect::<anyhow::Result<Vec<_>>>()?;
        cors.allow_origin(origins)
    } else {
        cors.allow_origin(Any)
    };

    let app = router(state).layer(cors).layer(TraceLayer::new_for_http());

    let app = if Path::new("frontend/dist/index.html").exists() {
        app.fallback_service(
            ServeDir::new("frontend/dist")
                .not_found_service(ServeFile::new("frontend/dist/index.html")),
        )
    } else {
        app.fallback(|| async {
            "TXT Reader API is running. Build the frontend with `npm run build` in ./frontend."
        })
    };

    let addr: SocketAddr = config
        .listen
        .parse()
        .with_context(|| format!("invalid listen address: {}", config.listen))?;
    match (&config.tls_cert_path, &config.tls_key_path) {
        (Some(cert_path), Some(key_path)) => {
            let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
            let tls_config = RustlsConfig::from_pem_file(cert_path, key_path)
                .await
                .with_context(|| {
                    format!("failed to load TLS certificate {cert_path} and key {key_path}")
                })?;

            tracing::info!("listening on https://{addr}");
            axum_server::bind_rustls(addr, tls_config)
                .serve(app.into_make_service())
                .await?;
        }
        (None, None) => {
            let listener = tokio::net::TcpListener::bind(addr).await?;

            tracing::info!("listening on http://{addr}");
            axum::serve(listener, app).await?;
        }
        _ => anyhow::bail!("tls_cert_path and tls_key_path must be configured together"),
    }

    Ok(())
}
