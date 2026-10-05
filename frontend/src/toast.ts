/**
 * One-at-a-time toast store ("Saved. Undo"). Any part of the app can call
 * showToast(); <ToastHost /> renders it. When a toast ends without Undo
 * (timeout, Dismiss, a newer toast, or flushToast()) its onExpire runs, which
 * is how a delayed action such as a delete is finally carried out.
 */

export interface ToastOptions {
  message: string
  /** Shown as the Undo button; no button when omitted. */
  onUndo?: () => void
  /** Runs once when the toast ends any way other than Undo. */
  onExpire?: () => void | Promise<void>
  durationMs?: number
}

export interface ToastState {
  id: number
  message: string
  canUndo: boolean
}

interface ActiveToast extends ToastState {
  options: ToastOptions
  timer: number
}

const DEFAULT_DURATION_MS = 6000

let active: ActiveToast | null = null
let snapshot: ToastState | null = null
let nextId = 1
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = active ? { id: active.id, message: active.message, canUndo: active.canUndo } : null
  for (const listener of listeners) {
    listener()
  }
}

/** End the current toast without Undo; resolves once its onExpire has finished. */
export function flushToast(): Promise<void> {
  const current = active
  if (!current) {
    return Promise.resolve()
  }
  window.clearTimeout(current.timer)
  active = null
  publish()
  return Promise.resolve(current.options.onExpire?.()).catch(() => undefined)
}

export function showToast(options: ToastOptions): void {
  void flushToast()
  const id = nextId++
  active = {
    id,
    message: options.message,
    canUndo: Boolean(options.onUndo),
    options,
    timer: window.setTimeout(() => {
      if (active?.id === id) {
        void flushToast()
      }
    }, options.durationMs ?? DEFAULT_DURATION_MS),
  }
  publish()
}

export function undoToast(): void {
  const current = active
  if (!current) {
    return
  }
  window.clearTimeout(current.timer)
  active = null
  publish()
  current.options.onUndo?.()
}

export function subscribeToast(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getToastSnapshot(): ToastState | null {
  return snapshot
}

// A pending action (e.g. a delayed delete) must not be lost when the page goes away.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void flushToast())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      void flushToast()
    }
  })
}
