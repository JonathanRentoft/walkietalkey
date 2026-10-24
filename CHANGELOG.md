# Changelog

All notable changes to WalkieTalkey are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (`0.x` until v1.0). The release workflow publishes the section of a version as its release notes.

## [Unreleased]

<!-- TODO(copy): the Danish release notes -->

**In English**

- On a Mac, "Sådan løser du det" in the Secure Input warning opens WalkieTalkey's own answer on walkietalkey.com.
- The About screen lists third-party code and models with their licences.
- Up to date: Tauri 2.12 and its plugins, and p256 0.14 in the encryption between phone and computer (RUSTSEC-2026-0387). Nothing changes on the wire, so paired phones keep working.
- For packagers: the environment variables are now `WALKIETALKEY_*` (for example `WALKIETALKEY_DISABLE_UPDATER`), and Linux packages keep their libraries in `/usr/lib/WalkieTalkey`.
- Releases name the updater archive with the version (`WalkieTalkey_<version>_universal.app.tar.gz`); the direct downloads `WalkieTalkey-mac.dmg` and `WalkieTalkey-windows.exe` keep their names.

## [0.1.0] - 2026-10-24

<!-- TODO(copy): the Danish release notes -->

**På dansk**

Den første udgave af WalkieTalkey: dansk tale til tekst på din egen computer, gratis og open source.

- Hold fn nede på en Mac (højre Ctrl på Windows), tal, og slip. Eller tryk én gang for at tale uden at holde tasten, og tryk igen for at stoppe.
- Talen bliver til tekst på din egen computer med Edda, en dansk talemodel. Appen henter den selv første gang, mens du gør resten klar.
- Telefonappen: hold knappen, eller tryk én gang, og teksten lander i udklipsholderen på din computer. Krypteret fra telefon til computer.
- Kom i gang på få trin: mikrofon, tilgængelighed (Mac) og prøv det. Ingen konto, ingen sporing.
- Appen er endnu ikke signeret af Apple eller Microsoft. På Mac åbner du appen én gang og trykker derefter Åbn alligevel under Systemindstillinger › Anonymitet og sikkerhed. På Windows trykker du Flere oplysninger › Kør alligevel.

**In English**

The first WalkieTalkey release: Danish dictation on your own computer, free and open source.

- Hold `fn` on a Mac (Right Ctrl on Windows), talk and release; or tap once to talk hands-free and tap again to stop. WalkieTalkey only needs Accessibility on the Mac, and offers to stop the Globe key's own action with one button.
- Edda v0.2 as the Danish speech model, converted to GGUF and checked against the original, downloaded by the app from the `models-v1` release; Ekko v1 Tiny as the fast model for slower computers; Ekko PnC punctuation on the computer.
- Transcription while you talk, piece by piece at pauses, so a long dictation waits about as long as a short one.
- Danish filler words removed, your own words and replacements (Ordliste), and the Udviklerord pack for English developer words, on by default.
- Optional AI cleanup with your own provider and key (off by default), with consent, guardrails and "Vis hvad der blev sendt".
- The phone app at app.walkietalkey.com: tap or hold the button, and the text lands on your computer's clipboard with a notification. Pairing by QR code, end-to-end encryption through a relay that cannot read the audio, no accounts.
- A larger, calmer desktop app with a floating pill and live waveform while you talk, for key and phone dictations.
- History with retention, a menu bar menu with Seneste, Par en telefon and Sæt på pause, managed settings for companies, updates with stable and beta channels.
- The website at walkietalkey.com with direct downloads and the privacy policy.
- Not signed by Apple or Microsoft yet: the first time, macOS 15 and later needs Open Anyway under System Settings › Privacy & Security, and Windows SmartScreen needs More info › Run anyway.

[Unreleased]: https://github.com/JonathanRentoft/walkietalkey/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/JonathanRentoft/walkietalkey/releases/tag/v0.1.0
