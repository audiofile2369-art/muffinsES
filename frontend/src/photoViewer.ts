/** Shared shapes for the full-screen photo viewer. */

export interface PhotoViewerImage {
  src: string
  alt: string
}

export interface PhotoViewerState extends PhotoViewerImage {
  /** Every photo to page through (with previous/next) when there are several. */
  gallery?: PhotoViewerImage[]
  /** Index of the shown photo within `gallery`. */
  index?: number
}

/** Open an item's photos in the viewer, starting at `index`. */
export function buildGalleryViewer(images: PhotoViewerImage[], index: number): PhotoViewerState | null {
  const shown = images[index]
  if (!shown) {
    return null
  }
  return { ...shown, gallery: images.length > 1 ? images : undefined, index }
}

/** Move the viewer to the previous (-1) or next (+1) photo, wrapping around. */
export function stepPhotoViewer(viewer: PhotoViewerState | null, step: number): PhotoViewerState | null {
  if (!viewer?.gallery || viewer.gallery.length < 2) {
    return viewer
  }
  const count = viewer.gallery.length
  const index = ((viewer.index ?? 0) + step + count) % count
  return buildGalleryViewer(viewer.gallery, index)
}
