import { useState } from 'react'
import { getItemGalleryPhotoUrl, getItemPhotoUrl, listItemPhotos } from './api'
import { buildGalleryViewer } from './photoViewer'
import type { PhotoViewerState } from './photoViewer'
import type { ItemRead } from './types'

export type { PhotoViewerState } from './photoViewer'

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
  const photoCount = item.photo_count ?? 0
  const extraCount = src === storedUrl ? photoCount - 1 : 0

  async function openViewer(shownSrc: string): Promise<void> {
    if (extraCount <= 0) {
      onOpen({ src: shownSrc, alt })
      return
    }
    try {
      const photos = await listItemPhotos(item.id)
      const images = photos
        .map((photo, position) => ({
          src: getItemGalleryPhotoUrl(item.id, photo) ?? '',
          alt: `Photo ${position + 1} of ${photos.length} of ${item.title}`,
        }))
        .filter((image) => image.src)
      onOpen(buildGalleryViewer(images, 0) ?? { src: shownSrc, alt })
    } catch {
      onOpen({ src: shownSrc, alt })
    }
  }

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
      aria-label={
        extraCount > 0
          ? `View ${photoCount} photos of ${item.title}`
          : `View larger photo of ${item.title}`
      }
      onClick={() => void openViewer(src)}
    >
      <img src={src} alt={alt} loading="lazy" onError={() => setFailedSrc(src)} />
      {extraCount > 0 ? (
        <span className="item-thumb-count" aria-hidden="true">
          +{extraCount}
        </span>
      ) : null}
    </button>
  )
}
