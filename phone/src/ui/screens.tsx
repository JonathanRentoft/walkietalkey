/** Pairing (PHONE-10..12), the Safari tab notice (PHONE-04) and loading. */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { LogoLoader, Logo, ShinyButton } from "@walkietalkey/ui";
import type { PairingPayload } from "@walkietalkey/protocol";
import type { PairingState } from "../core/controller";
import { parseScanned } from "../lib/pairingLink";
import { createVideoDecoder } from "../lib/qr";
import {
  INSTALL_STEPS,
  installFlow,
  type InstallFlow,
  type InstallIcon,
} from "../lib/install";
import { T, fill } from "../lib/strings";

export function Loading() {
  return (
    <main className="wt-screen wt-screen--center" aria-busy="true">
      <LogoLoader variant="smelt" size={56} />
    </main>
  );
}

function Brand() {
  return (
    <header className="wt-screen-brand">
      <Logo variant="lockup" size={26} />
    </header>
  );
}

/** First screen when not paired (PHONE-10), and "Par med en computer" from settings. */
export function PairScreen(props: {
  onScan: () => void;
  onBack?: () => void;
  message?: string | null;
}) {
  return (
    <main className="wt-screen">
      <Brand />
      <section className="wt-screen-body">
        <h1>{T.pairTitle}</h1>
        <p>{T.pairIntro}</p>
        {props.message ? (
          <p className="wt-screen-alert" role="alert">
            {props.message}
          </p>
        ) : null}
      </section>
      <footer className="wt-screen-actions">
        <ShinyButton size="lg" onClick={props.onScan}>
          {T.scan}
        </ShinyButton>
        {props.onBack ? (
          <button type="button" className="wt-link" onClick={props.onBack}>
            {T.back}
          </button>
        ) : null}
      </footer>
    </main>
  );
}

/** The camera, decoding QR codes in JavaScript (PHONE-10). */
export function ScanScreen(props: {
  onResult: (p: PairingPayload) => void;
  onCancel: () => void;
  allowInsecureLocalhost: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const done = useRef(false);
  const { onResult, allowInsecureLocalhost } = props;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        setProblem(
          name === "NotAllowedError" || name === "SecurityError"
            ? T.cameraDenied
            : T.cameraUnavailable,
        );
        return;
      }
      if (stopped) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      const v = video.current!;
      v.srcObject = stream;
      v.setAttribute("playsinline", "true");
      v.muted = true;
      await v.play().catch(() => undefined);
      let decode;
      try {
        decode = await createVideoDecoder();
      } catch {
        setProblem(T.cameraUnavailable);
        return;
      }
      const step = async () => {
        if (stopped || done.current) return;
        try {
          const text = await decode(v);
          if (text) {
            try {
              const payload = parseScanned(text, { allowInsecureLocalhost });
              done.current = true;
              onResult(payload);
              return;
            } catch {
              setHint(T.notACode);
            }
          }
        } catch {
          /* a frame that could not be read */
        }
        timer = setTimeout(step, 150);
      };
      void step();
    })();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      for (const t of stream?.getTracks() ?? []) t.stop();
    };
  }, [onResult, allowInsecureLocalhost]);

  return (
    <main className="wt-scan">
      <video
        ref={video}
        className="wt-scan-video"
        playsInline
        muted
        aria-hidden
      />
      <div className="wt-scan-frame" aria-hidden />
      <div className="wt-scan-text" role="status">
        <p>{problem ?? hint ?? T.scanHint}</p>
      </div>
      <div className="wt-scan-actions">
        <ShinyButton variant="glass" icon={false} onClick={props.onCancel}>
          {T.cancel}
        </ShinyButton>
      </div>
    </main>
  );
}

function pairingError(p: Extract<PairingState, { state: "error" }>): string {
  if (p.kind === "expired") return T.expired;
  if (p.kind === "full") return fill(T.roomFull, { computer: p.computer });
  if (p.kind === "network") return T.noConnection;
  return T.somethingWrong;
}

