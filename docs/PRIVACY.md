# Privacy

The user-facing privacy policy is the website's Danish page `/privatliv` (`site/src/pages/privatliv.astro`, PRIV-02). This document is the engineering view of the same facts (spec section 12) and of how the code keeps them true.

## What data exists where

| Data                               | Where                                                                                        | How long                                     | Who can read it                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------- |
| Audio from the key                 | computer memory                                                                              | until transcribed                            | the user                                      |
| Audio from the phone               | phone memory; encrypted in transit; encrypted in the relay buffer if the computer is offline | until transcribed; buffer at most 10 minutes | the user's devices only                       |
| Text                               | history on the computer it was dictated to; never sent to the phone or other computers       | per retention setting (default 14 days)      | the user                                      |
| Text sent to AI cleanup            | the provider the user chose                                                                  | per that provider's terms                    | the provider                                  |
| Device public keys, room ids       | relay                                                                                        | until removed or 90 days unused              | the relay operator (meaningless on their own) |
| IP addresses, connection times     | Cloudflare, as processor for the relay operator                                              | Cloudflare's standard retention              | the relay operator                            |
| Website visits and phone app files | Cloudflare Pages (or the company's `PhoneAppUrl`)                                            | Cloudflare's standard logs; no analytics     | the site operator                             |
| Update checks                      | GitHub (release files and update manifests)                                                  | GitHub's retention                           | GitHub: IP address and app version            |
| Model downloads                    | Hugging Face, or the company's `ModelBaseUrl`                                                | their retention                              | Hugging Face: IP address                      |
| Shared word list                   | the company's `VocabularySource` server                                                      | the company's rules                          | the company                                   |

## How the code keeps it true

- **No telemetry** (PRIV-01): the app, the phone app and the website send no analytics, crash reports or usage data. A crash can only be reported by the user copying a report into a GitHub issue themselves.
- **Audio is not stored** (DESK-92): key dictations keep no recording unless "Gem lyd til fejlfinding" is on, and then for at most 7 days. The phone keeps audio in memory only (PHONE-33).
- **The relay cannot read anything** (spec 8, 9): it routes binary frames by their plaintext header; payloads are AES-256-GCM with per-direction keys that never leave the two devices. It logs only hashed room ids, close codes and counts (RELAY-13). The text itself never goes back to the phone (DESK-64).
- **The clipboard stays on this computer** (DESK-54): on macOS the text is written current-host-only, so Universal Clipboard does not send it to other Apple devices; on Windows it carries the formats that keep it out of Clipboard History and Cloud Clipboard. "Del med mine andre enheder" turns this off.
- **AI cleanup is off by default** (PRIV-04, DESK-80). When it is on, only the text (never audio) goes to the one provider the user chose, with the user's key from the OS keychain, after the consent text "Teksten (ikke lyden) sendes til <udbyder>, hver gang du dikterer." Each item shows exactly what was sent ("Vis hvad der blev sendt").
- **History at rest** (DESK-94): the history database is in the app data folder. It is encrypted at rest only if the computer's disk encryption (FileVault, BitLocker) is on.
- **Keys** (SEC-09, SEC-10): device keys and pair keys live in the macOS Keychain or Windows Credential Manager (local machine, never roaming); the phone's keys are non-extractable WebCrypto keys.

## Operator

The operator of the public relay and the website, the name in the privacy policy and the contact address, depend on the owner's decision 18.1 (the owner personally, or Navigent.io ApS). The website has one marked placeholder for it (`OPERATOR` in `site/src/lib/site.ts`). Contact: kontakt@walkietalkey.com (forwarded with Cloudflare Email Routing once the domain is set up).
