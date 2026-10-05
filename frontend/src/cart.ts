import type { OrderDiscountKind } from './checkout'
import type { PaymentMethod } from './types'

/** One item in the cart. `unitPrice` null = the listed price. */
export interface CartLine {
  itemId: number
  quantity: number
  unitPrice: number | null
  /** $ off this line. */
  lineDiscount: number
}

export interface Cart {
  lines: CartLine[]
  discountKind: OrderDiscountKind
  /** As typed, so a half-typed value survives a reload. */
  discountValue: string
  note: string
  tendered: string
  paymentMethod: PaymentMethod | null
}

export function emptyCart(): Cart {
  return { lines: [], discountKind: 'none', discountValue: '', note: '', tendered: '', paymentMethod: null }
}

function cartKey(saleId: number): string {
  return `muffines.cart.v1.${saleId}`
}

/**
 * The cart for an estate sale, kept on this device until the sale is completed
 * or the cart is cleared, so a reload or a trip to another screen loses nothing.
 */
export function readCart(saleId: number): Cart {
  try {
    const raw = window.localStorage.getItem(cartKey(saleId))
    if (!raw) {
      return emptyCart()
    }
    const parsed = JSON.parse(raw) as Partial<Cart>
    const lines = Array.isArray(parsed.lines)
      ? parsed.lines.filter(
          (line): line is CartLine =>
            typeof line === 'object' && line !== null && Number.isInteger(line.itemId) && line.quantity >= 1,
        )
      : []
    return { ...emptyCart(), ...parsed, lines }
  } catch {
    return emptyCart()
  }
}

export function writeCart(saleId: number, cart: Cart): void {
  try {
    if (cart.lines.length === 0 && !cart.note && cart.discountKind === 'none') {
      window.localStorage.removeItem(cartKey(saleId))
    } else {
      window.localStorage.setItem(cartKey(saleId), JSON.stringify(cart))
    }
  } catch {
    // Private mode / blocked storage: the cart just lives until the page closes.
  }
}

/** Drop an item into the stored cart (one more unit if it is already there, up to `maxUnits`). */
export function addItemToStoredCart(saleId: number, itemId: number, maxUnits: number): void {
  const cart = readCart(saleId)
  const existing = cart.lines.find((line) => line.itemId === itemId)
  if (existing) {
    existing.quantity = Math.min(existing.quantity + 1, Math.max(1, maxUnits))
  } else {
    cart.lines.push({ itemId, quantity: 1, unitPrice: null, lineDiscount: 0 })
  }
  writeCart(saleId, cart)
}
