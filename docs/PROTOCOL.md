# WalkieTalkey protocol v1

This document fixes every byte between a phone, the relay and a computer. It refines sections 5,
8 and 9 and Appendix C of `docs/SPEC.md`; where it adds or changes something, the change is
listed in [Clarifications and deviations](#clarifications-and-deviations).

| Part                                                                    | Where                                               |
| ----------------------------------------------------------------------- | --------------------------------------------------- |
| TypeScript implementation (WebCrypto only; browsers, Node 20+, Workers) | `packages/protocol/src/` (`@walkietalkey/protocol`) |
| Rust implementation (RustCrypto)                                        | `packages/protocol/rust/` (crate `wt-protocol`)     |
| Shared test vectors (SEC-05)                                            | `packages/protocol/test-vectors.json`               |
| Relay (Cloudflare Worker + Durable Object)                              | `relay/`                                            |
| Computer-side client                                                    | `crates/wt-relay-client/`                           |
| Scripted phone (tests)                                                  | `packages/protocol/scripts/scripted-phone.ts`       |

## 1. Encoding conventions

- `‖` is byte concatenation.
- Labels are their ASCII bytes, without a terminator: `wt-room-v1`, `wt-auth-v1`, `wt-create-v1`,
  `wt-join-v1`, `wt-pair-v1`, `wt-p2c-v1`, `wt-c2p-v1`, `wt-join-mac-v1`.
- Sizes: roomId 16 bytes, device id 16, session id 16, challenge 32, salt 16, admission secret
  `a` 32, pairing secret `s` 32, join MAC 32, signature 64, AES key 32, nonce 12, GCM tag 16.
- In JSON, every binary value is **base64url without padding** (RFC 4648 §5). Decoders are
  strict: only the URL alphabet, no `=`, no whitespace, a length that is not 1 mod 4, and zero
  unused trailing bits, so every byte string has exactly one text form.
- Public keys are P-256 **SubjectPublicKeyInfo DER with an uncompressed point, exactly 91
  bytes**, starting with
  `3059301306072a8648ce3d020106082a8648ce3d030107034200 04`. Nothing else is accepted (device
  ids hash this encoding, so two encodings of one key must not exist). Both implementations
  also check that the point is on the curve.
- Signatures are ECDSA P-256 with SHA-256 over the message, as **64-byte raw r‖s** (WebCrypto's
  format; Rust `Signature::to_bytes()`, never DER). Verifiers accept both low-S and high-S
  forms (the vectors contain both).
- Integers in frames are big-endian. JSON numbers are plain integers.
- JSON text is UTF-8, compact (`JSON.stringify` / `serde_json::to_string`), keys in the order
  given below. Decoders accept any key order and ignore unknown keys.

## 2. Keys and identifiers

Each device has a signing key pair (ECDSA P-256) and an agreement key pair (ECDH P-256). In
TypeScript the private keys are non-extractable `CryptoKey`s (SEC-09). The Rust side keeps the
32-byte scalars in the `KeyStore` (the desktop's secret store: a private folder on macOS, SEC-11; Credential Manager on Windows).

```
deviceId = SHA-256(signing SPKI)[0..16]
roomId   = SHA-256("wt-room-v1" ‖ owner signing SPKI ‖ salt)[0..16]        salt: 16 random bytes
```

Challenge answers sign `label ‖ roomId ‖ challenge` with label `wt-auth-v1`, `wt-create-v1` or
`wt-join-v1` (so a signature for one purpose never works for another).

## 3. Pair derivation (spec 9.3)

```
shared   = ECDH(own agreement private, peer agreement public)      32 bytes, the x coordinate
base     = HKDF-SHA256(ikm = shared, salt = s,
                       info = "wt-pair-v1" ‖ roomId ‖ computerId ‖ phoneId, L = 32)
k_p2c    = HKDF-SHA256(ikm = base, salt = "", info = "wt-p2c-v1", L = 32)     phone → computer
k_c2p    = HKDF-SHA256(ikm = base, salt = "", info = "wt-c2p-v1", L = 32)     computer → phone
mac_key  = HKDF-SHA256(ikm = s, salt = "", info = "wt-join-mac-v1", L = 32)
join_mac = HMAC-SHA256(mac_key, roomId ‖ phone signing SPKI ‖ phone agreement SPKI)
```

`salt = ""` is a zero-length HKDF salt, which RFC 5869 treats as 32 zero bytes. `computerId`
and `phoneId` are device ids. The phone learns `computerId` from the `ok` member list (the
member with role `owner`); the QR does not carry it. The computer verifies the join MAC in
constant time.

## 4. Pairing URL (spec 5.3)

```
<phoneAppUrl>/p#<base64url(UTF-8 JSON)>
JSON = {"v":1,"r":<roomId>,"a":<a>,"s":<s>,"e":<computer agreement SPKI>,"u":<relay URL>,"n":<computer name>,"o":"mac"|"win"}
```

Exactly these keys, in this order. `r`, `a`, `s`, `e` are base64url. `u` is the relay base URL
(`wss://...`, no path); the phone connects to `<u>/v1/rooms/<r>/ws`. `n` is at most 256 UTF-8
bytes. A trailing `/` on `phoneAppUrl` is dropped. Decoders accept any origin and path and read
everything after the first `#`; they refuse `v` other than 1, wrong lengths, a non-canonical
SPKI, `o` other than `mac`/`win`, and a `u` that is not `wss://` (`ws://` only to `localhost`,
`127.0.0.1` or `[::1]` when the caller allows it for debugging, SEC-06).

## 5. Transport

| Method                  | Path                                              |                                                               |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------- |
| GET                     | `/v1/health`                                      | `200 {"ok":true,"service":"walkietalkey-relay","protocol":1}` |
| GET (WebSocket upgrade) | `/v1/rooms/{roomId}/ws?intent=auth\|create\|join` | one device in one room                                        |

- `roomId` is 22 characters of base64url (16 bytes). A malformed id is closed with 4404 by
  the Worker without touching a Durable Object. A plain GET on the socket path answers 426, an
  unknown `intent` 400, anything else 404.
- `intent` (default `auth`) declares what the first message will be. The Worker applies the
  per-IP limits to `create` and `join` before any Durable Object is touched (RELAY-11), and the
  object refuses a handshake message that differs from the declared intent with 4403.
- Refusals in the Worker (rate limit, malformed id) accept the upgrade and close at once, so a
  browser sees a close code instead of a failed handshake.
- Text WebSocket messages are control messages (section 6), binary messages are device frames
  (section 8).
- Ping: every client sends exactly the text `{"t":"ping"}` every 30 s; the relay answers exactly
  `{"t":"pong"}` without waking the object (`setWebSocketAutoResponse`). Byte-exact: any other
  spelling reaches the object (and is answered there).
- The computer treats a ping not answered within 10 s as a dead connection.

## 6. Control messages (Appendix C.1)

Every control message is a JSON object with its type in `t`, first. At most 4,096 characters.

| `t`                | Direction               | Fields (in this order)                                                     | Notes                                                                 |
| ------------------ | ----------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `challenge`        | relay → device          | `n` (32 bytes)                                                             | first message on every accepted socket                                |
| `auth`             | member → relay          | `id` (16), `sig` (64)                                                      | sig over `wt-auth-v1 ‖ roomId ‖ n`                                    |
| `create`           | owner → relay           | `pub` (SPKI), `salt` (16), `sig` (64)                                      | sig over `wt-create-v1 ‖ roomId ‖ n`                                  |
| `join`             | phone → relay           | `a` (32), `pub` (SPKI), `agree` (SPKI), `mac` (32), `sig` (64)             | sig over `wt-join-v1 ‖ roomId ‖ n` with the key in `pub`              |
| `ok`               | relay → device          | `role` (`owner`\|`phone`), `members` (`[{id, role, online, lastSeenDay}]`) | includes the device itself; `lastSeenDay` = days since 1970-01-01 UTC |
| `add_admission`    | owner → relay           | `h` (32, SHA-256 of `a`), `exp` (unix ms)                                  | answered with `ack`                                                   |
| `cancel_admission` | owner → relay           | `h` (32)                                                                   | answered with `ack`                                                   |
| `member_joined`    | relay → owner           | `id`, `pub`, `agree`, `mac`, `eid`                                         | `eid`: event id, see `event_ack`                                      |
| `member_left`      | relay → owner           | `id`, `eid`                                                                |                                                                       |
| `event_ack`        | owner → relay           | `eid`                                                                      | **extension**: the relay deletes that owner event                     |
| `ack`              | relay → owner           | `op` (`add_admission`\|`cancel_admission`\|`revoke`), then `h` or `id`     | **extension**                                                         |
| `leave`            | phone → relay           |                                                                            | relay closes the phone's sockets with 1000                            |
| `revoke`           | owner → relay           | `id` (16)                                                                  | answered with `ack`                                                   |
| `delete_room`      | owner → relay           |                                                                            | relay closes phones with 4404, the owner with 1000                    |
| `peer`             | relay → device          | `id`, `online`                                                             | phones hear about the owner, the owner about phones                   |
| `error`            | relay → device          | `code` (≤ 64 chars), `msg` (≤ 512 chars)                                   | codes in section 10                                                   |
| `ping` / `pong`    | device → relay → device |                                                                            | exact strings, section 5                                              |

Examples (from the test vectors): `{"t":"member_left","id":"fp8EAmIZWEEo2jlk_9k54w","eid":2}`,
`{"t":"ack","op":"revoke","id":"fp8EAmIZWEEo2jlk_9k54w"}`, `{"t":"ping"}`.

Parsers drop unknown fields and reject unknown types (`unknown_message`), wrong field types and
binary fields of the wrong length (`bad_message`).

## 7. Sessions with the relay

### 7.1 Create (first connection of a computer)

1. The computer picks a random 16-byte salt, computes `roomId`, **persists room id and salt**,
   then connects with `intent=create`.
2. If the room already exists the relay closes with 4409 right away (before `challenge`). The
   computer then marks the room as created and authenticates: this happens when an earlier
   `create` succeeded but its `ok` was lost.
3. Otherwise: `challenge` → `create` → the relay checks that the room has no devices, that
   `roomId = SHA-256("wt-room-v1" ‖ pub ‖ salt)[0..16]` (else 4401) and the signature (else
   4401), creates the tables, stores the owner and answers `ok` with role `owner`.

### 7.2 Auth (every later connection)

`intent=auth` (or none). An unknown room is closed with 4404 before `challenge` and nothing is
written. Then `challenge` → `auth`; an unknown device id or a bad signature closes with 4401.
On success the relay sends, in this order: `ok`; to the owner, every pending owner event
(`member_joined` / `member_left`, oldest first); every buffered frame for this device (oldest
first); and it sends `peer {online: true}` to the other side.

When `auth` of the **computer** is answered with 4404 (or 4401), the relay has forgotten the
room (90 days unseen, spec 5.4): the computer deletes all phones and counters, creates a new
room with a new salt, and reports `RoomReset`. A phone that gets 4404 or 4401 drops that
pairing (PHONE-14).

### 7.3 Join (a phone scans the QR)

`intent=join`, `challenge` → `join`. The relay verifies the signature with `pub` (4401), the
agreement key (`bad_key`, 1008), that the room exists (4404), that the phone is not the owner
(4403), that the room has fewer than 8 devices unless the phone is already a member
(`room_full`, 4403), and that SHA-256(`a`) matches a stored, unexpired admission (4401). Only
then it deletes the admission (single use), stores the phone, stores a `member_joined` owner
event, sends it to the owner if online, and answers the phone with `ok` (role `phone`). The
relay never checks the MAC.

If a phone's `join` socket is closed with 4401 after it sent `join`, the join may have succeeded
with the `ok` lost; the phone then tries `auth` once.

### 7.4 Owner events

`member_joined` and `member_left` are stored in `owner_events` and delivered on every owner
`auth` until the owner answers `event_ack {eid}`. Delivery is at least once. The computer
first checks a `member_joined` against its open pairing codes: a join MAC that verifies is a
new pairing, also for a phone that is paired already with the same device keys (it re-pairs:
new pair keys, counters from 1). Only when no open code verifies and the agreement key is the
one already stored is the event a re-delivery, ignored quietly.

### 7.5 Pairing on the computer

`start_pairing`: cancel any earlier code, draw `a` and `s` (32 random bytes each), send
`add_admission {h: SHA-256(a), exp: now + 10 min}`, wait for `ack`, return the pairing URL. `s`
stays in memory only. On `member_joined`: check that `id` = deviceId(`pub`), find the pending
`s` whose join MAC verifies, derive `k_p2c`/`k_c2p`, persist the phone, reset its counters,
forget `s`, and announce `PhonePaired` when the phone's `device_info` arrives or after 3 s
without a name (DESK-62). A MAC that verifies with no pending `s` makes the computer revoke the
phone and report `PhoneRejected` (SEC-03); for a phone that is already paired, a failed re-pair
is reported but the existing pairing is kept. The relay deletes unused admissions at expiry;
the computer reports `PairingExpired`.

## 8. Device frames (spec 9.4)

```
offset  size  field
0       1     version = 0x01
1       1     type (8.2)
2       16    sender device id
18      16    recipient device id
34      8     counter, uint64 big-endian, >= 1
42      12    nonce, random
54      n+16  AES-256-GCM(key, nonce, plaintext, aad = bytes 0..42) = ciphertext ‖ tag
```

- The 42-byte AAD covers version, type, sender, recipient and counter; changing any byte of the
  frame makes decryption fail.
- Frame size: at least 70 bytes (empty plaintext), at most **65,536 bytes**, so the plaintext is
  at most 65,466 bytes and 10 full PCM blocks (64,020 bytes of payload) fit.
- Key: `k_p2c` for phone → computer, `k_c2p` for computer → phone.
- Example (vector `audio_start`): `01 20 7e9f…f0e3` (sender) `f04750f0…a604` (recipient)
  `0000000000000003` (counter) `2c27c6f0be93dfb8197b7720` (nonce) … 143 bytes in total.

### 8.1 Receiving

In this order: parse (version 1, 70 ≤ length ≤ 65,536); the recipient must be this device
(`wrong_recipient`); the sender must be the paired peer (`wrong_sender`); the counter must be
higher than the last accepted one from that sender (`replay`); decrypt with the direction key
(`decrypt_failed`); persist the counter; the type must be one this direction carries
(`bad_payload`); decode the payload. Failed frames are dropped silently.

### 8.2 Payloads (Appendix C.2)

| Type | Name                   | Direction        | Plaintext                                                                                  |
| ---- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------ |
| 0x10 | `device_info`          | phone → computer | `{"name":…,"platform":…}`; name ≤ 256 UTF-8 bytes, platform ≤ 32 (`ios`, `android`, `web`) |
| 0x11 | `presence`             | computer → phone | `{"secondsSinceInput":u32,"locked":bool}`; only as an answer to 0x12                       |
| 0x12 | `presence_query`       | phone → computer | `{}`                                                                                       |
| 0x20 | `audio_start`          | phone → computer | `{"sessionId":…,"sampleRate":16000,"codec":"pcm16"}` (other values are refused)            |
| 0x21 | `audio_chunk`          | phone → computer | binary: sessionId (16) ‖ firstIndex (uint32 BE) ‖ PCM16 little-endian mono 16 kHz          |
| 0x22 | `audio_end`            | phone → computer | `{"sessionId":…,"chunks":u32,"durationMs":u32}`                                            |
| 0x23 | `audio_cancel`         | phone → computer | `{"sessionId":…}`                                                                          |
| 0x24 | `audio_start_training` | phone → computer | `audio_start` + `"training":…,"prompt":…` and optionally `"microphone":…` (8.4)            |
| 0x30 | `result`               | computer → phone | `{"sessionId":…,"ok":true}` or `{"sessionId":…,"ok":false,"reason":…}`; never text         |
| 0x31 | `training_prompt`      | computer → phone | `{"training":…,"style":…,"done":u32,"total":u32,"next":{…}?,"last":{…}?}` (8.4)            |
| 0x32 | `training_end`         | computer → phone | `{"training":…}` (8.4)                                                                     |

- A 200 ms block is 3,200 samples = 6,400 bytes. An `audio_chunk` carries 1 to 10 consecutive
  blocks starting at block `firstIndex`; every block is 6,400 bytes except the session's very
  last block, which may be shorter (an even number of bytes, at least 2). `chunks` in
  `audio_end` is the number of blocks; `durationMs` = samples / 16.
- `reason` is one of `no_speech`, `model_not_ready`, `too_long`, `paused`, `error`; a decoder
  maps any other reason to `error` (forward compatibility). `ok: true` with a reason, or
  `ok: false` without one, is refused.

### 8.3 Streaming and resending (PHONE-31, PHONE-32, DESK-61)

The phone sends `audio_start`, one `audio_chunk` per 200 ms block while recording, then
`audio_end`. It keeps every block in memory until the session's `result` arrives. After a
reconnect it resends the whole session: `audio_start`, chunks of up to 10 blocks, at most 25
frames per second, `audio_end`, each frame re-encrypted with a fresh counter and nonce (old frames
are never replayed). It also resends every open session that has not failed when the relay sends
`peer {online: true}` for the computer: a computer's socket that went quiet still counts as live
for up to 75 s (RELAY-10), so frames routed to it in that time are lost. A resend asked for while
one is running runs once more afterwards. The computer keys blocks by (phone, session, block
index), drops duplicates, reports missing indices with `audio_end` and keeps delivering late
blocks; the application waits up to 5 s for them (DESK-61). The computer remembers answered
sessions for 15 minutes and answers a resend of one with the same result instead of
transcribing it twice.

### 8.4 Training takes (run 5; DESK-65, PHONE-50, PHONE-51, PRIV-05)

The fine-tuning workbench (`wt-train record`, `training/`) records sentences on the phone through
the dictation path. The recorder on the computer hands its session to the running app, which
sends the sentence to the session's phone; the phone records it and sends it back as a take. It is
the one deliberate exception to "text never goes back to the phone" (spec 12.1): only the
recorder's sentences, only while its session runs, inside the end-to-end encryption.

```
0x24 audio_start_training (phone → computer)
{"sessionId":…,"sampleRate":16000,"codec":"pcm16","training":…,"prompt":"s0042","microphone":"iPhone-mikrofon"}

0x31 training_prompt (computer → phone)
{"training":…,"style":"whisper","done":12,"total":416,
 "next":{"prompt":"s0043","text":"Kan du deploye til staging?"},
 "last":{"prompt":"s0042","text":"Vi merger PR'en, når buildet er grønt.","check":"quiet"}}

0x32 training_end (computer → phone)
{"training":…}
```

- `training` is the session's id, 16 random bytes (base64url). `prompt` is the recorder's id of
  a sentence (1 to 64 UTF-8 bytes), `text` 1 to 4,096 bytes, `microphone` the phone's track
  label (1 to 128 bytes, left out when unknown). `style` is `normal` or `whisper`. `next` is left
  out when the condition is complete, `last` before the first take. `check` is one of `ok`,
  `quiet`, `clipped`, `short`, `silent`, `gaps`, `error`; a decoder maps any other value to
  `error`, like result reasons. Keys in this order; decoders ignore unknown keys.
- A training take's blocks, end and cancel are the ordinary 0x21 to 0x23, with the same
  resending (8.3); every start of it, resends included, is 0x24. The computer tracks it in the
  same session tracker, so its blocks never start a dictation implicitly, and answers with an
  ordinary `result`: `ok` when the recorder kept the take (a failed check is shown with the next
  prompt and offered for a redo), `no_speech` for a silent take, otherwise `error`. A take of no
  running session gets `error` at its end, and the phone gets `training_end`.
- The computer sends the current prompt when the recorder moves on, and again when the phone
  comes online (`peer`) or the computer's own connection is new; `training_prompt` is never
  queued while offline.
- A new frame type rather than a flag in `audio_start`: JSON decoders ignore unknown keys, so an
  older desktop would transcribe a flagged take and paste it. An older desktop drops 0x24, but
  it would still start a dictation implicitly from the take's 0x21 blocks; so the phone sends a
  training take only to a computer that sent the prompt on the current connection (PHONE-51:
  when the computer goes offline, or the phone's connection drops or is new, the prompt goes
  stale until the computer sends it again). What is left is a take sitting in the relay buffer
  while the computer is replaced by an older version within those 10 minutes.
- An older phone drops 0x31 and 0x32 (unknown types, 8.1) and keeps working; its counter still
  advances.
- The relay needs no change: it routes by the header and reads only the type byte, to flush a
  buffered batch on 0x22 and 0x23, which training takes use too.

## 9. Counters (spec 9.4)

- Counters are per (sender, recipient) and start at 1. Store keys: `<sender b64u>><recipient b64u>`;
  the Rust `KeyStore` prefixes them with `send:` (end of the reserved block) or `recv:` (last
  accepted).
- **Sending:** the stored value is the end of the last reserved block (0 if none). On start the
  next number is `stored + 1`, with nothing reserved yet. Before using a number beyond the
  reserved end, the sender writes `next + 999` and waits for it to be durable. So a restart
  starts a new block and a crash can skip numbers but never reuse one. Example: 1 (stores 1000)
  … 1000, 1001 (stores 2000); restart; 2001 (stores 3000).
- **Receiving:** a frame is accepted only if its counter is higher than the stored last
  accepted counter of that sender; the new value is stored for every accepted frame.
- A new pairing derives new keys, so its counters start at 1 again; frames under the old keys
  cannot decrypt.

## 10. Close codes and error codes

| Code | Meaning          | When                                                                                                                                                                       |
| ---- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4401 | not authorised   | message before auth; unknown member; bad signature; wrong room binding on create; invalid or used admission; revoked phone (its open sockets are closed with 4401 at once) |
| 4403 | not allowed      | wrong role for the command; handshake message ≠ declared intent; sender id ≠ socket's device; phone addressing anyone but the owner; owner addressing itself; room full    |
| 4404 | room not found   | auth/join to an unknown room; malformed room id; room deleted (phones on `delete_room` and on housekeeping)                                                                |
| 4409 | room exists      | create intent for an existing room                                                                                                                                         |
| 4413 | frame too large  | binary message > 65,536 bytes; text message > 4,096 characters                                                                                                             |
| 4429 | rate limited     | > 50 messages per second on one socket; per-IP create/join limit in the Worker; a 33rd socket in one room                                                                  |
| 1000 | normal           | `leave`; the owner's socket after `delete_room`                                                                                                                            |
| 1001 | going away       | the relay closed a socket that went quiet for more than 75 s (RELAY-10), or one that did not authenticate within 30 s                                                      |
| 1008 | policy violation | malformed control message or frame; invalid agreement key in `join`                                                                                                        |

Before closing for a reason of its own, the relay sends `error {code, msg}` with one of:
`not_authenticated`, `not_member`, `bad_signature`, `room_binding`, `room_exists`,
`room_not_found`, `admission_invalid`, `room_full`, `intent_mismatch`, `not_allowed`,
`wrong_sender`, `revoked`, `bad_message`, `bad_frame`, `bad_key`, `frame_too_large`,
`rate_limited`. Without closing it sends `buffer_full`, `admission_expired` and
`too_many_admissions`.

## 11. Relay behaviour

### 11.1 Storage (spec 8.3)

One SQLite-backed Durable Object per room, named by the base64url room id.

| Table                        | Columns                                                         |
| ---------------------------- | --------------------------------------------------------------- |
| `room`                       | owner_device_id, salt, created_at                               |
| `devices` (WITHOUT ROWID)    | device_id PK, signing_public_key, role, added_at, last_seen_day |
| `admissions` (WITHOUT ROWID) | admission_sha256 PK, expires_at                                 |
| `owner_events`               | id, kind, payload (JSON: id, pub, agree, mac), created_at       |
| `buffered`                   | id, recipient_device_id, frames (BLOB), expires_at              |

Ids and keys are stored as base64url text. No table exists until `create` succeeds, so a random
room id costs nothing. `last_seen_day` is written at most once per device per day: on a
successful auth, and in the housekeeping alarm for devices that are connected. A live dictation
therefore writes no row, or one (the daily last-seen of a phone that connects for it).

### 11.2 Socket state

Hibernation API. Each socket's attachment (JSON, at most ~150 bytes, limit 2,048):
`{v:1, st:"p"|"a", rm:<roomId>, in:<intent>, ch?:<challenge>, at:<connect ms>, id?:<device>, ro?:<role>}`.
In memory only (harmless to lose on hibernation): the per-socket token bucket, the time of the
last message, the members cache and the unflushed buffer batches (the object never hibernates
with a batch, because the flush timer is pending).

### 11.3 Routing (RELAY-07) and liveness (RELAY-10)

A frame's sender must equal the socket's device (4403). A phone may only address the owner
(4403); the owner may address any phone; frames for non-members are dropped. A device may have
several sockets; a frame goes to each of the recipient's live sockets. A socket is live while
`max(auto-response timestamp, connect time, last message) ≥ now − 75 s`; when routing finds only
quiet sockets it closes them (1001), buffers the frame and sends `peer {online:false}` to the
other side. `peer` is also sent when a device authenticates and when its last socket closes.

### 11.4 Buffering (RELAY-08)

Frames for an offline recipient are appended to an in-memory batch per recipient. A batch is
written as one `buffered` row when the next frame would take it past 262,144 bytes, on
`audio_end` or `audio_cancel` (the frame type is in the plaintext header), when a sender of the
batch disconnects, and 2 s after the batch's last frame. Row format: frames concatenated, each
prefixed with its length as uint32 big-endian. A row expires 10 minutes after its first frame.
When the recipient authenticates it gets the unexpired rows in order, then the unflushed batch,
and the delivered rows are deleted. Above 25 MB in a room, the oldest buffered dictations are
dropped whole: the oldest rows up to and including the first row that ends a dictation, and
only then is the fit checked again (repeated until the new row fits), so no dictation is left
without its beginning. The senders of the dropped rows (sender id, bytes 2..18 of each frame)
get `error buffer_full`. Buffering works in both directions (a `result` for an offline phone
waits too).

### 11.5 Limits (RELAY-11)

Device frames ≤ 65,536 bytes (4413); 50 messages per second per socket, token bucket with a
burst of 50, counting every message that reaches the object (4429); 8 devices per room; at most
32 open sockets per room, authenticated or not (a 33rd is accepted and closed at once with 4429);
a socket that has not authenticated 30 s after connecting is closed with 1001 (checked when a
socket connects and when a message arrives); at most 16 open admissions per room; `exp` of an
admission is clamped to now + 10 minutes. Per IP: 10
`create` and 10 `join` connections per minute through the Workers Rate Limiting binding (keyed
by SHA-256 of the IP), checked in the Worker before any Durable Object.

### 11.6 Housekeeping (RELAY-12)

One alarm per room, set to the earliest pending expiry: an admission's or buffer row's
`expires_at`, or a device's `(last_seen_day + 91) × 86,400,000` ms (the first moment it has been
unseen for more than 90 days). The alarm is only moved earlier (each `setAlarm` is a billed
write); the handler deletes what expired, removes phones unseen for 90 days (queuing
`member_left` for the owner and closing their sockets with 4401), deletes the whole room if the
owner is unseen for 90 days (phones then get 4404), and re-arms itself.

### 11.7 Logs (RELAY-13)

Only JSON lines with a room tag (`hex(SHA-256("wt-log-v1:" ‖ roomId base64url))[0..12]`), an
event name, close codes and counts. No payloads, device ids, keys, IP addresses or raw room ids.
Cloudflare's invocation logs (which contain request URLs) are disabled in `wrangler.jsonc`.

## 12. Computer client behaviour (DESK-60 to DESK-64)

`crates/wt-relay-client`: one socket per room, `wss://` only (`ws://localhost` only in debug
builds or with the `insecure-localhost` feature, SEC-06); create on the first connection, auth
afterwards; ping every 30 s; reconnect after 1, 2, 5, 10, 30, 30… s (reset after a successful
auth) and at once on `reconnect_now()` (wake, network change). Results are queued while offline
(at most 64) and sent after the next auth. Presence is sent only as the answer to a pending
`presence_query`. Ten seconds after connecting, phones the relay lists that have no keys on the
computer are revoked (a revoke that was lost while offline). `send_training` carries a
`training_prompt` or `training_end` to one phone, never queued (8.4).

## 13. Test vectors (SEC-05)

`packages/protocol/test-vectors.json` holds fixed device keys (as P-256 scalars and PKCS#8),
the room id preimage and value, challenge signatures (valid, high-S, wrong label, tampered),
every pairing derivation (`shared`, `pairInfo`, `base`, `k_p2c`, `k_c2p`, `mac_key`,
`macInput`, `join_mac`), the pairing URL, one or more sealed frames for every frame type with
their nonces, counters, plaintexts and decoded payloads, invalid frames with the expected error,
every control message in its canonical serialization, and the counter-reservation steps. The
training frames (8.4) come after the others, so every earlier vector kept its nonce and bytes. Binary
values are lowercase hex; counters are decimal strings. All inputs are derived from fixed labels
(`SHA-256("wt-test-vectors/<label>")`) and signatures are RFC 6979, so the file is reproducible:

```sh
cd packages/protocol/rust
cargo run --example gen_test_vectors --features test-utils
cargo test                       # also fails if the committed file is stale
cd .. && bun run test            # the TypeScript side checks every vector
```

Fixed nonces and private-key import exist only in test code: `src/testing.ts` (TypeScript) and
the `test-utils` feature (Rust).

## 14. Test tooling

- `bun packages/protocol/scripts/scripted-phone.ts stream --url '<pairing url>' --wav f.wav`
  pairs, streams a 16 kHz mono PCM16 WAV in real time and waits for the result.
- `scripted-phone.ts --stdio` reads one JSON command per line and writes JSON lines:
  events `{"event":…}` and replies `{"reply":<cmd>,"id":…,"ok":…}`. Commands: `pair {url,
corruptMac?, skipDeviceInfo?}`, `connect`, `stream {wav, fps?, dropAfter?}`, `resend
{sessionId}`, `reconnect {resend?}`, `drop`, `wait_result {sessionId, timeoutMs?}`,
  `presence {timeoutMs?}`, `leave`, `wait_closed`, `quit`.
- `relay/scripts/smoke.ts` runs a full live check against a relay and cleans up after itself.

## Clarifications and deviations

1. **Connection intent.** The Worker only sees the upgrade request, so clients declare
   `?intent=auth|create|join` (default `auth`). The Worker rate-limits `create` and `join` per
   IP before any Durable Object runs; the object closes a handshake message that differs from
   the intent with 4403. An unknown room is refused with 4404 and an existing room with intent
   `create` with 4409 before the challenge (fewer messages, still no writes).
2. **`ack`** (relay → owner, not in C.1) confirms `add_admission`, `cancel_admission` and
   `revoke`, so the computer shows a QR only once the relay has the admission.
3. **`eid` and `event_ack`** (not in C.1): owner events are "held until the owner has received
   them" by explicit acknowledgement, because a WebSocket send does not prove receipt (a
   sleeping laptop's socket can look open).
4. **Close codes outside C.3:** 1000 (leave; the owner after `delete_room`), 1001 (quiet socket,
   RELAY-10), 1008 (malformed message or frame). Room full is 4403 with `error room_full`.
   Revoked phones' open sockets close with 4401.
5. **Members in `ok`** include the device itself; `lastSeenDay` is days since the Unix epoch
   (UTC). The phone learns the computer's device id (needed for the pair keys) from this list.
6. **Last-seen writes** happen on auth/create/join and in the alarm, never per frame; so "a live
   dictation writes at most one row" means: zero rows, or one when the phone's connection is its
   first of the day.
7. **Per-socket rate limit** counts every message that reaches the object (control and frames),
   as a token bucket of 50 per second with a burst of 50. Its state is in memory rather than in
   the attachment: an object only hibernates after seconds without traffic, when the bucket is
   full anyway.
8. **Liveness** uses the newest of the auto-response timestamp, the connect time and the last
   message, so a socket that just connected or is busy streaming is not treated as asleep.
9. **Buffer details** the spec leaves open: row format (length-prefixed frames), expiry 10
   minutes after a row's first frame, "oldest dictation" = oldest rows up to the first row that
   contains an `audio_end`/`audio_cancel` (the fit is checked only after such a row),
   `buffer_full` goes to the senders of the dropped rows, and buffering applies in both
   directions.
10. **Several sockets per device** are allowed; frames go to every live one.
11. **Admissions:** `exp` is clamped to now + 10 minutes; an `exp` in the past gets
    `error admission_expired`; at most 16 open admissions per room. A join by a device that is
    already a member is allowed (re-pairing): it uses the admission and produces a new
    `member_joined`.
12. **Housekeeping** also tells the owner (`member_left`) about a phone removed after 90 days, so
    its keys are deleted on the computer.
13. **Strict encodings** in both implementations: canonical base64url and the single 91-byte
    SPKI form (section 1). JSON decoders ignore unknown keys; unknown `result` reasons decode as
    `error`; numeric fields are uint32.
14. **Counters reset on re-pairing** (new pair keys), and receivers check that a payload type
    belongs to the direction it arrived from.
15. **One pairing code at a time** on the computer; `start_pairing` cancels the previous code.
    `s` lives in memory only, so after a restart a join cannot be verified and is refused
    (`PhoneRejected { NoPairingInProgress }`).
16. **Answered sessions are remembered** for 15 minutes; a resend of one gets the same result
    again instead of a second transcription.
17. **Reconciliation:** 10 s after connecting, the computer revokes phones the relay lists but
    the computer has no keys for (for example a revoke issued while offline).
18. **A failed re-pair of a known phone** (bad MAC) is reported but does not remove the existing
    pairing, so a forged `member_joined` cannot unpair a phone.
19. **The computer treats 4401 on its own auth like 4404**: the relay does not accept it as the
    room's owner, so it creates a new room.
20. **Rate Limiting binding:** accepted and enforced on the owner's free Workers plan, so no
    limiter Durable Object was needed. Enforcement is approximate and eventually consistent:
    from one IP, a quick burst of `create` intents was first refused at attempt 25, after which
    most attempts were refused. The spec accepts this ("approximate ... fine for abuse
    protection").
21. **Test runner:** `@cloudflare/vitest-pool-workers` has been renamed to
    `@cloudflare/vitest-plugin` (same project); the relay tests use the new name. `wrangler.jsonc`
    has a local-only `integration` environment with per-IP limits of 1,000 per minute for the
    Rust integration tests; it is never deployed.
22. **Dependencies:** the Rust protocol crate uses `base64`, `thiserror`, `zeroize` and `subtle`
    besides the RustCrypto crates (no home-made crypto), and the RustCrypto generation that
    matches `sha2 0.11` (p256 0.14, hkdf/hmac 0.13, aes-gcm 0.11, getrandom 0.4; run 3, for
    RUSTSEC-2026-0387). The move from p256 0.13 changed no byte: the committed test vectors
    regenerate identically.
23. **Frames for non-members:** spec 9.4 mentions 4403 for a recipient that is not a member,
    while RELAY-07 says such frames are dropped. The relay drops the owner's frames for
    non-members silently and closes with 4403 when a phone addresses anyone but the owner or a
    sender id is wrong.
24. **Counter persistence frequency:** the receiver stores its last accepted counter for every
    frame (5 per second while streaming). The desktop `KeyStore` should keep counters in a plain
    file, not the secret store; only device keys and pair keys are secret.
25. **Training frames (run 5, 8.4):** 0x24, 0x31 and 0x32 are additions to Appendix C.2. The design
    note of run 4 said a desktop without training support simply drops a training take; it drops
    the 0x24 start, but the client's implicit start (a lost `audio_start`) would make the take's
    blocks a dictation. The phone's rule (PHONE-51) closes that: a take only goes to a computer
    that sent the prompt on the current connection. `audio_start_training` also carries the
    prompt's id (so a take is always tied to the sentence it reads, even when the recorder has
    moved on) and the microphone's name (clip metadata).
