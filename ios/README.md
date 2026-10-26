# WalkieTalkey for iPhone (the iOS shell)

A thin SwiftUI app around the phone web app in `phone/` (spec 7.1, PHONE-02 to PHONE-04). The phone build is bundled inside the app and served at `walkietalkey://localhost/` by a `WKURLSchemeHandler`, so the app loads nothing from the web.

Why a shell at all: a home-screen web app on iOS asks for the microphone again in every new session (PHONE-02, WebKit bugs 215884 and 327237). In an app, `WKUIDelegate` grants the microphone and camera to the page, so the user sees only the normal one-time iOS prompt. The keys stay non-extractable WebCrypto keys in IndexedDB (PHONE-13), in the app's own persistent `WKWebsiteDataStore`, not in Safari's storage, which Safari may clear (PHONE-04).

Native value beyond a website in a frame (PHONE-03, App Store guideline 4.2):

- Haptic ticks on start and stop (PHONE-27).
- "Start diktering", an App Intent with an App Shortcut: Siri, Spotlight, the Shortcuts app, the Action button, and Control Center through the Shortcuts control.
- Pairing links as Universal Links (PHONE-11): scanning the computer's QR code with the normal camera opens the app on the pairing page.

## Layout

```
ios/
  project.yml                          XcodeGen spec; WalkieTalkey.xcodeproj and Support/Info.plist are generated (not in git)
  scripts/bundle-phone.sh              builds phone/ and copies phone/dist into Web/
  Web/                                 the bundled phone build (generated, not in git; only .gitkeep is)
  Support/WalkieTalkey.entitlements    Associated Domains, used once a signing team exists
  WalkieTalkey/
    App/                               SwiftUI entry point; onOpenURL and Universal Links
    Shell/                             the WKWebView owner, the scheme handler, the haptics bridge
    Intents/                           "Start diktering" App Intent and App Shortcut
    Logic/                             plain Foundation types (no WebKit), unit-tested
    Assets.xcassets                    app icon (packages/ui/assets/App-ikoner/app-icon.png), background colour
  WalkieTalkeyTests/                   XCTest unit tests for Logic/
```

## The contract with the web app

| Shell (this folder)                                                                                                                                 | Web app (`phone/`)                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Serves `walkietalkey://localhost/`: exact files, `/p` from `p.html`, `index.html` for other paths without an extension, 404 otherwise, `..` refused | Every URL in the build is relative (`base: "./"`)                                                                                             |
| Adds `WalkieTalkeyIOS/<version>` to the user agent and registers the `haptics` message handler                                                      | `detectPlatform` treats either, or a non-http(s) protocol, as the shell (`phone/src/lib/platform.ts`)                                         |
| `haptics` messages `"start"` and `"stop"` play a medium and a light impact                                                                          | `haptic()` posts them (`phone/src/lib/device.ts`)                                                                                             |
| "Start diktering" on a cold start loads `walkietalkey://localhost/?start=1`                                                                         | `main.tsx` removes `start=1` and starts a tap-mode recording once it has loaded its pairings, unless a pairing link is open                   |
| "Start diktering" on a loaded page runs `window.dispatchEvent(new CustomEvent('wt-shell-start'))`                                                   | `App.tsx` listens for `wt-shell-start`                                                                                                        |
| `https://app.walkietalkey.com/p#…` and `https://walkietalkey-app.pages.dev/p#…` load `walkietalkey://localhost/p#…`; any other link is ignored      | The page reads the fragment and removes it from history (PHONE-15)                                                                            |
| Grants microphone and camera to `walkietalkey://localhost` only; links to the web and `mailto:` open outside the app                                | No service worker in the shell (only registered on http(s))                                                                                   |
| Associated Domains `applinks:app.walkietalkey.com` and `applinks:walkietalkey-app.pages.dev`                                                        | Serves `/.well-known/apple-app-site-association` for `TEAMID.com.walkietalkey.ios`, paths `/p` with any fragment (`phone/public/.well-known`) |

## Building

CI (`build-ios` in `.github/workflows/ci.yml`, on `macos-26`) builds for the simulator without signing:

