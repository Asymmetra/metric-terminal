#[allow(dead_code)]
pub struct AppConfig {
    pub imperial_api_url: String,
    pub imperial_ws_url: String,
    pub port: u16,
}

impl AppConfig {
    pub fn from_env() -> Self {
        Self {
            imperial_api_url: std::env::var("IMPERIAL_API_URL")
                .unwrap_or_else(|_| "https://api.imperial.space".to_string()),
            imperial_ws_url: std::env::var("IMPERIAL_WS_URL")
                .unwrap_or_else(|_| "wss://api.imperial.space".to_string()),
            port: std::env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3001),
        }
    }
}
