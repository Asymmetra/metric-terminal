use anyhow::Result;
use axum::{routing::get, Router};
use std::sync::Arc;
use tokio::net::TcpListener;
use axum::http::{HeaderValue, Method};
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

mod config;
mod error;
mod phoenix;
mod routes;
mod services;
mod state;
mod ws;

use state::AppState;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::from_default_env().add_directive("ember_backend=info".parse()?),
        )
        .init();

    tracing::info!("Starting Ember Terminal backend...");

    let state = AppState::new().await?;
    let state = Arc::new(state);

    // Start the market data relay (SDK WS subscriptions)
    let relay_symbols = {
        let markets = state.markets.read().await;
        markets.iter().map(|m| m.symbol.clone()).collect::<Vec<_>>()
    };
    ws::relay::start_relay(
        state.ws_client.clone(),
        state.market_cache.clone(),
        state.broadcast.clone(),
        relay_symbols,
    )
    .await;

    let cors = {
        let allowed_origins = std::env::var("CORS_ORIGIN")
            .unwrap_or_else(|_| "http://localhost:3000".to_string());
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
        .nest("/api", routes::api_router())
        .route("/ws", get(ws::handler::ws_upgrade))
        .with_state(state.clone())
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let cfg = config::AppConfig::from_env();
    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("Listening on {}", addr);
    let listener = TcpListener::bind(&addr).await?;

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    tracing::info!("Shutting down...");
    state.shutdown().await;

    Ok(())
}

async fn shutdown_signal() {
    tokio::signal::ctrl_c()
        .await
        .expect("Failed to listen for ctrl+c");
    tracing::info!("Received shutdown signal");
}