```
bun install --frozen-lockfile && brew install xcodegen
bash ios/scripts/bundle-phone.sh
cd ios && xcodegen generate
xcodebuild -project WalkieTalkey.xcodeproj -scheme WalkieTalkey -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

`bundle-phone.sh` works from any directory and fails when the phone build fails. `PHONE_DIST=<dir>` copies an existing build instead of building `phone/`. Cloudflare's `_headers`, `_redirects` and `.well-known/` are left out of the bundle.

CI only builds the app. The unit tests run with `xcodebuild test -project WalkieTalkey.xcodeproj -scheme WalkieTalkey -destination 'platform=iOS Simulator,name=<an installed iPhone simulator>'`. They cover the scheme handler's path resolution and MIME types, the pairing-link mapping and what "Start diktering" loads or runs.

Debug builds set `isInspectable`, so Safari's Web Inspector can attach (Develop menu, the iPhone, WalkieTalkey).

## Prepared, and what needs the Apple Developer membership

Prepared now: bundle id `com.walkietalkey.ios`, display name WalkieTalkey, iOS 17, iPhone only, portrait, app icon, Danish permission texts, the Associated Domains entitlement file, and the App Intent. The owner approved its Danish copy in run 8 (the permission texts in `project.yml`, the intent's description and phrases in `Intents/StartDictationIntent.swift`; spec Appendix A).

Needs the team (spec 17, one membership covers the Mac and iOS apps):

- **Signing**: set `DEVELOPMENT_TEAM` under `targets.WalkieTalkey.settings.base` in `project.yml`.
- **Universal Links**: add this line next to it, so the entitlement is used:
  ```yaml
  CODE_SIGN_ENTITLEMENTS: Support/WalkieTalkey.entitlements
  ```
  The App ID needs the Associated Domains capability (automatic signing adds it), and `TEAMID` in `phone/public/.well-known/apple-app-site-association` must become the team id.
- **TestFlight**: archive the Release configuration and upload it. App Store Connect asks about encryption: the app uses the system's standard cryptography (WebCrypto) for end-to-end encryption. `ITSAppUsesNonExemptEncryption` is not set yet, so the answer is given per upload until the owner decides.
- **App Store listing**: the privacy policy URL `https://walkietalkey.com/privatliv` (the Privatliv page must be live, M3), the privacy details from `docs/PRIVACY.md`, and review notes that point out the native features above. Review needs a paired computer, so a short video of a dictation helps.

## PHONE-03 spike checklist (on a real iPhone)

Run a Debug build from Xcode on the device and tick each item:

- [ ] The app opens on "Par med en computer"; in the Web Inspector `location.origin` is `walkietalkey://localhost` and `isSecureContext` is `true`.
- [ ] Microphone: the first recording shows the iOS prompt once, with the Danish text. After force-quitting and reopening, a recording starts with no prompt (the M3 goal).
- [ ] Camera: scanning shows the camera prompt once, and the QR code is read.
- [ ] AudioWorklet: the level meter moves while recording and the computer receives the audio.
- [ ] WebCrypto: pairing completes; the keys are non-extractable.
- [ ] IndexedDB: after force-quitting, and after a restart of the phone, the paired computer is still there.
- [ ] Haptics: a tick on start and on stop when the setting is on.
- [ ] "Start diktering" from the Shortcuts app, the Action button and the Control Center Shortcuts control, both with the app killed and with it in the background, starts a tap-mode recording.
- [ ] Universal Link (needs signing and the association file): scanning the computer's QR code with the Camera app opens WalkieTalkey on the name screen, and the fragment is gone.
- [ ] The screen stays awake while recording (Screen Wake Lock in WKWebView); if not, a native idle-timer bridge is the fallback.
- [ ] Leaving the app or locking the phone during a recording behaves as the web app expects.
- [ ] Links to the web open in Safari, not inside the app.
- [ ] Dark mode: no white flash at launch.

Already seen in a macOS WKWebView with this shell's code and the bundled phone build (same engine, not a device): the module scripts run from `walkietalkey://localhost/`, it is a secure context, a non-extractable ECDSA key signs and is stored in and read back from IndexedDB, the AudioWorklet module loads through the scheme handler, the MIME types, 404 and SPA fallback are right, `wt-shell-start` arrives once, and the web app removes the pairing fragment and `?start=1` itself.
