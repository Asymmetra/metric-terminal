use crate::imperial::error::ImperialError;
use crate::imperial::types::*;
use reqwest::Client;
use std::time::Duration;

/// Imperial REST client. Read-only — order placement is JWT-delegated and
/// the frontend calls those endpoints directly.
#[derive(Clone)]
pub struct ImperialHttp {
    base: String,
    client: Client,
}

#[allow(dead_code)]
impl ImperialHttp {
    pub fn new(base_url: impl Into<String>) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("reqwest client");
        Self {
            base: base_url.into().trim_end_matches('/').to_string(),
            client,
        }
    }

    pub fn from_env() -> Self {
        let base = std::env::var("IMPERIAL_API_URL")
            .unwrap_or_else(|_| "https://api.imperial.space".to_string());
        Self::new(base)
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.base, path)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
    ) -> Result<T, ImperialError> {
        let res = self.client.get(self.url(path)).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(ImperialError::Http {
                status: status.as_u16(),
                body,
            });
        }
        let parsed: T = res.json().await?;
        Ok(parsed)
    }

    async fn post_json<Req: serde::Serialize, Res: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: &Req,
    ) -> Result<Res, ImperialError> {
        let res = self.client.post(self.url(path)).json(body).send().await?;
        let status = res.status();
        if !status.is_success() {
            let body = res.text().await.unwrap_or_default();
            return Err(ImperialError::Http {
                status: status.as_u16(),
                body,
            });
        }
        Ok(res.json().await?)
    }

    // ───────────────────────────────────────── reads

    pub async fn mark_prices(&self) -> Result<MarkPriceList, ImperialError> {
        self.get_json("/mark-prices").await
    }

    pub async fn funding_rates(&self) -> Result<FundingRatesList, ImperialError> {
        self.get_json("/funding-rates").await
    }

    pub async fn phoenix_markets(&self) -> Result<Vec<PhoenixMarket>, ImperialError> {
        self.get_json("/phoenix/markets").await
    }

    pub async fn flash_markets(&self) -> Result<Vec<FlashMarket>, ImperialError> {
        self.get_json("/flash/markets").await
    }

    pub async fn gmtrade_markets(&self) -> Result<Vec<GmtradeMarket>, ImperialError> {
        self.get_json("/gmtrade/markets").await
    }

    pub async fn phoenix_depth(&self) -> Result<PhoenixDepth, ImperialError> {
        self.get_json("/phoenix/depth").await
    }

    pub async fn positions(&self, wallet: &str) -> Result<PositionList, ImperialError> {
        let path = format!("/positions?walletAddress={}", urlencode(wallet));
        self.get_json(&path).await
    }

    pub async fn trades(
        &self,
        wallet: &str,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> Result<PositionList, ImperialError> {
        let mut qs = vec![format!("walletAddress={}", urlencode(wallet))];
        if let Some(l) = limit {
            qs.push(format!("limit={}", l));
        }
        if let Some(o) = offset {
            qs.push(format!("offset={}", o));
        }
        let path = format!("/trades?{}", qs.join("&"));
        self.get_json(&path).await
    }

    pub async fn route(&self, q: &RouteQuery) -> Result<serde_json::Value, ImperialError> {
        let mut qs = vec![
            format!("asset={}", urlencode(&q.asset)),
            format!("side={}", urlencode(&q.side)),
            format!("notional={}", q.notional),
            format!("desiredLeverage={}", q.desired_leverage),
        ];
        if let Some(w) = &q.wallet {
            qs.push(format!("wallet={}", urlencode(w)));
        }
        if let Some(p) = q.profile_index {
            qs.push(format!("profileIndex={}", p));
        }
        let path = format!("/route?{}", qs.join("&"));
        self.get_json(&path).await
    }

    pub async fn priority_fee(&self) -> Result<serde_json::Value, ImperialError> {
        self.get_json("/priority-fee").await
    }

    // ───────────────────────────────────────── deposit / withdraw

    pub async fn build_deposit_tx(
        &self,
        req: &DepositRequest,
    ) -> Result<DepositResponse, ImperialError> {
        self.post_json("/deposit/build-tx", req).await
    }
}

/// Minimal URL-encoder; the values we pass are wallet pubkeys and short
/// strings, so a full percent-encoder isn't worth a dep.
fn urlencode(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c.to_string()
            } else {
                format!("%{:02X}", c as u32)
            }
        })
        .collect()
}
