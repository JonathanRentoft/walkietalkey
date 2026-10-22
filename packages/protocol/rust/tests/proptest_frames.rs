//! Property tests for frame parsing (spec 15.1).

use proptest::prelude::*;
use wt_protocol::consts::*;
use wt_protocol::*;

fn id() -> impl Strategy<Value = DeviceId> {
    any::<[u8; 16]>().prop_map(DeviceId)
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn random_bytes_never_panic(bytes in proptest::collection::vec(any::<u8>(), 0..400)) {
        let _ = parse_frame(&bytes);
        let _ = open_frame(&[0u8; 32], &bytes, &DeviceId([0; 16]), None);
    }

    #[test]
    fn random_payloads_never_panic(t in any::<u8>(), bytes in proptest::collection::vec(any::<u8>(), 0..300)) {
        let _ = DevicePayload::decode(t, &bytes);
    }

    #[test]
    fn random_control_text_never_panics(s in ".{0,200}") {
        let _ = ControlMessage::parse(&s);
        let _ = decode_pairing_url(&s, true);
    }

    #[test]
    fn version_one_frames_parse(mut bytes in proptest::collection::vec(any::<u8>(), FRAME_OVERHEAD..400)) {
        bytes[0] = 1;
        let parsed = parse_frame(&bytes).unwrap();
        prop_assert_eq!(parsed.ciphertext.len(), bytes.len() - HEADER_LEN);
    }

    #[test]
    fn seal_open_round_trip(
        key in any::<[u8; 32]>(),
        t in any::<u8>(),
        sender in id(),
        recipient in id(),
        counter in 1u64..,
        plaintext in proptest::collection::vec(any::<u8>(), 0..2000),
    ) {
        let f = seal_frame(&key, &SealHeader { frame_type: t, sender, recipient, counter }, &plaintext).unwrap();
        let (h, pt) = open_frame(&key, &f, &recipient, Some(&sender)).unwrap();
        prop_assert_eq!(h.frame_type, t);
        prop_assert_eq!(h.counter, counter);
        prop_assert_eq!(pt, plaintext);
    }

    #[test]
    fn any_single_bit_flip_fails(
        key in any::<[u8; 32]>(),
        sender in id(),
        recipient in id(),
        plaintext in proptest::collection::vec(any::<u8>(), 0..300),
        pos in any::<prop::sample::Index>(),
        bit in 0u8..8,
    ) {
        let f = seal_frame(&key, &SealHeader { frame_type: 0x21, sender, recipient, counter: 5 }, &plaintext).unwrap();
        let mut changed = f.clone();
        let i = pos.index(changed.len());
        changed[i] ^= 1 << bit;
        // Expect the recipient now in the header, so only authentication can catch the change.
        let header_recipient = DeviceId::from_slice(&changed[18..34]).unwrap();
        prop_assert!(open_frame(&key, &changed, &header_recipient, None).is_err());
    }
}
