import type {
  BulkItemUpdatePayload,
  CategoryPayload,
  CategoryRead,
  DashboardResponse,
  ItemPayload,
  ItemRead,
  ItemUpdatePayload,
  SalePayload,
  SaleRead,
  TaskPayload,
  TaskRead,
  TaskUpdatePayload,
  WorkspaceResponse,
} from './types'

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000/api'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

export function getDashboard(): Promise<DashboardResponse> {
  return request<DashboardResponse>('/dashboard')
}

export function getWorkspace(saleId: number): Promise<WorkspaceResponse> {
  return request<WorkspaceResponse>(`/sales/${saleId}/workspace`)
}

export function createSale(payload: SalePayload): Promise<SaleRead> {
  return request<SaleRead>('/sales', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateSale(saleId: number, payload: SalePayload): Promise<SaleRead> {
  return request<SaleRead>(`/sales/${saleId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function createCategory(payload: CategoryPayload): Promise<CategoryRead> {
  return request<CategoryRead>('/categories', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateCategory(categoryId: number, payload: CategoryPayload): Promise<CategoryRead> {
  return request<CategoryRead>(`/categories/${categoryId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function createItem(payload: ItemPayload): Promise<ItemRead> {
  return request<ItemRead>('/items', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateItem(itemId: number, payload: ItemUpdatePayload): Promise<ItemRead> {
  return request<ItemRead>(`/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function bulkUpdateItems(payload: BulkItemUpdatePayload): Promise<ItemRead[]> {
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
  return request<TaskRead>('/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateTask(taskId: number, payload: TaskUpdatePayload): Promise<TaskRead> {
  return request<TaskRead>(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}
