/** Relay limits and timings (spec section 8, RELAY-08/10/11/12). */
export const MAX_DEVICES_PER_ROOM = 8;
export const MAX_FRAMES_PER_SECOND = 50;
/** Longest control message accepted (characters). The largest real one (join) is ~420. */
export const MAX_CONTROL_CHARS = 4096;
/** Active admissions per room; a QR is shown one at a time, this only bounds abuse. */
export const MAX_ADMISSIONS = 16;

export const DAY_MS = 86_400_000;
/** A device not seen for more than this many days is removed (RELAY-12). */
export const DEVICE_TTL_DAYS = 90;

export const BUFFER_TTL_MS = 10 * 60 * 1000;
/** One buffered row holds at most this many bytes of length-prefixed frames. */
export const BUFFER_ROW_BYTES = 256 * 1024;
/** Total buffered bytes per room. */
export const ROOM_BUFFER_BYTES = 25 * 1024 * 1024;
/** A batch is flushed this long after its last frame (the relay's only timer). */
export const FLUSH_DELAY_MS = 2000;

/** A socket whose last automatic pong is older than this is treated as offline (RELAY-10). */
export const LIVENESS_TIMEOUT_MS = 75_000;
