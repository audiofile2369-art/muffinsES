import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createCategory,
  createItem,
  createSale,
  createTask,
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
  SalePayload,
  SaleStatus,
  TaskPayload,
  TaskRead,
  TaskStatus,
  TaskUpdatePayload,
  WorkspaceResponse,
} from './types'

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
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [showNewSaleForm, setShowNewSaleForm] = useState(false)
  const [saleFilter, setSaleFilter] = useState('')
  const [newSaleForm, setNewSaleForm] = useState<SaleFormState>(createEmptySaleForm)
  const [saleEditor, setSaleEditor] = useState<SaleFormState>(createEmptySaleForm)
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>(createEmptyCategoryForm)
  const [itemForm, setItemForm] = useState<ItemFormState>(createEmptyItemForm)
  const [taskForm, setTaskForm] = useState<TaskFormState>(createEmptyTaskForm)

  const categoryLookup = useMemo(() => {
    const entries: Array<[number, string]> =
      workspace?.categories.map((category) => [category.id, category.name]) ?? []
    return new Map<number, string>(entries)
  }, [workspace?.categories])

  const filteredItems = useMemo(() => {
    if (!workspace) {
      return []
    }

    return workspace.items.filter((item) => {
      const query = saleFilter.trim().toLowerCase()
      const matchesQuery =
        query.length === 0 ||
        [item.title, item.description, item.notes, item.room]
          .join(' ')
          .toLowerCase()
          .includes(query)

      return matchesQuery
    })
  }, [saleFilter, workspace])

  const categoryMetrics = useMemo(() => {
    if (!workspace) {
      return []
    }

    return workspace.categories.map((category) => {
      const matchingItems = workspace.items.filter((item) => item.category_id === category.id)
      return {
        ...category,
        itemCount: matchingItems.length,
      }
    })
  }, [workspace])

  const applyWorkspaceState = useCallback((nextWorkspace: WorkspaceResponse | null): void => {
    setWorkspace(nextWorkspace)
    setItemForm(createEmptyItemForm())
    setTaskForm(createEmptyTaskForm())
    setCategoryForm(createEmptyCategoryForm())
    setSaleFilter('')

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
  }, [])

  const refreshWorkspaceAndDashboard = useCallback(async (preferredSaleId?: number): Promise<void> => {
    setLoading(true)
    setErrorMessage('')

    try {
      const nextDashboard = await getDashboard()
      setDashboard(nextDashboard)
      const resolvedSaleId = preferredSaleId ?? selectedSaleId ?? nextDashboard.sales[0]?.id ?? null

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
  }, [applyWorkspaceState, selectedSaleId])

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshWorkspaceAndDashboard()
    }, 0)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [refreshWorkspaceAndDashboard])

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

  async function handleSaleSelection(saleId: number): Promise<void> {
    await refreshWorkspaceAndDashboard(saleId)
  }

  async function handleCreateSale(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    await withSavingState(async () => {
      const createdSale = await createSale(buildSalePayload(newSaleForm))
      setNewSaleForm(createEmptySaleForm())
      setShowNewSaleForm(false)
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
  }

  function beginEditingTask(task: TaskRead): void {
    setTaskForm({
      id: task.id,
      title: task.title,
      dueDate: task.due_date ?? '',
      status: task.status,
      notes: task.notes,
    })
  }

  function downloadItemsCsv(): void {
    if (!workspace) {
      return
    }

    const rows = [
      ['Title', 'Category', 'Room', 'Condition', 'Price', 'Status', 'Description', 'Notes'],
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Muffin Esate Sales</h1>
      </header>

      {errorMessage ? <div className="notice error">{errorMessage}</div> : null}

      <section className="surface">
        <div className="section-heading">
          <div>
            <h2>Sales</h2>
            <p>Pick the sale Amanda is working on right now.</p>
          </div>
          <button
            type="button"
            className="secondary-button"
            onClick={() => setShowNewSaleForm((current) => !current)}
          >
            {showNewSaleForm ? 'Close' : 'New sale'}
          </button>
        </div>

        {dashboard?.sales.length ? (
          <>
            <label>
              Current sale
              <select
                value={selectedSaleId ?? ''}
                onChange={(event) => void handleSaleSelection(Number(event.target.value))}
              >
                {dashboard.sales.map((sale) => (
                  <option key={sale.id} value={sale.id}>
                    {sale.title}
                  </option>
                ))}
              </select>
            </label>
            <div className="sale-list">
              {dashboard.sales.map((sale) => (
                <button
                  type="button"
                  key={sale.id}
                  className={`sale-card ${selectedSaleId === sale.id ? 'active' : ''}`}
                  onClick={() => void handleSaleSelection(sale.id)}
                >
                  <strong>{sale.title}</strong>
                  <span>{formatDateRange(sale.start_date, sale.end_date)}</span>
                  <small>
                    {sale.item_count} items · {sale.sold_count} sold
                  </small>
                </button>
              ))}
            </div>
          </>
        ) : (
          <p className="empty-copy">No sales yet. Start with one simple sale.</p>
        )}

        {showNewSaleForm || (dashboard?.sales.length ?? 0) === 0 ? (
          <form className="stack-form" onSubmit={(event) => void handleCreateSale(event)}>
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
            <div className="form-row">
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
            <button type="submit" className="primary-button" disabled={saving}>
              Save sale
            </button>
          </form>
        ) : null}
      </section>

      {loading ? (
        <section className="surface empty-block">
          <h2>Loading...</h2>
        </section>
      ) : null}

      {!loading && workspace ? (
        <>
          <section className="summary-grid">
            <article className="summary-card">
              <span>Sale</span>
              <strong>{workspace.sale.title}</strong>
              <small>{formatDateRange(workspace.sale.start_date, workspace.sale.end_date)}</small>
            </article>
            <article className="summary-card">
              <span>Items</span>
              <strong>{workspace.summary.item_count}</strong>
              <small>{workspace.summary.sold_count} sold</small>
            </article>
            <article className="summary-card">
              <span>Value</span>
              <strong>{formatCurrency(workspace.report.total_listed_value)}</strong>
              <small>{formatCurrency(workspace.report.total_sold_value)} sold</small>
            </article>
            <article className="summary-card">
              <span>Tasks</span>
              <strong>{workspace.summary.pending_task_count}</strong>
              <small>still open</small>
            </article>
          </section>

          <details className="surface" open>
            <summary>Items</summary>
            <div className="details-body">
              <div className="toolbar">
                <label>
                  Search items
                  <input
                    type="search"
                    placeholder="Search items"
                    value={saleFilter}
                    onChange={(event) => setSaleFilter(event.target.value)}
                  />
                </label>
                <button type="button" className="secondary-button" onClick={() => downloadItemsCsv()}>
                  Export CSV
                </button>
              </div>

              <div className="card-list">
                {filteredItems.length ? (
                  filteredItems.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      className="list-card"
                      onClick={() => beginEditingItem(item)}
                    >
                      <div>
                        <strong>{item.title}</strong>
                        <small>
                          {categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized'} · {item.room}
                        </small>
                      </div>
                      <div className="card-meta">
                        <span className="status-pill">{titleCase(item.status)}</span>
                        <strong>{item.price === null ? 'Unpriced' : formatCurrency(item.price)}</strong>
                      </div>
                    </button>
                  ))
                ) : (
                  <p className="empty-copy">No items yet.</p>
                )}
              </div>

              <form className="stack-form" onSubmit={(event) => void handleItemSubmit(event)}>
                <div className="section-heading">
                  <div>
                    <h3>{itemForm.id === null ? 'Add item' : 'Edit item'}</h3>
                    <p>Keep it quick and obvious.</p>
                  </div>
                  {itemForm.id !== null ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setItemForm(createEmptyItemForm())}
                    >
                      New item
                    </button>
                  ) : null}
                </div>
                <label>
                  Item name
                  <input
                    type="text"
                    value={itemForm.title}
                    onChange={(event) => setItemForm((current) => ({ ...current, title: event.target.value }))}
                    required
                  />
                </label>
                <div className="form-row">
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
                </div>
                <div className="form-row">
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
                </div>
                <label>
                  Notes
                  <textarea
                    rows={3}
                    value={itemForm.notes}
                    onChange={(event) => setItemForm((current) => ({ ...current, notes: event.target.value }))}
                  />
                </label>
                <button type="submit" className="primary-button" disabled={saving}>
                  {itemForm.id === null ? 'Save item' : 'Update item'}
                </button>
              </form>
            </div>
          </details>

          <details className="surface">
            <summary>Tasks</summary>
            <div className="details-body">
              <div className="card-list">
                {workspace.tasks.length ? (
                  workspace.tasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className="list-card"
                      onClick={() => beginEditingTask(task)}
                    >
                      <div>
                        <strong>{task.title}</strong>
                        <small>{task.due_date ? `Due ${task.due_date}` : 'No due date'}</small>
                      </div>
                      <span className="status-pill">{titleCase(task.status)}</span>
                    </button>
                  ))
                ) : (
                  <p className="empty-copy">No tasks yet.</p>
                )}
              </div>

              <form className="stack-form" onSubmit={(event) => void handleTaskSubmit(event)}>
                <div className="section-heading">
                  <div>
                    <h3>{taskForm.id === null ? 'Add task' : 'Edit task'}</h3>
                    <p>Only the basics.</p>
                  </div>
                  {taskForm.id !== null ? (
                    <button
                      type="button"
                      className="secondary-button"
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
                    onChange={(event) => setTaskForm((current) => ({ ...current, title: event.target.value }))}
                    required
                  />
                </label>
                <div className="form-row">
                  <label>
                    Due date
                    <input
                      type="date"
                      value={taskForm.dueDate}
                      onChange={(event) => setTaskForm((current) => ({ ...current, dueDate: event.target.value }))}
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
                <button type="submit" className="primary-button" disabled={saving}>
                  {taskForm.id === null ? 'Save task' : 'Update task'}
                </button>
              </form>
            </div>
          </details>

          <details className="surface">
            <summary>Sale details</summary>
            <div className="details-body">
              <form className="stack-form" onSubmit={(event) => void handleUpdateSale(event)}>
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
                <div className="form-row">
                  <label>
                    Start
                    <input
                      type="date"
                      value={saleEditor.startDate}
                      onChange={(event) =>
                        setSaleEditor((current) => ({ ...current, startDate: event.target.value }))
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
                    rows={3}
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
            </div>
          </details>

          <details className="surface">
            <summary>Categories and quick stats</summary>
            <div className="details-body">
              <div className="card-list">
                {categoryMetrics.length ? (
                  categoryMetrics.map((category) => (
                    <button
                      type="button"
                      key={category.id}
                      className="list-card"
                      onClick={() => beginEditingCategory(category)}
                    >
                      <div className="category-row">
                        <span className="color-dot" style={{ backgroundColor: category.color }} />
                        <strong>{category.name}</strong>
                      </div>
                      <small>{category.itemCount} items</small>
                    </button>
                  ))
                ) : (
                  <p className="empty-copy">No categories yet.</p>
                )}
              </div>

              <form className="stack-form" onSubmit={(event) => void handleCategorySubmit(event)}>
                <div className="section-heading">
                  <div>
                    <h3>{categoryForm.id === null ? 'Add category' : 'Edit category'}</h3>
                    <p>Keep names simple.</p>
                  </div>
                  {categoryForm.id !== null ? (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setCategoryForm(createEmptyCategoryForm())}
                    >
                      New category
                    </button>
                  ) : null}
                </div>
                <label>
                  Category name
                  <input
                    type="text"
                    value={categoryForm.name}
                    onChange={(event) =>
                      setCategoryForm((current) => ({ ...current, name: event.target.value }))
                    }
                    required
                  />
                </label>
                <div className="form-row">
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
                        setCategoryForm((current) => ({ ...current, sortOrder: event.target.value }))
                      }
                    />
                  </label>
                </div>
                <button type="submit" className="primary-button" disabled={saving}>
                  {categoryForm.id === null ? 'Save category' : 'Update category'}
                </button>
              </form>

              <div className="report-strip">
                <div className="report-card">
                  <span>Sell-through</span>
                  <strong>{workspace.report.sell_through_rate}%</strong>
                </div>
                <div className="report-card">
                  <span>Listed value</span>
                  <strong>{formatCurrency(workspace.report.total_listed_value)}</strong>
                </div>
                <div className="report-card">
                  <span>Sold value</span>
                  <strong>{formatCurrency(workspace.report.total_sold_value)}</strong>
                </div>
              </div>
            </div>
          </details>
        </>
      ) : null}

      {!loading && !workspace ? (
        <section className="surface empty-block">
          <h2>No sale selected</h2>
          <p className="empty-copy">Create the first sale and the rest of the app will stay simple.</p>
        </section>
      ) : null}
    </div>
  )
}

export default App
