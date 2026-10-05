import type {
  BulkItemUpdatePayload,
  CategoryBreakdown,
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

/** Listed value of an item line: unit price times quantity. */
function itemValue(item: ItemRead): number {
  return (item.price ?? 0) * (item.quantity ?? 1)
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
      saleItems.reduce((sum, item) => sum + itemValue(item), 0).toFixed(2),
    ),
    realized_revenue: Number(
      soldItems.reduce((sum, item) => sum + itemValue(item), 0).toFixed(2),
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
    categoryEntry.listedValue += itemValue(item)
    if (item.status === 'sold') {
      categoryEntry.soldCount += 1
      categoryEntry.soldValue += itemValue(item)
    }
    categoryMap.set(categoryName, categoryEntry)

    const roomEntry = roomMap.get(roomName) ?? { itemCount: 0, listedValue: 0 }
    roomEntry.itemCount += 1
    roomEntry.listedValue += itemValue(item)
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

  const totalListedValue = saleItems.reduce((sum, item) => sum + itemValue(item), 0)
  const soldItems = saleItems.filter((item) => item.status === 'sold')
  const totalSoldValue = soldItems.reduce((sum, item) => sum + itemValue(item), 0)

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

export async function getAllItems(): Promise<ItemWithSale[]> {
  const state = loadState()
  const saleTitles = new Map(state.sales.map((sale) => [sale.id, sale.title]))
  const categories = new Map(state.categories.map((category) => [category.id, category.name]))
  return state.items
    .filter((item) => saleTitles.has(item.sale_id))
    .sort((left, right) => right.id - left.id)
    .map((item) => ({
      ...item,
      sale_title: saleTitles.get(item.sale_id) ?? '',
      category_name: categories.get(item.category_id ?? -1) ?? null,
      created_at: '',
    }))
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
    photo_count: 0,
  }
  state.nextIds.item += 1
  state.items.push(item)
  saveState(state)
  return item
}

export async function deleteItem(itemId: number): Promise<void> {
  const state = loadState()
  if (!state.items.some((item) => item.id === itemId)) {
    throw new Error('Item not found.')
  }
  state.items = state.items.filter((item) => item.id !== itemId)
  saveState(state)
}

/** Browser demo mode never stores photos, so every item's photo list is empty. */
export async function listItemPhotos(itemId: number): Promise<ItemPhotoInfo[]> {
  const state = loadState()
  if (!state.items.some((item) => item.id === itemId)) {
    throw new Error('Item not found.')
  }
  return []
}

export async function updateItem(
  itemId: number,
  payload: ItemUpdatePayload | ItemPartialUpdatePayload,
): Promise<ItemRead> {
  const state = loadState()
  const item = state.items.find((currentItem) => currentItem.id === itemId)
  if (!item) {
    throw new Error('Item not found.')
  }

  Object.assign(item, payload)
  saveState(state)
  return item
}

export async function incrementItemQuantity(itemId: number, amount: number): Promise<ItemRead> {
  const state = loadState()
  const item = state.items.find((currentItem) => currentItem.id === itemId)
  if (!item) {
    throw new Error('Item not found.')
  }

  item.quantity = (item.quantity ?? 1) + amount
  saveState(state)
  return item
}

export async function decrementItemQuantity(itemId: number, amount: number): Promise<ItemRead> {
  const state = loadState()
  const item = state.items.find((currentItem) => currentItem.id === itemId)
  if (!item) {
    throw new Error('Item not found.')
  }

  item.quantity = Math.max(1, (item.quantity ?? 1) - amount)
  saveState(state)
  return item
}

function findMockItem(itemId: number): { state: ReturnType<typeof loadState>; item: ItemRead } {
  const state = loadState()
  const item = state.items.find((currentItem) => currentItem.id === itemId)
  if (!item) {
    throw new Error('Item not found.')
  }
  return { state, item }
}

/** Browser-demo version of selling: sale rows kept on the item itself. */
export async function sellItem(itemId: number, payload: ItemSellPayload): Promise<ItemRead> {
  const { state, item } = findMockItem(itemId)
  const events = item.sale_events ?? []
  const sold = events.reduce((sum, event) => sum + event.quantity, 0)
  const remaining = item.status === 'sold' ? 0 : Math.max(0, (item.quantity ?? 1) - sold)
  if (payload.quantity > remaining) {
    throw new Error(remaining === 0 ? 'This item is already sold.' : `Only ${remaining} left to sell.`)
  }
  const unitPrice = payload.unit_price ?? item.price ?? 0
  const event = {
    id: Date.now(),
    quantity: payload.quantity,
    amount: Number((unitPrice * payload.quantity).toFixed(2)),
    payment_method: payload.payment_method,
    sold_at: payload.sold_at ?? new Date().toISOString(),
  }
  item.sale_events = [...events, event]
  item.sold_quantity = sold + payload.quantity
  item.sold_total = item.sale_events.reduce((sum, saleEvent) => sum + saleEvent.amount, 0)
  item.sold_at = event.sold_at
  item.payment_method = event.payment_method
  if (item.sold_quantity >= (item.quantity ?? 1)) {
    item.status = 'sold'
  }
  saveState(state)
  return item
}

export async function unsellItem(itemId: number, eventId: number | null): Promise<ItemRead> {
  const { state, item } = findMockItem(itemId)
  const events = (item.sale_events ?? []).filter((event) => eventId !== null && event.id !== eventId)
  item.sale_events = events
  item.sold_quantity = events.reduce((sum, event) => sum + event.quantity, 0)
  item.sold_total = events.length ? events.reduce((sum, event) => sum + event.amount, 0) : null
  item.sold_at = events.at(-1)?.sold_at ?? null
  item.payment_method = events.at(-1)?.payment_method ?? null
  if (item.status === 'sold') {
    item.status = 'available'
  }
  saveState(state)
  return item
}

export async function updateItemPaymentMethod(
  itemId: number,
  paymentMethod: PaymentMethod,
  eventId: number | null,
): Promise<ItemRead> {
  const { state, item } = findMockItem(itemId)
  const events = item.sale_events ?? []
  const target = eventId === null ? events.at(-1) : events.find((event) => event.id === eventId)
  if (!target) {
    throw new Error('This item has not been sold.')
  }
  target.payment_method = paymentMethod
  item.payment_method = events.at(-1)?.payment_method ?? null
  saveState(state)
  return item
}

export async function updateItemStatus(itemId: number, status: ItemStatus): Promise<ItemRead> {
  const state = loadState()
  const item = state.items.find((currentItem) => currentItem.id === itemId)
  if (!item) {
    throw new Error('Item not found.')
  }

  item.status = status
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
