// Lightweight toast store — replaces alert() with non-blocking, dismissable
// notifications. Errors persist until dismissed; success/info auto-expire.

import {writable} from "svelte/store";

export type ToastKind = "error" | "success" | "info";
export type Toast = {id: number; kind: ToastKind; message: string};

function createToasts() {
  const {subscribe, update} = writable<Toast[]>([]);
  let seq = 0;

  function push(kind: ToastKind, message: string, ttlMs: number): number {
    const id = ++seq;
    update((list) => [...list, {id, kind, message}]);
    if (ttlMs > 0) setTimeout(() => dismiss(id), ttlMs);
    return id;
  }
  function dismiss(id: number): void {
    update((list) => list.filter((t) => t.id !== id));
  }

  return {
    subscribe,
    dismiss,
    error: (message: string) => push("error", message, 0), // sticky
    success: (message: string) => push("success", message, 5000),
    info: (message: string) => push("info", message, 5000),
  };
}

export const toasts = createToasts();
