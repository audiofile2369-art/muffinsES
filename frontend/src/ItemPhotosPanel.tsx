import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  addItemPhoto,
  getItemGalleryPhotoUrl,
  listItemPhotos,
  MAX_PHOTOS_PER_ITEM,
  removeItemPhoto,
  setMainItemPhoto,
} from './api'
import { buildGalleryViewer } from './photoViewer'
import type { PhotoViewerImage, PhotoViewerState } from './photoViewer'
import type { ItemPhotoInfo, ItemRead } from './types'

interface PendingUpload {
  key: number
  file: File
  previewUrl: string
  error: string
}

interface ItemPhotosPanelProps {
  /** The saved item (a new item gets its one photo from the AI pricing step instead). */
  itemId: number
  itemTitle: string
  onItemChanged: (item: ItemRead) => void
  onOpenViewer: (viewer: PhotoViewerState) => void
}

function pickedFiles(event: FormEvent<HTMLInputElement>): File[] {
  const files = Array.from(event.currentTarget.files ?? [])
  event.currentTarget.value = ''
  return files
}

/**
 * A saved item's photos ("Add more photos"): view, add (camera or several files),
 * remove and pick the main one. Uploads happen immediately. Never runs AI pricing.
 */
export function ItemPhotosPanel({
  itemId,
  itemTitle,
  onItemChanged,
  onOpenViewer,
}: ItemPhotosPanelProps) {
  const [photos, setPhotos] = useState<ItemPhotoInfo[] | null>(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const [busy, setBusy] = useState(false)
  const uploadKeyRef = useRef(0)
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    let cancelled = false
    listItemPhotos(itemId)
      .then((list) => {
        if (!cancelled) {
          setPhotos(list)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPhotos([])
          setLoadError(error instanceof Error ? error.message : 'Could not load the photos.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [itemId])

  const savedCount = photos?.length ?? 0
  const totalCount = savedCount + uploads.length
  const roomLeft = Math.max(0, MAX_PHOTOS_PER_ITEM - totalCount)

  const savedImages: PhotoViewerImage[] = (photos ?? []).map((photo, position) => ({
    src: getItemGalleryPhotoUrl(itemId, photo) ?? '',
    alt: `Photo ${position + 1} of ${savedCount} of ${itemTitle || 'this item'}`,
  }))

  async function refreshAfter(item: ItemRead): Promise<void> {
    onItemChanged(item)
    setPhotos(await listItemPhotos(itemId))
  }

  function uploadOne(upload: PendingUpload): void {
    // One upload at a time keeps the photo order and the per-item limit exact.
    uploadQueueRef.current = uploadQueueRef.current.then(async () => {
      try {
        const item = await addItemPhoto(itemId, upload.file)
        setUploads((current) => current.filter((entry) => entry.key !== upload.key))
        URL.revokeObjectURL(upload.previewUrl)
        await refreshAfter(item)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error.'
        setUploads((current) =>
          current.map((entry) => (entry.key === upload.key ? { ...entry, error: message } : entry)),
        )
      }
    })
  }

  function handleFilesPicked(event: FormEvent<HTMLInputElement>): void {
    const files = pickedFiles(event)
    if (files.length === 0) {
      return
    }
    setActionError('')
    const accepted = files.slice(0, roomLeft)
    if (accepted.length < files.length) {
      setActionError(
        `An item can have up to ${MAX_PHOTOS_PER_ITEM} photos, so ${files.length - accepted.length} photo(s) were not added.`,
      )
    }
    const newUploads = accepted.map((file) => {
      uploadKeyRef.current += 1
      return { key: uploadKeyRef.current, file, previewUrl: URL.createObjectURL(file), error: '' }
    })
    setUploads((current) => [...current, ...newUploads])
    newUploads.forEach(uploadOne)
  }

  function retryUpload(upload: PendingUpload): void {
    const retried = { ...upload, error: '' }
    setUploads((current) => current.map((entry) => (entry.key === upload.key ? retried : entry)))
    uploadOne(retried)
  }

  function dismissUpload(upload: PendingUpload): void {
    URL.revokeObjectURL(upload.previewUrl)
    setUploads((current) => current.filter((entry) => entry.key !== upload.key))
  }

  async function runPhotoAction(action: () => Promise<ItemRead>, failure: string): Promise<void> {
    setBusy(true)
    setActionError('')
    try {
      await refreshAfter(await action())
    } catch (error) {
      setActionError(`${failure} ${error instanceof Error ? error.message : ''}`.trim())
    } finally {
      setBusy(false)
    }
  }

  function handleRemove(photo: ItemPhotoInfo): void {
    const question = photo.is_main && savedCount > 1
      ? 'Remove the main photo? The next photo will become the main one. This cannot be undone.'
      : 'Remove this photo? This cannot be undone.'
    if (!window.confirm(question)) {
      return
    }
    void runPhotoAction(() => removeItemPhoto(itemId, photo), 'The photo could not be removed.')
  }

  function handleMakeMain(photo: ItemPhotoInfo): void {
    if (photo.id === null) {
      return
    }
    const photoId = photo.id
    void runPhotoAction(() => setMainItemPhoto(itemId, photoId), 'The main photo could not be changed.')
  }

  const addButtons = (
    <div className="photo-actions">
      <label className={roomLeft === 0 ? 'secondary-button is-disabled' : 'secondary-button'}>
        Take photo
        <input
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          disabled={roomLeft === 0}
          onChange={handleFilesPicked}
        />
      </label>
      <label className={roomLeft === 0 ? 'secondary-button is-disabled' : 'secondary-button'}>
        Upload photos
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          multiple
          hidden
          disabled={roomLeft === 0}
          onChange={handleFilesPicked}
        />
      </label>
    </div>
  )

  return (
    <fieldset className="item-photos" aria-busy={busy || uploads.some((upload) => !upload.error)}>
      <legend>
        Photos{totalCount > 0 ? ` (${totalCount})` : ''} &mdash; add more photos
      </legend>
      {photos === null ? <p className="hint-copy">Loading photos...</p> : null}
      {loadError ? <div className="notice error">{loadError}</div> : null}

      {savedCount > 0 || uploads.length > 0 ? (
        <ul className="photo-grid">
          {(photos ?? []).map((photo, position) => (
            <li key={`${photo.id ?? 'main'}-${photo.version}`} className="photo-tile">
              <button
                type="button"
                className="photo-tile-image"
                aria-label={`View photo ${position + 1} larger`}
                onClick={() => {
                  const viewer = buildGalleryViewer(savedImages, position)
                  if (viewer) {
                    onOpenViewer(viewer)
                  }
                }}
              >
                <img src={savedImages[position]?.src} alt={savedImages[position]?.alt} loading="lazy" />
              </button>
              {photo.is_main ? (
                <span className="photo-tile-badge">Main photo</span>
              ) : (
                <button
                  type="button"
                  className="secondary-button photo-tile-action"
                  disabled={busy}
                  onClick={() => handleMakeMain(photo)}
                >
                  Make main
                </button>
              )}
              <button
                type="button"
                className="secondary-button photo-tile-action photo-tile-remove"
                disabled={busy}
                onClick={() => handleRemove(photo)}
              >
                Remove
              </button>
            </li>
          ))}
          {uploads.map((upload) => (
            <li key={`upload-${upload.key}`} className={upload.error ? 'photo-tile has-error' : 'photo-tile is-uploading'}>
              <span className="photo-tile-image">
                <img src={upload.previewUrl} alt="Photo being saved" />
              </span>
              {upload.error ? (
                <>
                  <span className="photo-tile-status error" role="alert">
                    Not saved: {upload.error}
                  </span>
                  <button type="button" className="secondary-button photo-tile-action" onClick={() => retryUpload(upload)}>
                    Try again
                  </button>
                  <button type="button" className="secondary-button photo-tile-action" onClick={() => dismissUpload(upload)}>
                    Dismiss
                  </button>
                </>
              ) : (
                <span className="photo-tile-status" role="status">
                  Saving...
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {photos !== null && totalCount === 0 ? <p className="hint-copy">No photos yet.</p> : null}
      {actionError ? <div className="notice error">{actionError}</div> : null}
      {addButtons}
      {roomLeft === 0 ? (
        <p className="hint-copy">This item has the most photos allowed ({MAX_PHOTOS_PER_ITEM}).</p>
      ) : (
        <p className="hint-copy">Photos added here are saved right away.</p>
      )}
    </fieldset>
  )
}
