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

const runtimeHostname = typeof window === 'undefined' ? '' : window.location.hostname
const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL
const localApiBaseUrl =
  runtimeHostname === '127.0.0.1' || runtimeHostname === 'localhost'
    ? 'http://127.0.0.1:8000/api'
    : null
const productionApiBaseUrl = localApiBaseUrl === null ? '/api' : null
const API_BASE_URL = configuredApiBaseUrl ?? localApiBaseUrl ?? productionApiBaseUrl
const useBrowserDemoMode = API_BASE_URL === null

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
    throw new Error(message || `Request failed with status ${response.status}`)
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
    throw new Error(message || `Request failed with status ${response.status}`)
  }

  return (await response.json()) as PricingEstimateResponse
}