/** The phone's name, prefilled (PHONE-12), then the join. */
export function NameScreen(props: {
  payload: PairingPayload;
  defaultName: string;
  pairing: PairingState;
  onPair: (name: string) => void;
  onRescan: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.defaultName);
  const computer = props.payload.n;
  const p = props.pairing;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onPair(name);
  };
  if (p.state === "joining") {
    return (
      <main className="wt-screen wt-screen--center" aria-busy="true">
        <LogoLoader
          variant="smelt"
          size={56}
          label={fill(T.pairing, { computer })}
        />
        <p className="wt-screen-status">{fill(T.pairing, { computer })}</p>
      </main>
    );
  }
  if (p.state === "error") {
    const expired = p.kind === "expired" || p.kind === "full";
    return (
      <main className="wt-screen">
        <Brand />
        <section className="wt-screen-body">
          <h1 aria-live="polite">{pairingError(p)}</h1>
        </section>
        <footer className="wt-screen-actions">
          {expired ? (
            <ShinyButton size="lg" onClick={props.onRescan}>
              {T.scan}
            </ShinyButton>
          ) : (
            <ShinyButton size="lg" onClick={() => props.onPair(name)}>
              {T.retry}
            </ShinyButton>
          )}
          <button type="button" className="wt-link" onClick={props.onCancel}>
            {T.cancel}
          </button>
        </footer>
      </main>
    );
  }
  return (
    <main className="wt-screen">
      <Brand />
      <form className="wt-screen-body" onSubmit={submit} id="wt-name-form">
        <h1>{T.nameTitle}</h1>
        <p>{fill(T.nameHint, { computer })}</p>
        <label className="wt-field">
          <span>{T.nameLabel}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={64}
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="done"
          />
        </label>
      </form>
      <footer className="wt-screen-actions">
        <ShinyButton
          size="lg"
          type="submit"
          form="wt-name-form"
          disabled={!name.trim()}
        >
          {T.pairButton}
        </ShinyButton>
        <button type="button" className="wt-link" onClick={props.onCancel}>
          {T.cancel}
        </button>
      </footer>
    </main>
  );
}

/** Run 6: Safari's buttons as drawn on the iPhone, so the visitor finds the one each step names. */
function InstallIcon(props: { id: InstallIcon }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    className: "wt-install-icon",
  } as const;
  switch (props.id) {
    case "more":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" className="wt-install-ring" />
          <circle cx="7.5" cy="12" r="1.5" className="wt-install-dot" />
          <circle cx="12" cy="12" r="1.5" className="wt-install-dot" />
          <circle cx="16.5" cy="12" r="1.5" className="wt-install-dot" />
        </svg>
      );
    case "share":
      return (
        <svg {...common}>
          <path d="M8.5 9.5H6.8v11h10.4v-11h-1.7M12 14.5V2.8M8.4 6.2 12 2.6l3.6 3.6" />
        </svg>
      );
    case "viewMore":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="10.5" className="wt-install-ring" />
          <path d="m7.6 10.2 4.4 4.4 4.4-4.4" />
        </svg>
      );
    case "addToHome":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="4.5" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "add":
      return null;
  }
}

function InstallSteps(props: { flow: InstallFlow; last: string }) {
  return (
    <ol className="wt-steps wt-install">
      {INSTALL_STEPS[props.flow].map((s) => (
        <li key={s.id} className="wt-install-step" data-step={s.id}>
          <span className="wt-install-text">{s.text}</span>
          <span className="wt-install-button">
            {s.id === "add" ? (
              <span className="wt-install-pill">{s.da}</span>
            ) : (
              <InstallIcon id={s.id} />
            )}
            {s.en !== s.da ? (
              <span className="wt-install-en">
                {T.installEnglish} {s.en}
              </span>
            ) : null}
          </span>
        </li>
      ))}
      <li className="wt-install-step">
        <span className="wt-install-text">{props.last}</span>
      </li>
    </ol>
  );
}

/**
 * PHONE-04: in a Safari tab on iOS, install first. A pairing link opened here never joins
 * (spec 5.3); it stays in the address bar, so the home-screen app pairs on its first launch
 * (run 2, Phase 5). `computer` is the name from a valid link. Run 6: the steps follow the
 * visitor's iOS version (lib/install.ts).
 */
export function InstallScreen(props: {
  computer: string | null;
  fromLink: boolean;
  userAgent?: string;
}) {
  const { computer } = props;
  const { flow, safari } = installFlow(props.userAgent ?? navigator.userAgent);
  const notes = (
    <>
      {!safari ? <p className="wt-install-note">{T.installUseSafari}</p> : null}
      {flow === "compact" ? (
        <p className="wt-install-note">{T.installShareVisible}</p>
      ) : null}
    </>
  );
  // An invalid link: as before, scan in the home-screen app.
  if (props.fromLink && !computer)
    return (
      <main className="wt-screen">
        <Brand />
        <section className="wt-screen-body">
          <h1 aria-live="polite">{T.openFromHome}</h1>
          <p>{T.installTitle}</p>
          <InstallSteps flow={flow} last={T.installOpen} />
          {notes}
        </section>
      </main>
    );
  return (
    <main className="wt-screen">
      <Brand />
      <section className="wt-screen-body">
        <h1>{T.installTitle}</h1>
        <InstallSteps
          flow={flow}
          last={
            computer ? fill(T.installOpenPairs, { computer }) : T.installOpen
          }
        />
        {notes}
        {computer ? (
          <>
            <p>{T.installInTime}</p>
            <p>
              {T.installAlready} {T.openFromHome}
            </p>
          </>
        ) : (
          <p>{T.installWhy}</p>
        )}
      </section>
    </main>
  );
}

/** Shown when the page cannot do WebCrypto (not a secure context). */
export function Unsupported(props: { detail: string }) {
  return (
    <main className="wt-screen">
      <Brand />
      <section className="wt-screen-body">
        <h1 aria-live="polite">{T.somethingWrong}</h1>
        <p>{props.detail}</p>
      </section>
    </main>
  );
}
