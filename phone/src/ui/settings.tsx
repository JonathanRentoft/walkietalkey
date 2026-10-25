/** Phone settings (spec 7.6) and the small sheets: computer picker (PHONE-41), Detaljer, notices. */
import { useState, type ReactNode } from "react";
import { ShinyButton } from "@walkietalkey/ui";
import type { ComputerView, Notice, Snapshot } from "../core/controller";
import { T, fill } from "../lib/strings";

declare const __APP_VERSION__: string;

export function SettingsScreen(props: {
  snap: Snapshot;
  onBack: () => void;
  onPair: () => void;
  onRemove: (roomId: string) => Promise<void>;
  onHaptics: (on: boolean) => void;
}) {
  const { snap } = props;
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <main className="wt-screen wt-settings">
      <header className="wt-settings-head">
        <button type="button" className="wt-link" onClick={props.onBack}>
          {T.back}
        </button>
        <h1>{T.settings}</h1>
      </header>

      <section aria-labelledby="wt-s-computers">
        <h2 id="wt-s-computers">{T.pairedComputers}</h2>
        {snap.rooms.length === 0 ? <p>{T.noComputers}</p> : null}
        <ul className="wt-list">
          {snap.rooms.map((r) => (
            <li key={r.roomId} className="wt-list-row">
              <div className="wt-list-main">
                <b>{r.name}</b>
                <span>
                  <i
                    className={"wt-dot" + (r.online ? " wt-dot--on" : "")}
                    aria-hidden
                  />
                  {r.online ? T.online : T.offline}
                </span>
                <span>
                  {fill(T.phoneName, { computer: r.name, name: r.deviceName })}
                </span>
              </div>
              {confirm === r.roomId ? (
                <div
                  className="wt-confirm"
                  role="group"
                  aria-label={fill(T.removeConfirm, { computer: r.name })}
                >
                  <p>{fill(T.removeConfirm, { computer: r.name })}</p>
                  <p>{fill(T.removeHint, { computer: r.name })}</p>
                  <div className="wt-confirm-actions">
                    <button
                      type="button"
                      className="wt-pill-btn wt-pill-btn--danger"
                      disabled={busy === r.roomId}
                      onClick={async () => {
                        setBusy(r.roomId);
                        await props.onRemove(r.roomId);
                        setBusy(null);
                        setConfirm(null);
                      }}
                    >
                      {T.remove}
                    </button>
                    <button
                      type="button"
                      className="wt-pill-btn"
                      onClick={() => setConfirm(null)}
                    >
                      {T.cancel}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  className="wt-pill-btn"
                  onClick={() => setConfirm(r.roomId)}
                  aria-label={`${T.remove} ${r.name}`}
                >
                  {T.remove}
                </button>
              )}
            </li>
          ))}
        </ul>
        <ShinyButton onClick={props.onPair}>{T.pairTitle}</ShinyButton>
      </section>

      <section aria-labelledby="wt-s-haptics">
        <h2 id="wt-s-haptics">{T.haptics}</h2>
        <label className="wt-choice wt-choice--switch">
          <input
            type="checkbox"
            role="switch"
            checked={snap.settings.haptics}
            onChange={(e) => props.onHaptics(e.target.checked)}
          />
          <span>{T.hapticsOn}</span>
        </label>
      </section>

      <section aria-labelledby="wt-s-about">
        <h2 id="wt-s-about">{T.about}</h2>
        {T.aboutLines.map((l) => (
          <p key={l}>{l}</p>
        ))}
        <p>{T.credits}</p>
        <p className="wt-muted">
          {fill(T.version, { version: __APP_VERSION__ })}
        </p>
      </section>
    </main>
  );
}

function Sheet(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="wt-sheet-backdrop" onClick={props.onClose}>
      <div
        className="wt-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

/** PHONE-41: tap the chip to pick another computer for the next dictation. */
export function PickerSheet(props: {
  rooms: ComputerView[];
  target: string | null;
  onPick: (roomId: string) => void;
  onPair: () => void;
  onSettings: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={T.pickTitle} onClose={props.onClose}>
      <ul className="wt-list" role="listbox" aria-label={T.pickTitle}>
        {props.rooms.map((r) => (
          <li key={r.roomId}>
            <button
              type="button"
              role="option"
              aria-selected={r.roomId === props.target}
              className={
                "wt-pick" + (r.roomId === props.target ? " wt-pick--on" : "")
              }
              onClick={() => props.onPick(r.roomId)}
            >
              <b>{r.name}</b>
              <span>
                <i
                  className={"wt-dot" + (r.online ? " wt-dot--on" : "")}
                  aria-hidden
                />
                {r.online ? T.online : T.offline}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="wt-sheet-actions">
        <button type="button" className="wt-pill-btn" onClick={props.onPair}>
          {T.pairTitle}
        </button>
        <button
          type="button"
          className="wt-pill-btn"
          onClick={props.onSettings}
        >
          {T.settings}
        </button>
      </div>
    </Sheet>
  );
}

/** PHONE-25: what went wrong. */
export function DetailsSheet(props: {
  detail: string | null;
  onClose: () => void;
}) {
  const code = props.detail ?? "unknown";
  const key = code.startsWith("mic:") ? "mic" : code;
  return (
    <Sheet title={T.details} onClose={props.onClose}>
      <p>{T.detail[key] ?? T.detail.unknown}</p>
      <p className="wt-muted">{fill(T.detailCode, { code })}</p>
      <div className="wt-sheet-actions">
        <button type="button" className="wt-pill-btn" onClick={props.onClose}>
          {T.ok}
        </button>
      </div>
    </Sheet>
  );
}

/** PHONE-14: the pairing was removed on the other side. */
export function NoticeDialog(props: {
  notice: Notice;
  onPair: () => void;
  onClose: () => void;
}) {
  return (
    <div className="wt-sheet-backdrop">
      <div
        className="wt-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-label={fill(T.removed, { computer: props.notice.computer })}
      >
        <p className="wt-sheet-lead">
          {fill(T.removed, { computer: props.notice.computer })}
        </p>
        <div className="wt-sheet-actions">
          <button
            type="button"
            className="wt-pill-btn wt-pill-btn--ink"
            onClick={props.onPair}
          >
            {T.pairAgain}
          </button>
          <button type="button" className="wt-pill-btn" onClick={props.onClose}>
            {T.ok}
          </button>
        </div>
      </div>
    </div>
  );
}
