import { useEffect, useMemo, useRef, useState } from 'react'
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
  /** The saved item, or null while adding a new item (photos are then queued). */
  itemId: number | null
  itemTitle: string
  /** Photos picked for a new item, uploaded right after it is created. */
  queuedFiles: File[]
  onQueuedFilesChange: (files: File[]) => void
  /** True when an AI pricing photo will also be saved with the item. */
  hasPricingPhoto: boolean
  onItemChanged: (item: ItemRead) => void
  onOpenViewer: (viewer: PhotoViewerState) => void
}

function pickedFiles(event: FormEvent<HTMLInputElement>): File[] {
  const files = Array.from(event.currentTarget.files ?? [])
  event.currentTarget.value = ''
  return files
}

/**
 * The item's own photos: view, add (camera or several files), remove and pick
 * the main one. Saved items upload immediately; new items queue the photos.
 * Never runs AI pricing.
 */
export function ItemPhotosPanel({
  itemId,
  itemTitle,
  queuedFiles,
  onQueuedFilesChange,
  hasPricingPhoto,
  onItemChanged,
  onOpenViewer,
}: ItemPhotosPanelProps) {
  const [photos, setPhotos] = useState<ItemPhotoInfo[] | null>(itemId === null ? [] : null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState('')
  const [uploads, setUploads] = useState<PendingUpload[]>([])
  const [busy, setBusy] = useState(false)
  const uploadKeyRef = useRef(0)
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (itemId === null) {
      return
    }
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

  const queuedPreviews = useMemo(() => queuedFiles.map((file) => URL.createObjectURL(file)), [queuedFiles])
  useEffect(() => () => queuedPreviews.forEach((url) => URL.revokeObjectURL(url)), [queuedPreviews])

  const savedCount = photos?.length ?? 0
  const totalCount =
    itemId === null ? queuedFiles.length + (hasPricingPhoto ? 1 : 0) : savedCount + uploads.length
  const roomLeft = Math.max(0, MAX_PHOTOS_PER_ITEM - totalCount)

  const savedImages: PhotoViewerImage[] =
    itemId === null
      ? []
      : (photos ?? []).map((photo, position) => ({
          src: getItemGalleryPhotoUrl(itemId, photo) ?? '',
          alt: `Photo ${position + 1} of ${savedCount} of ${itemTitle || 'this item'}`,
        }))

  async function refreshAfter(item: ItemRead): Promise<void> {
    onItemChanged(item)
    if (itemId !== null) {
      setPhotos(await listItemPhotos(itemId))
    }
  }

  function uploadOne(upload: PendingUpload): void {
    if (itemId === null) {
      return
    }
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
    if (itemId === null) {
      onQueuedFilesChange([...queuedFiles, ...accepted])
      return
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
    if (itemId === null) {
      return
    }
    const question = photo.is_main && savedCount > 1
      ? 'Remove the main photo? The next photo will become the main one. This cannot be undone.'
      : 'Remove this photo? This cannot be undone.'
    if (!window.confirm(question)) {
      return
    }
    void runPhotoAction(() => removeItemPhoto(itemId, photo), 'The photo could not be removed.')
  }

  function handleMakeMain(photo: ItemPhotoInfo): void {
    if (itemId === null || photo.id === null) {
      return
    }
    const photoId = photo.id
    void runPhotoAction(() => setMainItemPhoto(itemId, photoId), 'The main photo could not be changed.')
  }

  function removeQueued(index: number): void {
    onQueuedFilesChange(queuedFiles.filter((_, position) => position !== index))
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
        Photos{totalCount > 0 ? ` (${totalCount})` : ''}
      </legend>
      {photos === null ? <p className="hint-copy">Loading photos...</p> : null}
      {loadError ? <div className="notice error">{loadError}</div> : null}

      {itemId !== null && (savedCount > 0 || uploads.length > 0) ? (
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

      {itemId === null && queuedFiles.length > 0 ? (
        <ul className="photo-grid">
          {queuedFiles.map((file, index) => (
            <li key={`${file.name}-${file.lastModified}-${index}`} className="photo-tile">
              <span className="photo-tile-image">
                <img src={queuedPreviews[index]} alt={`New photo ${index + 1}`} />
              </span>
              {index === 0 && !hasPricingPhoto ? <span className="photo-tile-badge">Main photo</span> : null}
              <button type="button" className="secondary-button photo-tile-action" onClick={() => removeQueued(index)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {photos !== null && totalCount === 0 ? <p className="hint-copy">No photos yet.</p> : null}
      {itemId === null && (queuedFiles.length > 0 || hasPricingPhoto) ? (
        <p className="hint-copy">
          {hasPricingPhoto ? 'The AI pricing photo below will be saved too, as the main photo.' : 'The first photo will be the main photo.'}
        </p>
      ) : null}
      {itemId !== null && hasPricingPhoto ? (
        <p className="hint-copy">The AI pricing photo below is added to these photos when you press Update item.</p>
      ) : null}
      {actionError ? <div className="notice error">{actionError}</div> : null}
      {addButtons}
      {roomLeft === 0 ? (
        <p className="hint-copy">This item has the most photos allowed ({MAX_PHOTOS_PER_ITEM}).</p>
      ) : (
        <p className="hint-copy">
          {itemId === null
            ? 'Photos added here are saved when you press Save item. They do not run AI pricing.'
            : 'Photos added here are saved right away. They do not run AI pricing.'}
        </p>
      )}
    </fieldset>
  )
}
