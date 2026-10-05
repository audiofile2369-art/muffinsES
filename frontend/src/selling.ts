import { sellItem, updateItemStatus } from './api'
import type { ItemRead, ItemSaleEvent, PaymentMethod } from './types'

export const PAYMENT_METHODS: Array<{ key: PaymentMethod; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'card', label: 'Card' },
  { key: 'square', label: 'Square' },
  { key: 'check', label: 'Check' },
  { key: 'venmo', label: 'Venmo' },
  { key: 'zelle', label: 'Zelle' },
  { key: 'other', label: 'Other' },
]

export function paymentLabel(method: PaymentMethod | null | undefined): string {
  return PAYMENT_METHODS.find((option) => option.key === method)?.label ?? 'Not recorded'
}

const LAST_METHOD_KEY = 'muffines.lastPaymentMethod'

/** The payment method last used on this device (Cash the first time). */
export function readLastPaymentMethod(): PaymentMethod {
  try {
    const stored = window.localStorage.getItem(LAST_METHOD_KEY)
    return PAYMENT_METHODS.find((option) => option.key === stored)?.key ?? 'cash'
  } catch {
    return 'cash'
  }
}

export function writeLastPaymentMethod(method: PaymentMethod): void {
  try {
    window.localStorage.setItem(LAST_METHOD_KEY, method)
  } catch {
    // Private mode / blocked storage: just do not remember it.
  }
}

/** Units sold so far; a sold item counts all of its units (as the server does). */
export function soldUnits(item: ItemRead): number {
  if (item.status === 'sold') {
    return item.quantity ?? 1
  }
  return Math.min(item.sold_quantity ?? 0, item.quantity ?? 1)
}

/** Units still to sell (none once the item is sold). */
export function remainingUnits(item: ItemRead): number {
  if (item.status === 'sold') {
    return 0
  }
  return Math.max(0, (item.quantity ?? 1) - soldUnits(item))
}

export function isSameLocalDay(iso: string | null, day: Date = new Date()): boolean {
  if (!iso) {
    return false
  }
  const when = new Date(iso)
  return (
    when.getFullYear() === day.getFullYear() && when.getMonth() === day.getMonth() && when.getDate() === day.getDate()
  )
}

/**
 * Put sales back exactly as they were (Undo after "Undo sale" or after moving a
 * sold item to another status): each sale again with its time, price and method.
 * An item marked sold without recorded sales is simply marked sold again.
 */
export async function restoreSales(item: ItemRead, events: ItemSaleEvent[]): Promise<ItemRead> {
  if (events.length === 0) {
    return updateItemStatus(item.id, 'sold')
  }
  let saved = item
  for (const event of events) {
    saved = await sellItem(item.id, {
      quantity: event.quantity,
      unit_price: event.amount / event.quantity,
      payment_method: event.payment_method ?? 'other',
      sold_at: event.sold_at,
    })
  }
  return saved
}
