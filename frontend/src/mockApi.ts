import type {
  BulkItemUpdatePayload,
  CategoryBreakdown,
  CategoryPayload,
  CategoryRead,
  DashboardResponse,
  ItemPayload,
  ItemRead,
  ItemUpdatePayload,
  ReportMetrics,
  RoomBreakdown,
  SalePayload,
  SaleRead,
  SaleSummary,
  TaskPayload,
  TaskRead,
  TaskUpdatePayload,
  WorkspaceResponse,
} from './types'

interface MockState {
  sales: SaleRead[]
  categories: CategoryRead[]
  items: ItemRead[]
  tasks: TaskRead[]
  nextIds: {
    sale: number
    category: number
    item: number
    task: number
  }
}

const STORAGE_KEY = 'muffines-browser-state-v2'

function createInitialState(): MockState {
  return {
    sales: [],
    categories: [],
    items: [],
    tasks: [],
    nextIds: {
      sale: 1,
      category: 1,
      item: 1,
      task: 1,
    },
  }
}

export function getStoredBrowserState(): {
  sales: SaleRead[]
  categories: CategoryRead[]
  items: ItemRead[]
  tasks: TaskRead[]
} | null {
  if (typeof window === 'undefined') {
    return null
  }

  const existingState = window.localStorage.getItem(STORAGE_KEY)
  if (!existingState) {
    return null
  }

  const parsedState = JSON.parse(existingState) as MockState
  return {
    sales: parsedState.sales,
    categories: parsedState.categories,
    items: parsedState.items,
    tasks: parsedState.tasks,
  }
}

export function clearStoredBrowserState(): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.removeItem(STORAGE_KEY)
}

function loadState(): MockState {
  if (typeof window === 'undefined') {
    return createInitialState()
  }

  const existingState = window.localStorage.getItem(STORAGE_KEY)
  if (existingState) {
    return JSON.parse(existingState) as MockState
  }

  const initialState = createInitialState()
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(initialState))
  return initialState
}

