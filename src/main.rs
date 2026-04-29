mod api;
mod app_error;
mod config;
mod db;
mod library;
mod models;
#[cfg(target_os = "windows")]
mod tray;

use std::{
    future::Future,
    net::SocketAddr,
    path::Path,
    pin::Pin,
    sync::{Arc, mpsc},
};

use anyhow::Context;
use api::router;
use axum::{
    extract::Request,
    http::{HeaderValue, header},
    middleware::{self, Next},
    response::Response,
};
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

fn main() -> anyhow::Result<()> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "txt_reader=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let config = Config::load("config.toml")?;

    #[cfg(target_os = "windows")]
    {
        let RunningServer {
            shutdown,
            failure_rx,
        } = runtime.block_on(start_server(config))?;
        let tray_result = tray::run(failure_rx);
        let _ = shutdown.send(());
        tray_result
    }

    #[cfg(not(target_os = "windows"))]
    {
        runtime.block_on(async {
            let RunningServer {
                shutdown: _shutdown,
                failure_rx,
            } = start_server(config).await?;
            wait_for_server_failure(failure_rx).await
        })
    }
}

struct RunningServer {
    shutdown: tokio::sync::oneshot::Sender<()>,
    failure_rx: mpsc::Receiver<String>,
}

async fn start_server(config: Config) -> anyhow::Result<RunningServer> {
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

    let app = router(state);

    let app = if Path::new("frontend/dist/index.html").exists() {
        app.fallback_service(
            ServeDir::new("frontend/dist")
                .not_found_service(ServeFile::new("frontend/dist/index.html")),
        )
    } else {
        app.fallback(|| async {
            "TXT Reader API is running. Build the frontend with `npm run build` in ./frontend."
        })
    }
    .layer(cors)
    .layer(middleware::from_fn(add_security_headers))
    .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = config
        .listen
        .parse()
        .with_context(|| format!("invalid listen address: {}", config.listen))?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel();
    let (failure_tx, failure_rx) = mpsc::channel();
    let server: Pin<Box<dyn Future<Output = Result<(), std::io::Error>> + Send>> =
        match (&config.tls_cert_path, &config.tls_key_path) {
            (Some(cert_path), Some(key_path)) => {
                let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
                let tls_config = RustlsConfig::from_pem_file(cert_path, key_path)
                    .await
                    .with_context(|| {
                        format!("failed to load TLS certificate {cert_path} and key {key_path}")
                    })?;

                tracing::info!("listening on https://{addr}");
                Box::pin(
                    axum_server::bind_rustls(addr, tls_config)
                        .serve(app.into_make_service())
                        .into_future(),
                )
            }
            (None, None) => {
                let listener = tokio::net::TcpListener::bind(addr).await?;

                tracing::info!("listening on http://{addr}");
                Box::pin(axum::serve(listener, app).into_future())
            }
            _ => anyhow::bail!("tls_cert_path and tls_key_path must be configured together"),
        };

    tokio::spawn(async move {
        tokio::select! {
            result = server => {
                let message = match result {
                    Ok(()) => "server exited unexpectedly".to_string(),
                    Err(error) => {
                        tracing::error!(%error, "server exited unexpectedly");
                        format!("server exited unexpectedly: {error}")
                    }
                };
                let _ = failure_tx.send(message);
            }
            _ = shutdown_rx => {
                tracing::info!("shutdown signal received");
            }
        }
    });

    Ok(RunningServer {
        shutdown: shutdown_tx,
        failure_rx,
    })
}

#[cfg(not(target_os = "windows"))]
async fn wait_for_server_failure(failure_rx: mpsc::Receiver<String>) -> anyhow::Result<()> {
    let message = tokio::task::spawn_blocking(move || failure_rx.recv())
        .await
        .context("server failure monitor panicked")?
        .context("server failure monitor stopped")?;
    anyhow::bail!(message)
}

async fn add_security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();

    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests; block-all-mixed-content",
        ),
    );
    headers.insert(
        header::STRICT_TRANSPORT_SECURITY,
        HeaderValue::from_static("max-age=31536000"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );

    response
}
