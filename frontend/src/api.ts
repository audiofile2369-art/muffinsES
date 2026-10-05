import type {
  BulkItemUpdatePayload,
  CategoryPayload,
  CategoryRead,
  DashboardResponse,
  ItemPayload,
  ItemPhotoInfo,
  ItemRead,
  ItemStatus,
  ItemPartialUpdatePayload,
  ItemSellPayload,
  ItemUpdatePayload,
  PaymentMethod,
  ItemWithSale,
  PhotoSearchResponse,
  PricingEstimateResponse,
  SalePayload,
  SaleRead,
  TaskPayload,
  TaskRead,
  TaskUpdatePayload,
  WorkspaceResponse,
} from './types'
import * as mockApi from './mockApi'

const LEGACY_BROWSER_IMPORT_FLAG = 'muffines-imported-browser-data-v1'

const runtimeHostname = typeof window === 'undefined' ? '' : window.location.hostname
const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL
const localApiBaseUrl =
  runtimeHostname === '127.0.0.1' || runtimeHostname === 'localhost'
    ? 'http://127.0.0.1:8000/api'
    : null
const productionApiBaseUrl = localApiBaseUrl === null ? '/api' : null
const API_BASE_URL = configuredApiBaseUrl ?? localApiBaseUrl ?? productionApiBaseUrl
const useBrowserDemoMode = API_BASE_URL === null

function extractErrorMessage(rawMessage: string, status: number): string {
  const trimmedMessage = rawMessage.trim()
  if (!trimmedMessage) {
    return `Request failed with status ${status}`
  }

  try {
    const parsed = JSON.parse(trimmedMessage) as { detail?: unknown; message?: unknown }
    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim()
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim()
    }
  } catch {
    // Fall back to the raw response body when the server did not return JSON.
  }

  return trimmedMessage
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (API_BASE_URL === null) {
    throw new Error('API base URL is not configured.')
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(extractErrorMessage(message, response.status))
  }

  return (await response.json()) as T
}

export function getDataSourceMode(): 'backend' | 'browser-demo' {
  return useBrowserDemoMode ? 'browser-demo' : 'backend'
}

export function getDashboard(): Promise<DashboardResponse> {
  if (useBrowserDemoMode) {
    return mockApi.getDashboard()
  }

  return request<DashboardResponse>('/dashboard')
}

export function getWorkspace(saleId: number): Promise<WorkspaceResponse> {
  if (useBrowserDemoMode) {
    return mockApi.getWorkspace(saleId)
  }

  return request<WorkspaceResponse>(`/sales/${saleId}/workspace`)
}

export function getAllItems(): Promise<ItemWithSale[]> {
  if (useBrowserDemoMode) {
    return mockApi.getAllItems()
  }

  return request<ItemWithSale[]>('/items')
}

export function createSale(payload: SalePayload): Promise<SaleRead> {
  if (useBrowserDemoMode) {
    return mockApi.createSale(payload)
  }

  return request<SaleRead>('/sales', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateSale(saleId: number, payload: SalePayload): Promise<SaleRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateSale(saleId, payload)
  }

  return request<SaleRead>(`/sales/${saleId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function createCategory(payload: CategoryPayload): Promise<CategoryRead> {
  if (useBrowserDemoMode) {
    return mockApi.createCategory(payload)
  }

  return request<CategoryRead>('/categories', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateCategory(categoryId: number, payload: CategoryPayload): Promise<CategoryRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateCategory(categoryId, payload)
  }

  return request<CategoryRead>(`/categories/${categoryId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function createItem(payload: ItemPayload): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.createItem(payload)
  }

  return request<ItemRead>('/items', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateItem(itemId: number, payload: ItemUpdatePayload | ItemPartialUpdatePayload): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateItem(itemId, payload)
  }

  return request<ItemRead>(`/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

/** Delete an item and all of its photos. */
export async function deleteItem(itemId: number): Promise<void> {
  if (useBrowserDemoMode) {
    return mockApi.deleteItem(itemId)
  }

  if (API_BASE_URL === null) {
    throw new Error('API base URL is not configured.')
  }

  // keepalive: a delete flushed as the page closes (after the Undo toast) still reaches the server.
  const response = await fetch(`${API_BASE_URL}/items/${itemId}`, { method: 'DELETE', keepalive: true })
  if (!response.ok) {
    const message = await response.text()
    throw new Error(extractErrorMessage(message, response.status))
  }
}

/** Add `amount` more of an existing item without resending (and overwriting) the rest of it. */
export function incrementItemQuantity(itemId: number, amount: number): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.incrementItemQuantity(itemId, amount)
  }

  return request<ItemRead>(`/items/${itemId}/quantity/increment`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  })
}

/** Take back `amount` of an item (Undo after adding to its quantity); never below 1. */
export function decrementItemQuantity(itemId: number, amount: number): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.decrementItemQuantity(itemId, amount)
  }

  return request<ItemRead>(`/items/${itemId}/quantity/decrement`, {
    method: 'POST',
    body: JSON.stringify({ amount }),
  })
}

/** Record a sale of some (or all remaining) units. Fails (409) when fewer remain. */
export function sellItem(itemId: number, payload: ItemSellPayload): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.sellItem(itemId, payload)
  }

  return request<ItemRead>(`/items/${itemId}/sell`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

/** Undo one recorded sale, or (no eventId) every sale of the item. */
export function unsellItem(itemId: number, eventId?: number | null): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.unsellItem(itemId, eventId ?? null)
  }

  return request<ItemRead>(`/items/${itemId}/unsell`, {
    method: 'POST',
    body: JSON.stringify({ event_id: eventId ?? null }),
  })
}

/** Correct how a sale was paid (default: the latest sale). */
export function updateItemPaymentMethod(
  itemId: number,
  paymentMethod: PaymentMethod,
  eventId?: number | null,
): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateItemPaymentMethod(itemId, paymentMethod, eventId ?? null)
  }

  return request<ItemRead>(`/items/${itemId}/payment-method`, {
    method: 'PATCH',
    body: JSON.stringify({ payment_method: paymentMethod, event_id: eventId ?? null }),
  })
}

/** Change only an item's status; the rest of the item is never resent. */
export function updateItemStatus(itemId: number, status: ItemStatus): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateItemStatus(itemId, status)
  }

  return request<ItemRead>(`/items/${itemId}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  })
}

