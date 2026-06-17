import { useEffect, useMemo, useState } from 'react'
import type { FormEvent, JSX } from 'react'
import {
  bulkUpdateItems,
  createCategory,
  createItem,
  createSale,
  createTask,
  getDataSourceMode,
  getDashboard,
  getWorkspace,
  updateCategory,
  updateItem,
  updateSale,
  updateTask,
} from './api'
import './App.css'
import type {
  CategoryRead,
  DashboardResponse,
  ItemPayload,
  ItemRead,
  ItemStatus,
  ItemUpdatePayload,
  ReportMetrics,
  SalePayload,
  SaleStatus,
  TaskRead,
  TaskPayload,
  TaskStatus,
  TaskUpdatePayload,
  WorkspaceResponse,
} from './types'

type TabKey = 'overview' | 'items' | 'categories' | 'tasks' | 'reports'
type ItemView = 'table' | 'cards'

interface SaleFormState {
  title: string
  address: string
  startDate: string
  endDate: string
  status: SaleStatus
  notes: string
}

interface CategoryFormState {
  id: number | null
  name: string
  color: string
  sortOrder: string
}

interface ItemFormState {
  id: number | null
  title: string
  description: string
  categoryId: string
  room: string
  condition: string
  price: string
  status: ItemStatus
  notes: string
  photoUrl: string
}

interface TaskFormState {
  id: number | null
  title: string
  dueDate: string
  status: TaskStatus
  notes: string
}

interface ItemFilters {
  query: string
  categoryId: string
  room: string
  status: string
  pricing: 'all' | 'priced' | 'unpriced'
}

const saleStatusOptions: SaleStatus[] = ['planning', 'ready', 'live', 'closed', 'archived']
const itemStatusOptions: ItemStatus[] = [
  'available',
  'sold',
  'discounted',
  'reserved',
  'donated',
  'removed',
]
const taskStatusOptions: TaskStatus[] = ['todo', 'in_progress', 'done']
const tabOptions: { key: TabKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'items', label: 'Items' },
  { key: 'categories', label: 'Categories' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'reports', label: 'Reports' },
]

function addDays(daysToAdd: number): string {
  const date = new Date()
  date.setDate(date.getDate() + daysToAdd)
  return date.toISOString().slice(0, 10)
}

function createEmptySaleForm(): SaleFormState {
  return {
    title: '',
    address: '',
    startDate: addDays(7),
    endDate: addDays(9),
    status: 'planning',
    notes: '',
  }
}

function createEmptyCategoryForm(): CategoryFormState {
  return {
    id: null,
    name: '',
    color: '#8b5cf6',
    sortOrder: '0',
  }
}

function createEmptyItemForm(): ItemFormState {
  return {
    id: null,
    title: '',
    description: '',
    categoryId: '',
    room: 'General',
    condition: 'Good',
    price: '',
    status: 'available',
    notes: '',
    photoUrl: '',
  }
}

function createEmptyTaskForm(): TaskFormState {
  return {
    id: null,
    title: '',
    dueDate: '',
    status: 'todo',
    notes: '',
  }
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function formatDateRange(startDate: string, endDate: string): string {
  const formatter = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  })

  return `${formatter.format(parseLocalDate(startDate))} - ${formatter.format(parseLocalDate(endDate))}`
}