function saveState(state: MockState): void {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function sortCategories(categories: CategoryRead[]): CategoryRead[] {
  return [...categories].sort((left, right) => {
    if (left.sort_order !== right.sort_order) {
      return left.sort_order - right.sort_order
    }

    return left.name.localeCompare(right.name)
  })
}

function buildSaleSummary(sale: SaleRead, state: MockState): SaleSummary {
  const saleItems = state.items.filter((item) => item.sale_id === sale.id)
  const saleTasks = state.tasks.filter((task) => task.sale_id === sale.id)
  const soldItems = saleItems.filter((item) => item.status === 'sold')
  const pricedItems = saleItems.filter((item) => item.price !== null)
  const pendingTaskCount = saleTasks.filter((task) => task.status !== 'done').length

  return {
    ...sale,
    item_count: saleItems.length,
    priced_count: pricedItems.length,
    sold_count: soldItems.length,
    pending_task_count: pendingTaskCount,
    estimated_revenue: Number(
      saleItems.reduce((sum, item) => sum + (item.price ?? 0), 0).toFixed(2),
    ),
    realized_revenue: Number(
      soldItems.reduce((sum, item) => sum + (item.price ?? 0), 0).toFixed(2),
    ),
  }
}

function buildReport(saleId: number, state: MockState): ReportMetrics {
  const saleItems = state.items.filter((item) => item.sale_id === saleId)
  const categories = new Map(state.categories.map((category) => [category.id, category.name]))
  const categoryMap = new Map<
    string,
    { itemCount: number; soldCount: number; listedValue: number; soldValue: number }
  >()
  const roomMap = new Map<string, { itemCount: number; listedValue: number }>()

  for (const item of saleItems) {
    const categoryName = categories.get(item.category_id ?? -1) ?? 'Uncategorized'
    const roomName = item.room || 'General'
    const categoryEntry = categoryMap.get(categoryName) ?? {
      itemCount: 0,
      soldCount: 0,
      listedValue: 0,
      soldValue: 0,
    }
    categoryEntry.itemCount += 1
    categoryEntry.listedValue += item.price ?? 0
    if (item.status === 'sold') {
      categoryEntry.soldCount += 1
      categoryEntry.soldValue += item.price ?? 0
    }
    categoryMap.set(categoryName, categoryEntry)

    const roomEntry = roomMap.get(roomName) ?? { itemCount: 0, listedValue: 0 }
    roomEntry.itemCount += 1
    roomEntry.listedValue += item.price ?? 0
    roomMap.set(roomName, roomEntry)
  }

  const categoryBreakdown: CategoryBreakdown[] = [...categoryMap.entries()]
    .map(([categoryName, values]) => ({
      category_name: categoryName,
      item_count: values.itemCount,
      sold_count: values.soldCount,
      listed_value: Number(values.listedValue.toFixed(2)),
      sold_value: Number(values.soldValue.toFixed(2)),
    }))
    .sort(
      (left, right) =>
        right.sold_value - left.sold_value || right.listed_value - left.listed_value,
    )

  const roomBreakdown: RoomBreakdown[] = [...roomMap.entries()]
    .map(([roomName, values]) => ({
      room_name: roomName,
      item_count: values.itemCount,
      listed_value: Number(values.listedValue.toFixed(2)),
    }))
    .sort((left, right) => right.listed_value - left.listed_value)

  const totalListedValue = saleItems.reduce((sum, item) => sum + (item.price ?? 0), 0)
  const soldItems = saleItems.filter((item) => item.status === 'sold')
  const totalSoldValue = soldItems.reduce((sum, item) => sum + (item.price ?? 0), 0)

  return {
    total_items: saleItems.length,
    priced_items: saleItems.filter((item) => item.price !== null).length,
    sold_items: soldItems.length,
    total_listed_value: Number(totalListedValue.toFixed(2)),
    total_sold_value: Number(totalSoldValue.toFixed(2)),
    sell_through_rate:
      saleItems.length === 0 ? 0 : Number(((soldItems.length / saleItems.length) * 100).toFixed(1)),
    category_breakdown: categoryBreakdown,
    room_breakdown: roomBreakdown,
  }
}

function buildWorkspace(saleId: number, state: MockState): WorkspaceResponse {
  const sale = state.sales.find((currentSale) => currentSale.id === saleId)
  if (!sale) {
    throw new Error('Sale not found.')
  }

  return {
    sale,
    summary: buildSaleSummary(sale, state),
    categories: sortCategories(state.categories),
    items: state.items
      .filter((item) => item.sale_id === saleId)
      .sort((left, right) => right.id - left.id),
    tasks: state.tasks
      .filter((task) => task.sale_id === saleId)
      .sort((left, right) => left.title.localeCompare(right.title)),
    report: buildReport(saleId, state),
  }
}

export async function getDashboard(): Promise<DashboardResponse> {
  const state = loadState()
  return {
    sales: [...state.sales]
      .sort((left, right) => left.start_date.localeCompare(right.start_date))
      .map((sale) => buildSaleSummary(sale, state)),
  }
}

export async function getWorkspace(saleId: number): Promise<WorkspaceResponse> {
  return buildWorkspace(saleId, loadState())
}

export async function createSale(payload: SalePayload): Promise<SaleRead> {
  const state = loadState()
  const sale: SaleRead = {
    id: state.nextIds.sale,
    ...payload,
  }
  state.nextIds.sale += 1
  state.sales.push(sale)
  saveState(state)
  return sale
}

export async function updateSale(saleId: number, payload: SalePayload): Promise<SaleRead> {
  const state = loadState()
  const sale = state.sales.find((currentSale) => currentSale.id === saleId)
  if (!sale) {
    throw new Error('Sale not found.')
  }

  Object.assign(sale, payload)
  saveState(state)
  return sale
}

export async function createCategory(payload: CategoryPayload): Promise<CategoryRead> {
  const state = loadState()
  const category: CategoryRead = {
    id: state.nextIds.category,
    ...payload,
  }
  state.nextIds.category += 1
  state.categories.push(category)
  saveState(state)
  return category
}

export async function updateCategory(
  categoryId: number,
  payload: CategoryPayload,
): Promise<CategoryRead> {
  const state = loadState()
  const category = state.categories.find((currentCategory) => currentCategory.id === categoryId)
  if (!category) {
    throw new Error('Category not found.')
  }

  Object.assign(category, payload)
  saveState(state)
  return category
}

export async function createItem(payload: ItemPayload): Promise<ItemRead> {
  const state = loadState()
  const item: ItemRead = {
    id: state.nextIds.item,
    ...payload,
  }
  state.nextIds.item += 1
  state.items.push(item)
  saveState(state)
  return item
}

export async function updateItem(itemId: number, payload: ItemUpdatePayload): Promise<ItemRead> {
  const state = loadState()
  const item = state.items.find((currentItem) => currentItem.id === itemId)
  if (!item) {
    throw new Error('Item not found.')
  }

  Object.assign(item, payload)
  saveState(state)
  return item
}

export async function bulkUpdateItems(payload: BulkItemUpdatePayload): Promise<ItemRead[]> {
  const state = loadState()
  const updatedItems = state.items.filter((item) => payload.item_ids.includes(item.id))

  for (const item of updatedItems) {
    if (payload.status !== undefined) {
      item.status = payload.status
    }
    if (payload.category_id !== undefined) {
      item.category_id = payload.category_id
    }
  }

  saveState(state)
  return updatedItems
}

export async function createTask(payload: TaskPayload): Promise<TaskRead> {
  const state = loadState()
  const task: TaskRead = {
    id: state.nextIds.task,
    ...payload,
  }
  state.nextIds.task += 1
  state.tasks.push(task)
  saveState(state)
  return task
}

export async function updateTask(taskId: number, payload: TaskUpdatePayload): Promise<TaskRead> {
  const state = loadState()
  const task = state.tasks.find((currentTask) => currentTask.id === taskId)
  if (!task) {
    throw new Error('Task not found.')
  }

  Object.assign(task, payload)
  saveState(state)
  return task
}
