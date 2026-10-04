import { useState } from 'react'
import { getItemPhotoUrl } from './api'
import type { ItemRead } from './types'

export interface PhotoViewerState {
  src: string
  alt: string
}

export function ItemThumbnail({
  item,
  onOpen,
}: {
  item: ItemRead
  onOpen: (photo: PhotoViewerState) => void
}) {
  const storedUrl = getItemPhotoUrl(item)
  const typedUrl = item.photo_url?.trim() || null
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const candidates = [storedUrl, typedUrl].filter(
    (url): url is string => Boolean(url) && url !== failedSrc,
  )
  const src = candidates[0] ?? null
  const alt = `Photo of ${item.title}`

  if (!src) {
    return (
      <span className="item-thumb item-thumb-placeholder" role="img" aria-label={`No photo for ${item.title}`}>
        <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
          <path
            fill="currentColor"
            d="M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 2v9.6l3.3-3.3a1 1 0 0 1 1.4 0l2.3 2.3 4.3-4.3a1 1 0 0 1 1.4 0L19 11.6V6H5Zm4 3.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z"
          />
        </svg>
      </span>
    )
  }

  return (
    <button
      type="button"
      className="item-thumb"
      aria-label={`View larger photo of ${item.title}`}
      onClick={() => onOpen({ src, alt })}
    >
      <img src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />
    </button>
  )
}
