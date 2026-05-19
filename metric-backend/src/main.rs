use anyhow::Result;
use axum::http::{HeaderValue, Method};
use axum::{routing::get, Json, Router};
use std::sync::Arc;
use tokio::net::TcpListener;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod config;
mod error;
mod imperial;
mod routes;
mod services;
mod state;
mod ws;

use state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("metric_backend=info".parse()?),
        )
        .init();

    tracing::info!("Starting Metric Terminal backend...");

    let state = Arc::new(AppState::new());

    // Spawn the upstream Imperial /ws/market relay (mark, funding, depth).
    ws::relay::start_market_relay(
        state.broadcast.clone(),
        state.candles.clone(),
        state.market_cache.clone(),
    );

    let cors = {
        let allowed_origins =
            std::env::var("CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:3000".to_string());
        let origins: Vec<HeaderValue> = allowed_origins
            .split(',')
            .filter_map(|s| s.trim().parse().ok())
            .collect();
        tracing::info!("CORS allowed origins: {:?}", origins);
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
            .allow_headers(Any)
    };

    let app = Router::new()
        .route("/health", get(|| async { "ok" }))
        .route(
            "/health/relay",
            get({
                let state = state.clone();
                move || {
                    let state = state.clone();
                    async move {
                        let status = state.market_cache.status();
                        let healthy = !status.is_empty()
                            && status.iter().all(|s| s.age_secs.unwrap_or(i64::MAX) < 120);
                        Json(serde_json::json!({
                            "status": if healthy { "ok" } else { "degraded" },
                            "channels": status,
                        }))
                    }
                }
            }),
        )
        .route(
            "/health/memory",
            get({
                let state = state.clone();
                move || {
                    let state = state.clone();
                    async move {
                        Json(serde_json::json!({
                            "broadcast": {
                                "channels": state.broadcast.channel_count(),
                                "subscribers_total": state.broadcast.total_subscribers(),
                                "subscribers_by_prefix": state.broadcast.subscribers_by_prefix(),
                            },
                            "market_cache": state.market_cache.sizes(),
                            "candles": {
                                "series": state.candles.series_count(),
                            },
                        }))
                    }
                }
            }),
        )
        .nest("/api", routes::api_router())
        .route("/ws", get(ws::handler::ws_upgrade))
        .with_state(state.clone())
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let cfg = config::AppConfig::from_env();
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("Listening on {addr}");
    let listener = TcpListener::bind(&addr).await?;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("Shutting down...");
    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to listen for ctrl+c");
    tracing::info!("Received shutdown signal");
}
