import { useEffect, useMemo, useState } from 'react'
import { getAllItems, updateItemStatus } from './api'
import { formatCurrency, itemMatchesSearch, searchTerms, titleCase } from './format'
import { ItemThumbnail } from './ItemThumbnail'
import { PhotoSearchButton, PhotoSearchPanel } from './PhotoSearch'
import { StatusMenu } from './StatusMenu'
import { SellControls } from './SellControls'
import { remainingUnits, restoreSales } from './selling'
import { useSellFlow } from './useSellFlow'
import { showToast } from './toast'
import type { PhotoViewerState } from './ItemThumbnail'
import type { ItemRead, ItemStatus, ItemWithSale } from './types'

type SortOrder = 'newest' | 'name' | 'price-high' | 'price-low'
type Layout = 'list' | 'grid'

const LAYOUT_KEY = 'muffines.allItems.layout'

function readStoredLayout(): Layout {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'list'
  } catch {
    return 'list'
  }
}

function sortItems(items: ItemWithSale[], order: SortOrder): ItemWithSale[] {
  const sorted = [...items]
  if (order === 'name') {
    sorted.sort((left, right) => left.title.localeCompare(right.title))
  } else if (order === 'price-high' || order === 'price-low') {
    const direction = order === 'price-high' ? -1 : 1
    // Unpriced items always go last.
    sorted.sort((left, right) => {
      if (left.price === null || right.price === null) {
        return (left.price === null ? 1 : 0) - (right.price === null ? 1 : 0)
      }
      return (left.price - right.price) * direction
    })
  }
  return sorted
}

interface AllItemsViewProps {
  onOpenItem: (item: ItemWithSale) => void
  onOpenPhoto: (photo: PhotoViewerState) => void
  /** Called after an item is changed here (e.g. its status), so the open sale stays in step. */
  onItemChanged?: (item: ItemRead) => void
}

