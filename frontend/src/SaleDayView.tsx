import { useMemo, useState } from 'react'
import { formatCurrency, itemMatchesSearch, searchTerms } from './format'
import { ItemThumbnail } from './ItemThumbnail'
import type { PhotoViewerState } from './ItemThumbnail'
import { PhotoSearchButton, PhotoSearchPanel } from './PhotoSearch'
import { SellControls } from './SellControls'
import { isSameLocalDay, paymentLabel, remainingUnits, soldUnits } from './selling'
import type { ItemRead, PaymentMethod, WorkspaceResponse } from './types'

type SaleDayFilter = 'available' | 'sold' | 'all'

interface SaleDayViewProps {
  workspace: WorkspaceResponse
  categoryLookup: Map<number, string>
  onSell: (item: ItemRead) => void
  onUndoSale: (item: ItemRead) => void
  onOpenPhoto: (photo: PhotoViewerState) => void
}

function stillForSale(item: ItemRead): boolean {
  return remainingUnits(item) > 0 && item.status !== 'donated' && item.status !== 'removed'
}

/**
 * Sale day: a stripped-down, large-type screen for the sale itself. Search (text
 * or photo), big Sell item / Undo sale per row, and a running tally of today.
 * "Today" is this device's local day, from each recorded sale's time.
 */
export function SaleDayView({ workspace, categoryLookup, onSell, onUndoSale, onOpenPhoto }: SaleDayViewProps) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SaleDayFilter>('available')
  const [photoSearchOpen, setPhotoSearchOpen] = useState(false)

  const tally = useMemo(() => {
    let todayUnits = 0
    let todayTotal = 0
    const byMethod = new Map<PaymentMethod | null, { count: number; total: number }>()
    let saleUnits = 0
    let saleTotal = 0
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

  const visibleItems = useMemo(() => {
    const terms = searchTerms(query)
    return workspace.items.filter((item) => {
      if (filter === 'available' && !stillForSale(item)) {
        return false
      }
      if (filter === 'sold' && soldUnits(item) === 0) {
        return false
      }
      return (
        terms.length === 0 ||
        itemMatchesSearch(item, terms, [categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized'])
      )
    })
  }, [categoryLookup, filter, query, workspace.items])

  const filters: Array<{ id: SaleDayFilter; label: string }> = [
    { id: 'available', label: 'Available' },
    { id: 'sold', label: 'Sold' },
    { id: 'all', label: 'All' },
  ]

  return (
    <section className="surface sale-day" aria-labelledby="sale-day-title">
      <div className="sale-day-sticky">
        <h2 id="sale-day-title">Sale day · {workspace.sale.title}</h2>
        <div className="sale-day-tally" aria-live="polite">
          <div>
            <span>Sold today</span>
            <strong>
              {tally.todayUnits} {tally.todayUnits === 1 ? 'item' : 'items'} · {formatCurrency(tally.todayTotal)}
            </strong>
          </div>
          <div>
            <span>Whole sale</span>
            <strong>
              {tally.saleUnits} sold · {formatCurrency(tally.saleTotal)}
            </strong>
          </div>
        </div>
        {tally.byMethod.length ? (
          <p className="sale-day-methods">
            Today:{' '}
            {tally.byMethod
              .map(([method, entry]) => `${paymentLabel(method)} ${formatCurrency(entry.total)} (${entry.count})`)
              .join(' · ')}
          </p>
        ) : null}
        <div className="sale-day-search">
          <input
            type="search"
            placeholder="Search items"
            aria-label="Search items"
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
        <div className="segmented sale-day-filter" role="group" aria-label="Show">
          {filters.map((entry) => (
            <button
              type="button"
              key={entry.id}
              className={filter === entry.id ? 'active' : ''}
              aria-pressed={filter === entry.id}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {photoSearchOpen ? (
        <PhotoSearchPanel
          saleId={workspace.sale.id}
          scopeLabel="this sale"
          onClose={() => setPhotoSearchOpen(false)}
          onOpenItem={(item) => {
            // Show just that item, whatever its state.
            setPhotoSearchOpen(false)
            setFilter('all')
            setQuery(item.title)
          }}
          onOpenPhoto={onOpenPhoto}
        />
      ) : null}

      <ul className="sale-day-list">
        {visibleItems.map((item) => (
          <li key={item.id} className="sale-day-row" id={`sale-day-row-${item.id}`}>
            <ItemThumbnail item={item} onOpen={onOpenPhoto} />
            <div className="sale-day-info">
              <strong>{item.title}</strong>
              <span>
                {item.price === null ? 'Unpriced' : formatCurrency(item.price)}
                {(item.quantity ?? 1) > 1 ? ` × ${item.quantity}` : ''}
              </span>
            </div>
            <SellControls item={item} large onSell={onSell} onUndoSale={onUndoSale} />
          </li>
        ))}
      </ul>
      {visibleItems.length === 0 ? (
        <p className="empty-copy">
          {query ? `No items match “${query.trim()}”.` : filter === 'sold' ? 'Nothing sold yet.' : 'Nothing left to sell.'}
        </p>
      ) : null}
    </section>
  )
}
