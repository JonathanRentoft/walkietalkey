//! Device key pairs, canonical SPKI, device ids and challenge signatures.

use p256::ecdsa::signature::{Signer, Verifier};
use p256::ecdsa::{Signature, SigningKey, VerifyingKey};
use p256::elliptic_curve::sec1::ToSec1Point;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use p256::{PublicKey, SecretKey};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::bytes::{
    b64u_decode, b64u_encode, random_bytes, Challenge, DeviceId, RoomId, Signature64,
};
use crate::consts::*;
use crate::error::{ProtocolError, Result};

/// A P-256 public key in the one canonical encoding: 91-byte SPKI with an uncompressed point.
/// Device ids hash this encoding, so no other encoding of the same key is accepted.
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct Spki(Vec<u8>);

impl Spki {
    /// Checks length, prefix and that the point is on the curve.
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        if bytes.len() != SPKI_LEN {
            return Err(ProtocolError::BadKey("SPKI must be 91 bytes"));
        }
        if bytes[..SPKI_PREFIX.len()] != SPKI_PREFIX {
            return Err(ProtocolError::BadKey("not an uncompressed P-256 SPKI"));
        }
        PublicKey::from_sec1_bytes(&bytes[SPKI_PREFIX.len() - 1..])
            .map_err(|_| ProtocolError::BadKey("invalid P-256 point"))?;
        Ok(Spki(bytes.to_vec()))
    }

    pub fn from_public_key(key: &PublicKey) -> Self {
        let point = key.to_sec1_point(false);
        let mut out = Vec::with_capacity(SPKI_LEN);
        out.extend_from_slice(&SPKI_PREFIX[..SPKI_PREFIX.len() - 1]);
        out.extend_from_slice(point.as_bytes());
        debug_assert_eq!(out.len(), SPKI_LEN);
        Spki(out)
    }

    pub fn public_key(&self) -> PublicKey {
        // Validated at construction.
        PublicKey::from_sec1_bytes(&self.0[SPKI_PREFIX.len() - 1..]).expect("validated SPKI")
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn from_b64u(text: &str) -> Result<Self> {
        Self::parse(&b64u_decode(text)?)
    }

    pub fn to_b64u(&self) -> String {
        b64u_encode(&self.0)
    }

    /// Device id = first 16 bytes of SHA-256(SPKI) (spec 9.2).
    pub fn device_id(&self) -> DeviceId {
        let digest = Sha256::digest(&self.0);
        DeviceId::from_slice(&digest[..DEVICE_ID_LEN]).expect("16 bytes")
    }
}

impl std::fmt::Debug for Spki {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Spki({})", self.to_b64u())
    }
}

impl Serialize for Spki {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_b64u())
    }
}

impl<'de> Deserialize<'de> for Spki {
    fn deserialize<D: Deserializer<'de>>(d: D) -> std::result::Result<Self, D::Error> {
        let s = <std::borrow::Cow<'de, str>>::deserialize(d)?;
        Spki::from_b64u(&s).map_err(serde::de::Error::custom)
    }
}

fn random_secret_key() -> Result<SecretKey> {
    loop {
        let bytes = Zeroizing::new(random_bytes::<32>()?);
        if let Ok(key) = SecretKey::from_slice(bytes.as_ref()) {
            return Ok(key);
        }
    }
}

/// The three challenge labels (spec 9.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChallengeLabel {
    Auth,
    Create,
    Join,
}

impl ChallengeLabel {
    pub fn as_str(self) -> &'static str {
        match self {
            ChallengeLabel::Auth => LABEL_AUTH,
            ChallengeLabel::Create => LABEL_CREATE,
            ChallengeLabel::Join => LABEL_JOIN,
        }
    }

    pub fn parse(label: &str) -> Result<Self> {
        match label {
            LABEL_AUTH => Ok(ChallengeLabel::Auth),
            LABEL_CREATE => Ok(ChallengeLabel::Create),
            LABEL_JOIN => Ok(ChallengeLabel::Join),
            _ => Err(ProtocolError::BadLabel),
        }
    }
}

/// label ‖ roomId ‖ challenge.
pub fn challenge_message(
    label: ChallengeLabel,
    room_id: &RoomId,
    challenge: &Challenge,
) -> Vec<u8> {
    let mut msg = Vec::with_capacity(label.as_str().len() + ROOM_ID_LEN + CHALLENGE_LEN);
    msg.extend_from_slice(label.as_str().as_bytes());
    msg.extend_from_slice(room_id.as_bytes());
    msg.extend_from_slice(challenge.as_bytes());
    msg
}

