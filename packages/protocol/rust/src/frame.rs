//! Device frame format of spec 9.4.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};

use crate::bytes::{random_bytes, DeviceId};
use crate::consts::*;
use crate::error::{ProtocolError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameHeader {
    pub version: u8,
    pub frame_type: u8,
    pub sender: DeviceId,
    pub recipient: DeviceId,
    pub counter: u64,
    pub nonce: [u8; NONCE_LEN],
}

/// A frame split into its parts, not decrypted.
#[derive(Debug, Clone)]
pub struct ParsedFrame<'a> {
    pub header: FrameHeader,
    /// The first 42 bytes, authenticated as AAD.
    pub aad: &'a [u8],
    /// Ciphertext followed by the 16-byte tag.
    pub ciphertext: &'a [u8],
}

/// What a sender chooses; the version is always 1 and the nonce random.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealHeader {
    pub frame_type: u8,
    pub sender: DeviceId,
    pub recipient: DeviceId,
    pub counter: u64,
}

/// Splits a frame without decrypting. Errors for frames shorter than 70 bytes, longer than
/// 65,536 bytes or with a version other than 1. Never panics.
pub fn parse_frame(bytes: &[u8]) -> Result<ParsedFrame<'_>> {
    if bytes.len() > MAX_FRAME_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    if bytes.len() < FRAME_OVERHEAD {
        return Err(ProtocolError::BadFrame("too short"));
    }
    if bytes[0] != PROTOCOL_VERSION {
        return Err(ProtocolError::BadVersion(bytes[0]));
    }
    let header = FrameHeader {
        version: bytes[0],
        frame_type: bytes[1],
        sender: DeviceId::from_slice(&bytes[2..18])?,
        recipient: DeviceId::from_slice(&bytes[18..34])?,
        counter: u64::from_be_bytes(bytes[34..42].try_into().expect("8 bytes")),
        nonce: bytes[AAD_LEN..HEADER_LEN].try_into().expect("12 bytes"),
    };
    Ok(ParsedFrame {
        header,
        aad: &bytes[..AAD_LEN],
        ciphertext: &bytes[HEADER_LEN..],
    })
}

fn encode_header(h: &SealHeader, nonce: &[u8; NONCE_LEN]) -> Result<[u8; HEADER_LEN]> {
    if h.counter == 0 {
        return Err(ProtocolError::BadFrame("counter must start at 1"));
    }
    let mut out = [0u8; HEADER_LEN];
    out[0] = PROTOCOL_VERSION;
    out[1] = h.frame_type;
    out[2..18].copy_from_slice(h.sender.as_bytes());
    out[18..34].copy_from_slice(h.recipient.as_bytes());
    out[34..42].copy_from_slice(&h.counter.to_be_bytes());
    out[AAD_LEN..HEADER_LEN].copy_from_slice(nonce);
    Ok(out)
}

