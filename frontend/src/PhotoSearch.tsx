import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { searchItemsByPhoto } from './api'
import { formatCurrency } from './format'
import { ItemThumbnail } from './ItemThumbnail'
import type { PhotoViewerState } from './photoViewer'
import type { ItemWithSale, PhotoSearchMatch, PhotoSearchResponse } from './types'

const CONFIDENCE_LABELS: Record<PhotoSearchMatch['confidence'], string> = {
  high: 'Strong match',
  medium: 'Possible match',
  low: 'Weak match',
}

/** Camera button shown next to an item search box. */
export function PhotoSearchButton({ active, onClick }: { active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={active ? 'secondary-button photo-search-button active' : 'secondary-button photo-search-button'}
      aria-pressed={active}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M9 4h6l1.6 2H20a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3.4L9 4Zm3 4.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z"
        />
      </svg>
      Search by photo
    </button>
  )
}

interface PhotoSearchPanelProps {
  /** Search one sale, or every sale when null. */
  saleId: number | null
  scopeLabel: string
  onClose: () => void
  onOpenItem: (item: ItemWithSale) => void
  onOpenPhoto: (viewer: PhotoViewerState) => void
}

type SearchState =
  | { phase: 'pick' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'done'; result: PhotoSearchResponse }

/** Take or upload a photo and list the saved items that look like it. */
export function PhotoSearchPanel({ saleId, scopeLabel, onClose, onOpenItem, onOpenPhoto }: PhotoSearchPanelProps) {
  const [state, setState] = useState<SearchState>({ phase: 'pick' })
  const [queryUrl, setQueryUrl] = useState('')
  const searchIdRef = useRef(0)

  useEffect(() => () => {
    if (queryUrl) {
      URL.revokeObjectURL(queryUrl)
    }
  }, [queryUrl])

  async function handlePicked(event: FormEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) {
      return
    }
    searchIdRef.current += 1
    const searchId = searchIdRef.current
    setQueryUrl(URL.createObjectURL(file))
    setState({ phase: 'loading' })
    try {
      const result = await searchItemsByPhoto(file, saleId)
      if (searchId === searchIdRef.current) {
        setState({ phase: 'done', result })
      }
    } catch (error) {
      if (searchId === searchIdRef.current) {
        setState({ phase: 'error', message: error instanceof Error ? error.message : 'The photo search failed.' })
      }
    }
  }

  const pickButtons = (label: string) => (
    <div className="photo-actions">
      <label className="secondary-button">
        {label === 'first' ? 'Take photo' : 'Take another photo'}
        <input type="file" accept="image/*" capture="environment" hidden onChange={(event) => void handlePicked(event)} />
      </label>
      <label className="secondary-button">
        {label === 'first' ? 'Upload photo' : 'Upload another photo'}
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          hidden
          onChange={(event) => void handlePicked(event)}
        />
      </label>
    </div>
  )

  return (
    <section className="photo-search-panel" aria-label="Search by photo" aria-busy={state.phase === 'loading'}>
      <div className="photo-search-head">
        <div>
          <strong>Search by photo</strong>
          <small>Finds matching items in {scopeLabel}.</small>
        </div>
        <button type="button" className="secondary-button" onClick={onClose}>
          Back to the list
        </button>
      </div>

      {queryUrl && state.phase !== 'pick' ? (
        <img className="photo-search-query" src={queryUrl} alt="Photo you are searching with" />
      ) : null}

      {state.phase === 'pick' ? (
        <>
          <p className="hint-copy">Take or upload a photo of an item to find it in the inventory.</p>
          {pickButtons('first')}
        </>
      ) : null}

      {state.phase === 'loading' ? (
        <p className="photo-search-status" role="status">
          <span className="spinner" aria-hidden="true" /> Looking for this item... this can take up to half a minute.
        </p>
      ) : null}

      {state.phase === 'error' ? (
        <>
          <div className="notice error" role="alert">
            {state.message}
          </div>
          {pickButtons('again')}
        </>
      ) : null}

      {state.phase === 'done' ? (
        <>
          {state.result.summary ? <p className="hint-copy">Looks like: {state.result.summary}</p> : null}
          {state.result.matches.length === 0 ? (
            <p className="empty-copy" role="status">
              No match found. Try a closer, well-lit photo, or search by name instead.
            </p>
          ) : (
            <ol className="card-list photo-search-results" aria-label="Matching items, best first">
              {state.result.matches.map((match) => (
                <li key={match.item.id} className="list-card item-row">
                  <ItemThumbnail item={match.item} onOpen={onOpenPhoto} />
                  <button type="button" className="item-row-main" onClick={() => onOpenItem(match.item)}>
                    <div>
                      <strong>{match.item.title}</strong>
                      <small className="item-sale-name">{match.item.sale_title}</small>
                      {match.reason ? <small>{match.reason}</small> : null}
                    </div>
                    <div className="card-meta">
                      <span className={`status-pill confidence-${match.confidence}`}>
                        {CONFIDENCE_LABELS[match.confidence]}
                      </span>
                      <strong>{match.item.price === null ? 'Unpriced' : formatCurrency(match.item.price)}</strong>
                    </div>
                  </button>
                </li>
              ))}
            </ol>
          )}
          {pickButtons('again')}
        </>
      ) : null}
    </section>
  )
}
