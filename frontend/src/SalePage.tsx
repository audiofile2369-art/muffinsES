import { useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, checkoutSale, getSaleOrders, voidSaleOrder } from './api'
import { emptyCart, readCart, writeCart } from './cart'
import type { Cart, CartLine } from './cart'
import { parseMoney, priceCart } from './checkout'
import type { OrderDiscountKind } from './checkout'
import { formatMoney, itemMatchesSearch, searchTerms } from './format'
import { ItemThumbnail } from './ItemThumbnail'
import type { PhotoViewerState } from './ItemThumbnail'
import { PhotoSearchButton, PhotoSearchPanel } from './PhotoSearch'
import {
  PAYMENT_METHODS,
  isSameLocalDay,
  paymentLabel,
  readLastPaymentMethod,
  remainingUnits,
  soldUnits,
  writeLastPaymentMethod,
} from './selling'
import type { CheckoutPayload, CheckoutUnavailable, ItemRead, OrderRead, PaymentMethod, WorkspaceResponse } from './types'

interface SalePageProps {
  workspace: WorkspaceResponse
  categoryLookup: Map<number, string>
  onOpenPhoto: (photo: PhotoViewerState) => void
  /** Reload the estate sale after items were sold or a sale voided. */
  onItemsChanged: () => Promise<void>
}

function stillForSale(item: ItemRead): boolean {
  return remainingUnits(item) > 0 && item.status !== 'donated' && item.status !== 'removed'
}

