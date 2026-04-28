mod api;
mod app_error;
mod config;
mod db;
mod library;
mod models;

use std::{net::SocketAddr, path::Path, sync::Arc};

use anyhow::Context;
use api::router;
use config::Config;
use db::{connect_db, migrate};
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

    let state = Arc::new(AppState {
        config: config.clone(),
        db,
    });

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

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
    let listener = tokio::net::TcpListener::bind(addr).await?;

    tracing::info!("listening on http://{addr}");
    axum::serve(listener, app).await?;

    Ok(())
}
