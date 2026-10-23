# WalkieTalkey relay

The relay passes end-to-end encrypted frames between a computer and its paired phones. It is a
Cloudflare Worker plus one SQLite-backed Durable Object per room. It never sees audio, text,
device names, pair keys or the pairing secret `s`. Spec: section 8 of `docs/SPEC.md`; every byte
and message: `docs/PROTOCOL.md`.

## Deploy your own (RELAY-14)

You need a Cloudflare account (the free plan is enough for a family or a company) and
[bun](https://bun.sh).

```sh
cd relay
bun install
bunx wrangler login        # once
bunx wrangler deploy       # the one command
```

Wrangler prints the URL, for example `https://walkietalkey-relay.<your-subdomain>.workers.dev`.
Check it:

```sh
curl https://walkietalkey-relay.<your-subdomain>.workers.dev/v1/health
# {"ok":true,"service":"walkietalkey-relay","protocol":1}
```

Point the apps at `wss://walkietalkey-relay.<your-subdomain>.workers.dev` (managed setting
`RelayUrl`, Appendix B of the spec). To use your own domain, add a custom domain to the Worker in
the Cloudflare dashboard.

A deploy restarts every Durable Object and drops all sockets; clients reconnect with backoff and
resend open dictations, so deploy only on releases (RELAY-09, OSS-22).

## What it stores

Per room: the owner's device id and salt, the members' public signing keys and the day each was
last seen, SHA-256 hashes of pairing admissions (10 minutes, single use), pending
`member_joined`/`member_left` notices for an offline computer, and encrypted frames for an
offline recipient (at most 10 minutes, 25 MB per room). Phones unseen for 90 days are removed;
a room whose computer is unseen for 90 days is deleted.

Logs contain only hashed room ids, close codes and counts (RELAY-13). Cloudflare's invocation
logs, which would contain request URLs with raw room ids, are turned off in `wrangler.jsonc`.

## Limits

- Device frames up to 65,536 bytes (4413), 50 messages per second per socket (4429), 8 devices
  per room.
- Per IP: 10 `create` and 10 `join` connections per minute, checked in the Worker with the
  Workers Rate Limiting binding before any Durable Object runs. The binding is approximate and
  counts per Cloudflare location; a fast burst can get through about twice the limit before
  refusals start. That is fine for abuse protection.
- The two `namespace_id` values in `wrangler.jsonc` only need to be unique within your account.

## Cost

On the free plan a 15-second live phone dictation is about 4 billed requests and writes at most
one SQLite row (the daily last-seen); a dictation buffered for an offline computer writes a
handful. The public relay runs on Workers Paid (5 USD per month) so a busy day cannot switch it
off (spec 8.5).

## Develop

```sh
bun install
bun run test          # Vitest inside the Workers runtime (@cloudflare/vitest-plugin)
bun run typecheck     # regenerates worker-configuration.d.ts, then tsc
bun run dev           # local relay on http://127.0.0.1:8787 (ws:// for debug clients only)
bun scripts/smoke.ts --relay wss://<your relay>           # live end-to-end check
bun scripts/smoke.ts --relay wss://<your relay> --rate-limit
```

The smoke test creates a room, pairs a scripted phone, sends frames both ways, revokes the phone
and deletes the room again, so it leaves nothing behind.
