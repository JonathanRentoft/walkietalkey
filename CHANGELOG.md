# Changelog

All notable changes to WalkieTalkey are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (`0.x` until v1.0). The release workflow publishes the section of a version as its release notes.

## [Unreleased]

## [0.1.0] - 2026-10-23

The first WalkieTalkey release, built on Handy.

### Added

- Danish dictation with the `fn` key on a Mac (Right Ctrl on Windows): hold to talk, release to paste where you type, or to the clipboard.
- Edda v0.2 as the Danish speech model, converted to GGUF and checked against the original; Ekko v1 Tiny as the fast model for slower computers; Ekko PnC punctuation on the computer.
- Transcription while you talk: 10 to 18 second chunks with the previous chunk as context, so a long dictation waits about as long as a short one.
- Danish filler words removed, your own words and replacements (Ordliste), the Udviklerord pack.
- Optional AI cleanup with your own provider and key (off by default), with consent, guardrails, chunk-by-chunk cleanup and "Vis hvad der blev sendt".
- The phone app: hold the button, and the text lands on your computer's clipboard with a notification. Pairing by QR code, end-to-end encryption through a relay that cannot read the audio, no accounts.
- The relay: a Cloudflare Worker with one Durable Object per room.
- History with retention, a menu bar menu with Seneste, Par en telefon and Sæt på pause, managed settings for companies, updates with stable and beta channels.
- The website and the privacy policy.

[Unreleased]: https://github.com/JonathanRentoft/walkietalkey/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JonathanRentoft/walkietalkey/releases/tag/v0.1.0
