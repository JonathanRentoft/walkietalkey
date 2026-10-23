use std::time::Duration;

use wt_protocol::{assert_relay_url, ComputerOs};

use crate::error::ClientError;

/// DESK-60: reconnect delays; the last one repeats.
pub const DEFAULT_BACKOFF: [Duration; 5] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
];

#[derive(Debug, Clone)]
pub struct ClientConfig {
    /// Relay base URL, `wss://...` (managed setting `RelayUrl`).
    pub relay_url: String,
    /// Phone app base URL for the pairing QR (managed setting `PhoneAppUrl`).
    pub phone_app_url: String,
    /// Shown on the phone ("Klar på <computer>").
    pub computer_name: String,
    /// Tells the phone whether to say ⌘V or Ctrl+V.
    pub os: ComputerOs,
    /// RELAY-10: ping every 30 s.
    pub ping_interval: Duration,
    /// A ping not answered within this time means the connection is dead.
    pub pong_timeout: Duration,
    pub connect_timeout: Duration,
    /// How long commands wait for the relay's `ack`.
    pub ack_timeout: Duration,
    pub backoff: Vec<Duration>,
    /// SEC-02: a pairing code lives 10 minutes.
    pub pairing_ttl: Duration,
    /// DESK-62: how long to wait for the phone's name before announcing it without one.
    pub name_wait: Duration,
    /// After connecting, phones that are members at the relay but have no keys here are
    /// revoked once this much time has passed (pending member_joined events arrive first).
    pub reconcile_delay: Duration,
    /// Allow `ws://localhost` (tests). Honoured only in debug builds or with the
    /// `insecure-localhost` feature (SEC-06).
    pub allow_insecure_localhost: bool,
}

impl ClientConfig {
    pub fn new(
        relay_url: impl Into<String>,
        phone_app_url: impl Into<String>,
        computer_name: impl Into<String>,
        os: ComputerOs,
    ) -> Self {
        ClientConfig {
            relay_url: relay_url.into().trim_end_matches('/').to_string(),
            phone_app_url: phone_app_url.into(),
            computer_name: computer_name.into(),
            os,
            ping_interval: Duration::from_secs(30),
            pong_timeout: Duration::from_secs(10),
            connect_timeout: Duration::from_secs(15),
            ack_timeout: Duration::from_secs(10),
            backoff: DEFAULT_BACKOFF.to_vec(),
            pairing_ttl: Duration::from_secs(600),
            name_wait: Duration::from_secs(3),
            reconcile_delay: Duration::from_secs(10),
            allow_insecure_localhost: false,
        }
    }

    /// Whether ws://localhost may be used in this build.
    pub fn insecure_localhost_allowed(&self) -> bool {
        self.allow_insecure_localhost
            && (cfg!(debug_assertions) || cfg!(feature = "insecure-localhost"))
    }

    pub fn validate(&self) -> Result<(), ClientError> {
        assert_relay_url(&self.relay_url, self.insecure_localhost_allowed())
            .map_err(|e| ClientError::InsecureRelayUrl(e.to_string()))
    }

    /// Delay before reconnect attempt `n` (0-based).
    pub fn backoff_for(&self, attempt: usize) -> Duration {
        let list = if self.backoff.is_empty() {
            &DEFAULT_BACKOFF[..]
        } else {
            &self.backoff[..]
        };
        list[attempt.min(list.len() - 1)]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(url: &str) -> ClientConfig {
        ClientConfig::new(url, "https://app.walkietalkey.com", "Mac", ComputerOs::Mac)
    }

    #[test]
    fn backoff_is_1_2_5_10_30_then_30() {
        let c = cfg("wss://r.example");
        let got: Vec<u64> = (0..7).map(|i| c.backoff_for(i).as_secs()).collect();
        assert_eq!(got, vec![1, 2, 5, 10, 30, 30, 30]);
    }

    #[test]
    fn sec06_wss_only() {
        assert!(cfg("wss://relay.walkietalkey.com").validate().is_ok());
        assert!(cfg("ws://relay.walkietalkey.com").validate().is_err());
        assert!(cfg("ws://127.0.0.1:8787").validate().is_err());
        let mut local = cfg("ws://127.0.0.1:8787");
        local.allow_insecure_localhost = true;
        // Tests run as debug builds.
        assert_eq!(
            local.validate().is_ok(),
            cfg!(debug_assertions) || cfg!(feature = "insecure-localhost")
        );
        let mut remote = cfg("ws://relay.example");
        remote.allow_insecure_localhost = true;
        assert!(remote.validate().is_err());
        assert_eq!(cfg("wss://r.example/").relay_url, "wss://r.example");
    }
}
