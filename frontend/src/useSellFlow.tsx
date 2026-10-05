import { useState } from 'react'
import type { ReactElement } from 'react'
import { sellItem, unsellItem } from './api'
import { formatCurrency } from './format'
import { SellSheet } from './SellSheet'
import { paymentLabel, restoreSales, writeLastPaymentMethod } from './selling'
import { showToast } from './toast'
import type { ItemRead } from './types'

interface SellFlow {
  /** Open the Sell item sheet (defaultQuantity: e.g. all remaining from the status menu). */
  openSell: (item: ItemRead, defaultQuantity?: number) => void
  /** "Undo sale" on a sold row: removes every sale; the toast's Undo puts them back. */
  undoSale: (item: ItemRead) => Promise<void>
  /** Render this somewhere in the tree (the sheet, when open). */
  sheet: ReactElement | null
}

/**
 * Selling, shared by the sale's item list, All Items and Sale day: the confirm
 * sheet, the API calls, and the Undo toast. `onSaved` receives every updated item.
 */
export function useSellFlow(onSaved: (item: ItemRead) => void, onError: (message: string) => void): SellFlow {
  const [target, setTarget] = useState<{ item: ItemRead; defaultQuantity: number } | null>(null)
  const [busy, setBusy] = useState(false)

  function describe(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown error'
  }

  async function undoSale(item: ItemRead): Promise<void> {
    const previousEvents = item.sale_events ?? []
    try {
      const restored = await unsellItem(item.id)
      onSaved(restored)
      showToast({
        message: `Sale of "${item.title}" undone`,
        onUndo: () => {
          void restoreSales(restored, previousEvents)
            .then(onSaved)
            .catch((error: unknown) => onError(`Could not put the sale back: ${describe(error)}`))
        },
      })
    } catch (error) {
      onError(`Could not undo the sale of "${item.title}": ${describe(error)}`)
    }
  }

  const sheet = target ? (
    <SellSheet
      key={target.item.id}
      item={target.item}
      defaultQuantity={target.defaultQuantity}
      busy={busy}
      onCancel={() => setTarget(null)}
      onConfirm={(payload) => {
        const item = target.item
        const before = new Set((item.sale_events ?? []).map((event) => event.id))
        setBusy(true)
        void sellItem(item.id, payload)
          .then((saved) => {
            setTarget(null)
            writeLastPaymentMethod(payload.payment_method)
            onSaved(saved)
            const newEvent = (saved.sale_events ?? []).find((event) => !before.has(event.id))
            const total = (payload.unit_price ?? item.price ?? 0) * payload.quantity
            showToast({
              message: `Sold ${payload.quantity > 1 ? `${payload.quantity} × ` : ''}"${saved.title}" · ${formatCurrency(total)} ${paymentLabel(payload.payment_method)}`,
              onUndo: newEvent
                ? () => {
                    void unsellItem(saved.id, newEvent.id)
                      .then(onSaved)
                      .catch((error: unknown) => onError(`Could not undo the sale: ${describe(error)}`))
                  }
                : undefined,
            })
          })
          .catch((error: unknown) => {
            setTarget(null)
            onError(`Could not sell "${item.title}": ${describe(error)}`)
          })
          .finally(() => setBusy(false))
      }}
    />
  ) : null

  return {
    openSell: (item, defaultQuantity = 1) => setTarget({ item, defaultQuantity }),
    undoSale,
    sheet,
  }
}