/** Every saved item across all sales, with search, filters, sort and a list/grid toggle. */
export function AllItemsView({ onOpenItem, onOpenPhoto, onItemChanged }: AllItemsViewProps) {
  const [items, setItems] = useState<ItemWithSale[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [photoSearchOpen, setPhotoSearchOpen] = useState(false)
  const [saleFilter, setSaleFilter] = useState<number | 'all'>('all')
  const [statusFilter, setStatusFilter] = useState<ItemStatus | 'all'>('all')
  const [sortOrder, setSortOrder] = useState<SortOrder>('newest')
  const [layout, setLayout] = useState<Layout>(readStoredLayout)

  useEffect(() => {
    let cancelled = false
    getAllItems()
      .then((nextItems) => {
        if (!cancelled) {
          setItems(nextItems)
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : 'Unable to load items.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  function applySaved(saved: ItemRead): void {
    setItems((current) =>
      current.map((existing) => (existing.id === saved.id ? { ...existing, ...saved } : existing)),
    )
    onItemChanged?.(saved)
  }
  const sellFlow = useSellFlow(applySaved, setError)

  function changeOrSell(item: ItemWithSale, status: ItemStatus): void {
    if (status === 'sold') {
      sellFlow.openSell(item, remainingUnits(item))
    } else {
      void changeStatus(item, status)
    }
  }

  /** One-tap status change: shown at once, status-only save, put back if it fails. */
  async function changeStatus(item: ItemWithSale, status: ItemStatus, withUndo = true): Promise<void> {
    const previous = item.status
    const setStatus = (from: ItemStatus, to: ItemStatus): void =>
      setItems((current) =>
        current.map((existing) =>
          existing.id === item.id && existing.status === from ? { ...existing, status: to } : existing,
        ),
      )
    setStatus(previous, status)
    try {
      const saved = await updateItemStatus(item.id, status)
      setItems((current) =>
        current.map((existing) => (existing.id === saved.id ? { ...existing, ...saved } : existing)),
      )
      onItemChanged?.(saved)
      if (withUndo) {
        showToast({
          message: `"${saved.title}" marked ${titleCase(status)}`,
          onUndo: () => {
            const previousEvents = item.sale_events ?? []
            if (previous === 'sold' && previousEvents.length > 0) {
              void restoreSales(saved, previousEvents)
                .then(applySaved)
                .catch((undoError: unknown) =>
                  setError(`Could not undo: ${undoError instanceof Error ? undoError.message : 'unknown error'}`),
                )
            } else {
              void changeStatus({ ...item, status }, previous, false)
            }
          },
        })
      }
    } catch (changeError) {
      setStatus(status, previous)
      setError(
        `Could not change "${item.title}" to ${titleCase(status)}: ${
          changeError instanceof Error ? changeError.message : 'unknown error'
        }`,
      )
    }
  }

  function changeLayout(next: Layout): void {
    setLayout(next)
    try {
      window.localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      // Remembering the layout is only a convenience.
    }
  }

  const saleChips = useMemo(() => {
    const counts = new Map<number, { title: string; count: number }>()
    for (const item of items) {
      const entry = counts.get(item.sale_id) ?? { title: item.sale_title, count: 0 }
      entry.count += 1
      counts.set(item.sale_id, entry)
    }
    return [...counts.entries()].map(([id, entry]) => ({ id, ...entry }))
  }, [items])

  const statusChips = useMemo(
    () => [...new Set(items.map((item) => item.status))].sort((left, right) => left.localeCompare(right)),
    [items],
  )

  const visibleItems = useMemo(() => {
    const terms = searchTerms(query)
    const matching = items.filter(
      (item) =>
        (saleFilter === 'all' || item.sale_id === saleFilter) &&
        (statusFilter === 'all' || item.status === statusFilter) &&
        itemMatchesSearch(item, terms, [item.category_name ?? 'Uncategorized', item.sale_title]),
    )
    return sortItems(matching, sortOrder)
  }, [items, query, saleFilter, statusFilter, sortOrder])

  const isFiltered = query.trim() !== '' || saleFilter !== 'all' || statusFilter !== 'all'

  function clearFilters(): void {
    setQuery('')
    setSaleFilter('all')
    setStatusFilter('all')
  }

  return (
    <section className="surface all-items" aria-labelledby="all-items-title">
      <div className="all-items-head">
        <div className="section-heading">
          <div>
            <h2 id="all-items-title">All items</h2>
            <p className="search-count" aria-live="polite">
              {loading
                ? 'Loading items...'
                : isFiltered
                  ? `${visibleItems.length} of ${items.length} items`
                  : `${items.length} ${items.length === 1 ? 'item' : 'items'} in ${saleChips.length} ${
                      saleChips.length === 1 ? 'sale' : 'sales'
                    }`}
            </p>
          </div>
          <div className="segmented" role="group" aria-label="Layout">
            <button
              type="button"
              aria-pressed={layout === 'list'}
              className={layout === 'list' ? 'active' : ''}
              onClick={() => changeLayout('list')}
            >
              List
            </button>
            <button
              type="button"
              aria-pressed={layout === 'grid'}
              className={layout === 'grid' ? 'active' : ''}
              onClick={() => changeLayout('grid')}
            >
              Photos
            </button>
          </div>
        </div>
      </div>

      <div className="toolbar all-items-toolbar">
        <div className="search-field">
          <label>
            Search all items
            <input
              type="search"
              placeholder="Name, room, sale, price..."
              autoComplete="off"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
        <PhotoSearchButton active={photoSearchOpen} onClick={() => setPhotoSearchOpen((open) => !open)} />
        <label className="sort-field">
          Sort
          <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}>
            <option value="newest">Newest first</option>
            <option value="name">Name A-Z</option>
            <option value="price-high">Price high-low</option>
            <option value="price-low">Price low-high</option>
          </select>
        </label>
      </div>

      {photoSearchOpen ? (
        <PhotoSearchPanel
          saleId={null}
          scopeLabel="every sale"
          onClose={() => setPhotoSearchOpen(false)}
          onOpenItem={onOpenItem}
          onOpenPhoto={onOpenPhoto}
        />
      ) : (
      <>
      <div className="all-items-filters">
        {saleChips.length > 1 ? (
          <div className="chip-row" role="group" aria-label="Filter by sale">
            <button
              type="button"
              className={`chip ${saleFilter === 'all' ? 'active' : ''}`}
              aria-pressed={saleFilter === 'all'}
              onClick={() => setSaleFilter('all')}
            >
              All sales
            </button>
            {saleChips.map((sale) => (
              <button
                type="button"
                key={sale.id}
                className={`chip ${saleFilter === sale.id ? 'active' : ''}`}
                aria-pressed={saleFilter === sale.id}
                onClick={() => setSaleFilter(sale.id)}
              >
                {sale.title} <span className="chip-count">{sale.count}</span>
              </button>
            ))}
          </div>
        ) : null}

        {statusChips.length > 1 ? (
          <div className="chip-row" role="group" aria-label="Filter by status">
            <button
              type="button"
              className={`chip ${statusFilter === 'all' ? 'active' : ''}`}
              aria-pressed={statusFilter === 'all'}
              onClick={() => setStatusFilter('all')}
            >
              Any status
            </button>
            {statusChips.map((status) => (
              <button
                type="button"
                key={status}
                className={`chip ${statusFilter === status ? 'active' : ''}`}
                aria-pressed={statusFilter === status}
                onClick={() => setStatusFilter(status)}
              >
                {titleCase(status)}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {error ? <div className="notice error">{error}</div> : null}

      {!loading && visibleItems.length === 0 ? (
        items.length === 0 ? (
          <p className="empty-copy">No items saved yet. Open a sale and tap Add item.</p>
        ) : (
          <div className="empty-search">
            <p className="empty-copy">No items match these filters.</p>
            <button type="button" className="secondary-button" onClick={() => clearFilters()}>
              Clear filters
            </button>
          </div>
        )
      ) : null}

      {layout === 'list' ? (
        <div className="card-list">
          {visibleItems.map((item) => (
            <div key={item.id} className="list-card item-row" data-item-id={item.id}>
              <ItemThumbnail item={item} onOpen={onOpenPhoto} />
              <button type="button" className="item-row-main" onClick={() => onOpenItem(item)}>
                <div>
                  <strong>{item.title}</strong>
                  <small className="item-sale-name">{item.sale_title}</small>
                  <small>
                    {item.category_name ?? 'Uncategorized'}
                    {item.room ? ` · ${item.room}` : ''}
                  </small>
                </div>
                <div className="card-meta">
                  <strong>
                    {item.price === null ? 'Unpriced' : formatCurrency(item.price)}
                    {(item.quantity ?? 1) > 1 ? <span className="quantity-badge"> × {item.quantity}</span> : null}
                  </strong>
                </div>
              </button>
              <div className="item-row-actions">
                <StatusMenu status={item.status} itemTitle={item.title} onChange={(status) => changeOrSell(item, status)} />
                <SellControls
                  item={item}
                  onSell={(target) => sellFlow.openSell(target)}
                  onUndoSale={(target) => void sellFlow.undoSale(target)}
                />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="item-grid">
          {visibleItems.map((item) => (
            <div key={item.id} className="grid-card" data-item-id={item.id}>
              <ItemThumbnail item={item} onOpen={onOpenPhoto} />
              <button type="button" className="grid-card-main" onClick={() => onOpenItem(item)}>
                <strong>{item.title}</strong>
                <small>{item.sale_title}</small>
                <span className="grid-card-meta">
                  <strong>
                    {item.price === null ? 'Unpriced' : formatCurrency(item.price)}
                    {(item.quantity ?? 1) > 1 ? <span className="quantity-badge"> × {item.quantity}</span> : null}
                  </strong>
                </span>
              </button>
              <div className="grid-card-actions">
                <StatusMenu status={item.status} itemTitle={item.title} onChange={(status) => changeOrSell(item, status)} />
                <SellControls
                  item={item}
                  onSell={(target) => sellFlow.openSell(target)}
                  onUndoSale={(target) => void sellFlow.undoSale(target)}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      </>
      )}
      {sellFlow.sheet}
    </section>
  )
}
