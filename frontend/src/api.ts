import type {
  BulkItemUpdatePayload,
  CategoryPayload,
  CategoryRead,
  DashboardResponse,
  ItemPayload,
  ItemRead,
  ItemUpdatePayload,
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

export function updateItem(itemId: number, payload: ItemUpdatePayload): Promise<ItemRead> {
  if (useBrowserDemoMode) {
    return mockApi.updateItem(itemId, payload)
  }

  return request<ItemRead>(`/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
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

export async function estimatePriceFromPhoto(
  photo: File,
  categoryHint: string,
  roomHint: string,
  notes: string,
  followUpAnswers: string,
): Promise<PricingEstimateResponse> {
  if (useBrowserDemoMode) {
    throw new Error('AI pricing needs the live backend/API to be available.')
  }

  if (API_BASE_URL === null) {
    throw new Error('API base URL is not configured.')
  }

  const formData = new FormData()
  formData.append('photo', photo)
  formData.append('category_hint', categoryHint)
  formData.append('room_hint', roomHint)
  formData.append('notes', notes)
  formData.append('follow_up_answers', followUpAnswers)

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
