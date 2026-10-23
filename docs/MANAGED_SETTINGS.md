# Managed settings

Companies can configure WalkieTalkey centrally (spec 6.15, Appendix B). The app reads:

- **macOS**: managed preferences for the domain `com.walkietalkey.app`, deployed with a configuration profile (Jamf, Intune, Kandji, Mosyle and similar). Only values the profile *forces* count (`CFPreferencesAppValueIsForced`); `defaults write` by a user does not.
- **Windows**: `HKLM\SOFTWARE\Policies\WalkieTalkey` (Group Policy or Intune with the ADMX template). Strings are `REG_SZ`, booleans and numbers `REG_DWORD`.

The values are read once when the app starts (restart it after a change).

## One rule

Every managed value is locked. It wins over the user's own value, the setting shows a lock with "Styret af din organisation", and the app cannot change it. There is no separate list of locked keys. Invalid values (for example a relay URL that is not `wss://`) are ignored, logged, and not locked.

## Keys

| Key | Type | Default | Meaning |
|---|---|---|---|
| `RelayUrl` | string | `wss://relay.walkietalkey.com` (until that domain exists: `wss://walkietalkey-relay.jonathan0912.workers.dev`) | Your own relay (`wss://` only). See `relay/README.md` for the one-command deploy. |
| `PhoneAppUrl` | string | `https://app.walkietalkey.com` (until then: `https://walkietalkey-app.pages.dev`) | Your own copy of the phone app (`https://`), used in the pairing QR code. The phone app is plain static files (`phone/`). |
| `ModelBaseUrl` | string | our Hugging Face organisation | Your own model server (`https://`). Files are fetched from `<ModelBaseUrl>/<file name>` with the same file names and SHA-256 sums as `models/manifest.json`; Hugging Face is then never contacted. |
| `AllowPhonePairing` | bool | true | `false` turns the phone feature off (no relay connection). |
| `CleanupMode` | `off`, `when-needed`, `always`, `shift` | `off` | The AI cleanup mode. |
| `CleanupProvider` | `apple`, `openai`, `anthropic`, `groq`, `cerebras`, `openrouter`, `custom` | | Forces a provider. With a managed provider the user is not asked for consent: the organisation decided. |
| `AllowCloudCleanup` | bool | true | `false` allows only on-device cleanup (Apple Intelligence, or a `custom` endpoint on `localhost`). |
| `CleanupBaseUrl` | string | | For `custom` (`https://`, or `http://localhost`), for example a company Azure OpenAI deployment. |
| `CleanupModel` | string | | The model name at the provider. |
| `CleanupApiKey` | string | | Read at every start and never copied anywhere else (it lives only in memory). Profile and policy values can be read by every local user: use a key made for this purpose, with a spending limit. |
| `VocabularySource` | file path or `https://` URL | | A shared word list, one word per line, fetched at start and every day. It goes to the speech model with the user's own words (within the vocabulary budget). |
| `OutputMode` | `paste`, `clipboard` | `paste` | Key dictations: paste at the cursor, or only the clipboard. |
| `ShowTextInNotifications` | bool | true | `false` hides dictated text in notifications (shared screens, meetings). |
| `HistoryRetentionDays` | int | 14 | `0` = do not keep, `-1` = keep forever. A retention period is a maximum, so other values round down to the periods the app offers: `1` to `13` = one day, `14` to `89` = 14 days, `90` or more = 90 days. |
| `AutoUpdate` | bool | true | `false` turns update checks off; install updates yourself. |
| `UpdateChannel` | `stable`, `beta` | `stable` | |
| `Model` | model id | by hardware | Pins a speech model, for example `walkietalkey/edda-v0.2-gguf/edda-v0.2-Q8_0.gguf`. |

## Templates

- `deploy/windows/WalkieTalkey.admx` with `en-US` and `da-DK` ADML files: copy them into the Group Policy Central Store or import them into Intune (Administrative templates).
- `deploy/macos/com.walkietalkey.app.mobileconfig`: a sample profile; remove the keys you do not want to manage, sign it with your MDM and deploy.
- All three are generated from one table: `python3 deploy/windows/generate.py`.

## Running everything yourself

A company that wants nothing to pass infrastructure we run (PRIV-03) sets `RelayUrl` (its own relay on its own Cloudflare account), `PhoneAppUrl` (its own copy of `phone/`) and `ModelBaseUrl`, and turns `AutoUpdate` off. Update checks otherwise go to GitHub.
