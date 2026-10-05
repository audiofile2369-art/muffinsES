import { useSyncExternalStore } from 'react'
import { flushToast, getToastSnapshot, subscribeToast, undoToast } from './toast'

/** Renders the one current toast at the bottom, above the tab bar on small screens. */
export function ToastHost() {
  const toast = useSyncExternalStore(subscribeToast, getToastSnapshot)

  return (
    <div className="toast-region" aria-live="polite" aria-atomic="true">
      {toast ? (
        <div className="toast" key={toast.id} data-toast-id={toast.id}>
          <span className="toast-message">{toast.message}</span>
          {toast.canUndo ? (
            <button type="button" className="toast-undo" onClick={() => undoToast()}>
              Undo
            </button>
          ) : null}
          <button
            type="button"
            className="toast-close"
            aria-label="Dismiss"
            onClick={() => void flushToast()}
          >
            ×
          </button>
        </div>
      ) : null}
    </div>
  )
}
