/** Error codes thrown by this package. Every failure of untrusted input is a ProtocolError. */
export type ProtocolErrorCode =
  | "bad_base64"
  | "bad_hex"
  | "bad_utf8"
  | "bad_length"
  | "bad_key"
  | "bad_label"
  | "bad_frame"
  | "bad_version"
  | "frame_too_large"
  | "wrong_recipient"
  | "wrong_sender"
  | "decrypt_failed"
  | "replay"
  | "bad_payload"
  | "bad_message"
  | "unknown_message"
  | "bad_pairing_url"
  | "bad_relay_url";

export class ProtocolError extends Error {
  readonly code: ProtocolErrorCode;

  constructor(code: ProtocolErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "ProtocolError";
    this.code = code;
  }
}