fn seal_inner(
    key: &[u8; KEY_LEN],
    h: &SealHeader,
    plaintext: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>> {
    if plaintext.len() > MAX_PLAINTEXT_LEN {
        return Err(ProtocolError::FrameTooLarge);
    }
    let header = encode_header(h, nonce)?;
    let cipher = Aes256Gcm::new(key.into());
    let ct = cipher
        .encrypt(
            &Nonce::from(*nonce),
            Payload {
                msg: plaintext,
                aad: &header[..AAD_LEN],
            },
        )
        .map_err(|_| ProtocolError::BadFrame("encryption failed"))?;
    let mut out = Vec::with_capacity(HEADER_LEN + ct.len());
    out.extend_from_slice(&header);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Encrypts one frame with AES-256-GCM, a random 96-bit nonce and the header as AAD.
pub fn seal_frame(key: &[u8; KEY_LEN], h: &SealHeader, plaintext: &[u8]) -> Result<Vec<u8>> {
    let nonce = random_bytes::<NONCE_LEN>()?;
    seal_inner(key, h, plaintext, &nonce)
}

/// TEST ONLY: seal with a caller-chosen nonce, for reproducible test vectors.
#[cfg(feature = "test-utils")]
pub fn seal_frame_with_nonce(
    key: &[u8; KEY_LEN],
    h: &SealHeader,
    plaintext: &[u8],
    nonce: &[u8; NONCE_LEN],
) -> Result<Vec<u8>> {
    seal_inner(key, h, plaintext, nonce)
}

/// Checks the recipient (and sender when given), then decrypts. Never panics.
pub fn open_frame(
    key: &[u8; KEY_LEN],
    bytes: &[u8],
    recipient: &DeviceId,
    sender: Option<&DeviceId>,
) -> Result<(FrameHeader, Vec<u8>)> {
    let parsed = parse_frame(bytes)?;
    if parsed.header.recipient != *recipient {
        return Err(ProtocolError::WrongRecipient);
    }
    if let Some(s) = sender {
        if parsed.header.sender != *s {
            return Err(ProtocolError::WrongSender);
        }
    }
    let cipher = Aes256Gcm::new(key.into());
    let plaintext = cipher
        .decrypt(
            &Nonce::from(parsed.header.nonce),
            Payload {
                msg: parsed.ciphertext,
                aad: parsed.aad,
            },
        )
        .map_err(|_| ProtocolError::DecryptFailed)?;
    Ok((parsed.header, plaintext))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> (DeviceId, DeviceId) {
        (DeviceId::random().unwrap(), DeviceId::random().unwrap())
    }

    #[test]
    fn layout_and_round_trip() {
        let key = [7u8; 32];
        let (s, r) = ids();
        let h = SealHeader {
            frame_type: 0x20,
            sender: s,
            recipient: r,
            counter: 0x0102030405060708,
        };
        let f = seal_frame(&key, &h, b"abc").unwrap();
        assert_eq!(f.len(), FRAME_OVERHEAD + 3);
        assert_eq!(f[0], 1);
        assert_eq!(f[1], 0x20);
        assert_eq!(&f[2..18], s.as_bytes());
        assert_eq!(&f[18..34], r.as_bytes());
        assert_eq!(&f[34..42], &[1, 2, 3, 4, 5, 6, 7, 8]);
        let (hdr, pt) = open_frame(&key, &f, &r, Some(&s)).unwrap();
        assert_eq!(pt, b"abc");
        assert_eq!(hdr.counter, 0x0102030405060708);
        assert_eq!(
            open_frame(&key, &f, &s, None).unwrap_err(),
            ProtocolError::WrongRecipient
        );
        assert_eq!(
            open_frame(&key, &f, &r, Some(&r)).unwrap_err(),
            ProtocolError::WrongSender
        );
        assert_eq!(
            open_frame(&[8u8; 32], &f, &r, None).unwrap_err(),
            ProtocolError::DecryptFailed
        );
    }

    #[test]
    fn size_limits() {
        let key = [1u8; 32];
        let (s, r) = ids();
        let h = SealHeader {
            frame_type: 0x21,
            sender: s,
            recipient: r,
            counter: 1,
        };
        let max = seal_frame(&key, &h, &vec![0u8; MAX_PLAINTEXT_LEN]).unwrap();
        assert_eq!(max.len(), 65536);
        assert_eq!(
            seal_frame(&key, &h, &vec![0u8; MAX_PLAINTEXT_LEN + 1]).unwrap_err(),
            ProtocolError::FrameTooLarge
        );
        let mut big = vec![0u8; MAX_FRAME_LEN + 1];
        big[0] = 1;
        assert_eq!(parse_frame(&big).unwrap_err(), ProtocolError::FrameTooLarge);
        assert!(parse_frame(&[1u8; 69]).is_err());
        let mut v2 = vec![0u8; 70];
        v2[0] = 2;
        assert_eq!(parse_frame(&v2).unwrap_err(), ProtocolError::BadVersion(2));
        let h0 = SealHeader { counter: 0, ..h };
        assert!(seal_frame(&key, &h0, b"").is_err());
    }
}
