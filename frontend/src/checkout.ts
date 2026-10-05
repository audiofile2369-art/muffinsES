/**
 * Price math for the Sale page, mirroring backend/core/checkout.py to the cent so
 * the total on screen is the total the server records. All work is in whole cents.
 */

export type OrderDiscountKind = 'none' | 'amount' | 'percent' | 'total'

export interface PricingLine {
  quantity: number
  unitPrice: number
  lineDiscount: number
}

export interface PricedCart {
  /** Unit price x quantity, before any discount. */
  subtotal: number
  /** Taken off individual lines. */
  lineDiscounts: number
  /** After line discounts. */
  itemsTotal: number
  /** The sale-wide discount actually applied (capped so the total is never negative). */
  orderDiscount: number
  total: number
  lineNets: number[]
  /** Set total above the items total (the server refuses it). */
  totalTooHigh: boolean
}

export function toCents(value: number): number {
  return Math.round(value * 100)
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100
}

/** A typed money amount ("$12.50", "12,5" -> 12.5); null when empty or not a number. */
export function parseMoney(value: string): number | null {
  const cleaned = value.replace(/[$\s]/g, '').replace(',', '.')
  if (!cleaned) {
    return null
  }
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed * 100) / 100 : null
}

export function priceCart(lines: PricingLine[], kind: OrderDiscountKind, value: number | null): PricedCart {
  let subtotalCents = 0
  let itemsCents = 0
  const lineNets: number[] = []
  for (const line of lines) {
    const gross = toCents(line.unitPrice * line.quantity)
    const discount = Math.min(Math.max(toCents(line.lineDiscount), 0), gross)
    subtotalCents += gross
    itemsCents += gross - discount
    lineNets.push(fromCents(gross - discount))
  }
  let orderCents = 0
  let totalTooHigh = false
  if (value !== null && kind !== 'none') {
    if (kind === 'total') {
      const target = toCents(value)
      totalTooHigh = target > itemsCents
      orderCents = itemsCents - target
    } else if (kind === 'percent') {
      orderCents = Math.round((itemsCents * Math.min(value, 100)) / 100)
    } else {
      orderCents = toCents(value)
    }
  }
  orderCents = Math.min(Math.max(orderCents, 0), itemsCents)
  return {
    subtotal: fromCents(subtotalCents),
    lineDiscounts: fromCents(subtotalCents - itemsCents),
    itemsTotal: fromCents(itemsCents),
    orderDiscount: fromCents(orderCents),
    total: fromCents(itemsCents - orderCents),
    lineNets,
    totalTooHigh,
  }
}
