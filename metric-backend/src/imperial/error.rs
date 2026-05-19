use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use thiserror::Error;

#[derive(Error, Debug)]
#[allow(dead_code)]
pub enum ImperialError {
    #[error("Imperial HTTP error {status}: {body}")]
    Http { status: u16, body: String },

    #[error("Imperial transport error: {0}")]
    Transport(#[from] reqwest::Error),

    #[error("Imperial WS error: {0}")]
    Ws(String),

    #[error("Bad request: {0}")]
    BadRequest(String),
}

impl IntoResponse for ImperialError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            ImperialError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ImperialError::Http { status, .. } => {
                let s = StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY);
                (s, self.to_string())
            }
            ImperialError::Transport(_) | ImperialError::Ws(_) => {
                (StatusCode::BAD_GATEWAY, self.to_string())
            }
        };
        let body = json!({ "error": message });
        (status, axum::Json(body)).into_response()
    }
}
