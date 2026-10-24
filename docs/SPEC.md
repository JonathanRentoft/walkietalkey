# WalkieTalkey: system specification

Version 0.3 (reviewed draft) · 23 October 2026 · Owner: Jonathan

This document describes everything WalkieTalkey must do before any code is written. It is the source of truth for behaviour. The WalkieTalkey design system (brand kit artifact) is the source of truth for how things look. Code, docs and commit messages are in English. Every word a user sees is in Danish (Appendix A).

Requirement IDs (DESK-, PHONE-, RELAY-, SEC-, SITE-, PRIV-, OSS-) are referenced from tests and pull requests. "Must" is required for the milestone named; "should" is wanted but may slip.

---

## 1. The product in one paragraph

WalkieTalkey is free, open-source Danish dictation. Hold `fn` on a Mac (or a chosen key on Windows), talk, let go, and the text appears where you are typing. Or hold the big button in the phone app, talk, let go, and the text lands on the computer you are sitting at, on the clipboard with a small notification: "Tekst klar til at indsætte". Speech becomes text on the user's own computer with a Danish speech model. The phone only records and sends encrypted audio through a relay that cannot read it. There are no accounts.

## 2. Principles (non-negotiable)

1. **No accounts.** No email, no passwords, no magic links, no OAuth. Devices trust each other by pairing (section 5).
2. **Speech becomes text on the user's own computer.** No cloud transcription, ever. AI cleanup is optional and off by default. When it is on, it is the only network call in a dictation: the text goes straight from the user's computer to the provider the user chose, with the user's own key. WalkieTalkey ships no API key and runs no server in between.
3. **Free for everyone, companies included.** Apache-2.0. Paid help with setup is a service, never a licence.
4. **A free user costs nothing to run.** No per-user servers, no paid APIs on our side. The public relay has one fixed cost, Cloudflare Workers Paid at 5 USD per month (section 8.5, decision 18.6), because a free-tier limit stops the relay for everyone until midnight UTC. A self-hosted relay for a company or a family fits the free tier.
5. **Danish first.** Danish model, Danish UI, Danish punctuation, Danish defaults. Mixed Danish and English speech is a first-class case.
6. **Only claims that are true.** Marketing and UI may only say:
   - "Talen bliver til tekst på din egen computer."
   - "Krypteret fra telefon til computer." Never "direkte", because audio passes an encrypted relay.
   - "Ingen konto."
   - "Ingen sporing." The app has no analytics or telemetry of any kind.
   - AI cleanup is optional; when on, the UI says exactly what is sent where.
7. **Calm.** Everything follows the design system: one living surface per screen, slow motion, reduced motion respected.

## 3. Scope

### 3.1 In scope for v1.0

| Part | What |
|---|---|
| Desktop app | macOS (Apple Silicon first-class, Intel best effort) and Windows 10/11 x64. Tauri v2, Rust, React. |
| Phone app | Web app (PWA) for iPhone and Android, plus a thin native iOS shell (section 7.1). |
| Relay | Cloudflare Worker with one Durable Object per pairing room. Self-hostable. |
| Website | walkietalkey.com, static, built from the design system. |
| Models | Danish speech model (Edda) and punctuation model (Ekko PnC), converted and hosted with checksums. |
| Open source | Public repo, releases, signing, updates, docs, contribution flow. |

### 3.2 Out of scope for v1.0

- Accounts, user database, web dashboard, admin console.
- Cloud transcription of any kind.
- Linux as a supported platform (it builds, but we do not test or promise it).
- Native Android app (the PWA works well on Android).
- English UI (strings are prepared for it; translation comes later).
- On-premise relay outside Cloudflare (planned for v1.x, see RELAY-15).

### 3.3 Minimum requirements

- macOS 13 Ventura or newer. Apple Intelligence cleanup needs macOS 26 and Apple Silicon.
- Windows 10 22H2 or Windows 11, x64.
- 8 GB RAM, about 2 GB free disk for models.
- iOS 17 or newer, Android 10 or newer with Chrome.

## 4. System overview

```
 ┌──────────────┐  hold fn                     ┌───────────────────────────────┐
 │  Keyboard    │ ───────────────────────────▶ │  Desktop app (Tauri, Rust)    │
 └──────────────┘                              │  VAD → Edda (transcribe.cpp)  │
                                               │  → punctuation → vocabulary   │
 ┌──────────────┐  encrypted audio frames      │  → optional AI cleanup        │
 │  Phone app   │ ──────┐               ┌────▶ │  → paste or clipboard+notice  │
 │  (PWA / iOS) │ ◀─────┼─── result ────┼───── │  keys in OS keychain          │
 └──────────────┘       ▼               │      └───────────────────────────────┘
               ┌──────────────────────────┐
               │ Relay: Cloudflare Worker │  sees only room ids, device public keys,
               │ + Durable Object / room  │  IP addresses, timing and sizes.
               └──────────────────────────┘  Never audio or text in the clear.
```

### 4.1 Repository layout (monorepo)

WalkieTalkey's own features live in their own folders and modules (DESK-05).

```
walkietalkey/
  src-tauri/            desktop app, Rust
  src/                  desktop UI, React + TypeScript
  phone/                phone web app, Vite + React + TypeScript, PWA
  ios/                  native iOS shell (SwiftUI + WKWebView), milestone M3
  relay/                Cloudflare Worker + Durable Object, TypeScript
  site/                 walkietalkey.com, Astro with React islands
  packages/ui/          React components and tokens ported from the design system
  packages/protocol/    message types, envelope crypto, test vectors (shared by TS and Rust tests)
  models/               model manifest, conversion scripts, licence texts
  docs/                 SPEC.md (this), PROTOCOL.md, PRIVACY.md, MANAGED_SETTINGS.md, ARCHITECTURE.md
  licenses/             third-party licence texts
  .github/              workflows, issue and PR templates
  LICENSE  NOTICE  TRADEMARKS.md  README.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md
```

Package manager: bun workspaces.

## 5. Identity without accounts

### 5.1 Why no logins at all

Nothing in WalkieTalkey needs to know who a person is. It only needs to know that this phone is allowed to send to that computer. Pairing answers exactly that question, and it is stronger than any login:

| | Magic link or OAuth | Pairing by QR (chosen) |
|---|---|---|
| What proves who you are | Access to an email inbox or a Google/Microsoft account | Possession of a key that only ever existed on your two devices |
| What we must run | Email sending (SPF, DKIM, DMARC), a user database, sessions, account deletion, GDPR requests | Nothing beyond the relay |
| What a leak of our server reveals | Email addresses, login history | Random room ids and public keys. No names, no emails, no text |
| Known failure modes | Corporate mail scanners (Outlook Safe Links and similar) open one-time links before the user does and burn them; links land in spam; phishing look-alikes | Someone photographs the QR within its 10 minutes; mitigated by single use and a "Var det dig?" confirmation (DESK-62) |
| Fits "Ingen konto" | No | Yes |

If WalkieTalkey ever gets a hosted admin console for companies, that console (not the app) gets sign-in. Not before.

### 5.2 Concepts

- **Device**: one installation (a desktop app or a phone app). On first start each device creates two P-256 key pairs: a signing key (ECDSA, to prove itself to the relay) and an agreement key (ECDH, to agree on encryption keys with its partner). Private keys never leave the device.
- **Room**: one per computer. The computer owns it. Phones join it. A phone can be in several rooms (one per computer it is paired with).
- **Pair key**: every phone and computer pair has its own 256-bit AES key, derived on both sides from an ECDH agreement and a secret from the QR code. The relay never sees it. Removing one phone never affects the others.
- **Pairing secrets**: the QR code carries two one-time secrets. `a` (admission) is shown to the relay so it lets the phone into the room; the relay stores only its SHA-256 hash. `s` (secret) is never sent anywhere; both devices mix it into the pair key and use it to prove that the phone's public keys were not swapped on the way.

### 5.3 Pairing flow

