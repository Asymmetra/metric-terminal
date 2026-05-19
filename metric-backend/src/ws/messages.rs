use serde::Deserialize;

/// Inbound from a /ws client. Channel naming preserved from Ember so
/// the frontend WS consumer (lib/ws.ts) doesn't need to change shape.
#[derive(Deserialize, Debug)]
#[serde(tag = "type")]
#[allow(dead_code)]
pub enum ClientMessage {
    #[serde(rename = "subscribe")]
    Subscribe {
        channel: String,
        symbol: Option<String>,
    },
    #[serde(rename = "unsubscribe")]
    Unsubscribe {
        channel: String,
        symbol: Option<String>,
    },
    #[serde(rename = "ping")]
    Ping,
}

/// Outbound to a /ws client. Server messages are raw JSON values produced
/// by the relay; the WS handler serializes them as-is.
pub type ServerMessage = serde_json::Value;