function units(count: number): string {
  return `${count} ${count === 1 ? 'item' : 'items'}`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function csvValue(value: string | number): string {
  const text = String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Every customer sale at the estate sale, one row per line, as a CSV download. */
function downloadOrdersCsv(title: string, orders: OrderRead[]): void {
  const header = ['Sale #', 'Time', 'Voided', 'Paid by', 'Customer / note', 'Item', 'Qty', 'Price each', 'Line discount', 'Line amount', 'Sale total']
  const rows = orders.flatMap((order) =>
    order.lines.map((line) => [
      order.id,
      new Date(order.created_at).toLocaleString(),
      order.voided ? 'yes' : '',
      paymentLabel(order.payment_method),
      order.note,
      line.title,
      line.quantity,
      line.unit_price.toFixed(2),
      line.line_discount.toFixed(2),
      line.amount.toFixed(2),
      order.total.toFixed(2),
    ]),
  )
  const csv = [header, ...rows].map((row) => row.map(csvValue).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-customer-sales.csv`
  link.click()
  URL.revokeObjectURL(url)
}

const DISCOUNT_KINDS: Array<{ id: OrderDiscountKind; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'amount', label: '$ off' },
  { id: 'percent', label: '% off' },
  { id: 'total', label: 'Set total' },
]

const QUICK_PERCENTS = [10, 25, 50]

/**
 * The Sale page: ring up one customer. Find items (text or photo) and tap to add
 * them to the cart, adjust quantities, prices and discounts, take payment and
 * complete the sale in one go. Below: today's tally and the recent sales, each
 * of which can be opened or voided. The cart is kept on this device (per estate
 * sale) until the sale is completed or the cart is cleared.
 */
export function SalePage({ workspace, categoryLookup, onOpenPhoto, onItemsChanged }: SalePageProps) {
  const saleId = workspace.sale.id
  const [cart, setCart] = useState<Cart>(() => readCart(saleId))
  const [query, setQuery] = useState('')
  const [photoSearchOpen, setPhotoSearchOpen] = useState(false)
  const [editing, setEditing] = useState<{ itemId: number; field: 'price' | 'discount'; value: string } | null>(null)
  const [conflicts, setConflicts] = useState<Map<number, CheckoutUnavailable>>(new Map())
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [completed, setCompleted] = useState<{ order: OrderRead; change: number | null; cart: Cart } | null>(null)
  const [orders, setOrders] = useState<OrderRead[] | null>(null)
  const [ordersError, setOrdersError] = useState<string | null>(null)
  const [openOrderId, setOpenOrderId] = useState<number | null>(null)
  const [showEarlier, setShowEarlier] = useState(false)
  const cartRef = useRef<HTMLElement | null>(null)

  const paymentMethod: PaymentMethod = cart.paymentMethod ?? readLastPaymentMethod()

  useEffect(() => {
    writeCart(saleId, cart)
  }, [cart, saleId])

  useEffect(() => {
    let alive = true
    getSaleOrders(saleId)
      .then((loaded) => {
        if (alive) {
          setOrders(loaded)
          setOrdersError(null)
        }
      })
      .catch((loadError: unknown) => {
        if (alive) {
          setOrdersError(loadError instanceof Error ? loadError.message : 'Could not load recent sales.')
        }
      })
    return () => {
      alive = false
    }
  }, [saleId])

  async function reloadOrders(): Promise<void> {
    try {
      setOrders(await getSaleOrders(saleId))
      setOrdersError(null)
    } catch (loadError) {
      setOrdersError(loadError instanceof Error ? loadError.message : 'Could not load recent sales.')
    }
  }

  const itemsById = useMemo(() => new Map(workspace.items.map((item) => [item.id, item])), [workspace.items])
  const cartLines = cart.lines
  const quantityInCart = useMemo(() => new Map(cartLines.map((line) => [line.itemId, line.quantity])), [cartLines])

  const pricingLines = cartLines.map((line) => {
    const item = itemsById.get(line.itemId)
    return {
      quantity: line.quantity,
      unitPrice: line.unitPrice ?? item?.price ?? 0,
      lineDiscount: line.lineDiscount,
    }
  })
  const discountValue = parseMoney(cart.discountValue)
  const priced = priceCart(pricingLines, cart.discountKind, discountValue)
  const itemCount = cartLines.reduce((sum, line) => sum + line.quantity, 0)
  const tendered = parseMoney(cart.tendered)
  const change = paymentMethod === 'cash' && tendered !== null ? Math.round((tendered - priced.total) * 100) / 100 : null

  /** Why a line cannot be sold as it stands (server conflict, or already sold elsewhere). */
  function lineProblem(line: CartLine): string | null {
    const item = itemsById.get(line.itemId)
    const conflict = conflicts.get(line.itemId)
    if (!item || conflict?.reason === 'deleted') {
      return 'This item was deleted. Remove it.'
    }
    const remaining = stillForSale(item) ? remainingUnits(item) : 0
    if (conflict && conflict.remaining < line.quantity) {
      return conflict.remaining === 0 ? 'Already sold. Remove it.' : `Only ${conflict.remaining} left.`
    }
    if (remaining < line.quantity) {
      return remaining === 0 ? 'Already sold. Remove it.' : `Only ${remaining} left.`
    }
    return null
  }

  const problems = cartLines.filter((line) => lineProblem(line) !== null).length

  function updateCart(apply: (current: Cart) => Cart): void {
    setError(null)
    setCart((current) => apply(current))
  }

  function updateLine(itemId: number, apply: (line: CartLine) => CartLine | null): void {
    updateCart((current) => ({
      ...current,
      lines: current.lines.flatMap((line) => {
        if (line.itemId !== itemId) {
          return [line]
        }
        const next = apply(line)
        return next ? [next] : []
      }),
    }))
  }

  function addItem(item: ItemRead): void {
    const remaining = remainingUnits(item)
    if (!stillForSale(item)) {
      return
    }
    setCompleted(null)
    updateCart((current) => {
      const existing = current.lines.find((line) => line.itemId === item.id)
      if (existing) {
        return {
          ...current,
          lines: current.lines.map((line) =>
            line.itemId === item.id ? { ...line, quantity: Math.min(line.quantity + 1, remaining) } : line,
          ),
        }
      }
      return { ...current, lines: [...current.lines, { itemId: item.id, quantity: 1, unitPrice: null, lineDiscount: 0 }] }
    })
  }

  function removeLine(itemId: number): void {
    updateLine(itemId, () => null)
    setConflicts((current) => {
      const next = new Map(current)
      next.delete(itemId)
      return next
    })
  }

  function commitEdit(): void {
    if (!editing) {
      return
    }
    const value = parseMoney(editing.value)
    const item = itemsById.get(editing.itemId)
    if (editing.field === 'price') {
      updateLine(editing.itemId, (line) => ({
        ...line,
        unitPrice: value === null || value === (item?.price ?? null) ? null : value,
      }))
    } else {
      updateLine(editing.itemId, (line) => ({ ...line, lineDiscount: value ?? 0 }))
    }
    setEditing(null)
  }

  function clearCart(): void {
    if (cartLines.length && !window.confirm(`Clear the cart? ${units(itemCount)} will be taken out of this sale.`)) {
      return
    }
    setCart({ ...emptyCart(), paymentMethod: cart.paymentMethod })
    setConflicts(new Map())
    setEditing(null)
    setError(null)
  }

  function buildPayload(): CheckoutPayload {
    const payload: CheckoutPayload = {
      lines: cartLines.map((line) => ({
        item_id: line.itemId,
        quantity: line.quantity,
        unit_price: line.unitPrice,
        line_discount: line.lineDiscount,
      })),
      payment_method: paymentMethod,
      note: cart.note.trim(),
    }
    if (discountValue !== null) {
      if (cart.discountKind === 'amount') {
        payload.discount_amount = discountValue
      } else if (cart.discountKind === 'percent') {
        payload.discount_percent = Math.min(discountValue, 100)
      } else if (cart.discountKind === 'total') {
        payload.set_total = discountValue
      }
    }
    return payload
  }

  async function completeSale(): Promise<void> {
    if (editing) {
      commitEdit()
      return
    }
    if (cartLines.length === 0 || problems > 0 || priced.totalTooHigh || submitting) {
      return
    }
    const confirmed = window.confirm(
      `Complete this sale?\n\n${units(itemCount)} · Total ${formatMoney(priced.total)} · ${paymentLabel(paymentMethod)}`,
    )
    if (!confirmed) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const order = await checkoutSale(saleId, buildPayload())
      writeLastPaymentMethod(paymentMethod)
      setCompleted({ order, change, cart })
      setCart({ ...emptyCart(), paymentMethod })
      setConflicts(new Map())
      setOrders((current) => [order, ...(current ?? []).filter((entry) => entry.id !== order.id)])
      await Promise.all([onItemsChanged(), reloadOrders()])
    } catch (saleError) {
      if (saleError instanceof ApiError && saleError.status === 409 && saleError.unavailable.length) {
        setConflicts(new Map(saleError.unavailable.map((entry) => [entry.item_id, entry])))
        setError('Some items were sold on another device. Fix the lines marked in red, then try again.')
        await Promise.all([onItemsChanged(), reloadOrders()])
      } else {
        setError(saleError instanceof Error ? saleError.message : 'The sale could not be completed.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  async function voidOrder(order: OrderRead, restoreCart: Cart | null = null): Promise<void> {
    const question = restoreCart
      ? `Undo this sale of ${formatMoney(order.total)}? The items go back on sale and back into the cart.`
      : `Void this sale of ${formatMoney(order.total)} (${units(order.item_count)})? The items go back on sale.`
    if (!window.confirm(question)) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const voided = await voidSaleOrder(saleId, order.id)
      setOrders((current) => (current ?? []).map((entry) => (entry.id === voided.id ? voided : entry)))
      void reloadOrders()
      if (restoreCart) {
        setCart(restoreCart)
        setCompleted(null)
      }
      await onItemsChanged()
    } catch (voidError) {
      setError(voidError instanceof Error ? voidError.message : 'The sale could not be voided.')
    } finally {
      setSubmitting(false)
    }
  }

  const visibleItems = useMemo(() => {
    const terms = searchTerms(query)
    return workspace.items.filter(
      (item) =>
        stillForSale(item) &&
        itemMatchesSearch(item, terms, [categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized']),
    )
  }, [categoryLookup, query, workspace.items])

  const tally = useMemo(() => {
    let todayUnits = 0
    let todayTotal = 0
    let saleUnits = 0
    let saleTotal = 0
    const byMethod = new Map<PaymentMethod | null, { count: number; total: number }>()
    for (const item of workspace.items) {
      saleUnits += soldUnits(item)
      saleTotal += item.sold_total ?? 0
      for (const event of item.sale_events ?? []) {
        if (isSameLocalDay(event.sold_at)) {
          todayUnits += event.quantity
          todayTotal += event.amount
          const entry = byMethod.get(event.payment_method) ?? { count: 0, total: 0 }
          entry.count += 1
          entry.total += event.amount
          byMethod.set(event.payment_method, entry)
        }
      }
    }
    return {
      todayUnits,
      todayTotal,
      saleUnits,
      saleTotal,
      byMethod: [...byMethod.entries()].sort((left, right) => right[1].total - left[1].total),
    }
  }, [workspace.items])

  const todayOrders = (orders ?? []).filter((order) => isSameLocalDay(order.created_at))
  const earlierOrders = (orders ?? []).filter((order) => !isSameLocalDay(order.created_at))
  const shownOrders = showEarlier ? (orders ?? []) : todayOrders

  return (
    <>
      <section className="surface sale-page" aria-labelledby="sale-page-title">
        <div className="sale-page-heading">
          <h2 id="sale-page-title">Sale</h2>
          <p className="sale-page-context">
            Selling at <strong>{workspace.sale.title}</strong>
          </p>
        </div>
        <div className="sale-day-tally" aria-live="polite">
          <div>
            <span>Sold today</span>
            <strong>
              {units(tally.todayUnits)} · {formatMoney(tally.todayTotal)}
            </strong>
          </div>
          <div>
            <span>Whole estate sale</span>
            <strong>
              {tally.saleUnits} sold · {formatMoney(tally.saleTotal)}
            </strong>
          </div>
        </div>
        {tally.byMethod.length ? (
          <p className="sale-day-methods">
            Today:{' '}
            {tally.byMethod
              .map(([method, entry]) => `${paymentLabel(method)} ${formatMoney(entry.total)} (${entry.count})`)
              .join(' · ')}
          </p>
        ) : null}

        <div className="checkout-layout">
          <div className="checkout-browse">
            <div className="sale-day-search">
              <input
                type="search"
                placeholder="Find an item"
                aria-label="Find an item"
                autoComplete="off"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button type="button" className="secondary-button" onClick={() => setQuery('')}>
                  Clear
                </button>
              ) : null}
              <PhotoSearchButton active={photoSearchOpen} onClick={() => setPhotoSearchOpen((open) => !open)} />
            </div>
            {photoSearchOpen ? (
              <PhotoSearchPanel
                saleId={saleId}
                scopeLabel="this estate sale"
                onClose={() => setPhotoSearchOpen(false)}
                onOpenItem={(found) => {
                  setPhotoSearchOpen(false)
                  const item = itemsById.get(found.id)
                  if (item && stillForSale(item)) {
                    addItem(item)
                  } else {
                    setQuery(found.title)
                  }
                }}
                onOpenPhoto={onOpenPhoto}
              />
            ) : null}
            <p className="checkout-hint">Tap an item to add it to the sale.</p>
            <ul className="checkout-items">
              {visibleItems.map((item) => {
                const remaining = remainingUnits(item)
                const inCart = quantityInCart.get(item.id) ?? 0
                const full = inCart >= remaining
                return (
                  <li key={item.id} className={`checkout-item ${inCart ? 'in-cart' : ''}`}>
                    <ItemThumbnail item={item} onOpen={onOpenPhoto} />
                    <button
                      type="button"
                      className="checkout-item-add"
                      disabled={full}
                      aria-label={`Add ${item.title} to the sale`}
                      onClick={() => addItem(item)}
                    >
                      <span className="checkout-item-info">
                        <strong>{item.title}</strong>
                        <span>
                          {item.price === null ? 'Unpriced' : formatMoney(item.price)}
                          {(item.quantity ?? 1) > 1 ? ` · ${remaining} left` : ''}
                        </span>
                      </span>
                      <span className="checkout-item-action">
                        {inCart ? (full ? `In sale: ${inCart}` : `+ Add (${inCart})`) : '+ Add'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
            {visibleItems.length === 0 ? (
              <p className="empty-copy">
                {query ? `No items for sale match “${query.trim()}”.` : 'Nothing left to sell at this estate sale.'}
              </p>
            ) : null}
          </div>

          <aside className="checkout-cart" aria-label="This sale" ref={cartRef}>
            {completed ? (
              <div className="checkout-done" role="status">
                <p className="checkout-done-title">Sale complete</p>
                <p className="checkout-done-total">{formatMoney(completed.order.total)}</p>
                <p>
                  {units(completed.order.item_count)} · {paymentLabel(completed.order.payment_method)}
                </p>
                {completed.change !== null && completed.change > 0 ? (
                  <p className="checkout-change">Change due {formatMoney(completed.change)}</p>
                ) : null}
                <div className="checkout-actions">
                  <button type="button" className="primary-button checkout-complete" onClick={() => setCompleted(null)}>
                    New sale
                  </button>
                  <button
                    type="button"
                    className="secondary-button danger-button"
                    disabled={submitting}
                    onClick={() => void voidOrder(completed.order, completed.cart)}
                  >
                    Undo this sale
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="checkout-cart-heading">
                  <h3>This sale</h3>
                  {cartLines.length ? (
                    <button type="button" className="text-button" onClick={clearCart}>
                      Clear cart
                    </button>
                  ) : null}
                </div>
                {cartLines.length === 0 ? (
                  <p className="empty-copy">No items yet. Tap items on the list to add them.</p>
                ) : (
                  <ul className="cart-lines">
                    {cartLines.map((line, index) => {
                      const item = itemsById.get(line.itemId)
                      const listed = item?.price ?? 0
                      const unitPrice = line.unitPrice ?? listed
                      const remaining = item ? remainingUnits(item) : 0
                      const maxUnits = Math.max(remaining, 1)
                      const problem = lineProblem(line)
                      const editingThis = editing?.itemId === line.itemId ? editing : null
                      return (
                        <li key={line.itemId} className={`cart-line ${problem ? 'has-problem' : ''}`} data-item-id={line.itemId}>
                          <div className="cart-line-top">
                            {item ? <ItemThumbnail item={item} onOpen={onOpenPhoto} /> : null}
                            <div className="cart-line-name">
                              <strong>{item?.title ?? 'Deleted item'}</strong>
                              {problem ? <span className="cart-line-problem">{problem}</span> : null}
                            </div>
                            <button
                              type="button"
                              className="icon-button cart-remove"
                              aria-label={`Remove ${item?.title ?? 'item'} from the sale`}
                              onClick={() => removeLine(line.itemId)}
                            >
                              ×
                            </button>
                          </div>
                          <div className="cart-line-controls">
                            {(item?.quantity ?? 1) > 1 || line.quantity > 1 ? (
                              <div className="stepper" role="group" aria-label="How many">
                                <button
                                  type="button"
                                  aria-label="One fewer"
                                  disabled={line.quantity <= 1}
                                  onClick={() => updateLine(line.itemId, (current) => ({ ...current, quantity: current.quantity - 1 }))}
                                >
                                  −
                                </button>
                                <span aria-live="polite">{line.quantity}</span>
                                <button
                                  type="button"
                                  aria-label="One more"
                                  disabled={line.quantity >= maxUnits}
                                  onClick={() =>
                                    updateLine(line.itemId, (current) => ({
                                      ...current,
                                      quantity: Math.min(current.quantity + 1, maxUnits),
                                    }))
                                  }
                                >
                                  +
                                </button>
                              </div>
                            ) : null}
                            {editingThis?.field === 'price' ? (
                              <input
                                className="cart-money-input"
                                inputMode="decimal"
                                aria-label={`Price each for ${item?.title ?? 'item'}`}
                                autoFocus
                                value={editingThis.value}
                                onChange={(event) => setEditing({ ...editingThis, value: event.target.value })}
                                onBlur={commitEdit}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    commitEdit()
                                  } else if (event.key === 'Escape') {
                                    setEditing(null)
                                  }
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="cart-price"
                                aria-label={`Change price of ${item?.title ?? 'item'}`}
                                onClick={() => setEditing({ itemId: line.itemId, field: 'price', value: unitPrice.toFixed(2) })}
                              >
                                {line.unitPrice !== null && line.unitPrice !== listed ? (
                                  <s className="cart-was">{formatMoney(listed)}</s>
                                ) : null}
                                <span>{formatMoney(unitPrice)}</span>
                                {line.quantity > 1 ? <small> each</small> : null}
                              </button>
                            )}
                            {editingThis?.field === 'discount' ? (
                              <input
                                className="cart-money-input"
                                inputMode="decimal"
                                aria-label={`Discount for ${item?.title ?? 'item'}`}
                                placeholder="$ off"
                                autoFocus
                                value={editingThis.value}
                                onChange={(event) => setEditing({ ...editingThis, value: event.target.value })}
                                onBlur={commitEdit}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    commitEdit()
                                  } else if (event.key === 'Escape') {
                                    setEditing(null)
                                  }
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="text-button cart-discount"
                                onClick={() =>
                                  setEditing({
                                    itemId: line.itemId,
                                    field: 'discount',
                                    value: line.lineDiscount ? line.lineDiscount.toFixed(2) : '',
                                  })
                                }
                              >
                                {line.lineDiscount ? `−${formatMoney(line.lineDiscount)} off` : 'Discount'}
                              </button>
                            )}
                            <span className="cart-line-total">{formatMoney(priced.lineNets[index] ?? 0)}</span>
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}

                {cartLines.length ? (
                  <>
                    <div className="checkout-discount">
                      <span className="checkout-label">Discount on the whole sale</span>
                      <div className="segmented" role="group" aria-label="Discount on the whole sale">
                        {DISCOUNT_KINDS.map((kind) => (
                          <button
                            type="button"
                            key={kind.id}
                            className={cart.discountKind === kind.id ? 'active' : ''}
                            aria-pressed={cart.discountKind === kind.id}
                            onClick={() =>
                              updateCart((current) => ({
                                ...current,
                                discountKind: kind.id,
                                discountValue:
                                  kind.id === 'total' && current.discountKind !== 'total'
                                    ? priced.itemsTotal.toFixed(2)
                                    : kind.id === current.discountKind
                                      ? current.discountValue
                                      : '',
                              }))
                            }
                          >
                            {kind.label}
                          </button>
                        ))}
                      </div>
                      <div className="checkout-chips">
                        {QUICK_PERCENTS.map((percent) => {
                          const active = cart.discountKind === 'percent' && discountValue === percent
                          return (
                            <button
                              type="button"
                              key={percent}
                              className={`chip ${active ? 'active' : ''}`}
                              aria-pressed={active}
                              onClick={() =>
                                updateCart((current) => ({ ...current, discountKind: 'percent', discountValue: String(percent) }))
                              }
                            >
                              {percent}% off
                            </button>
                          )
                        })}
                      </div>
                      {cart.discountKind !== 'none' ? (
                        <label className="checkout-field">
                          {cart.discountKind === 'amount'
                            ? 'Dollars off'
                            : cart.discountKind === 'percent'
                              ? 'Percent off'
                              : 'Agreed total'}
                          <input
                            inputMode="decimal"
                            value={cart.discountValue}
                            placeholder={cart.discountKind === 'percent' ? '25' : '0.00'}
                            onChange={(event) => updateCart((current) => ({ ...current, discountValue: event.target.value }))}
                          />
                        </label>
                      ) : null}
                      {priced.totalTooHigh ? (
                        <p className="cart-line-problem">
                          The total can’t be more than the items add up to ({formatMoney(priced.itemsTotal)}). Change an item’s price instead.
                        </p>
                      ) : null}
                    </div>

                    <dl className="checkout-totals">
                      <div>
                        <dt>Items ({itemCount})</dt>
                        <dd>{formatMoney(priced.subtotal)}</dd>
                      </div>
                      {priced.lineDiscounts > 0 ? (
                        <div>
                          <dt>Item discounts</dt>
                          <dd>−{formatMoney(priced.lineDiscounts)}</dd>
                        </div>
                      ) : null}
                      {priced.orderDiscount > 0 ? (
                        <div>
                          <dt>
                            Sale discount
                            {cart.discountKind === 'percent' && discountValue !== null ? ` (${Math.min(discountValue, 100)}%)` : ''}
                          </dt>
                          <dd>−{formatMoney(priced.orderDiscount)}</dd>
                        </div>
                      ) : null}
                      <div className="checkout-grand-total">
                        <dt>Total</dt>
                        <dd data-testid="checkout-total">{formatMoney(priced.total)}</dd>
                      </div>
                    </dl>

                    <div className="checkout-payment">
                      <span className="checkout-label">Paid by</span>
                      <div className="checkout-chips">
                        {PAYMENT_METHODS.map((method) => (
                          <button
                            type="button"
                            key={method.key}
                            className={`chip ${paymentMethod === method.key ? 'active' : ''}`}
                            aria-pressed={paymentMethod === method.key}
                            onClick={() => updateCart((current) => ({ ...current, paymentMethod: method.key }))}
                          >
                            {method.label}
                          </button>
                        ))}
                      </div>
                      {paymentMethod === 'cash' ? (
                        <div className="checkout-cash">
                          <label className="checkout-field">
                            Cash received
                            <input
                              inputMode="decimal"
                              placeholder="0.00"
                              value={cart.tendered}
                              onChange={(event) => updateCart((current) => ({ ...current, tendered: event.target.value }))}
                            />
                          </label>
                          {change !== null ? (
                            <p className={`checkout-change ${change < 0 ? 'is-short' : ''}`} aria-live="polite">
                              {change < 0 ? `Still owed ${formatMoney(-change)}` : `Change due ${formatMoney(change)}`}
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <label className="checkout-field">
                      Customer or note (optional)
                      <input
                        type="text"
                        maxLength={500}
                        value={cart.note}
                        onChange={(event) => updateCart((current) => ({ ...current, note: event.target.value }))}
                      />
                    </label>
                  </>
                ) : null}

                {error ? (
                  <p className="notice error" role="alert">
                    {error}
                  </p>
                ) : null}

                {cartLines.length ? (
                  <button
                    type="button"
                    className="primary-button checkout-complete"
                    disabled={submitting || problems > 0 || priced.totalTooHigh}
                    onClick={() => void completeSale()}
                  >
                    {submitting ? 'Completing…' : `Complete sale · ${formatMoney(priced.total)}`}
                  </button>
                ) : null}
              </>
            )}
          </aside>
        </div>

        {cartLines.length && !completed ? (
          <button
            type="button"
            className="primary-button checkout-jump"
            onClick={() => cartRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          >
            View sale · {units(itemCount)} · {formatMoney(priced.total)}
          </button>
        ) : null}
      </section>

      <section className="surface recent-sales" aria-labelledby="recent-sales-title">
        <div className="section-heading">
          <h2 id="recent-sales-title">Recent sales</h2>
          {earlierOrders.length ? (
            <button type="button" className="secondary-button" onClick={() => setShowEarlier((show) => !show)}>
              {showEarlier ? 'Today only' : `Earlier days (${earlierOrders.length})`}
            </button>
          ) : null}
        </div>
        {ordersError ? <p className="notice error">{ordersError}</p> : null}
        {orders === null && !ordersError ? <p className="empty-copy">Loading…</p> : null}
        {orders !== null && shownOrders.length === 0 ? <p className="empty-copy">No sales yet today.</p> : null}
        <ul className="recent-sales-list">
          {shownOrders.map((order) => {
            const open = openOrderId === order.id
            const returned = order.lines.filter((line) => line.returned).length
            return (
              <li key={order.id} className={`recent-sale ${order.voided ? 'is-voided' : ''}`}>
                <button
                  type="button"
                  className="recent-sale-summary"
                  aria-expanded={open}
                  onClick={() => setOpenOrderId(open ? null : order.id)}
                >
                  <span className="recent-sale-time">
                    {isSameLocalDay(order.created_at) ? formatTime(order.created_at) : `${formatDay(order.created_at)} ${formatTime(order.created_at)}`}
                  </span>
                  <span className="recent-sale-what">
                    {units(order.item_count)}
                    {order.note ? ` · ${order.note}` : ''}
                  </span>
                  <span className="recent-sale-money">
                    {order.voided ? <s>{formatMoney(order.total)}</s> : formatMoney(order.total)}
                    <small>{order.voided ? 'Voided' : paymentLabel(order.payment_method)}</small>
                  </span>
                </button>
                {open ? (
                  <div className="recent-sale-detail">
                    <ul>
                      {order.lines.map((line) => (
                        <li key={`${line.item_id}-${line.event_id}`} className={line.returned && !order.voided ? 'is-returned' : ''}>
                          <span>
                            {line.quantity > 1 ? `${line.quantity} × ` : ''}
                            {line.title}
                            {line.returned && !order.voided ? ' (returned)' : ''}
                          </span>
                          <span>{formatMoney(line.amount)}</span>
                        </li>
                      ))}
                    </ul>
                    {order.discount_total > 0 ? (
                      <p className="recent-sale-note">
                        Before discounts {formatMoney(order.subtotal)} · discount {formatMoney(order.discount_total)}
                      </p>
                    ) : null}
                    {returned && !order.voided ? (
                      <p className="recent-sale-note">Still counted: {formatMoney(order.received_total)}</p>
                    ) : null}
                    {order.voided ? null : (
                      <button
                        type="button"
                        className="secondary-button danger-button"
                        disabled={submitting}
                        onClick={() => void voidOrder(order)}
                      >
                        Void sale
                      </button>
                    )}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
        {orders?.length ? (
          <div className="recent-sales-actions">
            <button type="button" className="text-button" onClick={() => void reloadOrders()}>
              Refresh
            </button>
            <button type="button" className="text-button" onClick={() => downloadOrdersCsv(workspace.sale.title, orders)}>
              Download all sales (CSV)
            </button>
          </div>
        ) : null}
      </section>
    </>
  )
}