1. On the computer: Indstillinger › Telefon › "Par en telefon". If the computer has no room yet, it creates one first; the room id is bound to the computer's signing key (RELAY-03). The app creates `a` and `s` (32 random bytes each), registers SHA-256(`a`) with the relay with a 10-minute expiry, and shows a QR code with a countdown. Closing the window cancels the code (`cancel_admission`).
2. On the phone: open the WalkieTalkey app, tap "Par med en computer", scan the QR inside the app. (On Android and in the iOS app, scanning with the normal camera also opens the app directly. On an iPhone without the iOS app, the camera opens Safari, whose storage is separate from the home-screen app, so that page never joins and never creates keys. Run 2: it keeps the pairing link in its address bar and links a manifest without `start_url`, so the app added to the home screen from there starts with the link and pairs on its first launch with one tap; the secrets are single-use and expire after 10 minutes, so a stale copy is harmless. If iOS drops the link, the home-screen app's first launch opens the scanner by itself. Only a real iPhone can confirm which of the two happens on a given iOS version.)
3. The QR holds a URL whose secret part is after `#`, so browsers never send it to any server: `https://app.walkietalkey.com/p#<base64url(JSON)>` (or the company's `PhoneAppUrl`) with `{"v":1,"r":roomId,"a":admission,"s":secret,"e":computerAgreementPublicKey,"u":relayUrl,"n":computerName,"o":"mac"}` (`o` is `mac` or `win`, so the phone says ⌘V or Ctrl+V). The page removes the fragment from the address bar and history (`history.replaceState`) as soon as it has read it.
4. The phone creates its key pairs (if it has none), computes the pair keys (section 9.3), and sends `join` to the relay with `a`, its two public keys, and a MAC over those keys made with a key derived from `s`.
5. The relay checks SHA-256(`a`) against the stored hash, deletes it (single use), adds the phone's signing key to the room, and forwards the phone's public keys and MAC to the computer.
6. The computer verifies the MAC with `s` (which only it and the phone know), derives the same pair key, and forgets `s`. A relay that swapped the phone's keys would fail this check, and the computer would refuse the phone.
7. The phone sends its name, encrypted with the pair key. The computer shows "Ny telefon parret: Jonathans iPhone. Var det dig?" with "Ja" and "Fjern". The prompt is triggered by the relay's `member_joined`, not by the name, so a phone that never sends a name still shows up (as "en telefon uden navn").

### 5.4 How long a pairing lasts

- A pairing lasts until someone removes it. There is no "log in again every 14 days", because there is no password or session to steal: the keys sit in the phone's secure storage behind the phone's own lock.
- A phone that has not connected for 90 days is removed by the relay. If the computer itself has not connected for 90 days, the whole room is deleted; the computer then creates a new room with a new id and its phones pair again.
- **Lost phone**: on the computer, Indstillinger › Telefon › "Fjern" next to the phone. The computer tells the relay to remove the phone and deletes that phone's pair key. The phone can no longer connect or send, and other phones are not affected.
- **Removing from the phone**: the phone's settings › Parrede computere › "Fjern" sends `leave`; the relay tells the computer, which deletes that pair key.
- **Removed or deleted on the other side**: if the relay answers "not a member" or "room not found", the phone shows "Parringen med <computer> er fjernet. Par igen for at bruge den." and drops the room.
- **Factory reset or reinstall**: the keys are gone, so pair again.
- **Do not pair while sharing your screen**: the onboarding and the pairing window say so, because the QR is valid for 10 minutes.

### 5.5 Several computers

Each computer has its own room. The phone joins all of them. Section 7.5 describes how the phone picks the computer you are sitting at. The text only ever exists on that one computer; it is never copied to the phone or to the other computers.

---

## 6. Desktop app (DESK)

### 6.1 Base

The desktop app is built with Tauri v2. Its core does push-to-talk, local speech models (Whisper, Parakeet, Canary and more) through the engine `transcribe-cpp` with GGUF model files, transcription of long recordings in chunks while the user is still speaking, Silero VAD, a recording overlay, paste into the active app, history, a tray icon, translations, CLI flags, post-processing with LLM providers, and signed updates.

| ID | Requirement |
|---|---|
| DESK-01 | WalkieTalkey is its own product (run 3): its history starts at one root commit (OSS-02), and it carries no other project's name, logo, icons or sponsor images. Third-party licence notices (section 14.2) stay in `licenses/`, NOTICE and the About screen's licence list. |
| DESK-02 | App name WalkieTalkey, bundle id `com.walkietalkey.app`, app data folder named WalkieTalkey, icons from the design system (`assets/App-ikoner`). |
| DESK-03 | Danish is the default UI language. English strings stay in the codebase for later. |
| DESK-04 | Features that stay but are hidden behind "Avanceret": manual model install, debug mode, paste delays, CLI flags. |
| DESK-05 | WalkieTalkey's features live in their own modules (for example `src-tauri/src/walkietalkey/`, `src-tauri/src/pipeline/da/`, `src/walkietalkey/`), apart from the desktop core (audio, models, shortcuts, paste), so each part stays easy to read and test (run 3). |
| DESK-06 | Local Mac builds are signed with one self-signed code-signing identity, "WalkieTalkey Local" (`scripts/walkietalkey/build-local-mac.sh`, BUILD.md), until an Apple Development certificate exists. macOS ties permission grants (Accessibility, Microphone) to the app's signature, and ad-hoc signed builds lose them on every rebuild; a signature from one certificate keeps the designated requirement the same. CI release builds stay ad-hoc until the Apple Developer ID (decision 18.1 done, enrolment open); after such an update the app detects the dropped Accessibility grant and offers to repair it (DESK-13). |

### 6.2 First run (onboarding)

A single window, one step at a time, using the design system (LogoIntro on the first screen, LogoLoader `fyld` for the download).

| Step | What happens | Must |
|---|---|---|
| (Talemodel) | No step of its own (run 2): the speech model (DESK-31) downloads in the background from the very first launch, from our GitHub release, shown as one calm progress line under every step and in the sidebar, never blocking. "Importér modelfil" is under Avanceret. | DESK-11 |
| 1. Velkommen | "Dansk tale til tekst. Gratis, og det kører på din egen computer." Button "Kom i gang". | DESK-10 |
| 2. Mikrofon | Explains why, then one button: macOS's own question first, then the exact System Settings pane. The step notices the grant by itself and moves on. On Windows it is skipped when the microphone is already allowed. | DESK-12 |
| 3. Tilgængelighed (Mac only) | "Så teksten kan sættes ind, hvor du skriver". One button opens Privacy & Security › Accessibility; the step notices the grant within about a second and moves on, with no restart. Accessibility is the only permission for the key and for pasting; Input Monitoring is never asked for (run 2: the v1 step "Tasten" with Input Monitoring, the 🌐 instructions and the restart is gone). Windows has no such step; the key is Right Ctrl, or the key chosen in Prøv det. | DESK-13, DESK-14 |
| 4. Prøv det | A text field: tap or hold the key and say "Hej, det her er min første diktering." Shows the result, and says so if the key is not running yet (it asks the backend when the step opens). If the Globe key still has an action of its own, one sentence and the button "Ret det for mig" (DESK-20). On Windows the step offers the key picker, for example the Copilot key (Win+Shift+F23) on laptops without Right Ctrl (DESK-21). | DESK-17 |
| 5. Telefon | Optional: "Vil du også kunne tale ind i telefonen?" Shows the pairing QR (section 5.3) or "Spring over". Showing the code also asks for notification permission (DESK-15). | DESK-16 |
| 6. Klar | Three tips (hold, tap, Esc). "Færdig" turns on start at login and marks onboarding finished. | DESK-10 |

If Accessibility was granted before but is gone now (an update with a new ad-hoc signature, or switched off), the app opens its main window with one neutral notice, "WalkieTalkey har ikke længere adgang til Tilgængelighed.", and the button "Giv adgang igen". Every Accessibility button (this notice, the Tilgængelighed step, Prøv det's warning) first resets the app's own entry and shows macOS's dialog, then opens the pane, so a stale entry that looks switched on never leaves the user waiting; the key starts by itself once access is back (DESK-13).

Acceptance: a new user on a clean Mac goes from first launch to a working dictation without reading any docs, and every permission prompt is preceded by a Danish explanation.

### 6.3 Dictation with the key

| ID | Requirement |
|---|---|
| DESK-20 | Default trigger on macOS is `fn` (🌐) alone, tap or hold (DESK-22). WalkieTalkey's own active `CGEventTap` at the head of the HID event stream drives it, with Accessibility as the only permission (no Input Monitoring). It swallows fn-only events and the Globe key's follow-up event (keycode 0xB3), and passes fn combined with other keys through. macOS fires the Globe key's own action (for example Change Input Source) upstream of every event tap (run 2, Phase 0), so while `fn` is the key the app offers one button, "Ret det for mig", that sets the Globe key to Do Nothing (`com.apple.HIToolbox AppleFnUsageType` 0; applies at once, no logout), remembers the previous value and restores it when `fn` stops being the key. The user never has to change System Settings. |
| DESK-21 | Default trigger on Windows is Right Ctrl, hold mode. Any key or combination can be chosen. Third-party keyboards do not send `fn`, so the Mac settings also offer other keys. |
| DESK-22 | Tap or hold (run 2; replaces "hold to talk or tap to start"). Recording starts the moment the key goes down. Released within 0.5 s, the dictation is hands-free: it records until the next tap (stop and transcribe), Esc (cancel, DESK-25) or the 5-minute limit (DESK-24), and the pill shows a lock and "Tryk igen for at stoppe". Held longer, it is push-to-talk and stops on release. Settings also offer hold only and tap only. |
| DESK-23 | Recording starts within 100 ms of the key going down, so the first word is never cut. The start sound and the pill appear once the key has been held for 300 ms, or at once when a tap makes the dictation hands-free, so `fn` shortcuts stay silent. Sounds are on by default and can be turned off. |
| DESK-24 | Maximum 5 minutes per dictation. At 4:45 the pill shows a countdown. At 5:00 it stops and transcribes what it has. |
| DESK-25 | Esc while recording cancels without output. |
| DESK-26 | If any other key is pressed while `fn` is down (fn+Delete, fn+arrows, fn+F-keys), the dictation is cancelled silently, because `fn` is also a modifier. Modifiers alone (Shift for DESK-80) do not cancel, and typing during a hands-free dictation does not cancel it. A quick tap is no longer ignored (it starts a hands-free dictation, DESK-22); in the hold-only setting a hold under 300 ms is dropped silently. |
| DESK-27 | One transcription at a time, in the order the recordings end. A phone dictation that arrives during a key dictation waits; its notification follows the key dictation's paste. |

### 6.4 The pipeline

Runs entirely on the computer, in this order:

1. **Capture** 16 kHz mono (`cpal` + `rubato`).
2. **VAD** (Silero) trims leading and trailing silence. Clips with no speech end with no output and the pill says "Hørte ikke noget". A take on an input that gave no sound at all is not transcribed and ends with "Mikrofonen giver ingen lyd" instead (DESK-59).
3. **Speech recognition** with Edda (section 6.5) through transcribe.cpp, language forced to Danish (DESK-70 covers other languages), chunk by chunk while the user is still talking (DESK-46). The context prompt is the end of the previous chunk, or for the first chunk a short, well-punctuated Danish sentence; the user's vocabulary goes in transcribe.cpp's vocabulary field (6.9). Both share Whisper's 223-token prompt budget. The prompt pulls Whisper-family models towards punctuated, cased output.
4. **Punctuation** (DESK-41) when the text lacks it.
5. **Filler words** removed locally (DESK-44).
6. **Vocabulary replacements** (6.9).
7. **AI cleanup** if turned on (6.10). The only step that may use the network.
8. **Output** (6.6).

Everything except speech recognition and the optional cleanup call takes a fraction of a second. Speech recognition is the main cost of a dictation without cleanup; the cleanup call is the main cost of one with it, which is why DESK-80 can skip the call when there is nothing to fix.

**Why this runs on the user's computer and not on a server.** The model transcribes many times faster than anyone speaks (DESK-43), so a laptop's GPU sits idle most of the time even while dictating. A server would cost money every hour it waits: the cheapest dedicated GPU server at Hetzner is about 214 EUR per month plus a 209 EUR setup fee (October 2026), and a transcription API costs 0.003 to 0.017 USD per minute of speech. It would also need internet and break the promise that speech becomes text on the user's own computer. A company with many slow laptops may one day want one GPU server of its own for the whole office; that is paid setup work, not part of v1.

| ID | Requirement |
|---|---|
| DESK-40 | Each stage is a pure function with unit tests on fixed input (except capture). |
| DESK-41 | Punctuation: if the recognised text has fewer than 1 punctuation mark per 25 words, run Ekko PnC (int8 ONNX, about 22 MB, local via ONNX Runtime). Setting "Tegnsætning": Automatisk (default), Altid, Aldrig. The Rust port must reproduce the reference tool's windowing (128-token windows with 12 words of overlap) and match the Python reference (`ekko-stt`) on a golden set of sentences. |
| DESK-42 | Numbers, times and dates follow Danish conventions: "klokken ti" stays as spoken unless cleanup is on; cleanup may write "kl. 10". |
| DESK-43 | Speed is measured as the wait after the key (or the phone button) is released, without AI cleanup. Provisional target: about 1 s on the owner's 16-inch M1 MacBook Pro for any length up to 5 minutes, which DESK-46 makes possible; the ThinkPad target is set from M0. For reference, transcribe.cpp measures the model Edda is built on (Whisper large-v3-turbo, Q8_0) at 0.30 s for 11 s and 0.69 s for 35 s of speech on an M4 Max (Metal), and at 4.4 s and 9.6 s on a 2020 Ryzen 4750U laptop's integrated GPU (Vulkan). Whisper-family models always encode a full 30-second window, so short clips are not proportionally faster. Measured with `scripts/bench` before each release (CI runners have no usable GPU) and reported in the release notes. |
| DESK-44 | Filler words are removed locally: the language-gated filler removal has a Danish list ("øh", "øhm", "æh", "æhm"; the universal list already covers "hmm" and similar). Instant and free. |
| DESK-45 | The speech model is loaded when the app starts and stays loaded. It is not unloaded after a few idle minutes, so the first dictation after a break is as fast as the rest. Setting "Hold talemodellen indlæst": Altid (default), i 15 minutter, i 1 time, for machines short on memory. |
| DESK-46 | **Transcribe while talking.** Every recording, from the key or streamed in from the phone, goes through the live chunker as the audio arrives: it cuts at pauses and decodes each chunk as soon as its cut is certain, so when the recording stops only the last chunk is left. It aims for chunks of 10 to 20 seconds rather than 30 (cuts only in pauses, never shorter than 5 seconds), so the last chunk stays short whatever the total length, and a 5-minute dictation finishes about as fast as a 20-second one. Each chunk gets the end of the previous chunk's text as its context prompt. Whisper writes each chunk as a whole utterance (a capital first letter, often a full stop at the end), so each joint is read again with both sides in view as soon as the chunk after it is decoded: Ekko PnC sees the last words before it and the first words after it and decides whether a sentence ends there; if not, a full stop at the end of the chunk goes and the next chunk's first word is lower-cased unless it is a name or an acronym (run 4; not when Tegnsætning is Aldrig). A chunk that comes back with letters from another script or broken characters (U+FFFD) is decoded again without the vocabulary, and any left are removed. Acceptance: on the owner's Mac, the wait after release for a 2-minute dictation is within 0.3 s of the wait for a 15-second one. |
| DESK-47 | **Clean up while talking.** With AI cleanup on, each chunk is cleaned in the background as soon as it is transcribed. The call gets the previous chunk (already cleaned, and still allowed to change) plus the new chunk, so "nej vent, torsdag" can fix something said before a cut. Nothing is pasted until the end, so earlier text can still change. When the key is released only the last chunk's call is left, so a long dictation waits no longer than a short one. With "Når der er noget at rette" (DESK-80), only the chunks that need it are sent. |

### 6.5 Models

| ID | Requirement |
|---|---|
| DESK-29 | M0 converts Edda to GGUF with transcribe.cpp's `scripts/convert-whisper.py`, quantises it to Q8_0 with `transcribe-quantize`, and checks it against the Transformers reference the way transcribe.cpp validates its own Whisper models (`dump_reference_whisper_transformers.py`), plus the same text as the original on 10 real clips, before anything is published. The desktop app loads the result from its custom models folder, so M0 needed no new app code. |
| DESK-30 | Default model: **Edda v0.2** (Whisper large-v3-turbo fine-tuned on about 2,600 hours of Danish, 809M parameters, Apache-2.0, Alexandra Institute). We publish it as GGUF for transcribe.cpp, `Q8_0` (about 890 MB) by default. Smaller quantisations save download size but not time: in transcribe.cpp's own measurements Q4_K_M is as fast as Q8_0. About 1,690 of the training hours are FTSpeech (parliament) with lower-case, unpunctuated transcripts, so some output arrives without punctuation and DESK-41 will run often. Whether the FTSpeech terms limit use of the weights is an open question for M0 (section 11). |
| DESK-31 | Model choice by measured speed: after the download, the app transcribes a bundled 10-second Danish clip. If Edda needs 1.5 s or less (Apple Silicon and most recent GPUs), Edda is the default. If it needs more (older or CPU-only Windows machines), the app offers the fast model (DESK-35) and says why in one sentence. The user can always switch. |
| DESK-32 | Models download from the assets of our GitHub release `models-v1` (run 2; was our Hugging Face organisation), or from the company's own server if `ModelBaseUrl` is set. Every file is checked against a SHA-256 from `models/manifest.json` shipped inside the app. Downloads resume after interruption. A failed check deletes the file and retries once, then shows an error. |
| DESK-33 | Model cards, published with the models in the GitHub release (`<model>-README.md`), state the original, the licence (Apache-2.0), what we changed (conversion, quantisation) and the dataset terms (the CoRal terms forbid speech synthesis and biometric identification; dictation is fine). |
| DESK-34 | The other models (Whisper, Parakeet) remain under "Andre modeller". |
| DESK-35 | **Fast model** for slower PCs: Ekko v1 tiny (RyeAI; 110M parameters; FastConformer RNN-T fine-tuned from NVIDIA's `parakeet-rnnt-110m-da-dk`). Mean WER 12.1 on the Danish ASR leaderboard against Edda's 8.6, at 60 to 75 times real time on CPU alone. Evaluated in M0 on the ThinkPad. Before it ships: read its layered licence (NVIDIA Open Model License for the base model, CC BY 4.0 for RyeAI's changes, the CoRal terms, and its FTSpeech note), and convert the `.nemo` checkpoint with transcribe.cpp's `convert-parakeet.py` (transcribe.cpp already runs Parakeet RNN-T models). Its output has no punctuation, so DESK-41 always runs. |

### 6.6 Output

| ID | Requirement |
|---|---|
| DESK-50 | **Key dictations** paste at the cursor ("Indsæt automatisk", default) when Accessibility is granted on Mac. On Windows this works except into apps running as administrator (Windows blocks that); then the text goes to the clipboard as in DESK-51. The pill shows "Indsat" briefly. |
| DESK-51 | Without Accessibility (or if the user chooses "Kun udklipsholder"), the text goes to the clipboard and the pill shows "Tekst klar til at indsætte ⌘V" (Windows: Ctrl+V). |
| DESK-52 | **Phone dictations** always go to the clipboard with a notification (6.7), never auto-paste, because the cursor might be anywhere. |
| DESK-53 | Auto-paste saves the previous clipboard, pastes, and restores the previous clipboard afterwards ("Reliable Paste"). |
| DESK-54 | Clipboard privacy: on macOS the text is written for this Mac only (`NSPasteboard` current-host-only option), so Universal Clipboard does not send it to other Apple devices. On Windows the clipboard entry carries the formats that keep it out of Clipboard History and Cloud Clipboard (`CanIncludeInClipboardHistory`=0, `CanUploadToCloudClipboard`=0, `ExcludeClipboardContentFromMonitorProcessing`). Setting "Del med mine andre enheder" turns this off. Implementation note: Tauri's clipboard plugin cannot set these options, so this is a small native module (Objective-C via `objc2` on macOS, Win32 on Windows). |

### 6.7 Notifications and the pill

| ID | Requirement |
|---|---|
| DESK-55 | The DictationPill floats at the bottom centre during key and phone dictations: about 220×56 px and growing with its text up to 416 px (inside a 512×152 overlay window that leaves 48 px for its glow on every side, fully transparent and without a window shadow, and lets clicks through everywhere except on the pill itself; run 4), glass, with the mark, a live waveform from the microphone level (or the phone's audio) and the time. Lytter (hands-free: a lock and "Tryk igen for at stoppe") → Renskriver → Indsat or Tekst klar til at indsætte, with the countdown from 4:45 (DESK-24). It hides 1.5 s after the end (4 s after "Mikrofonen giver ingen lyd", DESK-59). Position and "Vis aldrig" are settings. |
| DESK-56 | Phone dictations show a system notification: title "Tekst klar til at indsætte", body the first 80 characters, or "Tryk ⌘V for at indsætte" when "Vis teksten i notifikationen" is off (for shared screens and meetings). |
| DESK-57 | Clicking the notification opens the history with that item selected. Implementation note: Tauri v2's notification plugin only handles actions and clicks on mobile, so this needs a small native module (a `UNUserNotificationCenter` delegate on macOS, a toast activation handler on Windows). Windows toasts only show the app's own name and icon for the installed app. |
| DESK-58 | While a phone recording streams in, the menu bar icon pulses and the pill shows (run 2: on by default, not while paused; a setting turns it off), its waveform following the phone's audio. A phone dictation that goes silent for 15 s lets go of the pill and the pulse (its audio is kept; a resend after a reconnect continues it), is dropped after 15 silent minutes, and is answered "too long" past 5:30 of audio. |
| DESK-59 | **Silent microphone** (run 4; the owner's Scarlett interface with nothing plugged in looked like a broken app). Key dictations watch the raw input level before VAD, in 32 ms windows: a window has sound when its peak, DC offset removed, reaches -60 dBFS (the built-in Mac microphone's room tone alone is -47 to -62 dBFS, speech on the quietest working input measured peaks at -16 to -31 dBFS; an interface with nothing plugged in is near -90 dBFS, a muted, denied or virtual input delivers zeros), and the input is alive after 3 such windows. If it is not alive 1.5 s into the take, the pill says "Mikrofonen giver ingen lyd" while it keeps recording; sound clears it. Once alive, pauses never count as silence. A take of at least 0.5 s that never came alive is not transcribed: the pill ends with "Mikrofonen giver ingen lyd", and the app probes the other inputs once, 500 ms each (inputs only, never virtual devices or the system audio), the system default first, then the built-in microphone, and offers the first that gives sound: "Prøv {navn}" under the pill's note, and in the window (at the top, and at the microphone setting under Avanceret) "{input} giver ingen lyd. Prøv {navn}." with one button, "Brug {navn}". When none gives sound it says so plainly, with "Tjek igen". The notice goes once the selected input gives sound again or another input is chosen. A working microphone that heard no speech still ends with "Hørte ikke noget". On macOS the app never opens an input stream on a device without input channels (cpal would record the system audio through a process tap instead): the system default is opened by its ID only if it is an input, and a stream that became cpal's loopback device is closed; both are refused as "no input device". Phone dictations have their own audio path and are not watched. |

### 6.8 Receiving from the phone

| ID | Requirement |
|---|---|
| DESK-60 | The app keeps one WebSocket per room open to the relay (section 8) whenever it runs, with the 30-second ping of RELAY-10. It reconnects with backoff (1, 2, 5, 10, 30 s) and right after sleep or a network change. |
| DESK-61 | Audio frames are decrypted as they arrive, keyed by session id and chunk index, and fed into the live chunker (DESK-46), so phone dictations are transcribed while the user is still talking too. Duplicate chunks (after a resend) are dropped. If chunks are missing at `audio_end`, the app waits up to 5 s for the phone's resend (PHONE-32), then transcribes what it has. |
| DESK-62 | When the relay reports a new member (`member_joined`), the app shows "Ny telefon parret: <navn>. Var det dig?" with "Ja" and "Fjern", whether or not the phone has sent a name (without one: "en telefon uden navn"). |
| DESK-63 | Presence (M4; only matters with two or more computers): when a phone asks (`presence_query`), the app answers with the seconds since the last keyboard or mouse input and whether the screen is locked. Nothing is sent unasked, so the relay cannot see when the user arrives at or leaves the computer. |
| DESK-64 | After a phone dictation, the computer sends the phone a `result`: ok, or a reason (`no_speech`, `model_not_ready`, `too_long`, `paused`, `error`). The text itself is never sent back; it exists only on this computer. |

### 6.9 Vocabulary

| ID | Requirement |
|---|---|
| DESK-66 | Indstillinger › Ordliste has two lists. **Ord**: names and terms to spell right (fed to the model's vocabulary field, about 150 tokens max, most recent first, because Whisper's 223-token prompt budget is shared with the context from the previous chunk, DESK-46). **Erstatninger**: "når jeg siger X, skriv Y" (applied after recognition, whole words, case-insensitive match, keeps the replacement's casing). |
| DESK-67 | A built-in pack "Udviklerord" (pull request, deploy, standup, merge, commit, frontend, backend and similar, 30 terms) helps mixed Danish and English. On by default (run 2). It reaches Whisper models through transcribe.cpp's vocabulary field as a "Glossary:" prompt (73 Whisper tokens; with the longest chunk context 164 of the 223). Measured on the owner's sentences (run 2, Phase 2): Mac WER 11.8 % to 9.2 % with it, English terms unchanged (3 of 8); adding the inflected forms that failed did not help, so English words inside Danish speech need a code-switched fine-tune (run 3). The "Glossary:" prompt can tip Edda into fragments in other scripts on code-switched speech ("Husk atали til grief"), so a Danish chunk decoded with a vocabulary that shows letters outside the Latin script is decoded again without it, and any such letters left are removed from Danish text (`pipeline::da::script`). |
| DESK-68 | Lists can be imported and exported as plain text, one entry per line, and can be set by the company (Appendix B). |

### 6.10 AI cleanup (optional)

Built on the post-processing module, as a mode rather than a separate shortcut.

| ID | Requirement |
|---|---|
| DESK-80 | "Ryd op med AI": Fra (default), Når der er noget at rette, Altid, or Kun når jeg holder Shift med. "Når der er noget at rette" (recommended once a provider is set up) calls the provider only if the text, after the local steps, contains a self-correction marker ("nej", "nej vent", "jeg mener", "eller rettere", "undskyld", "I mean", "no wait", "sorry") or a repeated phrase. Every other dictation goes out at once with no network call. The marker list is tuned in M5 against the test set. |
| DESK-81 | Providers, as presets: Apple Intelligence (Mac with Apple Silicon and macOS 26 or newer, on-device, no key; Apple added Danish in the 26.1 releases, to be confirmed on macOS in M5), OpenAI, Anthropic, Groq, Cerebras, OpenRouter, and Custom (any OpenAI-compatible endpoint: Azure OpenAI, LM Studio, Ollama). Keys are the user's own, stored in the OS keychain, never in settings files, and sent only to that provider. |
| DESK-82 | Turning on a cloud provider shows exactly: "Teksten (ikke lyden) sendes til <udbyder>, hver gang du dikterer." with "Slå til" and "Annullér". |
| DESK-83 | The prompt makes the model an editor, not an assistant: remove filler words, apply self-corrections ("onsdag, nej, torsdag" → "torsdag"), fix punctuation, keep the mix of Danish and English, never add content, never answer questions in the text. Temperature 0 where the model accepts it (OpenAI's reasoning models reject it), and reasoning turned off (`llm_client` sends the right field per provider). The text is wrapped in tags so it is never read as instructions. |
| DESK-84 | Guardrails: the raw text is used instead, and the pill says "Brugte teksten uden oprydning", if the result is more than 30% longer than the input, if more than 20% of its words do not occur in the input (ignoring case and punctuation, and allowing digits, "kl." and other number and date forms that cleanup may write), or if no answer has arrived within 3 s plus 1 s per 100 words. |
| DESK-85 | "Vis hvad der blev sendt": each history item that went through a cloud provider shows the exact text sent, the provider and how long the call took. |
| DESK-86 | Known limit, stated in the UI: small local models (under about 3B parameters) often ignore instructions; the setting recommends Apple Intelligence on Mac or a larger model. |
| DESK-87 | Warm connection: when the key goes down (or a phone recording starts) and a cloud provider is active, the app opens the HTTPS connection to the provider in parallel with the recording and keeps it alive between dictations, so the request after release does not wait for the TCP and TLS handshake. |

### 6.11 Language

| ID | Requirement |
|---|---|
| DESK-70 | v1.0: Danish, with English words inside Danish sentences handled by Edda plus vocabulary plus cleanup. |
| DESK-71 | v1.1: "Sprog: Automatisk". Detect the language per dictation; English dictations go to an English-capable model (Whisper turbo or Parakeet V3, both already in the app). Ship only if it beats Danish-only on our mixed test set (section 15). |

### 6.12 History

| ID | Requirement |
|---|---|
| DESK-90 | Every dictation is kept locally with time, source (tast or telefonens navn), the text, and whether cleanup was used. |
| DESK-91 | Retention setting: Gem ikke, 1 dag, 14 dage (default), 90 dage, Altid. Old items are deleted on start and every hour. |
| DESK-92 | Audio is never stored, except when the user turns on "Gem lyd til fejlfinding" (off by default, max 7 days). |
| DESK-93 | History is searchable, each item can be copied or deleted, and "Slet al historik" exists. |
| DESK-94 | History is stored in the app data folder. It is encrypted at rest only if the computer's disk encryption (FileVault or BitLocker) is on, and the privacy page says exactly this. |

### 6.13 Menu bar and tray

| ID | Requirement |
|---|---|
| DESK-95 | Icon (the mark, monochrome template image) with states: klar, lytter (subtle pulse), renskriver. |
| DESK-96 | Menu: Seneste (last 5 items, click copies), Par en telefon, Sæt på pause, Indstillinger, Søg efter opdateringer, Afslut. "Sæt på pause" makes the key do nothing and answers phone dictations with `paused` until "Genoptag" or the next start of the app. |
| DESK-97 | Starts at login (on by default after onboarding, can be turned off). |

### 6.14 Settings (complete list)

Generelt: start ved login, lyde, pillens placering eller Vis aldrig, vis teksten i notifikationen, sprog for brugerfladen.
Tast: tast, tilstand (hold eller tryk), test.
Tekst: indsæt automatisk eller kun udklipsholder, tegnsætning, del med mine andre enheder.
Ordliste: ord, erstatninger, Udviklerord, import og eksport.
Ryd op med AI: tilstand, udbyder, model, endpoint, nøgle, vis hvad der blev sendt.
Telefon: parrede telefoner (navn, sidst set, Fjern), Par en telefon.
Model: valgt model, hold talemodellen indlæst, andre modeller, hent igen, plads brugt.
Historik: opbevaring, gem lyd til fejlfinding, slet al historik.
Opdateringer: automatisk (default on), kanal (stabil eller beta).
Avanceret: relæ-adresse, manuel installation af modeller, fejlsøgning, forsinkelser ved indsæt, CLI.
Om: version, licenser og kreditering (Handy, transcribe.cpp, Edda, Ekko PnC, ONNX Runtime), links til kode, privatliv og varemærke.

### 6.15 Managed settings for companies (MDM)

| ID | Requirement |
|---|---|
| DESK-100 | On macOS the app reads managed preferences for domain `com.walkietalkey.app` (deployed with a configuration profile from Jamf, Intune, Kandji and the like) through `CFPreferences`. On Windows it reads `HKLM\SOFTWARE\Policies\WalkieTalkey`. Our own settings file stays the store for everything that is not managed. |
| DESK-101 | One rule: every managed value is locked. It wins over the user's value and shows a small lock with "Styret af din organisation". There is no separate list of locked keys. The full key list is in Appendix B and in `docs/MANAGED_SETTINGS.md`. |
| DESK-102 | A company can point the app at its own relay, its own copy of the phone app (`PhoneAppUrl`), its own model server (`ModelBaseUrl`), its own Azure OpenAI endpoint, and a shared vocabulary file or HTTPS URL, and can forbid cloud cleanup or phone pairing. The repo ships ready-made templates: ADMX/ADML files for Group Policy and Intune, and a sample `.mobileconfig` for macOS. |

### 6.16 Updates

| ID | Requirement |
|---|---|
| DESK-110 | Tauri updater with signed artifacts (our own updater key, separate from Apple and Windows signing). Stable manifest: `latest.json` on GitHub's latest release (GitHub's "latest" skips pre-releases, which is what stable wants). |
| DESK-111 | Checks at start and every 6 hours. Downloads in the background and installs on next restart, with "Genstart nu" in the menu. A company can turn this off (Appendix B). |
| DESK-112 | Beta channel for people who want early builds. Because GitHub's "latest" skips pre-releases, beta has its own manifest at `https://walkietalkey.com/updates/beta.json`, written by the release workflow. |

### 6.17 Accessibility and localisation

- All settings reachable by keyboard, visible focus ring, VoiceOver and Narrator labels on every control, text contrast at least 4.5:1 (the design system already measures this).
- The pill and notifications are announced to screen readers.
- Reduced motion: every animation stops or becomes a calm fade, as the design system components already do.

---

## 7. Phone app (PHONE)

### 7.1 Platform strategy

| ID | Requirement |
|---|---|
| PHONE-01 | **PWA first** (M2) at `app.walkietalkey.com`: Vite + React + TypeScript, installable to the home screen, works on Android and iPhone. No App Store needed to start. |
| PHONE-02 | **Known iPhone problem**: a home-screen web app on iOS asks for microphone permission again in every new session; the permission is not remembered (WebKit bug 215884, follow-up bug 327237 opened October 2026, still open). For a pull-it-out-of-your-pocket product this is too much friction. |
| PHONE-03 | **Native iOS app** (M3): a small SwiftUI app with a WKWebView that runs the same phone app from files bundled inside the app (not loaded from the web), grants microphone access through `WKUIDelegate` (so only the normal one-time iOS permission prompt appears), keeps the keys as non-extractable WebCrypto keys in the app's own web storage (app data, not Safari's), and handles pairing links as Universal Links. M3 starts with a spike that serves the bundled files through `WKURLSchemeHandler` and confirms that microphone capture, AudioWorklet, WebCrypto and IndexedDB all work there. It adds native value so it is more than a website in a frame (App Store guideline 4.2): haptics and a "Start diktering" shortcut for the Action button and Control Center. If review still rejects it, the fallback is the same screens rebuilt natively in SwiftUI. Distributed through TestFlight and the App Store, covered by the same Apple Developer membership as the Mac signing. The App Store listing needs a privacy policy URL, so the Privatliv page goes live in M3. |
| PHONE-04 | iPhone users must use the installed app, not a Safari tab: Safari can clear website storage after 7 days without use, and home-screen apps keep their own separate storage. The web app detects a Safari tab on iOS and shows how to install it. |

### 7.2 Pairing on the phone

| ID | Requirement |
|---|---|
| PHONE-10 | First screen when not paired: "Par med en computer" with a short explanation and a button that opens the camera to scan the QR (QR decoding in JavaScript, no server). A home-screen app's first launch without a pairing link opens the scanner by itself (run 2). |
| PHONE-11 | On Android, and in the iOS shell, scanning the QR with the normal camera opens the app and pairs directly. |
| PHONE-12 | The phone asks for a name for itself, prefilled from the computer's owner when the computer's name has one ("Jonathans MacBook Pro" gives "Jonathans iPhone"), else the kind of phone ("iPhone"), which is sent encrypted to the computer. |
| PHONE-13 | Keys are stored as non-extractable WebCrypto keys in IndexedDB, in both the PWA and the iOS app (PHONE-03). One TypeScript implementation of the protocol serves both. |
| PHONE-14 | If the relay answers 4404 (room not found) or 4401 (not a member) for a room, the phone shows "Parringen med <computer> er fjernet. Par igen for at bruge den." and drops that room and its keys. |
| PHONE-15 | The pairing page reads the fragment, then removes it with `history.replaceState`, so the secrets do not linger in browser history or history sync. Exception (run 2): an iPhone Safari tab keeps the link in its address bar, so the home-screen app added from it starts with the link (5.3 step 2); it never joins. A home-screen app remembers SHA-256(`a`) of the links it has handled (paired, cancelled or expired), never the secrets, so launching from the same start URL later is normal. |

### 7.3 Main screen

As the design system's `PhoneApp` component: brand, the big button, the label, the lock line "Krypteret fra telefon til computer". Run 2: the target computer is one quiet status line at the very top (a small dot and "Forbundet til {computer}", "Forbinder til {computer}", "Ikke forbundet til {computer}" or "{computer} er ikke online", low contrast, wrapping, safe-area aware) instead of a chip; tapping it picks a computer and opens the settings. Text is never below 16 px.

| ID | State | Label | Must |
|---|---|---|---|
| PHONE-20 | idle | "Hold for at tale" | M2 |
| PHONE-21 | rec | "Slip for at sende" while a finger is on the button; hands-free shows a lock and "Tryk igen for at stoppe" with "Annullér". Red dot and time, level meter, glowing ring; the glow is never clipped (only the full screen clips it; run 2 fixed the PhoneApp box's `overflow: hidden`, which cut it on home-screen screens wider than its proportions) | M2 |
| PHONE-22 | send | "Sender til <computer>" | M2 |
| PHONE-23 | ready | "Klar på <computer>" and "Tryk ⌘V for at indsætte" ("Tryk Ctrl+V for at indsætte" when the QR said `o: win`) | M2 |
| PHONE-24 | offline | "<computer> er ikke online. Optagelsen venter i 10 minutter." The phone keeps the recording in memory until it gets a result. If none arrives within 10 minutes: "Nåede ikke frem til <computer>." with "Prøv igen" (resends from memory while the app is open). | M2 |
| PHONE-25 | error or paused | "Noget gik galt. Prøv igen." plus a "Detaljer" link. If the result says `paused`: "<computer> er sat på pause." | M2 |

| ID | Requirement |
|---|---|
| PHONE-26 | Tap or hold (run 2; replaces hold to talk with the "Tryk for at starte og stoppe" setting). Recording starts at button-down. Released within 0.5 s it is hands-free until the next tap (sends), "Annullér", the 5-minute limit, or the app going to the background (sends). Held longer it is push-to-talk and the release sends. Sliding the finger off the button while it is down shows "Slip for at annullere", and letting go there cancels (`audio_cancel`). A press the system interrupts (`pointercancel`) ends like a release and is never a tap: it sends, or cancels if the finger had slid off. There is no setting. |
| PHONE-27 | Haptic tick on start and stop where the platform allows (Android vibration API, iOS shell native haptics). |
| PHONE-28 | The screen stays awake while recording (Screen Wake Lock API where available). |
| PHONE-29 | Maximum 5 minutes per recording, also hands-free, with a countdown from 4:45. |

### 7.4 Recording and streaming

| ID | Requirement |
|---|---|
| PHONE-30 | Audio is captured with `getUserMedia` (channelCount 1; echoCancellation, noiseSuppression and autoGainControl off, so speech recognition gets the raw microphone instead of the call-processing chain) and an AudioWorklet, downsampled to 16 kHz mono, raised by a fixed 15 dB under a look-ahead peak limiter at -1 dBFS (the raw iPhone microphone arrives 17-18 dB below the Mac's, run 3; the limiter keeps every sample below the ceiling, so 16-bit PCM never clips), 16-bit PCM, in 200 ms frames. While the app is visible and paired the microphone stays open and keeps the last 300 ms in memory as the start of the next dictation, so the first word is never lost (run 2, Phase 0: v1 opened the microphone at button-down and lost first words); it closes when the page is hidden, after 3 idle minutes, or when no computer is paired. The 300 ms are measured on the clock: at button-down only audio captured in the last 300 ms is used, and audio from before an interruption is never sent. |
| PHONE-31 | Each frame is encrypted (section 9) and sent while the user is still talking, so the computer has nearly all the audio the moment the button is released. Every audio payload carries the session id and its chunk index (Appendix C.2). |
| PHONE-32 | The phone keeps every chunk of the open session in memory until the computer's result arrives. After a reconnect it resends the whole session, packing up to 10 chunks (2 s of audio) per frame and sending at most 25 frames per second, so it stays under the relay's limit (RELAY-11). The computer drops duplicates by chunk index. |
| PHONE-33 | The phone never stores audio on disk. Between dictations it keeps at most the last 300 ms in memory, overwritten all the time, and sends nothing unless a dictation is made. |
| PHONE-34 | Data use is about 32 kB per second of speech (about 2 MB per minute). Opus compression is a later optimisation, not v1. |
| PHONE-35 | The hold button uses pointer events with pointer capture, blocks the long-press menu and text selection, and resumes the AudioContext on the first touch (browsers only start audio after a user gesture). |

### 7.5 Several computers

| ID | Requirement |
|---|---|
| PHONE-40 | (M4) When the app comes to the foreground and more than one paired computer is online, it sends `presence_query` to each (DESK-63) and waits up to 1 s. The target is the unlocked computer with the most recent input; if none answers, the computer used last. |
| PHONE-41 | Tapping the computer chip lets the user pick another target for the next dictation. |

### 7.6 Phone settings

Parrede computere (navn, Fjern, which sends `leave`), Par med en computer, haptik, om og licenser. (Run 2: "hold eller tryk" is gone; the button does both, PHONE-26.)

---

## 8. Relay (RELAY)

### 8.1 What the relay does and does not do

It forwards encrypted frames between devices in the same room, holds frames briefly for a device that is offline, and keeps the room's list of allowed signing public keys. It never sees pair keys, the pairing secret `s`, audio, text, device names or presence answers. It keeps no logs of payloads.

### 8.2 Endpoints and frames

| Method | Path | Purpose |
|---|---|---|
| GET (WebSocket upgrade) | `/v1/rooms/{roomId}/ws` | The socket for one device in one room |
| GET | `/v1/health` | Liveness for monitoring |

Two kinds of WebSocket messages travel on the socket:

- **Control messages** between a device and the relay itself: JSON text frames, not end-to-end encrypted, never containing audio, text or names. Used for authentication, membership and connection status (Appendix C.1).
- **Device frames** between devices: binary, end-to-end encrypted (section 9.4). The relay only reads the plaintext header to route them (Appendix C.2).

### 8.3 Storage per room (SQLite-backed Durable Object)

| Table | Columns |
|---|---|
| `room` | owner_device_id, salt, created_at |
| `devices` | device_id, signing_public_key, role (`owner` or `phone`), added_at, last_seen_day (written at most once per day) |
| `admissions` | admission_sha256, expires_at |
| `owner_events` | id, kind (`member_joined` or `member_left`), payload, created_at (held until the owner has received them) |
| `buffered` | id, recipient_device_id, frames (encrypted, batched, at most 256 kB per row), expires_at |

Nothing is written until a `create` or `join` succeeds, so connecting to a random room id costs no storage. A live dictation writes at most one row (the daily last-seen update); a buffered one writes a handful.

### 8.4 Requirements

| ID | Requirement |
|---|---|
| RELAY-01 | The Worker applies the per-IP limits (RELAY-11), then routes `/v1/rooms/{roomId}/ws` to the Durable Object named by `roomId` (128 bits, base64url, bound to the owner's key, RELAY-03). The object accepts sockets with the WebSocket Hibernation API and keeps all per-socket state (device id, role, pending challenge) in `serializeAttachment` (at most 2,048 bytes), because in-memory state is lost when the object hibernates. Unknown rooms answer 4404 without writing anything. |
| RELAY-02 | Authentication: on connect the relay sends `challenge` (32 random bytes). A member answers `auth` with its device id and an ECDSA signature over `"wt-auth-v1" ‖ roomId ‖ challenge`. Wrong or unknown keys are closed with 4401. The reply `ok` lists the members with role, whether they are online and the day they were last seen (for "sidst set"). |
| RELAY-03 | `create` carries the owner's signing key, a 16-byte salt and a signature over `"wt-create-v1" ‖ roomId ‖ challenge`. The relay accepts it only if the room has no devices and roomId equals the first 16 bytes of SHA-256(`"wt-room-v1"` ‖ signing SPKI ‖ salt), so nobody but the holder of that key can ever own that id. An existing room cannot be created again (4409). |
| RELAY-04 | `add_admission` (owner only): stores SHA-256 of a pairing admission secret with a 10-minute expiry. `cancel_admission` deletes it early (the user closed the QR window). |
| RELAY-05 | `join`: a new phone sends the admission secret, its two public keys, the join MAC and a signature over `"wt-join-v1" ‖ roomId ‖ challenge` with its new signing key. If the hash matches and has not expired, the relay deletes the admission, adds the phone as a member, and passes `member_joined` (keys and MAC) to the owner, now or as soon as it next connects. The relay never checks the MAC; only the owner can. |
| RELAY-06 | `revoke` (owner only) removes a phone and closes its sockets at once. `leave` (phone only) removes the phone itself, and the owner gets `member_left`. `delete_room` (owner only) removes everything. A phone that is removed gets 4404 or 4401 on its next connect (PHONE-14). |
| RELAY-07 | Routing: device frames go to the recipient named in the header. Frames from a phone may only be addressed to the owner; frames from the owner may only be addressed to a phone in the room. The sender id must equal the socket's authenticated device (4403 otherwise). Frames for a recipient that is not a member are dropped. |
| RELAY-08 | Buffering: if the recipient is offline (no socket, or a socket that has gone quiet, RELAY-10), frames are stored for up to 10 minutes and delivered in order when it connects, then deleted. Frames are batched in memory and written as one row at 256 kB, on `audio_end`, when the sender disconnects, and 2 s after the last frame (the relay's only `setTimeout`; it never hibernates with an unflushed batch). At most 25 MB per room; above that the oldest buffered dictation is dropped and the sender gets `error` with code `buffer_full`. |
| RELAY-09 | Deploys: a new deploy restarts every Durable Object and drops all sockets, so the relay deploys only on release tags (OSS-22). Clients reconnect with backoff (DESK-60) and resend open sessions (PHONE-32). |
| RELAY-10 | Liveness and connection status: every client sends `{"t":"ping"}` every 30 s, and the relay answers `{"t":"pong"}` through `setWebSocketAutoResponse`, which does not wake the object. When routing to a socket whose last automatic answer (`getWebSocketAutoResponseTimestamp`) is more than 75 s old, the relay treats it as offline: it closes it, buffers the frame and tells the others. A sleeping laptop's socket can look open for minutes, which is why this matters. The relay tells each device in plain `peer` messages whether the other members are online, so the phone can show "offline" before you start talking. |
| RELAY-11 | Limits: device frames up to 64 kB; 50 frames per second per socket; 8 devices per room. Per IP: 10 new rooms and 10 joins per minute, generous enough for an office rolling out behind one public IP, enforced in the Worker with the Workers Rate Limiting binding before any Durable Object is touched. That binding is approximate and counts per Cloudflare location, which is fine for abuse protection. It counts in fixed windows of 60 s, so a burst that straddles a window boundary can get up to twice the limit through; the tests keep each burst inside one window (run 3). |
| RELAY-12 | Housekeeping with one alarm per room, set to the earliest pending expiry (each `setAlarm()` counts as a write). Phones not seen for 90 days are removed. If the owner has not been seen for 90 days, the whole room is deleted and its phones get 4404 (PHONE-14). Expired admissions and buffers are deleted. |
| RELAY-13 | No payload logging. Logs contain only hashed room ids, close codes and counts. |
| RELAY-14 | Self-hosting: `relay/` deploys to any Cloudflare account with one `wrangler deploy`, and a company's or a family's traffic fits the free tier. The apps accept a custom relay URL (a managed setting for companies). |
| RELAY-15 | v1.x: a Node.js relay with the same protocol and a Docker image, for companies that want it on their own servers. |

### 8.5 Cost

Workers Free plan (checked October 2026), per day: 100,000 requests, 13,000 GB-s of duration, 5 million rows read, 100,000 rows written (deletes and every `setAlarm()` count as writes), 5 GB stored. Incoming WebSocket messages count 20 to 1 as requests. A 15-second phone dictation is about 75 audio frames plus a few control messages, about 4 billed requests, and with the write rules in 8.3 and RELAY-08 almost no row writes. That is room for roughly 25,000 live phone dictations a day.

The catch: when a free limit is passed, further operations of that type fail until 00:00 UTC, for everyone. A launch spike, or someone abusing the relay, could switch it off for a day. So the public relay runs on Workers Paid from launch: 5 USD per month, with 1 million Durable Object requests and 50 million rows written per month included and small pay-as-you-go prices above that, so heavy use costs a little more instead of stopping. Self-hosted relays (RELAY-14) stay on the free tier.

---

## 9. Cryptography (SEC)

### 9.1 Primitives

Only what WebCrypto supports in every target browser, so the phone needs no crypto library:

- Signatures: ECDSA P-256 with SHA-256 (devices prove themselves to the relay).
- Key agreement: ECDH P-256.
- Key derivation and MACs: HKDF-SHA-256, HMAC-SHA-256.
- Encryption: AES-256-GCM, random 96-bit nonce per frame.
- Randomness: the platform CSPRNG (`crypto.getRandomValues`, Rust `getrandom`).
- Rust side: RustCrypto crates (`p256`, `hkdf`, `hmac`, `aes-gcm`, `sha2`). No home-made crypto.
- Encodings, fixed so the two implementations cannot drift: public keys are SPKI DER (base64url in JSON); ECDSA signatures are 64-byte raw r‖s, which is WebCrypto's format (Rust uses `p256`'s fixed-size `Signature::to_bytes()`, never DER).

### 9.2 Keys and where they live

| Key | Created by | Lives in | Leaves the device? |
|---|---|---|---|
| Signing key (ECDSA P-256) | each device | macOS Keychain, Windows Credential Manager, IndexedDB as a non-extractable key, iOS Keychain | Public half to the relay |
| Agreement key (ECDH P-256) | each device | same as above | Public half to the partner: the computer's inside the QR, the phone's through the relay, protected by the join MAC |
| Pair keys (two AES-256 keys per pair, one per direction) | derived on both sides | same as above | Never |
| Admission secret `a` | the computer | the QR; the relay keeps only its hash | Shown to the relay once |
| Pairing secret `s` | the computer | the QR only; the computer forgets it after the join | Never |

Device id = the first 16 bytes of SHA-256 of the signing public key (SPKI encoding).

### 9.3 Derivations

```
roomId   = first 16 bytes of SHA-256("wt-room-v1" ‖ owner signing SPKI ‖ salt)        // RELAY-03
shared   = ECDH(phone agreement private, computer agreement public)          // 32 bytes
base     = HKDF-SHA256(ikm = shared, salt = s, info = "wt-pair-v1" ‖ roomId ‖ computerId ‖ phoneId, 32 bytes)
k_p2c    = HKDF-SHA256(ikm = base, salt = "", info = "wt-p2c-v1", 32 bytes)   // phone → computer
k_c2p    = HKDF-SHA256(ikm = base, salt = "", info = "wt-c2p-v1", 32 bytes)   // computer → phone
mac_key  = HKDF-SHA256(ikm = s, salt = "", info = "wt-join-mac-v1", 32 bytes)
join_mac = HMAC-SHA256(mac_key, roomId ‖ phone signing SPKI ‖ phone agreement SPKI)
```

The computer derives the same values from its own agreement private key and the phone's agreement public key. Separate keys per direction mean the two sides can never produce the same key and nonce pair.

Signatures that answer the relay's challenge each sign their own label followed by roomId ‖ challenge (`"wt-auth-v1"`, `"wt-create-v1"` or `"wt-join-v1"`), so a signature made for one purpose can never be used for another.

### 9.4 Frame format (end-to-end encrypted, binary)

```
offset  size  field
0       1     version (1)
1       1     type (Appendix C)
2       16    sender device id
18      16    recipient device id
34      8     counter (big-endian uint64; per sender and recipient; starts at 1; persisted; never reused)
42      12    nonce (random)
54      n     AES-256-GCM ciphertext + 16-byte tag
```

- The first 42 bytes are the additional authenticated data (AAD). The relay routes on them but cannot change them without breaking decryption.
- The relay drops any frame whose sender id is not the device the socket authenticated as, or whose recipient is not a member of the room (close code 4403).
- The receiver drops frames whose recipient is not itself, decrypts with the pair key for that sender and direction, and rejects any frame whose counter is not higher than the last one it accepted from that sender (replay protection). Counters are stored, so this holds across reconnects, restarts and the relay buffer.
- Counters are reserved in blocks of 1,000: a device writes the end of the current block to storage before using numbers from it, and after a restart it starts a new block. A crash can skip numbers but never reuse one.
- A relay that delivers an old frame again (for example after a restart) does no harm: the counter check drops it.

### 9.5 Rules

| ID | Requirement |
|---|---|
| SEC-01 | Never reuse a nonce with the same key: random 96-bit nonces, separate keys per direction, new keys on every pairing. |
| SEC-02 | The QR is valid for 10 minutes and one use. The computer hides it as soon as a phone joins or the time runs out. |
| SEC-03 | The computer accepts a new phone only if the join MAC verifies with `s`. Every new phone triggers DESK-62 ("Var det dig?"). |
| SEC-04 | Removing a phone revokes it at the relay and deletes its pair keys on the computer. |
| SEC-05 | `packages/protocol/test-vectors.json` holds fixed keys, secrets, nonces, plaintexts and expected frames for every derivation and frame type. The TypeScript and Rust implementations must both pass them in CI. |
| SEC-06 | The relay URL must be `wss://`. Plain `ws://` is refused except to `localhost` in debug builds. |
| SEC-07 | Update artifacts are verified with the Tauri updater signature before install. |
| SEC-08 | Secrets (Apple certificates, notarization key, updater private key, Cloudflare API token, Windows signing credentials) live only in GitHub Actions secrets and on the owner's machine. Never in the repo. |
| SEC-09 | Private keys are created as non-extractable wherever the platform allows it (WebCrypto `extractable: false`, Keychain items without export). |
| SEC-10 | On Windows, device keys are stored in Credential Manager with local-machine persistence (`CRED_PERSIST_LOCAL_MACHINE`, the keyring store's `persistence=local` modifier). The keyring crate's default is Enterprise, which roams to the user's other computers in a company domain, and two computers must never share a device identity. |

---

## 10. Website (SITE)

| ID | Requirement |
|---|---|
| SITE-01 | Astro with React islands, static output, hosted on Cloudflare Pages (free plan, commercial use allowed). Components ported to TSX in `packages/ui` from the design system bundle. |
| SITE-02 | Pages: Forside (exactly `ForsideKomplet` from the design system), Hent, Sådan virker det, Privatliv (privacy policy, section 12), Open source, Virksomheder, Sikkerhed (architecture in plain Danish and how to report a vulnerability), Varemærke, Spørgsmål. Hent detects Mac, Windows or a phone before the first paint and shows that visitor's download first and largest: direct links to the newest release's stable assets `releases/latest/download/WalkieTalkey-mac.dmg` (universal) and `WalkieTalkey-windows.exe`, the other platform as a small link, both visible without JavaScript. Phones get the phone app first and are told to install the computer app. The page has the phone app link and a QR code for it (inline SVG, rendered at build time). While the builds are unsigned it gives honest first-open steps (Mac: Systemindstillinger › Anonymitet og sikkerhed › Åbn alligevel; Windows: Edge's download warning › Behold › Vis mere › Behold alligevel, then Flere oplysninger › Kør alligevel), and it links to all releases. |
| SITE-03 | `app.walkietalkey.com` serves the phone app, built from `phone/`. The build is plain static files, so a company can host its own copy (`PhoneAppUrl`, PRIV-03). walkietalkey.com and app.walkietalkey.com are Workers static assets on Workers custom domains, from the same builds as the Pages projects (run 2: Pages custom domains need a DNS record wrangler cannot write). The website links only to walkietalkey.com and its subdomains, never to the pages.dev or workers.dev deployments, which stay up for pairings made with v1. |
| SITE-04 | No cookies and no analytics of any kind, so "Ingen sporing" is true for the website too. No cookie banner is needed. |
| SITE-05 | The contact for everyone (companies, privacy and trademark questions) is `kontakt@walkietalkey.com`, forwarded to the owner with Cloudflare Email Routing (free; live since run 2). No contact form, so no form data to store. Vulnerabilities go through GitHub's private vulnerability reporting (SECURITY.md); open questions may also go to GitHub Discussions. |
| SITE-06 | Lighthouse 95+ on performance and accessibility on mobile. Only one WebGL surface per page. Every animation respects reduced motion. |
| SITE-07 | Open Graph image and favicon from the design system assets. |
| SITE-08 | `/updates/beta.json` (DESK-112) is published by the release workflow. |

## 11. Models and third-party licences

| Component | Licence | What we must do |
|---|---|---|
| Handy | MIT | Keep the licence text and copyright; credit in NOTICE and About; no Handy branding |
| transcribe.cpp and ggml (the speech engine) | MIT | Licence text in `licenses/` |
| Ekko v1 tiny (RyeAI), only if shipped (DESK-35) | NVIDIA Open Model License (base model), CC BY 4.0 (RyeAI's changes), CoRal terms, FTSpeech note | Read all of it before shipping; the CoRal terms must travel with the model; credit in About and NOTICE |
| Edda v0.2 (Alexandra Institute), base Whisper large-v3-turbo (MIT) | Apache-2.0 | Include licence, credit, state our changes on the model card. **Open question:** about 1,690 of Edda's 2,605 training hours are FTSpeech, whose paper says the corpus is "freely available for research purposes only". Before M0 picks the default model, the owner reads the FTSpeech terms (and NST's), asks the Alexandra Institute whether they limit use of the weights, and records the answer in `docs/MODELS.md`. If they do, the default falls back to Handy's Whisper turbo or Parakeet V3 until a Danish model is cleared |
| CoRal dataset terms (behind Edda and Ekko) | Custom | No speech synthesis, no biometric identification. Dictation is fine. Mention in docs |
| Ekko PnC v2 (RyeAI) | CC BY 4.0 plus CoRal terms | Credit in About and NOTICE |
| ONNX Runtime | MIT | Licence text |
| Silero VAD | MIT | Licence text |
| Albert Sans | SIL Open Font License 1.1 | Licence text with the font |
| hviske-v6 | CC BY-NC 4.0 | **Not allowed.** Companies may not use it, so we never ship or recommend it |

A CI check fails the build if a dependency with an unknown or non-permissive licence is added (`cargo deny` for Rust, a licence checker for npm).

## 12. Privacy and data protection (PRIV)

### 12.1 What data exists where

| Data | Where | How long | Who can read it |
|---|---|---|---|
| Audio from the key | computer memory | until transcribed | the user |
| Audio from the phone | phone memory; encrypted in transit; encrypted in the relay buffer if the computer is offline | until transcribed; buffer max 10 minutes | the user's devices only |
| Text | history on the computer it was dictated to; never sent to the phone or other computers | per retention setting (default 14 days) | the user |
| Text sent to AI cleanup | the provider the user chose | per that provider's terms | the provider |
| Device public keys, room ids | relay | until removed or 90 days unused | the relay operator (meaningless on their own) |
| IP addresses, connection times | Cloudflare, as processor for the relay operator | Cloudflare's standard retention | the relay operator |
| Website visits and phone app files | Cloudflare Pages (or the company's `PhoneAppUrl`) | Cloudflare's standard logs; no analytics | the site operator |
| Update checks | GitHub (release files and update manifests) | GitHub's retention | GitHub: IP address and app version |
| Model downloads | GitHub releases, or the company's `ModelBaseUrl` | their retention | GitHub: IP address |
| Shared word list | the company's `VocabularySource` server | the company's rules | the company |

### 12.2 Requirements

| ID | Requirement |
|---|---|
| PRIV-01 | No telemetry, no crash reporting that sends data automatically. A crash dialog may offer "Kopiér fejlrapport" for the user to paste into a GitHub issue themselves. |
| PRIV-02 | The privacy policy (`/privatliv`) states the table above in plain Danish, names the operator of the public relay and website, Cloudflare as processor, and how to contact the operator. |
| PRIV-03 | Companies that want nothing to pass infrastructure we run can self-host the relay (RELAY-14) and the phone app (SITE-03), and set `ModelBaseUrl`. Update checks still go to GitHub unless the company turns updates off and installs them itself. |
| PRIV-04 | Settings that send data anywhere (cloud cleanup, a custom relay) are off by default and clearly labelled. |

## 13. Security and threat model

| Threat | Protection | Not protected |
|---|---|---|
| Someone reads traffic between phone and relay or relay and computer | TLS plus end-to-end AES-GCM | Timing and size of messages are visible to the relay |
| The relay or its operator is compromised | The relay has no encryption keys and cannot swap keys during pairing (join MAC); it can drop or delay frames but not read or forge them | Denial of service |
| Someone photographs the pairing QR, or finds the pairing link in browser history | 10-minute, single-use admission; the fragment is removed from history (PHONE-15); "Var det dig?" on the computer for every join; one tap to remove. After use or expiry the link is useless, because the pair keys also need the phone's private key | A person with physical access to the unlocked computer |
| Stolen phone | Phone lock protects the key; remove it on the computer in seconds | Dictations made by the thief before removal |
| Whoever serves the phone web app (our Pages project or its deploy pipeline) ships JavaScript that reads audio before it is encrypted | The iOS app bundles its code and loads nothing from the web; the PWA is built by CI from the public repo; companies can host the phone app themselves | PWA users trust whoever serves the page, as with any web app |
| Malicious update | Updates are signed with our updater key and the OS signature (Apple notarization, Authenticode) | A compromised owner machine with the signing keys |
| Malicious contribution | Branch protection, review of every PR, CI, dependency licence and advisory checks | Vulnerabilities nobody spots in review |
| Text in the clipboard reaching other devices or clipboard history | DESK-54 | Apps on the same computer that read the clipboard |
| AI provider misuses text | Off by default, explicit consent, show what was sent, on-device options | Provider behaviour once the user opts in |

## 14. Open source operations (OSS)

This section explains how running the project works in practice, step by step.

### 14.1 Creating the repo

| ID | Requirement |
|---|---|
| OSS-01 | A GitHub organisation `walkietalkey` (recommended; keeps the project independent of a personal account, and the repo can still be pinned on the personal profile) owns the repo `walkietalkey/walkietalkey`, public from day one. |
| OSS-02 | The repo is a normal GitHub repo with its own history (run 3): it starts at one root commit, "WalkieTalkey 0.1", authored by the owner, which the tags `v0.1.0` and `models-v1` point at. |
| OSS-03 | The root commit holds the product, its licences (14.2) and the project files (14.3). |

### 14.2 Licence files

| File | Content |
|---|---|
| `LICENSE` | Apache License 2.0, full text, copyright "2026 Navigent.io ApS and the WalkieTalkey contributors" (decision 18.1: Navigent.io ApS, CVR 46285395) |
| `NOTICE` | "WalkieTalkey. Copyright 2026 Navigent.io ApS and the WalkieTalkey contributors". "This product includes software from Handy (MIT, Copyright (c) CJ Pais)". Credits for Edda, Ekko PnC, transcribe.cpp |
| `licenses/Handy-MIT.txt` | Handy's MIT licence, unchanged |
| `TRADEMARKS.md` | The name WalkieTalkey and the logo are not covered by the code licence. Forks must use another name and logo. Saying "based on WalkieTalkey" is fine |

WalkieTalkey is Apache-2.0. Third-party code under MIT keeps its copyright and permission notice (`licenses/`, NOTICE), which is all MIT asks for inside an Apache-2.0 project.

### 14.3 Project files

| File | Content |
|---|---|
| `README.md` | What it is, a GIF of the hero animation, download links, how to build, privacy in three lines, credits |
| `CONTRIBUTING.md` | How to build each part, run tests, commit style, PR checklist. Contributions are accepted under Apache-2.0 (licence section 5); no CLA |
| `CODE_OF_CONDUCT.md` | Contributor Covenant 2.1, contact email |
| `SECURITY.md` | Report vulnerabilities privately through GitHub's "Report a vulnerability" button, never in public issues; we answer within 7 days |
| `CHANGELOG.md` | Keep a Changelog format, one section per release |
| `.github/ISSUE_TEMPLATE/` | Fejl (bug, with version, OS, model, steps), Ønske (feature) |
| `.github/pull_request_template.md` | What and why, tests added, screenshots for UI, checklist |
| `CLAUDE.md` / `AGENTS.md` | Guides for coding agents, with this spec's structure, so they follow it |

### 14.4 GitHub settings

- Branch protection on `main`: pull request required, CI green required, no force pushes. The owner can merge their own PRs.
- Secret scanning with push protection, Dependabot alerts and updates, private vulnerability reporting: all on.
- Issues on. Discussions on (questions go there, not in issues).
- Labels: `bug`, `ønske`, `god første opgave`, `hjælp ønskes`, `dansk-model`, `telefon`, `relæ`, `windows`, `mac`.

### 14.5 Day-to-day

- Someone opens an issue or a PR. CI runs. The owner reviews, asks for changes or merges. Squash merges keep history readable.
- Nobody needs permission to fork or build. Only the owner can publish releases and sign them.
- A healthy rhythm for a side project: look at new issues and PRs once or twice a week, label them, and close what will not be done with a friendly reason.

### 14.6 Releases

| ID | Requirement |
|---|---|
| OSS-20 | Semantic versioning. `0.x` until v1.0. Tag `vX.Y.Z` on `main` triggers the release workflow. |
| OSS-21 | Release workflow: build macOS (arm64 and x64, universal if feasible) and Windows x64; sign and notarize the Mac app (Developer ID); sign the Windows installer (route decided in section 18); create the GitHub Release with assets, Tauri updater signatures and `latest.json`; publish release notes from `CHANGELOG.md`. |
| OSS-22 | The relay deploys only on release tags `relay-vX.Y.Z`, not on every merge, because a deploy restarts every Durable Object and drops all sockets (RELAY-09). `wrangler deploy` with the Cloudflare API token as a secret, after the relay tests pass. The protocol version only changes with a new `/vN/` path, so old apps keep working. |
| OSS-23 | Site deploys from `main` through Cloudflare Pages. |
| OSS-24 | Models are published once per version as the assets of a GitHub release (`models-v1`, made by `models/release.sh`), and the manifest with SHA-256 sums is committed. |
| OSS-25 | Later: Homebrew cask and winget manifests. |
| OSS-26 | `deploy/` holds the managed-settings templates (DESK-102): ADMX/ADML for Windows Group Policy and Intune, and a sample `.mobileconfig` for macOS. |

### 14.7 Keeping dependencies current

- Dependabot opens one grouped pull request per ecosystem each week, and security updates in a group of their own, so they never wait behind routine bumps.
- An update is taken when everything passes. One that breaks something is fixed in our code when it is worth it, or held back with an `ignore` rule in `.github/dependabot.yml` whose comment says why (run 3).

### 14.8 Trademark

- "WalkieTalkey" is used as a name from day one, which gives some protection in Denmark through use. Registration at Patent- og Varemærkestyrelsen if the project grows.
- The logo files in the repo carry a short README: "Ikke omfattet af kodelicensen. Se TRADEMARKS.md."

## 15. Quality

### 15.1 Tests

| Part | Tests |
|---|---|
| Pipeline (Rust) | Unit tests per stage; punctuation trigger; vocabulary replacements; cleanup guardrails with a fake provider |
| Danish accuracy | A test set of 30 to 50 clips: the owner's own dictations (with consent, stored outside the public repo or recorded for the purpose), plus mixed Danish and English sentences. Reports WER, punctuation, the latency of DESK-43 and the AI cleanup time per provider. Runs nightly and before each release, not on every PR (model size). In a release it reports in the run summary and never blocks publishing (run 3) |
| Protocol | Shared test vectors (SEC-05) in TypeScript and Rust; property tests for frame parsing |
| Relay | Vitest with the Cloudflare Workers pool (Miniflare): auth, create (room id binding), join, leave, revoke, routing, liveness timeout, buffering, limits, housekeeping. Tests count storage writes per dictation, so a change that writes per frame fails |
| Phone app | Unit tests (Vitest); Playwright in Chromium and WebKit with a fake microphone stream: pairing, recording, cancel, offline, resend after reconnect, errors |
| Desktop UI | Playwright for settings and onboarding |
| Licences and advisories | `cargo deny`, `cargo audit`, npm licence and audit checks |

### 15.2 CI

- On every PR: lint, type check, unit tests, relay tests, phone tests, desktop build check (macOS and Windows), licence checks.
- On tag: the release workflow (OSS-21). A pull request that changes the release machinery runs the release as a dry run (both builds, updater signatures with a throwaway key, latest.json, the accuracy harness), which publishes nothing (run 3).
- macOS jobs use one released Xcode and its own SDK (`scripts/walkietalkey/ci/select-xcode.sh`), never the image's Command Line Tools SDK, which can be a beta.
- Work style: tests first, then code, all green locally before one push; if CI fails, fix everything in one go before merging.

## 16. Milestones

| Milestone | Content | Done when |
|---|---|---|
| **M0: Prove the model** (no app code) | Convert Edda to GGUF (DESK-29), load it in the desktop app as a custom model, record 20 to 30 real dictations, compare Edda with Ekko v1 tiny (DESK-35) and Whisper turbo on errors and punctuation. On both of the owner's machines (16-inch M1 MacBook Pro and the ThinkPad), measure the wait after release for a 15-second and a 2-minute dictation, and AI cleanup time with the owner's OpenAI key and with Groq or Cerebras. Read Ekko's licence. Ask the Alexandra Institute about the FTSpeech terms (section 11). Decide 18.1 first, then set up the GitHub organisation, Apple Developer Program (an ApS enrolls as an organisation and needs a D-U-N-S number), Cloudflare account and Hugging Face organisation | The owner has used Edda for a few days and the numbers decide the default model per machine, the DESK-43 targets and whether Ekko PnC is needed |
| **M1: Mac alpha** | Rebrand (DESK-01 to 06), onboarding, `fn`, pipeline with Edda and punctuation, paste and clipboard modes, pill, history, model download, Danish UI | The owner dictates on the Mac every day for a week without going back to anything else |
| **M2a: Phone to an online Mac** | Relay (auth, create, join, routing, liveness), protocol, pairing, phone PWA, notifications | Phone dictations land on the Mac over 4G and over office Wi-Fi, typically within 2.5 s of letting go |
| **M2b: When things go wrong** | Buffering for an offline Mac, resend after reconnect, several phones, removing a phone from either side, the PHONE-24 copy | A dictation made while the Mac sleeps arrives when it wakes within 10 minutes, and a removed phone is shut out at once |
| **M3: iPhone app** | Spike first (bundled web app with microphone in WKWebView), then the iOS app (PHONE-03), Universal Links, Privatliv page live, TestFlight | No microphone prompt after the first time |
| **M4: Windows** | Windows build, Right Ctrl or Copilot key, clipboard formats, presence query and routing between two computers | Phone dictations reach the right computer (MacBook or ThinkPad) |
| **M5: Smarter text** | Vocabulary, Udviklerord, AI cleanup with all providers and guardrails | The mixed-language test set improves with cleanup on |
| **M6: v1.0** | Signed and notarized releases, auto-update, managed settings, website, privacy policy, all OSS files, README with GIF | Public launch |
| v1.x | Automatic language, Node relay and Docker image, English UI, Homebrew and winget, lighter Danish model | |

## 17. Costs

| Item | Price | Needed for |
|---|---|---|
| Apple Developer Program | 99 USD per year | Signing and notarizing the Mac app, the iOS app (one membership covers both) |
| Domain walkietalkey.com | about 10 USD per year at cost through Cloudflare Registrar | Website, relay, email |
| Cloudflare (Pages, Workers, Durable Objects, Email Routing) | Workers Paid 5 USD per month for the public relay from launch (8.5, decision 18.6); Pages and Email Routing free | Relay, website, email forwarding |
| GitHub | 0 | Code, releases, model hosting |
| Windows signing | 0 with SignPath Foundation if accepted for open source; about 10 USD per month with Azure Artifact Signing (available to organisations in the EU, so through a company, not as a private person in Denmark); 150 to 300 USD per year for an OV certificate | Avoiding Windows SmartScreen warnings. No option gives instant trust; reputation builds over releases |
| AI cleanup | 0 for us; users bring their own key or use on-device options | |

## 18. Decisions for the owner

1. **Who runs the public relay and website**: decided (run 2): **Navigent.io ApS** (CVR 46285395), the copyright holder in LICENSE and NOTICE and the operator on the privacy page. Was: you personally, or Navigent.io ApS. Decide this first. It decides the name in the privacy policy, who carries the liability, the copyright holder in LICENSE and NOTICE, and how you enroll in the Apple Developer Program (personally, or the ApS as an organisation, which needs a D-U-N-S number). A company limits personal liability; ask an accountant or lawyer if in doubt.
2. **Windows signing**: apply to SignPath Foundation first (free), with Azure Artifact Signing through a company as the fallback. Unsigned beta builds until then.
3. **GitHub home**: organisation `walkietalkey` (recommended) or your personal account.
4. **iPhone**: build the iOS shell in M3 (recommended, because of PHONE-02), or live with the permission prompt in the PWA.
5. **History default**: 14 days (proposed).
6. **Public relay on Workers Paid from launch**: 5 USD per month (recommended), or the free tier with the risk that the relay stops for everyone until midnight UTC on a busy day (8.5).
7. **Edda's training data**: ask the Alexandra Institute whether the FTSpeech terms limit use of the weights (section 11) before M0 picks the default model. Run 2: the owner chose to publish the converted models as assets of the GitHub release `models-v1` (not Hugging Face); the open question only concerns companies' use and stays open.

---

## Appendix A: Danish UI copy

Use these strings exactly. Sentence case, no exclamation marks, no emoji.

**Pill**: Hold fn for at tale · Lytter · Tryk igen for at stoppe (hands-free, run 2) · Renskriver · Indsat · Tekst klar til at indsætte · Hørte ikke noget · Brugte teksten uden oprydning · Talemodellen er ikke klar endnu · Kunne ikke hente talemodellen. Prøv igen.

**Notifications**: Tekst klar til at indsætte · Tryk ⌘V for at indsætte · Tryk Ctrl+V for at indsætte · Ny telefon parret: {navn}. Var det dig? · en telefon uden navn · Opdatering klar. Genstart for at installere · Genstart nu · Ingen forbindelse til telefonen. Prøver igen.

**Phone**: Par med en computer · Scan koden på din computer · Hold for at tale · Slip for at sende · Slip for at annullere · Sender til {computer} · Klar på {computer} · Tryk ⌘V for at indsætte · Tryk Ctrl+V for at indsætte · {computer} er ikke online. Optagelsen venter i 10 minutter. · Nåede ikke frem til {computer}. · Prøv igen · {computer} er sat på pause. · Hørte ikke noget · Noget gik galt. Prøv igen. · Parringen med {computer} er fjernet. Par igen for at bruge den. · Koden er udløbet. Lav en ny på computeren. · WalkieTalkey skal bruge mikrofonen. Slå den til i indstillingerne. · Ingen forbindelse. Prøver igen. · Krypteret fra telefon til computer · Føj WalkieTalkey til hjemmeskærmen for at bruge den · Åbn WalkieTalkey fra hjemmeskærmen og scan koden der.

**Onboarding**: Dansk tale til tekst. Gratis, og det kører på din egen computer. · Kom i gang · Henter dansk talemodel · Talemodellen er klar · WalkieTalkey skal bruge mikrofonen for at høre dig · Hold fn nede og tal · Så teksten kan sættes ind, hvor du skriver · Vil du også kunne tale ind i telefonen? · Spring over · Prøv det

**AI cleanup**: Ryd op med AI · Fra · Når der er noget at rette · Altid · Kun når jeg holder Shift med · Hold talemodellen indlæst

**Cleanup consent**: Teksten (ikke lyden) sendes til {udbyder}, hver gang du dikterer. · Slå til · Annullér

**Key (run 2, from the owner's brief)**: Ret det for mig

**Managed**: Styret af din organisation

**Missing strings**: anything not listed here is drafted in Danish by the implementer, marked `TODO(copy)` in the code, and approved by the owner before release.

## Appendix B: Managed settings

macOS domain `com.walkietalkey.app`; Windows `HKLM\SOFTWARE\Policies\WalkieTalkey` (same names). Every managed value is locked (DESK-101).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `RelayUrl` | string | `wss://relay.walkietalkey.com` | Own relay |
| `PhoneAppUrl` | string | `https://app.walkietalkey.com` | Own copy of the phone app; used in the pairing QR |
| `ModelBaseUrl` | string | our GitHub release `models-v1` | Own model server with the same file names and SHA-256 sums |
| `AllowPhonePairing` | bool | true | Turn off the phone feature |
| `CleanupMode` | `off`, `when-needed`, `always`, `shift` | `off` | AI cleanup mode (DESK-80) |
| `CleanupProvider` | `apple`, `openai`, `anthropic`, `groq`, `cerebras`, `openrouter`, `custom` | | Forces a provider |
| `AllowCloudCleanup` | bool | true | `false` allows only on-device cleanup (Apple Intelligence, or a `custom` endpoint on `localhost`) |
| `CleanupBaseUrl`, `CleanupModel` | string | | For example a company's Azure OpenAI deployment |
| `CleanupApiKey` | string | | Read from the profile at each start and never copied elsewhere. Profile values can be read by every local user, so use a key made for this purpose, with a spending limit |
| `VocabularySource` | path or https URL | | Shared word list, refreshed daily |
| `OutputMode` | `paste`, `clipboard` | `paste` | Key dictations |
| `ShowTextInNotifications` | bool | true | Hide text on shared screens |
| `HistoryRetentionDays` | int | 14 | `0` = Gem ikke, `-1` = Altid |
| `AutoUpdate` | bool | true | |
| `UpdateChannel` | `stable`, `beta` | `stable` | |
| `Model` | model id | by hardware | Pin a model |

## Appendix C: Protocol messages

### C.1 Control messages (JSON text frames, device ↔ relay)

| `t` | Direction | Fields |
|---|---|---|
| `challenge` | relay → device | `n` (32 bytes, base64url) |
| `auth` | member → relay | `id`, `sig` |
| `create` | first device → relay | `pub` (signing SPKI), `salt` (16 bytes), `sig` |
| `join` | new phone → relay | `a` (admission secret), `pub` (signing SPKI), `agree` (agreement SPKI), `mac`, `sig` |
| `ok` | relay → device | `role` (`owner` or `phone`), `members` (`[{id, role, online, lastSeenDay}]`) |
| `add_admission` | owner → relay | `h` (SHA-256 of `a`), `exp` (unix ms) |
| `cancel_admission` | owner → relay | `h` |
| `member_joined` | relay → owner | `id`, `pub`, `agree`, `mac` |
| `member_left` | relay → owner | `id` |
| `leave` | phone → relay | |
| `revoke` | owner → relay | `id` |
| `delete_room` | owner → relay | |
| `peer` | relay → device | `id`, `online` |
| `error` | relay → device | `code`, `msg` |
| `ping` / `pong` | device → relay → device | none; answered automatically (RELAY-10) |

Every control message is a JSON object with its type in `t`. Permission comes from the authenticated socket; only the answers to the challenge are signed. `auth`, `create` and `join` each sign their own label followed by roomId ‖ challenge (`"wt-auth-v1"`, `"wt-create-v1"`, `"wt-join-v1"`) with the signing key whose public half is sent or registered. Public keys are SPKI DER and signatures 64-byte raw r‖s, both base64url (section 9.1).

### C.2 Device frames (binary, end-to-end encrypted, section 9.4)

| Type | Name | Direction | Decrypted payload |
|---|---|---|---|
| 0x10 | `device_info` | phone → computer | `{name, platform}` |
| 0x11 | `presence` | computer → phone | `{secondsSinceInput, locked}`, only as an answer to 0x12 |
| 0x12 | `presence_query` | phone → computer | `{}` |
| 0x20 | `audio_start` | phone → computer | `{sessionId, sampleRate: 16000, codec: "pcm16"}` |
| 0x21 | `audio_chunk` | phone → computer | binary: sessionId (16 bytes) ‖ index of the first 200 ms block (uint32, big-endian) ‖ PCM16 for 1 to 10 blocks |
| 0x22 | `audio_end` | phone → computer | `{sessionId, chunks, durationMs}` |
| 0x23 | `audio_cancel` | phone → computer | `{sessionId}` |
| 0x30 | `result` | computer → phone | `{sessionId, ok, reason?}`; reason is `no_speech`, `model_not_ready`, `too_long`, `paused` or `error`. Never the text |

`sessionId` is 16 random bytes (base64url inside JSON payloads). JSON payloads are UTF-8 before encryption.

### C.3 Close codes

4401 not authorised · 4403 not allowed for this role or wrong sender · 4404 room not found · 4409 room exists · 4413 frame too large · 4429 rate limited

## Appendix D: Where the design system is used

| Place | Components |
|---|---|
| Desktop onboarding | LogoIntro, LogoLoader (`fyld` for the download), ShinyButton, GradientBackground |
| Desktop pill | DictationPill |
| Desktop settings | tokens, ShinyButton, Keycap (key picker), Notice (preview of notifications) |
| Phone app | PhoneApp states, LogoLoader (`ekko` while sending), tokens |
| Website | ForsideKomplet and everything in it (RelayDemo, ShowcaseCard scenes, FlipWords, LightWaves) |
| Loading states anywhere | LogoLoader (`smelt` for general waiting, `glans` in buttons) |

## Appendix E: Glossary

- **Rum (room)**: the private channel between one computer and its phones on the relay.
- **Parring**: the QR step that lets a phone into a room.
- **Relæ**: the server that passes encrypted frames between devices.
- **Edda**: the Danish speech model.
- **PnC**: punctuation and capitalisation model.
- **Oprydning**: the optional AI step that tidies text.
- **API-nøgle**: the user's own key for an AI provider. Only the optional cleanup uses one; it stays in the OS keychain and goes only to that provider.
- **Til stede (presence)**: a computer's answer when a phone asks how recently it was used (DESK-63).

## Sources checked for this spec (October 2026)

- Edda v0.2 model card: huggingface.co/danish-foundation-models/edda-v0.2
- Ekko PnC model card: huggingface.co/RyeAI/ekko-pnc; Ekko v1 tiny: huggingface.co/RyeAI/ekko-v1-tiny
- Cloudflare Durable Objects pricing: developers.cloudflare.com/durable-objects/platform/pricing
- WebKit bug 215884 (microphone permission in home-screen web apps) and follow-up 327237
- Microsoft code signing options: learn.microsoft.com/windows/apps/package-and-deploy/code-signing-options
- Windows clipboard formats for history and cloud clipboard: learn.microsoft.com/windows/win32/dataxchg/clipboard-formats
- Magic links broken by mail scanners: e.g. forum.ghost.org "Magic links don't work when Outlook safe links are enabled"; docs.descope.com/conditions/email-scanner
- Azure Artifact Signing availability (organisations in the EU, individuals only in the US and Canada): learn.microsoft.com/azure/artifact-signing/quickstart
- SignPath Foundation (free code signing for open source): signpath.org
- App Store Review Guidelines 4.2 (minimum functionality): developer.apple.com/app-store/review/guidelines
- Durable Objects WebSocket API (`serializeAttachment` limit, auto-response timestamps) and lifecycle (hibernation conditions, deploy restarts): developers.cloudflare.com/durable-objects/api/state, /api/websockets, /concepts/durable-object-lifecycle
- Workers Rate Limiting binding (10 or 60 s periods, approximate, per location): developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit
- FT Speech paper ("freely available for research purposes only"): arxiv.org/abs/2005.12368
- Apple Intelligence languages in the 26.1 releases: 9to5mac.com (11 November 2025) and developer.apple.com/forums/thread/805378
- Provider latency medians: openrouter.ai model pages (gpt-oss-120b, gpt-6-luna)
- Desktop source, October 2026: model unload default (`settings.rs`), cleanup presets and reasoning switch-off (`llm_client.rs`), filler-word lists (`audio_toolkit/text.rs`)
- Windows keyring store default persistence: github.com/open-source-cooperative/windows-native-keyring-store
- transcribe.cpp (MIT): github.com/handy-computer/transcribe.cpp; Whisper large-v3-turbo speed per machine in docs/models/whisper-large-v3-turbo.md; converters in scripts/
- Live chunking: src-tauri/src/audio_toolkit/chunking.rs and managers/transcription/chunked.rs
- Danish ASR leaderboard (same evaluation for every model): huggingface.co/datasets/RyeAI/danish-asr-leaderboard
- Ekko v1 tiny model card and licence notice: huggingface.co/RyeAI/ekko-v1-tiny
- Edda v0.2 evaluation: huggingface.co/danish-foundation-models/edda-v0.2
- Hetzner GPU server prices (13 October 2026): wz-it.com/en/blog/hetzner-gpu-server-comparison
- OpenAI transcription prices: developers.openai.com/api/docs/pricing
