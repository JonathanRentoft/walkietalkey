# Changelog

All notable changes to WalkieTalkey are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/) (`0.x` until v1.0). The release workflow publishes the section of a version as its release notes.

## [Unreleased]

## [0.2.2] - 2026-10-26

**På dansk**

- Åbner du WalkieTalkey fra diskbilledet, tilbyder den at flytte sig selv til Programmer med ét klik og åbne igen derfra. Så kan den opdatere sig selv.
- Om WalkieTalkey nævner nu ophavsretten: Jonathan Rentoft og WalkieTalkeys bidragydere.
- Beskederne om mikrofonen bruger nu macOS' eget navn, Anonymitet og sikkerhed.

**In English**

- When WalkieTalkey runs from its disk image, it offers to move itself to Applications with one click ("Flyt til Programmer") and opens again from there, so updates work. A copy already in Applications goes to the Trash. A user who may not write to Applications is told to drag it there instead. "Ikke nu" keeps the reminder in the window (DESK-114).
- For developers: `wt-train report <run>` shows an evaluation as one HTML page (WER and CER with 95 % intervals, per condition, substitutions, deletions and insertions, per English term, and the 25 worst clips with audio and a word diff), `--vs` compares two runs, and every page is attached to its MLflow run.
- For developers: `wt-train pilot record --setup <name>` records 12 pilot sentences for any recording setup (never trained on), `wt-train pilot report` compares the setups (accuracy with base Edda and the audio: level, noise, SNR, clipping), and `wt-train check` sums up the latest recording session in at most 25 lines.
- For developers: the recording mix is configurable (`wt-train plan --mix phone-whisper=40,...`) and has a Mac whisper condition; `wt-train fetch --overlap` checks that FLEURS test shares nothing with Edda's training clips.
- The copyright holder is Jonathan Rentoft in LICENSE, NOTICE, the installers and About; Navigent.io ApS stays the operator of the public relay and the website.
- The owner approved the app's Danish text; on the Mac, the microphone messages name System Settings' pane as macOS does in Danish, "Anonymitet og sikkerhed".
- For developers: the accuracy job's normaliser reads references and the model's text the same way (fractions, abbreviations, units, ordinals, dates, clock times, hyphenated compounds). With identical transcripts, Edda float16 on FLEURS da_dk test goes from 7.21 % to 6.32 % WER and the app path from 7.63 % to 6.72 %; FLEURS no longer reports term accuracy.

## [0.2.1] - 2026-10-25

**På dansk**

- Tilgængelighed viser nu listen, som du ser den i Systemindstillinger, med WalkieTalkey nær bunden og dens kontakt fremhævet.
- Under Indstillinger › Generelt kan du se introduktionen igen. Den ændrer ikke dine tilladelser.
- Under Indstillinger › Model står Edda og de versioner af Edda, du selv har trænet. Du kan skifte frem og tilbage, og Edda bliver altid på computeren.
- Kører WalkieTalkey fra diskbilledet, siger appen det, for så kan den ikke opdatere sig selv. Afslut den, træk den over i Programmer, og åbn den derfra.
- Telefonappen viser de præcise trin i Safari til din version af iOS, med knapperne på dansk og engelsk.

**In English**

- Accessibility: the picture now looks like the real list in System Settings › Privacy & Security › Accessibility, in light and dark, with WalkieTalkey near the bottom and its switch highlighted, and the + and − buttons under the list.
- Indstillinger › Generelt › "Vis introduktionen igen" shows the first-run screens again without asking for, repairing or opening any permission, and without changing the login item or any other setting.
- Indstillinger › Model › "Versioner af Edda" lists the base Edda and every version of it you trained with the workbench, with its version number, date and validation error rate, and switches between them. Rolling back means switching. The base Edda can no longer be deleted from the app, and a missing one is fetched again at start (unless your organisation pins a model).
- When WalkieTalkey runs straight from its disk image, macOS runs a read-only copy that cannot update itself; the window now says so and asks you to open WalkieTalkey from Applications. The download page says the same.
- Phone app: the install steps in Safari follow your iOS version: on iOS 26 and newer ••• › Share › View More › Add to Home Screen › Add, before that Share › Add to Home Screen › Add, each with Safari's button drawn and named in Danish and English.
- For developers: `wt-train export` installs every export as a version of its own (`edda-ft-<slug>-v<N>`) and registers it as version N of `edda-da` in the local MLflow model registry, with its run, metrics and config. `wt-train use <N|edda>` switches the app (through the new `walkietalkey --use-model <id>`), and `wt-train use --list` lists the versions. Every MLflow run is tagged with what it changed: the pipeline around the model or the model's weights.

## [0.2.0] - 2026-10-25

**På dansk**