export function bulkUpdateItems(payload: BulkItemUpdatePayload): Promise<ItemRead[]> {
  if (useBrowserDemoMode) {
    return mockApi.bulkUpdateItems(payload)
  }

  const normalizedPayload = {
    ...payload,
    category_id: payload.category_id === undefined ? undefined : payload.category_id,
  }

  return request<ItemRead[]>('/items/bulk-update', {
    method: 'POST',
    body: JSON.stringify(normalizedPayload),
  })
}

export function createTask(payload: TaskPayload): Promise<TaskRead> {
  if (useBrowserDemoMode) {
    return mockApi.createTask(payload)
  }

  return request<TaskRead>('/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateTask(taskId: number, payload: TaskUpdatePayload): Promise<TaskRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateTask(taskId, payload)
  }

  return request<TaskRead>(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export async function importLegacyBrowserDataToBackend(): Promise<boolean> {
  if (useBrowserDemoMode || typeof window === 'undefined') {
    return false
  }

  if (window.localStorage.getItem(LEGACY_BROWSER_IMPORT_FLAG) === 'done') {
    return false
  }

  const browserState = mockApi.getStoredBrowserState()
  if (!browserState || browserState.sales.length === 0) {
    return false
  }

  const categoryIdMap = new Map<number, number>()
  for (const category of browserState.categories) {
    const createdCategory = await createCategory({
      name: category.name,
      color: category.color,
      sort_order: category.sort_order,
    })
    categoryIdMap.set(category.id, createdCategory.id)
  }

  const saleIdMap = new Map<number, number>()
  for (const sale of browserState.sales) {
    const createdSale = await createSale({
      title: sale.title,
      address: sale.address,
      start_date: sale.start_date,
      end_date: sale.end_date,
      status: sale.status,
      notes: sale.notes,
    })
    saleIdMap.set(sale.id, createdSale.id)
  }

  for (const item of browserState.items) {
    const migratedSaleId = saleIdMap.get(item.sale_id)
    if (!migratedSaleId) {
      continue
    }

    await createItem({
      sale_id: migratedSaleId,
      category_id: item.category_id === null ? null : (categoryIdMap.get(item.category_id) ?? null),
      title: item.title,
      description: item.description,
      room: item.room,
      condition: item.condition,
      price: item.price,
      quantity: item.quantity ?? 1,
      status: item.status,
      notes: item.notes,
      photo_url: item.photo_url,
    })
  }

  for (const task of browserState.tasks) {
    const migratedSaleId = saleIdMap.get(task.sale_id)
    if (!migratedSaleId) {
      continue
    }

    await createTask({
      sale_id: migratedSaleId,
      title: task.title,
      due_date: task.due_date,
      status: task.status,
      notes: task.notes,
    })
  }

  mockApi.clearStoredBrowserState()
  window.localStorage.setItem(LEGACY_BROWSER_IMPORT_FLAG, 'done')
  return true
}

const MAX_PHOTO_DIMENSION = 1600
const MAX_UNSCALED_PHOTO_BYTES = 1_500_000
const ITEM_PHOTO_DIMENSION = 640
const SEARCH_PHOTO_DIMENSION = 1024

/**
 * Re-encode a photo as a JPEG whose longest side is at most `maxDimension`.
 * Returns null when the browser cannot decode or draw the image.
 */
async function resizePhoto(photo: File, maxDimension: number, quality: number): Promise<File | null> {
  if (typeof createImageBitmap !== 'function') {
    return null
  }

  try {
    const bitmap = await createImageBitmap(photo)
    const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      return null
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
    if (!blob) {
      return null
    }
    return new File([blob], photo.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
  } catch {
    return null
  }
}

/**
 * Downscale large phone/tablet photos so the upload stays far below the
 * 4.5 MB serverless request limit. Falls back to the original file.
 */
async function shrinkPhotoForUpload(photo: File): Promise<File> {
  if (photo.size <= MAX_UNSCALED_PHOTO_BYTES) {
    return photo
  }
  return (await resizePhoto(photo, MAX_PHOTO_DIMENSION, 0.85)) ?? photo
}

/** URL of an item's stored thumbnail, or null when none is saved. */
export function getItemPhotoUrl(item: ItemRead): string | null {
  if (API_BASE_URL === null || !item.photo_version) {
    return null
  }
  return `${API_BASE_URL}/items/${item.id}/photo?v=${encodeURIComponent(item.photo_version)}`
}

/** Remove the main photo from an item (its next photo, if any, becomes the main one). */
export function deleteItemPhoto(itemId: number): Promise<ItemRead> {
  return request<ItemRead>(`/items/${itemId}/photo`, { method: 'DELETE' })
}

/** Most photos one item can hold (matches the backend). */
export const MAX_PHOTOS_PER_ITEM = 12

/** URL of one of an item's photos from `listItemPhotos`. */
export function getItemGalleryPhotoUrl(itemId: number, photo: ItemPhotoInfo): string | null {
  if (API_BASE_URL === null) {
    return null
  }
  const path = photo.id === null ? `/items/${itemId}/photo` : `/items/${itemId}/photos/${photo.id}`
  return `${API_BASE_URL}${path}?v=${encodeURIComponent(photo.version)}`
}

/** List an item's photos, main photo first (no image bytes). */
export function listItemPhotos(itemId: number): Promise<ItemPhotoInfo[]> {
  if (useBrowserDemoMode) {
    return mockApi.listItemPhotos(itemId)
  }
  return request<ItemPhotoInfo[]>(`/items/${itemId}/photos`)
}

/** Shrink a picked photo and add it to the item; an item's first photo becomes its main photo. */
export async function addItemPhoto(itemId: number, photo: File): Promise<ItemRead> {
  if (useBrowserDemoMode || API_BASE_URL === null) {
    throw new Error('Saving item photos needs the live backend/API to be available.')
  }

  const thumbnail = (await resizePhoto(photo, ITEM_PHOTO_DIMENSION, 0.8)) ?? photo
  const formData = new FormData()
  formData.append('photo', thumbnail)

  const response = await fetch(`${API_BASE_URL}/items/${itemId}/photos`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(extractErrorMessage(message, response.status))
  }

  return (await response.json()) as ItemRead
}

/** Remove one of an item's photos (the main photo goes through `deleteItemPhoto`). */
export function removeItemPhoto(itemId: number, photo: ItemPhotoInfo): Promise<ItemRead> {
  if (photo.id === null) {
    return deleteItemPhoto(itemId)
  }
  return request<ItemRead>(`/items/${itemId}/photos/${photo.id}`, { method: 'DELETE' })
}

/** Make one of an item's extra photos its main photo. */
export function setMainItemPhoto(itemId: number, photoId: number): Promise<ItemRead> {
  return request<ItemRead>(`/items/${itemId}/photos/${photoId}/main`, { method: 'POST' })
}

export async function estimatePriceFromPhoto(
  photo: File,
  categoryHint: string,
  roomHint: string,
  notes: string,
  followUpAnswers: string,
  categories: string[] = [],
): Promise<PricingEstimateResponse> {
  if (useBrowserDemoMode) {
    throw new Error('AI pricing needs the live backend/API to be available.')
  }

  if (API_BASE_URL === null) {
    throw new Error('API base URL is not configured.')
  }

  const formData = new FormData()
  formData.append('photo', await shrinkPhotoForUpload(photo))
  formData.append('category_hint', categoryHint)
  formData.append('room_hint', roomHint)
  formData.append('notes', notes)
  formData.append('follow_up_answers', followUpAnswers)
  formData.append('categories', JSON.stringify(categories))

  const response = await fetch(`${API_BASE_URL}/pricing/estimate`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(extractErrorMessage(message, response.status))
  }

  return (await response.json()) as PricingEstimateResponse
}

/**
 * Find saved items that look like the photo: in one sale, or in every sale when
 * `saleId` is null. The photo is downscaled first to keep the upload small.
 */
export async function searchItemsByPhoto(photo: File, saleId: number | null): Promise<PhotoSearchResponse> {
  if (useBrowserDemoMode || API_BASE_URL === null) {
    throw new Error('Search by photo needs the live backend/API to be available.')
  }

  const formData = new FormData()
  formData.append('photo', (await resizePhoto(photo, SEARCH_PHOTO_DIMENSION, 0.85)) ?? (await shrinkPhotoForUpload(photo)))
  if (saleId !== null) {
    formData.append('sale_id', String(saleId))
  }

  const response = await fetch(`${API_BASE_URL}/items/search-by-photo`, {
    method: 'POST',
    body: formData,
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(extractErrorMessage(message, response.status))
  }

  return (await response.json()) as PhotoSearchResponse
}
