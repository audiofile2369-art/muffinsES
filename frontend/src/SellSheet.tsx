import { useState } from 'react'
import { formatCurrency } from './format'
import { getItemPhotoUrl } from './api'
import { PAYMENT_METHODS, readLastPaymentMethod, remainingUnits } from './selling'
import type { ItemRead, ItemSellPayload, PaymentMethod } from './types'

interface SellSheetProps {
  item: ItemRead
  /** Units to start the "How many?" stepper at (e.g. all remaining from the status menu). */
  defaultQuantity?: number
  busy: boolean
  onConfirm: (payload: ItemSellPayload) => void
  onCancel: () => void
}

/** Small confirm sheet for "Sell item": price (editable), how many, and how it was paid. */
export function SellSheet({ item, defaultQuantity = 1, busy, onConfirm, onCancel }: SellSheetProps) {
  const remaining = Math.max(1, remainingUnits(item))
  const [quantity, setQuantity] = useState(Math.min(Math.max(1, defaultQuantity), remaining))
  const [price, setPrice] = useState(item.price === null ? '' : String(item.price))
  const [method, setMethod] = useState<PaymentMethod>(readLastPaymentMethod)
  const unitPrice = price.trim() === '' ? 0 : Number(price)
  const priceValid = Number.isFinite(unitPrice) && unitPrice >= 0
  const photo = getItemPhotoUrl(item) ?? item.photo_url

  return (
    <div className="modal-backdrop" onClick={() => onCancel()}>
      <form
        className="modal-card sell-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sell-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onCancel()
          }
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (priceValid && !busy) {
            onConfirm({ quantity, unit_price: unitPrice, payment_method: method })
          }
        }}
      >
        <div className="duplicate-summary">
          {photo ? <img className="duplicate-thumb" src={photo} alt="" /> : null}
          <div>
            <h3 id="sell-title">Sell &ldquo;{item.title}&rdquo;</h3>
            <p className="hint-copy">
              {remaining > 1 ? `${remaining} left` : '1 left'}
              {item.price !== null ? ` · listed at ${formatCurrency(item.price)} each` : ' · no listed price'}
            </p>
          </div>
        </div>

        <label>
          {remaining > 1 ? 'Sold price (each)' : 'Sold price'}
          <input
            type="number"
            min="0"
            step="0.01"
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            aria-invalid={!priceValid}
          />
        </label>

        {remaining > 1 ? (
          <div className="sell-stepper" role="group" aria-label="How many?">
            <span className="sell-stepper-label">How many?</span>
            <button
              type="button"
              className="secondary-button"
              aria-label="One fewer"
              disabled={quantity <= 1}
              onClick={() => setQuantity((current) => Math.max(1, current - 1))}
            >
              −
            </button>
            <output aria-live="polite" className="sell-stepper-value">
              {quantity}
            </output>
            <button
              type="button"
              className="secondary-button"
              aria-label="One more"
              disabled={quantity >= remaining}
              onClick={() => setQuantity((current) => Math.min(remaining, current + 1))}
            >
              +
            </button>
            <span className="hint-copy">of {remaining}</span>
          </div>
        ) : null}

        <fieldset className="payment-choices">
          <legend>Payment method</legend>
          <div className="chip-row">
            {PAYMENT_METHODS.map((option) => (
              <button
                type="button"
                key={option.key}
                className={`chip payment-chip ${method === option.key ? 'active' : ''}`}
                aria-pressed={method === option.key}
                onClick={() => setMethod(option.key)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>

        <button type="submit" className="primary-button sell-confirm" disabled={!priceValid || busy} autoFocus>
          Sell {quantity > 1 ? `${quantity} ` : ''}for {formatCurrency(priceValid ? unitPrice * quantity : 0)}
        </button>
        <button type="button" className="secondary-button" onClick={() => onCancel()}>
          Cancel
        </button>
      </form>
    </div>
  )
}