- Første gang er let: Mac'en beder kun om Mikrofon og Tilgængelighed, og WalkieTalkey spørger aldrig om din adgangskode til nøgleringen, heller ikke efter en opdatering.
- Én gang efter denne opdatering: par telefonen igen. Nøglerne ligger nu i en privat mappe på din Mac i stedet for i nøgleringen. Bruger du AI-oprydning, skal du indtaste din nøgle igen.
- Færre ord, som ingen har sagt: et klik, et åndedrag eller et par ord efter en pause bliver nu skrevet sammen med sætningen ved siden af. På den danske FLEURS-test falder fejlraten gennem appen fra 8,44 % til 7,63 %.
- Ingen store bogstaver midt i en sætning, hvor en lang diktering blev delt ved en pause, og ingen ødelagte tegn i teksten.
- Telefonens lyd kommer 15 dB kraftigere frem. Kommer computeren ikke tilbage, siger telefonen "Par igen" i stedet for bare at vente.
- Giver mikrofonen ingen lyd, siger pillen det og foreslår en mikrofon, der virker.
- Telefonen tilbydes først efter din første diktering, der virker.

**In English**

- A first run as light as it gets: a new Mac asks for two permissions, Microphone and Accessibility, and nothing else, ever.
- No more keychain dialog on the Mac, neither on a fresh install nor after an update. The app's keys now live in a private folder only WalkieTalkey writes (excluded from Time Machine and bound to this Mac) instead of the keychain, which asked for your password after every update of an app without an Apple Developer ID, and froze the app until you answered. **Once after updating:** pair your phone again (the app says so), and enter your AI cleanup API key again. The old keychain items "WalkieTalkey relay" and "WalkieTalkey AI cleanup" are never read again; you can delete them in Nøgleringsadgang (Keychain Access) if you like.
- A remote-control flag during start-up can no longer stop the key for good: nothing starts before the app is ready, and one failed step never ends the dictation coordinator.
- Mikrofon: after you have said no once, the one button opens the right pane in System Settings at the first click.
- Pairing a phone comes after your first dictation that works, never before: Telefon follows Prøv det only when it worked, and otherwise the window offers it once, after the first dictation that works.
- On the phone, a pairing whose computer never comes back no longer just waits: a computer away for days says so and offers "Par igen", so does a dictation that never arrived, and pairing the same computer again replaces its old pairing. An old pairing code no longer breaks a pairing that works.
- No more invented words after a pause: a click, a breath or a few words on their own after a pause are now transcribed together with the sentence next to them, where Edda used to write words nobody said ("Tester en to tre fire fem seks syv otte."). On the Danish FLEURS test, the error rate through the app falls from 8.44 % to 7.63 %, and the same recording always gives the same text.
- For developers: `walkietalkey --transcribe-list <file> --key-recording` (or `--transcribe-file`) measures files as a key recording captures them, after the recorder's own silence removal.
- On a Mac, "Sådan løser du det" in the Secure Input warning opens WalkieTalkey's own answer on walkietalkey.com.
- The About screen lists third-party code and models with their licences.
- Up to date: Tauri 2.12 and its plugins, and p256 0.14 in the encryption between phone and computer (RUSTSEC-2026-0387). Nothing changes on the wire, so paired phones keep working.
- For packagers: the environment variables are now `WALKIETALKEY_*` (for example `WALKIETALKEY_DISABLE_UPDATER`), and Linux packages keep their libraries in `/usr/lib/WalkieTalkey`.
- Releases name the updater archive with the version (`WalkieTalkey_<version>_universal.app.tar.gz`); the direct downloads `WalkieTalkey-mac.dmg` and `WalkieTalkey-windows.exe` keep their names.
- The pill's glow is no longer cut off in a hard rectangle: its window leaves room for the whole glow, has no window shadow, and lets clicks through everywhere except on the pill.
- Dictations from the phone arrive 15 dB louder, about as loud as the Mac's microphone, with a limiter so nothing clips.
- On the phone, a press right after coming back to the app could record nothing and be dropped: the microphone now always starts again.
- When the microphone gives no sound at all (an audio interface with nothing plugged in, a muted input), the pill and the window say "Mikrofonen giver ingen lyd" and offer a microphone that works. WalkieTalkey never records the computer's own sound instead.
- No more broken characters ("mødet��") or letters from other scripts in the text: a piece that comes back with them is transcribed again without the developer vocabulary, and any left are removed.
- No more capital letters in the middle of a sentence where a long dictation was cut at a pause ("og ikke bare Kaster mig"): each joint is read again by the punctuation model, which also removes a full stop that does not belong there.
- For developers: a fine-tuning workbench in `training/` (`wt-train`): about 1,000 sentences with English developer terms, a recorder, LoRA training on Edda, evaluation like the accuracy job, and export to the app.
- For developers: the workbench tracks every training, evaluation and export in a local MLflow store (`wt-train ui`), and `wt-train card <run>` starts a lab-journal page from a run.
- For developers: `wt-train record` records training sentences on the paired phone (whispered or in a normal voice) or on the Mac, through exactly the audio path of a dictation; the phone shows the sentence in large text, and the takes never reach the clipboard or the history.
- A fine-tuned Edda from the training workbench (`training/`) appears in the model list and is decoded like Edda; it can no longer be "downloaded again", which deleted it.
- `walkietalkey --transcribe-list <file> --json` transcribes many WAV files with the model loaded once.
- Up to date: TypeScript 6, Tauri 2.12.5, openssl 0.10.81 and pytest 9.

## [0.1.0] - 2026-10-24

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