/// ECDSA P-256 signing key with its SPKI and device id.
#[derive(Clone)]
pub struct SigningKeyPair {
    key: SigningKey,
    spki: Spki,
    device_id: DeviceId,
}

impl SigningKeyPair {
    pub fn generate() -> Result<Self> {
        Ok(Self::from_secret(random_secret_key()?))
    }

    fn from_secret(secret: SecretKey) -> Self {
        let spki = Spki::from_public_key(&secret.public_key());
        let device_id = spki.device_id();
        SigningKeyPair {
            key: SigningKey::from(secret),
            spki,
            device_id,
        }
    }

    /// Restores a key from its 32-byte big-endian scalar (how the KeyStore keeps it).
    pub fn from_scalar_bytes(bytes: &[u8]) -> Result<Self> {
        let secret = SecretKey::from_slice(bytes)
            .map_err(|_| ProtocolError::BadKey("invalid P-256 scalar"))?;
        Ok(Self::from_secret(secret))
    }

    pub fn from_pkcs8_der(der: &[u8]) -> Result<Self> {
        let secret =
            SecretKey::from_pkcs8_der(der).map_err(|_| ProtocolError::BadKey("invalid PKCS#8"))?;
        Ok(Self::from_secret(secret))
    }

    pub fn to_scalar_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.key.to_bytes().into())
    }

    pub fn to_pkcs8_der(&self) -> Result<Zeroizing<Vec<u8>>> {
        let secret = SecretKey::from(self.key.as_nonzero_scalar());
        let doc = secret
            .to_pkcs8_der()
            .map_err(|_| ProtocolError::BadKey("PKCS#8 encoding failed"))?;
        Ok(Zeroizing::new(doc.as_bytes().to_vec()))
    }

    pub fn spki(&self) -> &Spki {
        &self.spki
    }

    pub fn device_id(&self) -> DeviceId {
        self.device_id
    }

    /// Signs label ‖ roomId ‖ challenge; 64-byte raw r‖s (never DER).
    pub fn sign_challenge(
        &self,
        label: ChallengeLabel,
        room_id: &RoomId,
        challenge: &Challenge,
    ) -> Signature64 {
        let sig: Signature = self.key.sign(&challenge_message(label, room_id, challenge));
        Signature64::from_slice(&sig.to_bytes()).expect("64 bytes")
    }
}

impl std::fmt::Debug for SigningKeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SigningKeyPair({})", self.device_id)
    }
}

/// Verifies a challenge answer; false for any wrong or malformed signature.
pub fn verify_challenge(
    spki: &Spki,
    label: ChallengeLabel,
    room_id: &RoomId,
    challenge: &Challenge,
    signature: &[u8],
) -> bool {
    let Ok(sig) = Signature::from_slice(signature) else {
        return false;
    };
    let vk = VerifyingKey::from(spki.public_key());
    vk.verify(&challenge_message(label, room_id, challenge), &sig)
        .is_ok()
}

/// ECDH P-256 key pair.
#[derive(Clone)]
pub struct AgreementKeyPair {
    secret: SecretKey,
    spki: Spki,
}

impl AgreementKeyPair {
    pub fn generate() -> Result<Self> {
        Ok(Self::from_secret(random_secret_key()?))
    }

    fn from_secret(secret: SecretKey) -> Self {
        let spki = Spki::from_public_key(&secret.public_key());
        AgreementKeyPair { secret, spki }
    }

    pub fn from_scalar_bytes(bytes: &[u8]) -> Result<Self> {
        let secret = SecretKey::from_slice(bytes)
            .map_err(|_| ProtocolError::BadKey("invalid P-256 scalar"))?;
        Ok(Self::from_secret(secret))
    }

    pub fn from_pkcs8_der(der: &[u8]) -> Result<Self> {
        let secret =
            SecretKey::from_pkcs8_der(der).map_err(|_| ProtocolError::BadKey("invalid PKCS#8"))?;
        Ok(Self::from_secret(secret))
    }

    pub fn to_scalar_bytes(&self) -> Zeroizing<[u8; 32]> {
        Zeroizing::new(self.secret.to_bytes().into())
    }

    pub fn to_pkcs8_der(&self) -> Result<Zeroizing<Vec<u8>>> {
        let doc = self
            .secret
            .to_pkcs8_der()
            .map_err(|_| ProtocolError::BadKey("PKCS#8 encoding failed"))?;
        Ok(Zeroizing::new(doc.as_bytes().to_vec()))
    }

    pub fn spki(&self) -> &Spki {
        &self.spki
    }

    /// ECDH shared secret: the 32-byte x coordinate (same as WebCrypto deriveBits).
    pub fn shared_secret(&self, peer: &Spki) -> Zeroizing<[u8; 32]> {
        let shared = p256::ecdh::diffie_hellman(
            self.secret.to_nonzero_scalar(),
            peer.public_key().as_affine(),
        );
        Zeroizing::new((*shared.raw_secret_bytes()).into())
    }
}

