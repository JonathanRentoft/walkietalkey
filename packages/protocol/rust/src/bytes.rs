//! base64url, fixed-size byte newtypes and helpers.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use subtle::ConstantTimeEq;

use crate::error::{ProtocolError, Result};

/// base64url without padding.
pub fn b64u_encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Strict base64url: URL alphabet, no padding, canonical trailing bits.
pub fn b64u_decode(text: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(text)
        .map_err(|_| ProtocolError::BadBase64)
}

pub fn b64u_decode_fixed<const N: usize>(text: &str) -> Result<[u8; N]> {
    let v = b64u_decode(text)?;
    v.try_into()
        .map_err(|_| ProtocolError::BadLength("unexpected length"))
}

/// Constant-time equality.
pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

/// Fills a buffer from the platform CSPRNG.
pub fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).map_err(|_| ProtocolError::Random)?;
    Ok(out)
}

macro_rules! fixed_bytes {
    ($(#[$meta:meta])* $name:ident, $len:expr) => {
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub [u8; $len]);

        impl $name {
            pub const LEN: usize = $len;

            pub fn from_slice(bytes: &[u8]) -> Result<Self> {
                let arr: [u8; $len] = bytes
                    .try_into()
                    .map_err(|_| ProtocolError::BadLength(concat!(stringify!($name), " has the wrong length")))?;
                Ok(Self(arr))
            }

            pub fn from_b64u(text: &str) -> Result<Self> {
                Self::from_slice(&b64u_decode(text)?)
            }

            pub fn to_b64u(&self) -> String {
                b64u_encode(&self.0)
            }

            pub fn as_bytes(&self) -> &[u8; $len] {
                &self.0
            }

            /// A fresh random value from the platform CSPRNG.
            pub fn random() -> Result<Self> {
                Ok(Self(random_bytes::<$len>()?))
            }
        }

        impl AsRef<[u8]> for $name {
            fn as_ref(&self) -> &[u8] {
                &self.0
            }
        }

        impl std::fmt::Debug for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}({})", stringify!($name), self.to_b64u())
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.to_b64u())
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
                s.serialize_str(&self.to_b64u())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
                let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
                Self::from_b64u(&s).map_err(serde::de::Error::custom)
            }
        }
    };
}

fixed_bytes!(
    /// First 16 bytes of SHA-256(signing SPKI).
    DeviceId,
    16
);
fixed_bytes!(
    /// First 16 bytes of SHA-256("wt-room-v1" ‖ owner signing SPKI ‖ salt).
    RoomId,
    16
);
fixed_bytes!(
    /// 16 random bytes naming one dictation.
    SessionId,
    16
);
fixed_bytes!(
    /// The relay's 32-byte challenge.
    Challenge,
    32
);
fixed_bytes!(
    /// The 16-byte salt bound into the room id.
    Salt,
    16
);
fixed_bytes!(
    /// 64-byte raw r‖s ECDSA signature.
    Signature64,
    64
);
fixed_bytes!(
    /// HMAC-SHA-256 output.
    Mac32,
    32
);
fixed_bytes!(
    /// SHA-256 digest (for example of an admission secret).
    Digest32,
    32
);
/// A 32-byte secret (admission `a` or pairing secret `s`). Debug output is redacted and the
/// bytes are wiped on drop.
#[derive(Clone, PartialEq, Eq, zeroize::Zeroize, zeroize::ZeroizeOnDrop)]
pub struct Secret32(pub [u8; 32]);

impl Secret32 {
    pub fn from_slice(bytes: &[u8]) -> Result<Self> {
        let arr: [u8; 32] = bytes
            .try_into()
            .map_err(|_| ProtocolError::BadLength("secret must be 32 bytes"))?;
        Ok(Self(arr))
    }

    pub fn from_b64u(text: &str) -> Result<Self> {
        let mut v = b64u_decode(text)?;
        let out = Self::from_slice(&v);
        zeroize::Zeroize::zeroize(&mut v);
        out
    }

    pub fn to_b64u(&self) -> String {
        b64u_encode(&self.0)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn random() -> Result<Self> {
        Ok(Self(random_bytes::<32>()?))
    }
}

impl std::fmt::Debug for Secret32 {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret32(<redacted>)")
    }
}

impl Serialize for Secret32 {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_b64u())
    }
}

impl<'de> Deserialize<'de> for Secret32 {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
        Self::from_b64u(&s).map_err(serde::de::Error::custom)
    }
}
