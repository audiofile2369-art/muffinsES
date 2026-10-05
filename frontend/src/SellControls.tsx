import { paymentLabel, remainingUnits, soldUnits } from './selling'
import type { ItemRead } from './types'

interface SellControlsProps {
  item: ItemRead
  onSell: (item: ItemRead) => void
  onUndoSale: (item: ItemRead) => void
  /** Bigger buttons (item editor, Sale day). */
  large?: boolean
}

/**
 * The row's quick action: "Sell item" while units remain ("2 of 5 sold" for a
 * partly sold lot); once fully sold, "Sold" + how it was paid + "Undo sale".
 */
export function SellControls({ item, onSell, onUndoSale, large = false }: SellControlsProps) {
  const remaining = remainingUnits(item)
  const sold = soldUnits(item)
  const quantity = item.quantity ?? 1
  const size = large ? ' sell-large' : ''

  if (item.status === 'sold') {
    return (
      <div className={`sell-controls is-sold${size}`} onClick={(event) => event.stopPropagation()}>
        <span className="sold-label">
          Sold
          <small className="payment-label">{paymentLabel(item.payment_method)}</small>
        </span>
        <button type="button" className="secondary-button undo-sale-button" onClick={() => onUndoSale(item)}>
          Undo sale
        </button>
      </div>
    )
  }

  // Donated or removed items are not for sale; use the status menu to change that first.
  if (remaining === 0 || item.status === 'donated' || item.status === 'removed') {
    return null
  }

  return (
    <div className={`sell-controls${size}`} onClick={(event) => event.stopPropagation()}>
      {sold > 0 ? (
        <span className="partial-sold">
          {sold} of {quantity} sold
        </span>
      ) : null}
      <button
        type="button"
        className="primary-button sell-button"
        aria-label={`Sell ${item.title}`}
        onClick={() => onSell(item)}
      >
        Sell item
      </button>
    </div>
  )
}