impl std::fmt::Debug for AgreementKeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "AgreementKeyPair({})", self.spki.to_b64u())
    }
}

/// A device's two key pairs.
#[derive(Clone, Debug)]
pub struct DeviceKeys {
    pub signing: SigningKeyPair,
    pub agreement: AgreementKeyPair,
}

impl DeviceKeys {
    pub fn generate() -> Result<Self> {
        Ok(DeviceKeys {
            signing: SigningKeyPair::generate()?,
            agreement: AgreementKeyPair::generate()?,
        })
    }

    pub fn device_id(&self) -> DeviceId {
        self.signing.device_id()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spki_is_canonical_and_device_id_hashes_it() {
        let k = SigningKeyPair::generate().unwrap();
        assert_eq!(k.spki().as_bytes().len(), 91);
        assert_eq!(&k.spki().as_bytes()[..27], &SPKI_PREFIX);
        let digest = Sha256::digest(k.spki().as_bytes());
        assert_eq!(k.device_id().as_bytes(), &digest[..16]);
        assert_eq!(Spki::parse(k.spki().as_bytes()).unwrap(), *k.spki());
    }

    #[test]
    fn spki_parse_rejects_malformed() {
        let k = SigningKeyPair::generate().unwrap();
        let good = k.spki().as_bytes().to_vec();
        assert!(Spki::parse(&good[..90]).is_err());
        let mut p = good.clone();
        p[3] ^= 1;
        assert!(Spki::parse(&p).is_err());
        let mut c = good.clone();
        c[90] ^= 1;
        assert!(Spki::parse(&c).is_err());
    }

    #[test]
    fn scalar_and_pkcs8_round_trip() {
        let k = SigningKeyPair::generate().unwrap();
        let again = SigningKeyPair::from_scalar_bytes(k.to_scalar_bytes().as_ref()).unwrap();
        assert_eq!(again.spki(), k.spki());
        let der = k.to_pkcs8_der().unwrap();
        assert_eq!(
            SigningKeyPair::from_pkcs8_der(&der).unwrap().spki(),
            k.spki()
        );
        let a = AgreementKeyPair::generate().unwrap();
        let der = a.to_pkcs8_der().unwrap();
        assert_eq!(
            AgreementKeyPair::from_pkcs8_der(&der).unwrap().spki(),
            a.spki()
        );
        assert_eq!(
            AgreementKeyPair::from_scalar_bytes(a.to_scalar_bytes().as_ref())
                .unwrap()
                .spki(),
            a.spki()
        );
    }

    #[test]
    fn signatures_bind_label_room_and_challenge() {
        let k = SigningKeyPair::generate().unwrap();
        let room = RoomId::random().unwrap();
        let ch = Challenge::random().unwrap();
        let sig = k.sign_challenge(ChallengeLabel::Auth, &room, &ch);
        assert!(verify_challenge(
            k.spki(),
            ChallengeLabel::Auth,
            &room,
            &ch,
            sig.as_bytes()
        ));
        assert!(!verify_challenge(
            k.spki(),
            ChallengeLabel::Create,
            &room,
            &ch,
            sig.as_bytes()
        ));
        assert!(!verify_challenge(
            k.spki(),
            ChallengeLabel::Join,
            &room,
            &ch,
            sig.as_bytes()
        ));
        assert!(!verify_challenge(
            k.spki(),
            ChallengeLabel::Auth,
            &RoomId::random().unwrap(),
            &ch,
            sig.as_bytes()
        ));
        assert!(!verify_challenge(
            k.spki(),
            ChallengeLabel::Auth,
            &room,
            &Challenge::random().unwrap(),
            sig.as_bytes()
        ));
        assert!(!verify_challenge(
            k.spki(),
            ChallengeLabel::Auth,
            &room,
            &ch,
            &sig.as_bytes()[..63]
        ));
        assert!(!verify_challenge(
            k.spki(),
            ChallengeLabel::Auth,
            &room,
            &ch,
            &[0u8; 64]
        ));
        let other = SigningKeyPair::generate().unwrap();
        assert!(!verify_challenge(
            other.spki(),
            ChallengeLabel::Auth,
            &room,
            &ch,
            sig.as_bytes()
        ));
    }

    #[test]
    fn ecdh_agrees() {
        let a = AgreementKeyPair::generate().unwrap();
        let b = AgreementKeyPair::generate().unwrap();
        assert_eq!(*a.shared_secret(b.spki()), *b.shared_secret(a.spki()));
    }
}
