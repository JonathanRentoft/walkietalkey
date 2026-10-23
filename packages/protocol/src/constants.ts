/** Frame format version (spec 9.4). */
export const PROTOCOL_VERSION = 1;

/** Domain-separation labels; used as their ASCII bytes. */
export const LABELS = {
  room: "wt-room-v1",
  auth: "wt-auth-v1",
  create: "wt-create-v1",
  join: "wt-join-v1",
  pair: "wt-pair-v1",
  p2c: "wt-p2c-v1",
  c2p: "wt-c2p-v1",
  joinMac: "wt-join-mac-v1",
} as const;

export type ChallengeLabel = typeof LABELS.auth | typeof LABELS.create | typeof LABELS.join;

export const ROOM_ID_LEN = 16;
export const DEVICE_ID_LEN = 16;
export const SESSION_ID_LEN = 16;
export const SALT_LEN = 16;
export const CHALLENGE_LEN = 32;
export const SECRET_LEN = 32;
export const MAC_LEN = 32;
export const SHA256_LEN = 32;
export const KEY_LEN = 32;
export const SIGNATURE_LEN = 64;
export const NONCE_LEN = 12;
export const TAG_LEN = 16;

/** DER prefix of a P-256 SubjectPublicKeyInfo with an uncompressed point (the 0x04 follows). */
export const SPKI_PREFIX = new Uint8Array([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce,
  0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04,
]);
export const SPKI_LEN = 91;

/** Header bytes covered as AAD: version, type, sender, recipient, counter. */
export const AAD_LEN = 42;
/** AAD plus nonce. */
export const HEADER_LEN = 54;
/** Smallest possible frame: header plus GCM tag. */
export const FRAME_OVERHEAD = HEADER_LEN + TAG_LEN;
/** Largest device frame the relay forwards (RELAY-11). */
export const MAX_FRAME_LEN = 65536;
export const MAX_PLAINTEXT_LEN = MAX_FRAME_LEN - FRAME_OVERHEAD;

/** Device frame types (Appendix C.2). */
export const FrameType = {
  DeviceInfo: 0x10,
  Presence: 0x11,
  PresenceQuery: 0x12,
  AudioStart: 0x20,
  AudioChunk: 0x21,
  AudioEnd: 0x22,
  AudioCancel: 0x23,
  Result: 0x30,
} as const;
export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** WebSocket close codes (Appendix C.3). */
export const CloseCode = {
  NotAuthorised: 4401,
  NotAllowed: 4403,
  RoomNotFound: 4404,
  RoomExists: 4409,
  FrameTooLarge: 4413,
  RateLimited: 4429,
} as const;

/** Close codes outside C.3 that the relay also uses (documented in PROTOCOL.md). */
export const ExtraCloseCode = {
  Normal: 1000,
  GoingAway: 1001,
  PolicyViolation: 1008,
} as const;

export const SAMPLE_RATE = 16000;
export const BLOCK_MS = 200;
export const BLOCK_SAMPLES = 3200;
export const BLOCK_BYTES = 6400;
export const MAX_BLOCKS_PER_FRAME = 10;
export const AUDIO_CHUNK_HEADER_LEN = SESSION_ID_LEN + 4;
export const MAX_RESEND_FRAMES_PER_SECOND = 25;

export const MAX_DEVICE_NAME_BYTES = 256;
export const MAX_PLATFORM_BYTES = 32;
export const MAX_COMPUTER_NAME_BYTES = 256;
export const MAX_U32 = 0xffffffff;

export const ADMISSION_TTL_MS = 10 * 60 * 1000;
export const PING_INTERVAL_MS = 30_000;
export const LIVENESS_TIMEOUT_MS = 75_000;
export const COUNTER_BLOCK = 1000;

/** The exact strings of the relay's automatic ping answer (RELAY-10). Byte-exact. */
export const PING_MESSAGE = '{"t":"ping"}';
export const PONG_MESSAGE = '{"t":"pong"}';

export const RESULT_REASONS = ["no_speech", "model_not_ready", "too_long", "paused", "error"] as const;
export type ResultReason = (typeof RESULT_REASONS)[number];

export type Role = "owner" | "phone";
export type Intent = "auth" | "create" | "join";
export type ComputerOs = "mac" | "win";
