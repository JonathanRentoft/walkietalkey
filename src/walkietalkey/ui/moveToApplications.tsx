// "Flyt til Programmer" (DESK-114). Opened straight from its disk image,
// WalkieTalkey runs from a read-only copy that cannot update itself
// (DESK-113). A dialog offers the move once per start, over the onboarding as
// over the main window; after "Ikke nu" the main window's banner keeps the
// same button. The backend copies the app to Programmer, opens it from there
// and quits this copy (src-tauri/src/walkietalkey/move_app.rs).
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { commands } from "@/bindings";
import { Button, Dialog } from "./controls";

type MoveFailure = "not_writable" | "failed";

interface DiskImageState {
  /** null until the backend has answered. */
  fromImage: boolean | null;
  /** The offer at start, until it is answered. */
  offerOpen: boolean;
  moving: boolean;
  error: MoveFailure | null;
  load: () => Promise<void>;
  notNow: () => void;
  move: () => Promise<void>;
}

let loading: Promise<void> | null = null;

export const useDiskImage = create<DiskImageState>((set, get) => ({
  fromImage: null,
  offerOpen: false,
  moving: false,
  error: null,
  load: () => {
    loading ??= commands
      .wtRunsFromDiskImage()
      .catch(() => false)
      .then((fromImage) => set({ fromImage, offerOpen: fromImage }));
    return loading;
  },
  notNow: () => set({ offerOpen: false }),
  move: async () => {
    if (get().moving) return;
    set({ moving: true, error: null });
    try {
      const r = await commands.wtMoveToApplications();
      // On success the app quits and opens again from Programmer.
      if (r.status === "error") {
        console.warn("Could not move WalkieTalkey:", r.error);
        set({
          moving: false,
          error: r.error.kind === "not_writable" ? "not_writable" : "failed",
        });
      }
    } catch (e) {
      console.warn("Could not move WalkieTalkey:", e);
      set({ moving: false, error: "failed" });
    }
  },
}));

function MoveButton(props: { variant?: "primary" | "secondary" }) {
  const { t } = useTranslation();
  const moving = useDiskImage((s) => s.moving);
  const move = useDiskImage((s) => s.move);
  return (
    <Button
      variant={props.variant}
      data-autofocus
      disabled={moving}
      onClick={() => void move()}
    >
      {moving ? t("wt.move.moving") : t("wt.move.move")}
    </Button>
  );
}

function failureText(error: MoveFailure) {
  return error === "not_writable" ? "wt.move.notWritable" : "wt.move.failed";
}

/** The offer at start (GlobalDialogs). */
export function MoveToApplicationsDialog() {
  const { t } = useTranslation();
  const open = useDiskImage((s) => !!s.fromImage && s.offerOpen);
  const moving = useDiskImage((s) => s.moving);
  const error = useDiskImage((s) => s.error);
  const load = useDiskImage((s) => s.load);
  const notNow = useDiskImage((s) => s.notNow);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Dialog
      open={open}
      alert
      title={t("wt.move.title")}
      onCancel={notNow}
      actions={
        error ? (
          <Button variant="primary" data-autofocus onClick={notNow}>
            {t("wt.common.close")}
          </Button>
        ) : (
          <>
            <Button variant="quiet" disabled={moving} onClick={notNow}>
              {t("wt.move.notNow")}
            </Button>
            <MoveButton variant="primary" />
          </>
        )
      }
    >
      <p>{t("wt.move.body")}</p>
      {error ? (
        <p role="alert" className="wt-status wt-status--warn">
          {t(failureText(error))}
        </p>
      ) : null}
    </Dialog>
  );
}

/** Run 6's banner in the main window, now with the same button. */
export function DiskImageBanner() {
  const { t } = useTranslation();
  const fromImage = useDiskImage((s) => s.fromImage);
  const error = useDiskImage((s) => s.error);
  const load = useDiskImage((s) => s.load);
  useEffect(() => {
    void load();
  }, [load]);
  if (!fromImage) return null;
  return (
    <div className="wt-banner" role="status" data-testid="disk-image-notice">
      <div className="wt-banner-text">
        <p>{t("wt.updates.fromDiskImage")}</p>
        {error ? (
          <p className="wt-banner-sub">{t(failureText(error))}</p>
        ) : null}
      </div>
      {/* A standard user cannot move it; the text says how instead. */}
      {error === "not_writable" ? null : <MoveButton />}
    </div>
  );
}
