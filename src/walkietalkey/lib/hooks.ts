import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Listens to a backend event while the component is mounted. The latest
 *  handler is always used, so callers need not memoise it. */
export function useTauriEvent<T>(event: string, handler: (payload: T) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    listen<T>(event, (e) => ref.current(e.payload))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.warn(`Could not listen to ${event}:`, e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [event]);
}

/** The current time, ticking every `ms` while `active`. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