function titleCase(value: string): string {
  return value
    .split('_')
    .join(' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function escapeCsvValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null)
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [itemView, setItemView] = useState<ItemView>('table')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([])
  const [bulkCategoryId, setBulkCategoryId] = useState('')
  const [newSaleForm, setNewSaleForm] = useState<SaleFormState>(createEmptySaleForm)
  const [saleEditor, setSaleEditor] = useState<SaleFormState>(createEmptySaleForm)
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>(createEmptyCategoryForm)
  const [itemForm, setItemForm] = useState<ItemFormState>(createEmptyItemForm)
  const [taskForm, setTaskForm] = useState<TaskFormState>(createEmptyTaskForm)
  const [filters, setFilters] = useState<ItemFilters>({
    query: '',
    categoryId: '',
    room: '',
    status: '',
    pricing: 'all',
  })
  const dataSourceMode = getDataSourceMode()

  useEffect(() => {
    async function loadInitialData(): Promise<void> {
      setLoading(true)
      setErrorMessage('')

      try {
        const nextDashboard = await getDashboard()
        setDashboard(nextDashboard)
        const firstSaleId = nextDashboard.sales[0]?.id ?? null

        if (firstSaleId === null) {
          applyWorkspaceState(null)
          setSelectedSaleId(null)
          return
        }

        setSelectedSaleId(firstSaleId)
        const nextWorkspace = await getWorkspace(firstSaleId)
        applyWorkspaceState(nextWorkspace)
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : 'Unable to load the app.')
      } finally {
        setLoading(false)
      }
    }

    void loadInitialData()
  }, [])

  const categoryLookup = useMemo(() => {
    const entries: Array<[number, string]> =
      workspace?.categories.map((category) => [category.id, category.name]) ?? []
    return new Map<number, string>(entries)
  }, [workspace?.categories])

  const roomOptions = useMemo(() => {
    const rooms = workspace?.items.map((item) => item.room).filter(Boolean) ?? []
    return [...new Set(rooms)].sort((left, right) => left.localeCompare(right))
  }, [workspace?.items])

  const filteredItems = useMemo(() => {
    if (!workspace) {
      return []
    }

    return workspace.items.filter((item) => {
      const matchesQuery =
        filters.query.trim().length === 0 ||
        [item.title, item.description, item.notes]
          .join(' ')
          .toLowerCase()
          .includes(filters.query.trim().toLowerCase())
      const matchesCategory =
        filters.categoryId.length === 0 || item.category_id === Number(filters.categoryId)
      const matchesRoom = filters.room.length === 0 || item.room === filters.room
      const matchesStatus = filters.status.length === 0 || item.status === filters.status
      const matchesPricing =
        filters.pricing === 'all' ||
        (filters.pricing === 'priced' && item.price !== null) ||
        (filters.pricing === 'unpriced' && item.price === null)

      return matchesQuery && matchesCategory && matchesRoom && matchesStatus && matchesPricing
    })
  }, [filters, workspace])

  const dashboardTotals = useMemo(() => {
    const sales = dashboard?.sales ?? []
    return {
      salesCount: sales.length,
      itemsCount: sales.reduce((sum, sale) => sum + sale.item_count, 0),
      soldCount: sales.reduce((sum, sale) => sum + sale.sold_count, 0),
      revenue: sales.reduce((sum, sale) => sum + sale.realized_revenue, 0),
    }
  }, [dashboard])

  const categoryMetrics = useMemo(() => {
    if (!workspace) {
      return []
    }

    return workspace.categories.map((category) => {
      const matchingItems = workspace.items.filter((item) => item.category_id === category.id)
      const soldCount = matchingItems.filter((item) => item.status === 'sold').length

      return {
        ...category,
        itemCount: matchingItems.length,
        soldCount,
        value: matchingItems.reduce((sum, item) => sum + (item.price ?? 0), 0),
      }
    })
  }, [workspace])

  function applyWorkspaceState(nextWorkspace: WorkspaceResponse | null): void {
    setWorkspace(nextWorkspace)
    setSelectedItemIds([])
    setItemForm(createEmptyItemForm())
    setTaskForm(createEmptyTaskForm())

    if (nextWorkspace === null) {
      setSaleEditor(createEmptySaleForm())
      return
    }

    setSaleEditor({
      title: nextWorkspace.sale.title,
      address: nextWorkspace.sale.address,
      startDate: nextWorkspace.sale.start_date,
      endDate: nextWorkspace.sale.end_date,
      status: nextWorkspace.sale.status,
      notes: nextWorkspace.sale.notes,
    })
  }

  async function refreshWorkspaceAndDashboard(preferredSaleId?: number): Promise<void> {
    setLoading(true)
    setErrorMessage('')

    try {
      const nextDashboard = await getDashboard()
      setDashboard(nextDashboard)
      const resolvedSaleId =
        preferredSaleId ??
        selectedSaleId ??
        nextDashboard.sales[0]?.id ??
        null

      if (resolvedSaleId === null) {
        applyWorkspaceState(null)
        setSelectedSaleId(null)
        return
      }

      setSelectedSaleId(resolvedSaleId)
      const nextWorkspace = await getWorkspace(resolvedSaleId)
      applyWorkspaceState(nextWorkspace)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the app.')
    } finally {
      setLoading(false)
    }
  }

  async function handleSaleSelection(saleId: number): Promise<void> {
    setActiveTab('overview')
    await refreshWorkspaceAndDashboard(saleId)
  }

  async function withSavingState(work: () => Promise<void>): Promise<void> {
    setSaving(true)
    setErrorMessage('')

    try {
      await work()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Something went wrong.')
    } finally {
      setSaving(false)
    }
  }

  function buildSalePayload(form: SaleFormState): SalePayload {
    return {
      title: form.title.trim(),
      address: form.address.trim(),
      start_date: form.startDate,
      end_date: form.endDate,
      status: form.status,
      notes: form.notes.trim(),
    }
  }

  function buildItemPayload(saleId: number): ItemPayload {
    return {
      sale_id: saleId,
      category_id: itemForm.categoryId ? Number(itemForm.categoryId) : null,
      title: itemForm.title.trim(),
      description: itemForm.description.trim(),
      room: itemForm.room.trim() || 'General',
      condition: itemForm.condition.trim() || 'Good',
      price: itemForm.price.trim().length > 0 ? Number(itemForm.price) : null,
      status: itemForm.status,
      notes: itemForm.notes.trim(),
      photo_url: itemForm.photoUrl.trim() || null,
    }
  }

  function buildItemUpdatePayload(saleId: number): ItemUpdatePayload {
    const payload = buildItemPayload(saleId)
    return {
      category_id: payload.category_id,
      title: payload.title,
      description: payload.description,
      room: payload.room,
      condition: payload.condition,
      price: payload.price,
      status: payload.status,
      notes: payload.notes,
      photo_url: payload.photo_url,
    }
  }

  function buildTaskPayload(saleId: number): TaskPayload {
    return {
      sale_id: saleId,
      title: taskForm.title.trim(),
      due_date: taskForm.dueDate || null,
      status: taskForm.status,
      notes: taskForm.notes.trim(),
    }
  }

  function buildTaskUpdatePayload(saleId: number): TaskUpdatePayload {
    const payload = buildTaskPayload(saleId)
    return {
      title: payload.title,
      due_date: payload.due_date,
      status: payload.status,
      notes: payload.notes,
    }
  }

  async function handleCreateSale(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    await withSavingState(async () => {
      const createdSale = await createSale(buildSalePayload(newSaleForm))
      setNewSaleForm(createEmptySaleForm())
      await refreshWorkspaceAndDashboard(createdSale.id)
    })
  }

  async function handleUpdateSale(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!workspace) {
      return
    }

    await withSavingState(async () => {
      await updateSale(workspace.sale.id, buildSalePayload(saleEditor))
      await refreshWorkspaceAndDashboard(workspace.sale.id)
    })
  }

  async function handleCategorySubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    await withSavingState(async () => {
      const payload = {
        name: categoryForm.name.trim(),
        color: categoryForm.color,
        sort_order: Number(categoryForm.sortOrder) || 0,
      }

      if (categoryForm.id === null) {
        await createCategory(payload)
      } else {
        await updateCategory(categoryForm.id, payload)
      }

      setCategoryForm(createEmptyCategoryForm())
      await refreshWorkspaceAndDashboard(workspace?.sale.id)
    })
  }

  async function handleItemSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!workspace) {
      return
    }

    await withSavingState(async () => {
      if (itemForm.id === null) {
        await createItem(buildItemPayload(workspace.sale.id))
      } else {
        await updateItem(itemForm.id, buildItemUpdatePayload(workspace.sale.id))
      }

      setItemForm(createEmptyItemForm())
      setSelectedItemIds([])
      await refreshWorkspaceAndDashboard(workspace.sale.id)
    })
  }

  async function handleTaskSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!workspace) {
      return
    }

    await withSavingState(async () => {
      if (taskForm.id === null) {
        await createTask(buildTaskPayload(workspace.sale.id))
      } else {
        await updateTask(taskForm.id, buildTaskUpdatePayload(workspace.sale.id))
      }

      setTaskForm(createEmptyTaskForm())
      await refreshWorkspaceAndDashboard(workspace.sale.id)
    })
  }

  async function handleBulkStatusUpdate(status: ItemStatus): Promise<void> {
    if (!workspace || selectedItemIds.length === 0) {
      return
    }

    await withSavingState(async () => {
      await bulkUpdateItems({ item_ids: selectedItemIds, status })
      setSelectedItemIds([])
      await refreshWorkspaceAndDashboard(workspace.sale.id)
    })
  }

  async function handleBulkCategoryUpdate(): Promise<void> {
    if (!workspace || selectedItemIds.length === 0 || bulkCategoryId.length === 0) {
      return
    }

    await withSavingState(async () => {
      await bulkUpdateItems({
        item_ids: selectedItemIds,
        category_id: Number(bulkCategoryId),
      })
      setBulkCategoryId('')
      setSelectedItemIds([])
      await refreshWorkspaceAndDashboard(workspace.sale.id)
    })
  }

  function downloadItemsCsv(): void {
    if (!workspace) {
      return
    }

    const rows = [
      [
        'Title',
        'Category',
        'Room',
        'Condition',
        'Price',
        'Status',
        'Description',
        'Notes',
      ],
      ...filteredItems.map((item) => [
        item.title,
        categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized',
        item.room,
        item.condition,
        item.price === null ? '' : String(item.price),
        item.status,
        item.description,
        item.notes,
      ]),
    ]

    const csvContent = rows
      .map((row) => row.map((value) => escapeCsvValue(value)).join(','))
      .join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${workspace.sale.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-items.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  function beginEditingCategory(category: CategoryRead): void {
    setCategoryForm({
      id: category.id,
      name: category.name,
      color: category.color,
      sortOrder: String(category.sort_order),
    })
  }

  function beginEditingItem(item: ItemRead): void {
    setItemForm({
      id: item.id,
      title: item.title,
      description: item.description,
      categoryId: item.category_id ? String(item.category_id) : '',
      room: item.room,
      condition: item.condition,
      price: item.price === null ? '' : String(item.price),
      status: item.status,
      notes: item.notes,
      photoUrl: item.photo_url ?? '',
    })
    setActiveTab('items')
  }

  function beginEditingTask(task: TaskRead): void {
    setTaskForm({
      id: task.id,
      title: task.title,
      dueDate: task.due_date ?? '',
      status: task.status,
      notes: task.notes,
    })
    setActiveTab('tasks')
  }

  function toggleItemSelection(itemId: number): void {
    setSelectedItemIds((currentSelection) =>
      currentSelection.includes(itemId)
        ? currentSelection.filter((currentId) => currentId !== itemId)
        : [...currentSelection, itemId],
    )
  }

  function renderStatCard(label: string, value: string, accent?: string): JSX.Element {
    return (
      <article className="stat-card" data-accent={accent ?? 'default'}>
        <span>{label}</span>
        <strong>{value}</strong>
      </article>
    )
  }

  function renderItemsView(report: ReportMetrics): JSX.Element {
    if (!workspace) {
      return <></>
    }

    return (
      <section className="tab-panel">
        <div className="panel-header">
          <div>
            <h2>Items</h2>
            <p>Track pricing, room placement, and sold status without losing speed.</p>
          </div>
          <div className="header-actions">
            <button type="button" className="ghost-button" onClick={() => downloadItemsCsv()}>
              Export CSV
            </button>
            <div className="segmented-control">
              <button
                type="button"
                className={itemView === 'table' ? 'active' : ''}
                onClick={() => setItemView('table')}
              >
                List view
              </button>
              <button
                type="button"
                className={itemView === 'cards' ? 'active' : ''}
                onClick={() => setItemView('cards')}
              >
                Photo card view
              </button>
            </div>
          </div>
        </div>

        <div className="filter-bar">
          <input
            type="search"
            placeholder="Search title, description, or notes"
            value={filters.query}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
          />
          <select
            value={filters.categoryId}
            onChange={(event) =>
              setFilters((current) => ({ ...current, categoryId: event.target.value }))
            }
          >
            <option value="">All categories</option>
            {workspace.categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
          <select
            value={filters.room}
            onChange={(event) => setFilters((current) => ({ ...current, room: event.target.value }))}
          >
            <option value="">All rooms</option>
            {roomOptions.map((room) => (
              <option key={room} value={room}>
                {room}
              </option>
            ))}
          </select>
          <select
            value={filters.status}
            onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
          >
            <option value="">All statuses</option>
            {itemStatusOptions.map((status) => (
              <option key={status} value={status}>
                {titleCase(status)}
              </option>
            ))}
          </select>
          <select
            value={filters.pricing}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                pricing: event.target.value as ItemFilters['pricing'],
              }))
            }
          >
            <option value="all">All pricing</option>
            <option value="priced">Priced</option>
            <option value="unpriced">Unpriced</option>
          </select>
        </div>

        <div className="two-column">
          <div className="surface">
            <div className="bulk-toolbar">
              <span>{selectedItemIds.length} selected</span>
              <div className="bulk-actions">
                <button
                  type="button"
                  disabled={selectedItemIds.length === 0 || saving}
                  onClick={() => void handleBulkStatusUpdate('sold')}
                >
                  Mark sold
                </button>
                <button
                  type="button"
                  disabled={selectedItemIds.length === 0 || saving}
                  onClick={() => void handleBulkStatusUpdate('available')}
                >
                  Mark available
                </button>
                <button
                  type="button"
                  disabled={selectedItemIds.length === 0 || saving}
                  onClick={() => void handleBulkStatusUpdate('discounted')}
                >
                  Mark discounted
                </button>
                <select
                  value={bulkCategoryId}
                  onChange={(event) => setBulkCategoryId(event.target.value)}
                  disabled={selectedItemIds.length === 0}
                >
                  <option value="">Move to category</option>
                  {workspace.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={selectedItemIds.length === 0 || bulkCategoryId.length === 0 || saving}
                  onClick={() => void handleBulkCategoryUpdate()}
                >
                  Apply
                </button>
              </div>
            </div>

            {itemView === 'table' ? (
              <div className="item-table">
                <div className="item-table__header">
                  <span></span>
                  <span>Item</span>
                  <span>Category</span>
                  <span>Room</span>
                  <span>Status</span>
                  <span>Price</span>
                </div>
                {filteredItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="item-table__row"
                    onClick={() => beginEditingItem(item)}
                  >
                    <span>
                      <input
                        type="checkbox"
                        checked={selectedItemIds.includes(item.id)}
                        onChange={() => toggleItemSelection(item.id)}
                        onClick={(event) => event.stopPropagation()}
                      />
                    </span>
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.description || item.notes || 'No extra notes yet'}</small>
                    </span>
                    <span>{categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized'}</span>
                    <span>{item.room}</span>
                    <span>
                      <span className="status-badge" data-status={item.status}>
                        {titleCase(item.status)}
                      </span>
                    </span>
                    <span>{item.price === null ? 'Unpriced' : formatCurrency(item.price)}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="item-card-grid">
                {filteredItems.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className="item-card"
                    onClick={() => beginEditingItem(item)}
                  >
                    <div className="item-card__media">{item.title.slice(0, 2).toUpperCase()}</div>
                    <div className="item-card__content">
                      <div className="item-card__header">
                        <h3>{item.title}</h3>
                        <input
                          type="checkbox"
                          checked={selectedItemIds.includes(item.id)}
                          onChange={() => toggleItemSelection(item.id)}
                          onClick={(event) => event.stopPropagation()}
                        />
                      </div>
                      <p>{item.room}</p>
                      <div className="pill-row">
                        <span className="status-badge" data-status={item.status}>
                          {titleCase(item.status)}
                        </span>
                        <span className="category-pill">
                          {categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized'}
                        </span>
                      </div>
                      <strong>{item.price === null ? 'Unpriced' : formatCurrency(item.price)}</strong>
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="summary-note">
              <strong>{filteredItems.length}</strong> of <strong>{report.total_items}</strong> items shown
              for this sale.
            </div>
          </div>

          <form className="surface form-surface" onSubmit={(event) => void handleItemSubmit(event)}>
            <div className="surface-heading">
              <div>
                <h3>{itemForm.id === null ? 'Add item' : 'Edit item'}</h3>
                <p>Keep intake fast, then reuse the form for the next item.</p>
              </div>
              {itemForm.id !== null ? (
                <button type="button" className="ghost-button" onClick={() => setItemForm(createEmptyItemForm())}>
                  New item
                </button>
              ) : null}
            </div>
            <label>
              Title
              <input
                type="text"
                value={itemForm.title}
                onChange={(event) => setItemForm((current) => ({ ...current, title: event.target.value }))}
                required
              />
            </label>
            <label>
              Description
              <textarea
                rows={3}
                value={itemForm.description}
                onChange={(event) =>
                  setItemForm((current) => ({ ...current, description: event.target.value }))
                }
              />
            </label>
            <div className="form-grid">
              <label>
                Category
                <select
                  value={itemForm.categoryId}
                  onChange={(event) =>
                    setItemForm((current) => ({ ...current, categoryId: event.target.value }))
                  }
                >
                  <option value="">Uncategorized</option>
                  {workspace.categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Room
                <input
                  type="text"
                  value={itemForm.room}
                  onChange={(event) => setItemForm((current) => ({ ...current, room: event.target.value }))}
                />
              </label>
              <label>
                Condition
                <input
                  type="text"
                  value={itemForm.condition}
                  onChange={(event) =>
                    setItemForm((current) => ({ ...current, condition: event.target.value }))
                  }
                />
              </label>
              <label>
                Price
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={itemForm.price}
                  onChange={(event) => setItemForm((current) => ({ ...current, price: event.target.value }))}
                />
              </label>
              <label>
                Status
                <select
                  value={itemForm.status}
                  onChange={(event) =>
                    setItemForm((current) => ({
                      ...current,
                      status: event.target.value as ItemStatus,
                    }))
                  }
                >
                  {itemStatusOptions.map((status) => (
                    <option key={status} value={status}>
                      {titleCase(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Photo URL
                <input
                  type="url"
                  value={itemForm.photoUrl}
                  onChange={(event) =>
                    setItemForm((current) => ({ ...current, photoUrl: event.target.value }))
                  }
                />
              </label>
            </div>
            <label>
              Notes
              <textarea
                rows={4}
                value={itemForm.notes}
                onChange={(event) => setItemForm((current) => ({ ...current, notes: event.target.value }))}
              />
            </label>
            <button type="submit" className="primary-button" disabled={saving}>
              {itemForm.id === null ? 'Save item' : 'Update item'}
            </button>
          </form>
        </div>
      </section>
    )
  }

  return (
    <div className="app-shell">
      <header className="hero-banner">
        <div>
          <span className="eyebrow">Estate sale command center</span>
          <h1>MuffinES</h1>
          <p>
            Amanda can manage every sale, item, category, task, and revenue snapshot from one
            clean workspace.
          </p>
          {dataSourceMode === 'browser-demo' ? (
            <div className="mode-banner">
              Running in browser storage mode for deployment preview. Changes save in this browser.
            </div>
          ) : null}
        </div>
        <div className="hero-stats">
          {renderStatCard('Active sales', String(dashboardTotals.salesCount), 'purple')}
          {renderStatCard('Tracked items', String(dashboardTotals.itemsCount), 'teal')}
          {renderStatCard('Sold items', String(dashboardTotals.soldCount), 'amber')}
          {renderStatCard('Revenue booked', formatCurrency(dashboardTotals.revenue), 'green')}
        </div>
      </header>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <main className="app-layout">
        <aside className="sidebar">
          <section className="surface">
            <div className="surface-heading">
              <div>
                <h2>New sale</h2>
                <p>Spin up the next estate sale without leaving the dashboard.</p>
              </div>
            </div>
            <form className="stacked-form" onSubmit={(event) => void handleCreateSale(event)}>
              <label>
                Sale name
                <input
                  type="text"
                  value={newSaleForm.title}
                  onChange={(event) =>
                    setNewSaleForm((current) => ({ ...current, title: event.target.value }))
                  }
                  required
                />
              </label>
              <label>
                Address
                <input
                  type="text"
                  value={newSaleForm.address}
                  onChange={(event) =>
                    setNewSaleForm((current) => ({ ...current, address: event.target.value }))
                  }
                />
              </label>
              <div className="form-grid">
                <label>
                  Start
                  <input
                    type="date"
                    value={newSaleForm.startDate}
                    onChange={(event) =>
                      setNewSaleForm((current) => ({ ...current, startDate: event.target.value }))
                    }
                    required
                  />
                </label>
                <label>
                  End
                  <input
                    type="date"
                    value={newSaleForm.endDate}
                    onChange={(event) =>
                      setNewSaleForm((current) => ({ ...current, endDate: event.target.value }))
                    }
                    required
                  />
                </label>
              </div>
              <label>
                Status
                <select
                  value={newSaleForm.status}
                  onChange={(event) =>
                    setNewSaleForm((current) => ({
                      ...current,
                      status: event.target.value as SaleStatus,
                    }))
                  }
                >
                  {saleStatusOptions.map((status) => (
                    <option key={status} value={status}>
                      {titleCase(status)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Notes
                <textarea
                  rows={4}
                  value={newSaleForm.notes}
                  onChange={(event) =>
                    setNewSaleForm((current) => ({ ...current, notes: event.target.value }))
                  }
                />
              </label>
              <button type="submit" className="primary-button" disabled={saving}>
                Create sale
              </button>
            </form>
          </section>

          <section className="surface">
            <div className="surface-heading">
              <div>
                <h2>Sales</h2>
                <p>Jump between events and keep prep moving.</p>
              </div>
            </div>
            <div className="sale-list">
              {dashboard?.sales.map((sale) => (
                <button
                  type="button"
                  key={sale.id}
                  className={`sale-card ${selectedSaleId === sale.id ? 'active' : ''}`}
                  onClick={() => void handleSaleSelection(sale.id)}
                >
                  <div className="sale-card__header">
                    <strong>{sale.title}</strong>
                    <span className="status-badge" data-status={sale.status}>
                      {titleCase(sale.status)}
                    </span>
                  </div>
                  <p>{sale.address}</p>
                  <small>{formatDateRange(sale.start_date, sale.end_date)}</small>
                  <div className="sale-card__metrics">
                    <span>{sale.item_count} items</span>
                    <span>{sale.sold_count} sold</span>
                    <span>{sale.pending_task_count} open tasks</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        </aside>

        <section className="workspace">
          {loading ? (
            <section className="surface empty-state">
              <h2>Loading workspace...</h2>
              <p>Pulling sales, items, categories, tasks, and reports.</p>
            </section>
          ) : workspace ? (
            <>
              <section className="workspace-header surface">
                <div>
                  <span className="eyebrow">Sale workspace</span>
                  <h2>{workspace.sale.title}</h2>
                  <p>{workspace.sale.address}</p>
                  <small>{formatDateRange(workspace.sale.start_date, workspace.sale.end_date)}</small>
                </div>
                <div className="workspace-summary">
                  {renderStatCard('Items', String(workspace.summary.item_count))}
                  {renderStatCard('Priced', String(workspace.summary.priced_count))}
                  {renderStatCard('Sold', String(workspace.summary.sold_count))}
                  {renderStatCard('Est. revenue', formatCurrency(workspace.summary.estimated_revenue))}
                </div>
              </section>

              <nav className="tab-strip">
                {tabOptions.map((tab) => (
                  <button
                    type="button"
                    key={tab.key}
                    className={activeTab === tab.key ? 'active' : ''}
                    onClick={() => setActiveTab(tab.key)}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              {activeTab === 'overview' ? (
                <section className="tab-panel">
                  <div className="two-column">
                    <form
                      className="surface form-surface"
                      onSubmit={(event) => void handleUpdateSale(event)}
                    >
                      <div className="surface-heading">
                        <div>
                          <h3>Sale details</h3>
                          <p>Keep the master record accurate while you prep and run the event.</p>
                        </div>
                      </div>
                      <label>
                        Sale name
                        <input
                          type="text"
                          value={saleEditor.title}
                          onChange={(event) =>
                            setSaleEditor((current) => ({ ...current, title: event.target.value }))
                          }
                          required
                        />
                      </label>
                      <label>
                        Address
                        <input
                          type="text"
                          value={saleEditor.address}
                          onChange={(event) =>
                            setSaleEditor((current) => ({ ...current, address: event.target.value }))
                          }
                        />
                      </label>
                      <div className="form-grid">
                        <label>
                          Start
                          <input
                            type="date"
                            value={saleEditor.startDate}
                            onChange={(event) =>
                              setSaleEditor((current) => ({
                                ...current,
                                startDate: event.target.value,
                              }))
                            }
                            required
                          />
                        </label>
                        <label>
                          End
                          <input
                            type="date"
                            value={saleEditor.endDate}
                            onChange={(event) =>
                              setSaleEditor((current) => ({ ...current, endDate: event.target.value }))
                            }
                            required
                          />
                        </label>
                      </div>
                      <label>
                        Status
                        <select
                          value={saleEditor.status}
                          onChange={(event) =>
                            setSaleEditor((current) => ({
                              ...current,
                              status: event.target.value as SaleStatus,
                            }))
                          }
                        >
                          {saleStatusOptions.map((status) => (
                            <option key={status} value={status}>
                              {titleCase(status)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Notes
                        <textarea
                          rows={6}
                          value={saleEditor.notes}
                          onChange={(event) =>
                            setSaleEditor((current) => ({ ...current, notes: event.target.value }))
                          }
                        />
                      </label>
                      <button type="submit" className="primary-button" disabled={saving}>
                        Save sale details
                      </button>
                    </form>

                    <div className="column-stack">
                      <section className="surface metrics-grid">
                        {renderStatCard('Sell-through', `${workspace.report.sell_through_rate}%`, 'purple')}
                        {renderStatCard(
                          'Revenue booked',
                          formatCurrency(workspace.report.total_sold_value),
                          'green',
                        )}
                        {renderStatCard(
                          'Remaining value',
                          formatCurrency(
                            workspace.report.total_listed_value - workspace.report.total_sold_value,
                          ),
                          'amber',
                        )}
                        {renderStatCard(
                          'Pending tasks',
                          String(workspace.summary.pending_task_count),
                          'teal',
                        )}
                      </section>

                      <section className="surface">
                        <div className="surface-heading">
                          <div>
                            <h3>Upcoming tasks</h3>
                            <p>The next things Amanda should knock out.</p>
                          </div>
                        </div>
                        <div className="task-list compact">
                          {workspace.tasks.slice(0, 4).map((task) => (
                            <button
                              type="button"
                              key={task.id}
                              className="task-card"
                              onClick={() => beginEditingTask(task)}
                            >
                              <div className="task-card__header">
                                <strong>{task.title}</strong>
                                <span className="status-badge" data-status={task.status}>
                                  {titleCase(task.status)}
                                </span>
                              </div>
                              <p>{task.notes || 'No notes yet'}</p>
                              <small>{task.due_date ? `Due ${task.due_date}` : 'No due date set'}</small>
                            </button>
                          ))}
                        </div>
                      </section>
                    </div>
                  </div>
                </section>
              ) : null}

              {activeTab === 'items' ? renderItemsView(workspace.report) : null}

              {activeTab === 'categories' ? (
                <section className="tab-panel">
                  <div className="two-column">
                    <div className="surface category-grid">
                      {categoryMetrics.map((category) => (
                        <button
                          type="button"
                          key={category.id}
                          className="category-card"
                          onClick={() => beginEditingCategory(category)}
                        >
                          <div className="category-swatch" style={{ backgroundColor: category.color }} />
                          <div>
                            <h3>{category.name}</h3>
                            <p>
                              {category.itemCount} items · {category.soldCount} sold
                            </p>
                            <strong>{formatCurrency(category.value)}</strong>
                          </div>
                        </button>
                      ))}
                    </div>

                    <form
                      className="surface form-surface"
                      onSubmit={(event) => void handleCategorySubmit(event)}
                    >
                      <div className="surface-heading">
                        <div>
                          <h3>{categoryForm.id === null ? 'Add category' : 'Edit category'}</h3>
                          <p>Use color coding so Amanda can scan item lists faster.</p>
                        </div>
                        {categoryForm.id !== null ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setCategoryForm(createEmptyCategoryForm())}
                          >
                            New category
                          </button>
                        ) : null}
                      </div>
                      <label>
                        Name
                        <input
                          type="text"
                          value={categoryForm.name}
                          onChange={(event) =>
                            setCategoryForm((current) => ({ ...current, name: event.target.value }))
                          }
                          required
                        />
                      </label>
                      <div className="form-grid">
                        <label>
                          Color
                          <input
                            type="color"
                            value={categoryForm.color}
                            onChange={(event) =>
                              setCategoryForm((current) => ({ ...current, color: event.target.value }))
                            }
                          />
                        </label>
                        <label>
                          Sort order
                          <input
                            type="number"
                            value={categoryForm.sortOrder}
                            onChange={(event) =>
                              setCategoryForm((current) => ({
                                ...current,
                                sortOrder: event.target.value,
                              }))
                            }
                          />
                        </label>
                      </div>
                      <button type="submit" className="primary-button" disabled={saving}>
                        {categoryForm.id === null ? 'Save category' : 'Update category'}
                      </button>
                    </form>
                  </div>
                </section>
              ) : null}

              {activeTab === 'tasks' ? (
                <section className="tab-panel">
                  <div className="two-column">
                    <div className="surface task-list">
                      {workspace.tasks.map((task) => (
                        <button
                          type="button"
                          key={task.id}
                          className="task-card"
                          onClick={() => beginEditingTask(task)}
                        >
                          <div className="task-card__header">
                            <strong>{task.title}</strong>
                            <span className="status-badge" data-status={task.status}>
                              {titleCase(task.status)}
                            </span>
                          </div>
                          <p>{task.notes || 'No notes yet'}</p>
                          <small>{task.due_date ? `Due ${task.due_date}` : 'No due date set'}</small>
                        </button>
                      ))}
                    </div>

                    <form className="surface form-surface" onSubmit={(event) => void handleTaskSubmit(event)}>
                      <div className="surface-heading">
                        <div>
                          <h3>{taskForm.id === null ? 'Add task' : 'Edit task'}</h3>
                          <p>Prep work stays visible instead of falling into random notes.</p>
                        </div>
                        {taskForm.id !== null ? (
                          <button
                            type="button"
                            className="ghost-button"
                            onClick={() => setTaskForm(createEmptyTaskForm())}
                          >
                            New task
                          </button>
                        ) : null}
                      </div>
                      <label>
                        Task
                        <input
                          type="text"
                          value={taskForm.title}
                          onChange={(event) =>
                            setTaskForm((current) => ({ ...current, title: event.target.value }))
                          }
                          required
                        />
                      </label>
                      <div className="form-grid">
                        <label>
                          Due date
                          <input
                            type="date"
                            value={taskForm.dueDate}
                            onChange={(event) =>
                              setTaskForm((current) => ({ ...current, dueDate: event.target.value }))
                            }
                          />
                        </label>
                        <label>
                          Status
                          <select
                            value={taskForm.status}
                            onChange={(event) =>
                              setTaskForm((current) => ({
                                ...current,
                                status: event.target.value as TaskStatus,
                              }))
                            }
                          >
                            {taskStatusOptions.map((status) => (
                              <option key={status} value={status}>
                                {titleCase(status)}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                      <label>
                        Notes
                        <textarea
                          rows={5}
                          value={taskForm.notes}
                          onChange={(event) =>
                            setTaskForm((current) => ({ ...current, notes: event.target.value }))
                          }
                        />
                      </label>
                      <button type="submit" className="primary-button" disabled={saving}>
                        {taskForm.id === null ? 'Save task' : 'Update task'}
                      </button>
                    </form>
                  </div>
                </section>
              ) : null}

              {activeTab === 'reports' ? (
                <section className="tab-panel">
                  <div className="metrics-grid">
                    {renderStatCard(
                      'Listed value',
                      formatCurrency(workspace.report.total_listed_value),
                      'purple',
                    )}
                    {renderStatCard(
                      'Sold value',
                      formatCurrency(workspace.report.total_sold_value),
                      'green',
                    )}
                    {renderStatCard(
                      'Items priced',
                      `${workspace.report.priced_items}/${workspace.report.total_items}`,
                      'amber',
                    )}
                    {renderStatCard(
                      'Sell-through',
                      `${workspace.report.sell_through_rate}%`,
                      'teal',
                    )}
                  </div>

                  <div className="two-column">
                    <section className="surface">
                      <div className="surface-heading">
                        <div>
                          <h3>Category performance</h3>
                          <p>See where the money is and what still needs attention.</p>
                        </div>
                      </div>
                      <div className="report-table">
                        {workspace.report.category_breakdown.map((entry) => (
                          <div key={entry.category_name} className="report-row">
                            <div>
                              <strong>{entry.category_name}</strong>
                              <small>
                                {entry.sold_count} sold / {entry.item_count} total
                              </small>
                            </div>
                            <div className="report-row__values">
                              <span>{formatCurrency(entry.listed_value)}</span>
                              <span>{formatCurrency(entry.sold_value)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>

                    <section className="surface">
                      <div className="surface-heading">
                        <div>
                          <h3>Room breakdown</h3>
                          <p>Quick glance at where the remaining value is sitting.</p>
                        </div>
                      </div>
                      <div className="report-bars">
                        {workspace.report.room_breakdown.map((entry) => (
                          <div key={entry.room_name} className="report-bar">
                            <div className="report-bar__labels">
                              <strong>{entry.room_name}</strong>
                              <span>
                                {entry.item_count} items · {formatCurrency(entry.listed_value)}
                              </span>
                            </div>
                            <div className="report-bar__track">
                              <div
                                className="report-bar__fill"
                                style={{
                                  width: `${Math.max(
                                    8,
                                    (entry.listed_value /
                                      Math.max(
                                        ...workspace.report.room_breakdown.map((room) => room.listed_value),
                                        1,
                                      )) *
                                      100,
                                  )}%`,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  </div>
                </section>
              ) : null}
            </>
          ) : (
            <section className="surface empty-state">
              <h2>No sales yet</h2>
              <p>Create Amanda&apos;s first estate sale from the panel on the left.</p>
            </section>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
