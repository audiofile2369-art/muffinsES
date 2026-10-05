import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  createCategory,
  createItem,
  createSale,
  createTask,
  addItemPhoto,
  deleteItem,
  estimatePriceFromPhoto,
  getDashboard,
  getItemPhotoUrl,
  getWorkspace,
  importLegacyBrowserDataToBackend,
  incrementItemQuantity,
  decrementItemQuantity,
  updateItemStatus,
  updateItemPaymentMethod,
  updateCategory,
  updateItem,
  updateSale,
  updateTask,
} from './api'
import './App.css'
import { formatCurrency, itemMatchesSearch, searchTerms, titleCase } from './format'
import { AllItemsView } from './AllItemsView'
import { ItemPhotosPanel } from './ItemPhotosPanel'
import { ItemThumbnail } from './ItemThumbnail'
import { PhotoSearchButton, PhotoSearchPanel } from './PhotoSearch'
import { QuickNav } from './QuickNav'
import { StatusMenu } from './StatusMenu'
import { SellControls } from './SellControls'
import { PAYMENT_METHODS, paymentLabel, remainingUnits, restoreSales, soldUnits } from './selling'
import { useSellFlow } from './useSellFlow'
import { ToastHost } from './ToastHost'
import { flushToast, showToast } from './toast'
import { buildRouteHash, parseRouteHash } from './routes'
import type { AppRoute, AppView, SaleSection } from './routes'
import { stepPhotoViewer } from './photoViewer'
import type { PhotoViewerState } from './photoViewer'
import type {
  CategoryRead,
  DashboardResponse,
  ItemPayload,
  ItemPartialUpdatePayload,
  ItemRead,
  ItemStatus,
  ItemUpdatePayload,
  ItemWithSale,
  PaymentMethod,
  PricingEstimateResponse,
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
  categoryName: string
  room: string
  condition: string
  price: string
  quantity: string
  status: ItemStatus
  notes: string
  photoUrl: string
}

const itemConditionOptions = ['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Poor', 'For Parts']

type PricingAutofillField = 'title' | 'description' | 'categoryName' | 'room' | 'condition' | 'price'

type PricingAutofill = Partial<Record<PricingAutofillField, string>>

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

/**
 * Merge an AI suggestion into the item form. A field is only filled when it is
 * empty, still at its blank-form default, or still holds the previous AI fill;
 * anything the user typed is left alone (the suggestion stays visible on the card).
 */
function applyPricingSuggestion(
  current: ItemFormState,
  estimate: PricingEstimateResponse,
  previousFill: PricingAutofill,
): { form: ItemFormState; fill: PricingAutofill } {
  const defaults = createEmptyItemForm()
  const suggestions: Record<PricingAutofillField, string> = {
    title: estimate.suggested_title,
    description: estimate.suggested_description ?? '',
    categoryName: estimate.suggested_category,
    room: estimate.suggested_room,
    condition: estimate.suggested_condition ?? '',
    price: estimate.estimated_price === null ? '' : String(estimate.estimated_price),
  }
  const form = { ...current }
  const fill: PricingAutofill = {}

  for (const field of Object.keys(suggestions) as PricingAutofillField[]) {
    const suggestion = suggestions[field].trim()
    const value = current[field].trim()
    const canFill = value === '' || value === defaults[field] || value === previousFill[field]
    if (suggestion && canFill) {
      form[field] = suggestion
      fill[field] = suggestion
    } else if (value === previousFill[field]) {
      fill[field] = value
    }
  }

  return { form, fill }
}

function createEmptyItemForm(): ItemFormState {
  return {
    id: null,
    title: '',
    description: '',
    categoryName: '',
    room: 'General',
    condition: 'Good',
    price: '',
    quantity: '1',
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

function resolveSelectedSaleId(
  sales: DashboardResponse['sales'],
  preferredSaleId?: number | null,
): number | null {
  if (preferredSaleId !== null && preferredSaleId !== undefined) {
    const matchingSale = sales.find((sale) => sale.id === preferredSaleId)
    if (matchingSale) {
      return matchingSale.id
    }
  }

  return sales[0]?.id ?? null
}

const REVERTIBLE_ITEM_FIELDS = [
  'category_id',
  'title',
  'description',
  'room',
  'condition',
  'price',
  'quantity',
  'status',
  'notes',
  'photo_url',
] as const

/**
 * The fields a save changed, set back to their earlier values (for Undo).
 * Only those fields are sent, so anything changed elsewhere since is left alone.
 * Returns null when the save changed nothing.
 */
function buildRevertPayload(before: ItemRead, after: ItemRead): ItemPartialUpdatePayload | null {
  const payload: Record<string, unknown> = { title: before.title }
  let changed = false
  for (const field of REVERTIBLE_ITEM_FIELDS) {
    if (before[field] !== after[field]) {
      payload[field] = before[field]
      changed = true
    }
  }
  return changed ? (payload as ItemPartialUpdatePayload) : null
}

/** True when two flat forms hold the same values. */
function sameFormValues<T extends object>(left: T, right: T): boolean {
  return (Object.keys(left) as Array<keyof T>).every((key) => left[key] === right[key])
}

/** Item names compared for duplicates: trimmed, case-insensitive, single spaces. */
function normalizeItemName(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function parseQuantity(value: string): number {
  const parsed = Math.floor(Number(value))
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1
}

function escapeCsvValue(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

interface DuplicatePromptState {
  existing: ItemRead
  amount: number
}


function App() {
  const [dashboard, setDashboard] = useState<DashboardResponse | null>(null)
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
  const [selectedSaleId, setSelectedSaleId] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  // A background refresh of totals failed; the data on screen is kept and a Retry is offered.
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [showNewSaleForm, setShowNewSaleForm] = useState(false)
  const [showItemForm, setShowItemForm] = useState(false)
  const [saleFilter, setSaleFilter] = useState('')
  const [photoSearchOpen, setPhotoSearchOpen] = useState(false)
  const [newSaleForm, setNewSaleForm] = useState<SaleFormState>(createEmptySaleForm)
  const [saleEditor, setSaleEditor] = useState<SaleFormState>(createEmptySaleForm)
  const [categoryForm, setCategoryForm] = useState<CategoryFormState>(createEmptyCategoryForm)
  const [itemForm, setItemForm] = useState<ItemFormState>(createEmptyItemForm)
  // What the item / task form held when it was opened; anything different is an unsaved edit.
  const [itemBaseline, setItemBaseline] = useState<ItemFormState>(createEmptyItemForm)
  const [taskForm, setTaskForm] = useState<TaskFormState>(createEmptyTaskForm)
  const [taskBaseline, setTaskBaseline] = useState<TaskFormState>(createEmptyTaskForm)
  const [discardPrompt, setDiscardPrompt] = useState<{ name: string; resolve: (discard: boolean) => void } | null>(
    null,
  )
  // The address-bar hash last shown, to go back to when Back is pressed but edits are kept.
  const lastHashRef = useRef(window.location.hash)
  const leaveGuardRef = useRef<(route: AppRoute) => Promise<boolean>>(async () => true)
  const [pricingImageFile, setPricingImageFile] = useState<File | null>(null)
  const [pricingPreviewUrl, setPricingPreviewUrl] = useState('')
  const [pricingEstimate, setPricingEstimate] = useState<PricingEstimateResponse | null>(null)
  const [pricingAnswers, setPricingAnswers] = useState('')
  const [pricingLoading, setPricingLoading] = useState(false)
  const [pricingError, setPricingError] = useState('')
  // Photos picked in the Photos area for a new item; uploaded right after it is created.
  const [queuedPhotos, setQueuedPhotos] = useState<File[]>([])
  const [photoViewer, setPhotoViewer] = useState<PhotoViewerState | null>(null)
  const [duplicatePrompt, setDuplicatePrompt] = useState<DuplicatePromptState | null>(null)
  const [view, setView] = useState<AppView>(() => parseRouteHash(window.location.hash).view)
  const [activeSection, setActiveSection] = useState<SaleSection | null>(
    () => parseRouteHash(window.location.hash).section ?? null,
  )
  // Element id to scroll to once the next view has rendered ('top' scrolls to the top).
  const pendingScrollRef = useRef<string | null>(null)
  const pricingAutofillRef = useRef<PricingAutofill>({})
  const shownSaleIdRef = useRef<number | null>(null)
  // A list row to hold at the same place on screen across the next render(s),
  // so opening, moving or saving the inline editor never makes the list jump.
  const rowAnchorRef = useRef<{ id: string; top: number } | null>(null)
  // Bumped on every local change; a background refresh that started before a newer change is dropped.
  const changeSeqRef = useRef(0)
  // Items deleted but still inside their Undo window: hidden here, DELETE sent when the toast ends.
  const pendingDeleteIdsRef = useRef(new Set<number>())

  const categoryLookup = useMemo(() => {
    const entries: Array<[number, string]> =
      workspace?.categories.map((category) => [category.id, category.name]) ?? []
    return new Map<number, string>(entries)
  }, [workspace?.categories])

  const filteredItems = useMemo(() => {
    if (!workspace) {
      return []
    }

    // Every word typed must appear somewhere in the item (any field, any order).
    const terms = searchTerms(saleFilter)
    if (terms.length === 0) {
      return workspace.items
    }

    return workspace.items.filter((item) =>
      itemMatchesSearch(item, terms, [categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized']),
    )
  }, [categoryLookup, saleFilter, workspace])
  const isSearching = saleFilter.trim().length > 0

  const roomOptions = useMemo(() => {
    const rooms = workspace?.items.map((item) => item.room.trim()).filter(Boolean) ?? []
    return [...new Set(rooms)].sort((left, right) => left.localeCompare(right))
  }, [workspace?.items])

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

  const resetPricingState = useCallback((): void => {
    setPricingImageFile(null)
    setPricingPreviewUrl('')
    setPricingEstimate(null)
    setPricingAnswers('')
    setPricingError('')
    setPricingLoading(false)
    setQueuedPhotos([])
    pricingAutofillRef.current = {}
  }, [])

  useEffect(() => {
    if (!photoViewer && !duplicatePrompt) {
      return
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setPhotoViewer(null)
        setDuplicatePrompt(null)
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        setPhotoViewer((current) => stepPhotoViewer(current, event.key === 'ArrowLeft' ? -1 : 1))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [photoViewer, duplicatePrompt])

  const resetItemEditor = useCallback(
    (shouldShowForm = false): void => {
      setItemForm(createEmptyItemForm())
      setItemBaseline(createEmptyItemForm())
      resetPricingState()
      setShowItemForm(shouldShowForm)
    },
    [resetPricingState],
  )

  const applyWorkspaceState = useCallback((nextWorkspace: WorkspaceResponse | null): void => {
    setWorkspace(nextWorkspace)
    resetItemEditor(false)
    setTaskForm(createEmptyTaskForm())
    setTaskBaseline(createEmptyTaskForm())
    setCategoryForm(createEmptyCategoryForm())
    // Keep the search while working in one sale; start fresh when the sale changes.
    const nextSaleId = nextWorkspace?.sale.id ?? null
    if (nextSaleId !== shownSaleIdRef.current) {
      shownSaleIdRef.current = nextSaleId
      setSaleFilter('')
      setPhotoSearchOpen(false)
    }

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
  }, [resetItemEditor])

  const refreshWorkspaceAndDashboard = useCallback(async (preferredSaleId?: number | null): Promise<WorkspaceResponse | null> => {
    // Carry out a delete still waiting on its Undo toast before another sale is loaded.
    await flushToast()
    setLoading(true)
    setErrorMessage('')

    try {
      let nextDashboard = await getDashboard()
      if (nextDashboard.sales.length === 0) {
        const importedBrowserData = await importLegacyBrowserDataToBackend()
        if (importedBrowserData) {
          nextDashboard = await getDashboard()
        }
      }
      setDashboard(nextDashboard)
      const resolvedSaleId = resolveSelectedSaleId(nextDashboard.sales, preferredSaleId)

      if (resolvedSaleId === null) {
        applyWorkspaceState(null)
        setSelectedSaleId(null)
        return null
      }

      setShowNewSaleForm(false)
      setSelectedSaleId(resolvedSaleId)
      const nextWorkspace = await getWorkspace(resolvedSaleId)
      applyWorkspaceState(nextWorkspace)
      return nextWorkspace
    } catch (error) {
      // Keep whatever sale is already on screen; only the first load has nothing to show.
      setSelectedSaleId(shownSaleIdRef.current)
      setErrorMessage(error instanceof Error ? error.message : 'Unable to load the app.')
      return null
    } finally {
      setLoading(false)
    }
  }, [applyWorkspaceState])

  /**
   * Refresh the dashboard and the open sale's totals in the background after a save:
   * no loading screen, nothing closed, and a failure never clears what is on screen.
   */
  const refreshQuietly = useCallback(async (saleId: number): Promise<void> => {
    const seq = changeSeqRef.current
    try {
      const [nextDashboard, nextWorkspace] = await Promise.all([getDashboard(), getWorkspace(saleId)])
      if (seq !== changeSeqRef.current) {
        return // A newer change started its own refresh; this result may be stale.
      }
      setRefreshFailed(false)
      setDashboard(nextDashboard)
      const pending = pendingDeleteIdsRef.current
      const shown = pending.size
        ? { ...nextWorkspace, items: nextWorkspace.items.filter((item) => !pending.has(item.id)) }
        : nextWorkspace
      setWorkspace((current) => (current?.sale.id === saleId ? shown : current))
    } catch {
      if (seq === changeSeqRef.current) {
        setRefreshFailed(true)
      }
    }
  }, [])

  /** Note a local change and refresh totals quietly behind it. */
  const afterLocalChange = useCallback(
    (saleId: number): void => {
      changeSeqRef.current += 1
      void refreshQuietly(saleId)
    },
    [refreshQuietly],
  )

  /** Put a saved item into the open sale's list (new items go first, like the server's order). */
  const upsertItem = useCallback((item: ItemRead): void => {
    setWorkspace((current) => {
      if (!current || current.sale.id !== item.sale_id) {
        return current
      }
      const exists = current.items.some((existing) => existing.id === item.id)
      return {
        ...current,
        items: exists
          ? current.items.map((existing) => (existing.id === item.id ? item : existing))
          : [item, ...current.items],
      }
    })
  }, [])

  /** An item changed by selling (or undoing a sale): into the list, editor kept in step, totals refreshed. */
  const applySoldItem = useCallback(
    (item: ItemRead): void => {
      upsertItem(item)
      const syncStatus = (current: ItemFormState): ItemFormState =>
        current.id === item.id ? { ...current, status: item.status } : current
      setItemForm(syncStatus)
      setItemBaseline(syncStatus)
      afterLocalChange(item.sale_id)
    },
    [afterLocalChange, upsertItem],
  )
  const sellFlow = useSellFlow(applySoldItem, setErrorMessage)

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const initialRoute = parseRouteHash(window.location.hash)
      pendingScrollRef.current = initialRoute.section ? `section-${initialRoute.section}` : null
      void refreshWorkspaceAndDashboard(initialRoute.saleId)
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
      category_id: null,
      title: itemForm.title.trim(),
      description: itemForm.description.trim(),
      room: itemForm.room.trim() || 'General',
      condition: itemForm.condition.trim() || 'Good',
      price: itemForm.price.trim().length > 0 ? Number(itemForm.price) : null,
      quantity: parseQuantity(itemForm.quantity),
      status: itemForm.status,
      notes: itemForm.notes.trim(),
      photo_url: itemForm.photoUrl.trim() || null,
    }
  }

  function buildItemUpdatePayload(saleId: number, categoryId: number | null): ItemUpdatePayload {
    const payload = buildItemPayload(saleId)
    return {
      category_id: categoryId,
      title: payload.title,
      description: payload.description,
      room: payload.room,
      condition: payload.condition,
      price: payload.price,
      quantity: payload.quantity,
      status: payload.status,
      notes: payload.notes,
      photo_url: payload.photo_url,
    }
  }

  function upsertCategory(category: CategoryRead): void {
    setWorkspace((current) => {
      if (!current) {
        return current
      }
      const exists = current.categories.some((existing) => existing.id === category.id)
      return {
        ...current,
        categories: exists
          ? current.categories.map((existing) => (existing.id === category.id ? category : existing))
          : [...current.categories, category],
      }
    })
  }

  async function resolveCategoryId(categoryName: string): Promise<number | null> {
    if (!workspace) {
      return null
    }

    const normalizedCategoryName = categoryName.trim()
    if (normalizedCategoryName.length === 0) {
      return null
    }

    const existingCategory = workspace.categories.find(
      (category) => category.name.toLowerCase() === normalizedCategoryName.toLowerCase(),
    )
    if (existingCategory) {
      return existingCategory.id
    }

    const createdCategory = await createCategory({
      name: normalizedCategoryName,
      color: '#8b5cf6',
      sort_order: workspace.categories.length + 1,
    })
    upsertCategory(createdCategory)
    return createdCategory.id
  }

  async function requestPriceEstimate(file: File, followUpAnswers: string): Promise<void> {
    setPricingLoading(true)
    setPricingError('')

    try {
      const estimate = await estimatePriceFromPhoto(
        file,
        itemForm.categoryName,
        itemForm.room,
        itemForm.notes,
        followUpAnswers,
        workspace?.categories.map((category) => category.name) ?? [],
      )
      setPricingEstimate(estimate)
      const previousFill = pricingAutofillRef.current
      setItemForm((current) => {
        const { form, fill } = applyPricingSuggestion(current, estimate, previousFill)
        pricingAutofillRef.current = fill
        return form
      })
    } catch (error) {
      setPricingError(error instanceof Error ? error.message : 'Unable to estimate price right now.')
    } finally {
      setPricingLoading(false)
    }
  }

  async function handlePhotoSelected(event: FormEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0]
    if (!file) {
      return
    }
    event.currentTarget.value = ''

    setPricingImageFile(file)
    setPricingPreviewUrl(URL.createObjectURL(file))
    setPricingEstimate(null)
    setPricingAnswers('')
    await requestPriceEstimate(file, '')
  }

  async function handleRefreshEstimate(): Promise<void> {
    if (!pricingImageFile) {
      return
    }

    await requestPriceEstimate(pricingImageFile, pricingAnswers)
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
    if (saleId !== selectedSaleId && !(await confirmDiscard('all'))) {
      return
    }
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
      const saleId = workspace.sale.id
      const savedSale = await updateSale(saleId, buildSalePayload(saleEditor))
      setWorkspace((current) => (current?.sale.id === saleId ? { ...current, sale: savedSale } : current))
      afterLocalChange(saleId)
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

      const savedCategory =
        categoryForm.id === null ? await createCategory(payload) : await updateCategory(categoryForm.id, payload)

      setCategoryForm(createEmptyCategoryForm())
      upsertCategory(savedCategory)
      if (workspace) {
        afterLocalChange(workspace.sale.id)
      }
    })
  }

  async function handleItemSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!workspace) {
      return
    }

    if (itemForm.id === null) {
      const newName = normalizeItemName(itemForm.title)
      const existing = workspace.items.find((item) => normalizeItemName(item.title) === newName)
      if (newName && existing) {
        setDuplicatePrompt({ existing, amount: parseQuantity(itemForm.quantity) })
        return
      }
    }

    await saveItem()
  }

  async function handleDuplicateAddToQuantity(): Promise<void> {
    if (!workspace || !duplicatePrompt) {
      return
    }

    const { existing, amount } = duplicatePrompt
    setDuplicatePrompt(null)
    await withSavingState(async () => {
      const updated = await incrementItemQuantity(existing.id, amount)
      resetItemEditor(false)
      upsertItem(updated)
      afterLocalChange(updated.sale_id)
      showToast({
        message: `Added ${amount} to "${updated.title}" (now ${updated.quantity})`,
        onUndo: () => {
          void (async () => {
            try {
              const restored = await decrementItemQuantity(updated.id, amount)
              upsertItem(restored)
              afterLocalChange(restored.sale_id)
            } catch (error) {
              setErrorMessage(`Could not undo: ${error instanceof Error ? error.message : 'unknown error'}`)
            }
          })()
        },
      })
    })
  }

  function handleDuplicateMistake(): void {
    setDuplicatePrompt(null)
    resetItemEditor(false)
  }

  async function handleDuplicateAddSeparately(): Promise<void> {
    setDuplicatePrompt(null)
    await saveItem()
  }

  async function saveItem(): Promise<void> {
    if (!workspace) {
      return
    }

    await withSavingState(async () => {
      const resolvedCategoryId = await resolveCategoryId(itemForm.categoryName)

      let savedItem: ItemRead
      const isNewItem = itemForm.id === null
      const before = workspace.items.find((item) => item.id === itemForm.id) ?? null
      if (itemForm.id !== null) {
        anchorRow(itemForm.id)
      }
      if (itemForm.id === null) {
        savedItem = await createItem({
          ...buildItemPayload(workspace.sale.id),
          category_id: resolvedCategoryId,
        })
      } else {
        savedItem = await updateItem(itemForm.id, buildItemUpdatePayload(workspace.sale.id, resolvedCategoryId))
      }

      upsertItem(savedItem)
      const photoError = await savePhotosAfterSave(savedItem.id, isNewItem)
      resetItemEditor(false)
      afterLocalChange(workspace.sale.id)
      const revert = before ? buildRevertPayload(before, savedItem) : null
      showToast({
        message: isNewItem ? `Added "${savedItem.title}"` : `Saved "${savedItem.title}"`,
        onUndo: revert
          ? () => {
              void (async () => {
                try {
                  const restored = await updateItem(savedItem.id, revert)
                  upsertItem(restored)
                  afterLocalChange(restored.sale_id)
                } catch (error) {
                  setErrorMessage(`Could not undo: ${error instanceof Error ? error.message : 'unknown error'}`)
                }
              })()
            }
          : undefined,
      })
      if (photoError) {
        setErrorMessage(photoError)
      }
    })
  }

  /**
   * After the item itself is saved, add the AI pricing photo (if one was picked)
   * to its photos, then, for a new item, the photos queued in the Photos area.
   * Returns an error message instead of throwing so a photo problem never loses the item.
   */
  async function savePhotosAfterSave(itemId: number, isNewItem: boolean): Promise<string> {
    const files = [...(pricingImageFile ? [pricingImageFile] : []), ...(isNewItem ? queuedPhotos : [])]
    let failed = 0
    let reason = ''
    for (const file of files) {
      try {
        upsertItem(await addItemPhoto(itemId, file))
      } catch (error) {
        failed += 1
        reason = error instanceof Error ? error.message : 'Unknown error.'
      }
    }
    if (failed === 0) {
      return ''
    }
    return failed === 1
      ? `The item was saved, but a photo could not be saved: ${reason}`
      : `The item was saved, but ${failed} photos could not be saved: ${reason}`
  }

  /** Delete the item being edited (after a confirm) without reloading the whole screen. */
  async function handleDeleteItem(): Promise<void> {
    if (!workspace || itemForm.id === null) {
      return
    }
    const itemId = itemForm.id
    const saleId = workspace.sale.id
    const name = itemForm.title.trim() || 'this item'
    if (!window.confirm(`Delete "${name}"? This removes it and its photos from this sale.`)) {
      return
    }

    const index = workspace.items.findIndex((item) => item.id === itemId)
    const removed = workspace.items[index]
    if (!removed) {
      return
    }
    const restore = (): void => {
      pendingDeleteIdsRef.current.delete(itemId)
      setWorkspace((current) => {
        if (!current || current.sale.id !== saleId || current.items.some((item) => item.id === itemId)) {
          return current
        }
        const items = [...current.items]
        items.splice(Math.min(index, items.length), 0, removed)
        return { ...current, items }
      })
    }

    // Hide the row now; the real DELETE waits until the Undo toast ends (or the page is left).
    resetItemEditor(false)
    pendingDeleteIdsRef.current.add(itemId)
    setWorkspace((current) =>
      current ? { ...current, items: current.items.filter((item) => item.id !== itemId) } : current,
    )
    showToast({
      message: `Deleted "${name}"`,
      onUndo: restore,
      onExpire: async () => {
        try {
          await deleteItem(itemId)
          pendingDeleteIdsRef.current.delete(itemId)
          afterLocalChange(saleId)
        } catch (error) {
          restore()
          setErrorMessage(
            `Could not delete "${name}": ${error instanceof Error ? error.message : 'unknown error'}`,
          )
        }
      },
    })
  }

  /** Put an updated item (e.g. new photo count) into the list without reloading the sale. */
  function applyItemChange(item: ItemRead): void {
    setWorkspace((current) =>
      current
        ? { ...current, items: current.items.map((existing) => (existing.id === item.id ? item : existing)) }
        : current,
    )
  }

  /**
   * One-tap status change from a list: shown at once, saved with the status-only
   * endpoint (so nothing else on the item is overwritten), put back if it fails.
   */
  async function changeItemStatus(item: ItemRead, status: ItemStatus, withUndo = true): Promise<boolean> {
    const previous = item.status
    const setStatus = (from: ItemStatus, to: ItemStatus): void =>
      setWorkspace((current) =>
        current
          ? {
              ...current,
              items: current.items.map((existing) =>
                existing.id === item.id && existing.status === from ? { ...existing, status: to } : existing,
              ),
            }
          : current,
      )
    setStatus(previous, status)
    // Keep an open editor for this item in step, so its next save does not undo the change.
    setItemForm((current) => (current.id === item.id ? { ...current, status } : current))
    setItemBaseline((current) => (current.id === item.id ? { ...current, status } : current))
    try {
      const saved = await updateItemStatus(item.id, status)
      upsertItem(saved)
      afterLocalChange(saved.sale_id)
      if (withUndo) {
        showToast({
          message: `"${saved.title}" marked ${titleCase(status)}`,
          onUndo: () => {
            const previousEvents = item.sale_events ?? []
            if (previous === 'sold' && previousEvents.length > 0) {
              // The server cleared the sales when the item left "sold"; put each one back as it was.
              void restoreSales(saved, previousEvents)
                .then(applySoldItem)
                .catch((error: unknown) =>
                  setErrorMessage(`Could not undo: ${error instanceof Error ? error.message : 'unknown error'}`),
                )
            } else {
              void changeItemStatus(saved, previous, false)
            }
          },
        })
      }
      return true
    } catch (error) {
      setStatus(status, previous)
      setItemForm((current) =>
        current.id === item.id && current.status === status ? { ...current, status: previous } : current,
      )
      setErrorMessage(
        `Could not change "${item.title}" to ${titleCase(status)}: ${error instanceof Error ? error.message : 'unknown error'}`,
      )
      return false
    }
  }

  function anchorRow(itemId: number): void {
    const element = document.getElementById(`item-row-${itemId}`)
    if (!element) {
      rowAnchorRef.current = null
      return
    }
    // Hold the row where it is, but on screen: after saving from the bottom of a
    // long form the row may have scrolled out of view above.
    const top = element.getBoundingClientRect().top
    rowAnchorRef.current = { id: element.id, top: Math.min(Math.max(top, 16), window.innerHeight - 120) }
  }

  async function handleTaskSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!workspace) {
      return
    }

    await withSavingState(async () => {
      const saleId = workspace.sale.id
      const savedTask =
        taskForm.id === null
          ? await createTask(buildTaskPayload(saleId))
          : await updateTask(taskForm.id, buildTaskUpdatePayload(saleId))

      setTaskForm(createEmptyTaskForm())
      setTaskBaseline(createEmptyTaskForm())
      setWorkspace((current) => {
        if (!current || current.sale.id !== saleId) {
          return current
        }
        const exists = current.tasks.some((task) => task.id === savedTask.id)
        return {
          ...current,
          tasks: exists
            ? current.tasks.map((task) => (task.id === savedTask.id ? savedTask : task))
            : [...current.tasks, savedTask],
        }
      })
      afterLocalChange(saleId)
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

  function beginEditingItem(item: ItemRead, categoryName?: string): void {
    resetPricingState()
    setShowItemForm(true)
    const form: ItemFormState = {
      id: item.id,
      title: item.title,
      description: item.description,
      categoryName: categoryName ?? categoryLookup.get(item.category_id ?? -1) ?? '',
      room: item.room,
      condition: item.condition,
      price: item.price === null ? '' : String(item.price),
      quantity: String(item.quantity ?? 1),
      status: item.status,
      notes: item.notes,
      photoUrl: item.photo_url ?? '',
    }
    setItemForm(form)
    setItemBaseline(form)
  }

  // ---------- Unsaved-changes guard ----------
  // Photos added in the Photos section of an existing item are saved at once and never count.
  const itemDirty =
    showItemForm &&
    (!sameFormValues(itemForm, itemBaseline) || pricingImageFile !== null || queuedPhotos.length > 0)
  const taskDirty = !sameFormValues(taskForm, taskBaseline)
  const saleDirty =
    workspace !== null &&
    !sameFormValues(saleEditor, {
      title: workspace.sale.title,
      address: workspace.sale.address,
      startDate: workspace.sale.start_date,
      endDate: workspace.sale.end_date,
      status: workspace.sale.status,
      notes: workspace.sale.notes,
    })
  const anyDirty = itemDirty || taskDirty || saleDirty

  /** Name of the first form with unsaved edits in `scope`, or null when nothing would be lost. */
  function dirtyName(scope: 'item' | 'task' | 'all'): string | null {
    if (itemDirty && (scope === 'item' || scope === 'all')) {
      return itemForm.title.trim() || (itemForm.id === null ? 'the new item' : 'this item')
    }
    if (taskDirty && (scope === 'task' || scope === 'all')) {
      return taskForm.title.trim() || 'the new task'
    }
    if (saleDirty && scope === 'all') {
      return `${saleEditor.title.trim() || 'this sale'} details`
    }
    return null
  }

  /** Ask before edits would be lost; resolves true when it is fine to go on (edits discarded). */
  async function confirmDiscard(scope: 'item' | 'task' | 'all'): Promise<boolean> {
    const name = dirtyName(scope)
    if (name === null) {
      return true
    }
    const discard = await new Promise<boolean>((resolve) => setDiscardPrompt({ name, resolve }))
    setDiscardPrompt(null)
    if (!discard) {
      return false
    }
    if (scope === 'item' || scope === 'all') {
      resetItemEditor(false)
    }
    if (scope === 'task' || scope === 'all') {
      setTaskForm(createEmptyTaskForm())
      setTaskBaseline(createEmptyTaskForm())
    }
    if (scope === 'all' && workspace) {
      setSaleEditor({
        title: workspace.sale.title,
        address: workspace.sale.address,
        startDate: workspace.sale.start_date,
        endDate: workspace.sale.end_date,
        status: workspace.sale.status,
        notes: workspace.sale.notes,
      })
    }
    return true
  }

  function routeLeavesScreen(route: AppRoute): boolean {
    return route.view !== view || (route.view === 'sales' && route.saleId != null && route.saleId !== selectedSaleId)
  }

  useEffect(() => {
    leaveGuardRef.current = (route) =>
      routeLeavesScreen(route) ? confirmDiscard('all') : Promise.resolve(true)
  })

  // Closing or reloading the tab with unsaved edits asks the browser's own "Leave site?".
  useEffect(() => {
    if (!anyDirty) {
      return
    }
    function handleBeforeUnload(event: BeforeUnloadEvent): void {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [anyDirty])

  async function toggleItemForm(): Promise<void> {
    if (!(await confirmDiscard('item'))) {
      return
    }
    if (showItemForm && itemForm.id === null) {
      resetItemEditor(false)
      return
    }

    resetItemEditor(true)
  }

  async function beginEditingTask(task: TaskRead): Promise<void> {
    if (!(await confirmDiscard('task'))) {
      return
    }
    const form: TaskFormState = {
      id: task.id,
      title: task.title,
      dueDate: task.due_date ?? '',
      status: task.status,
      notes: task.notes,
    }
    setTaskForm(form)
    setTaskBaseline(form)
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
        'Quantity',
        'Status',
        'Description',
        'Notes',
        'Sold qty',
        'Sold price (total received)',
        'Sold at',
        'Payment method',
      ],
      ...filteredItems.map((item) => [
        item.title,
        categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized',
        item.room,
        item.condition,
        item.price === null ? '' : String(item.price),
        String(item.quantity ?? 1),
        item.status,
        item.description,
        item.notes,
        String(soldUnits(item)),
        item.sold_total === null || item.sold_total === undefined ? '' : String(item.sold_total),
        item.sold_at ?? '',
        soldUnits(item) > 0 ? paymentLabel(item.payment_method) : '',
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

  // Keep the address bar in step with what is on screen, so reload and Back keep your place.
  useEffect(() => {
    if (loading) {
      return
    }
    const nextHash = buildRouteHash({ view, saleId: selectedSaleId, section: activeSection })
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, '', nextHash)
    }
    lastHashRef.current = nextHash
  }, [activeSection, loading, selectedSaleId, view])

  // Keep an anchored list row where it was on screen (before paint, so nothing jumps).
  useLayoutEffect(() => {
    const anchor = rowAnchorRef.current
    if (loading || anchor === null) {
      return
    }
    const element = document.getElementById(anchor.id)
    if (!element) {
      return
    }
    rowAnchorRef.current = null
    const shift = element.getBoundingClientRect().top - anchor.top
    if (Math.abs(shift) > 1) {
      window.scrollBy({ top: shift, behavior: 'instant' })
    }
  })

  // Scroll once the requested view or section has rendered.
  useEffect(() => {
    const target = pendingScrollRef.current
    if (loading || target === null) {
      return
    }
    if (target === 'top') {
      pendingScrollRef.current = null
      window.scrollTo({ top: 0 })
      return
    }
    const element = document.getElementById(target)
    if (!element) {
      return
    }
    pendingScrollRef.current = null
    if (element instanceof HTMLDetailsElement) {
      element.open = true
    }
    // Absolute scroll (not scrollIntoView, which some embedded browsers apply relative to the current offset).
    window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY })
  })

  const applyRoute = useCallback(
    async (route: AppRoute): Promise<WorkspaceResponse | null> => {
      setView(route.view)
      setActiveSection(route.view === 'sales' ? (route.section ?? null) : null)
      pendingScrollRef.current = route.view === 'sales' && route.section ? `section-${route.section}` : 'top'
      if (route.view === 'sales' && route.saleId != null && route.saleId !== selectedSaleId) {
        return refreshWorkspaceAndDashboard(route.saleId)
      }
      return workspace
    },
    [refreshWorkspaceAndDashboard, selectedSaleId, workspace],
  )

  useEffect(() => {
    function handlePopState(): void {
      const route = parseRouteHash(window.location.hash)
      void leaveGuardRef.current(route).then((ok) => {
        if (!ok) {
          // Keep editing: put the address bar back where the screen still is.
          window.history.pushState(null, '', lastHashRef.current)
          return
        }
        lastHashRef.current = window.location.hash
        void flushToast().then(() => applyRoute(route))
      })
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [applyRoute])

  async function navigate(route: AppRoute): Promise<WorkspaceResponse | null> {
    if (!(await leaveGuardRef.current(route))) {
      return null
    }
    const nextHash = buildRouteHash(route)
    if (window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash)
    }
    lastHashRef.current = nextHash
    // A delete waiting on its Undo toast is sent before another view loads its own copy.
    await flushToast()
    return applyRoute(route)
  }

  async function startAddingItem(): Promise<void> {
    if (!(await confirmDiscard('item'))) {
      return
    }
    void navigate({ view: 'sales', saleId: selectedSaleId, section: 'items' })
    resetItemEditor(true)
    pendingScrollRef.current = 'item-editor'
  }

  async function openItemFromAllItems(item: ItemWithSale): Promise<void> {
    const loadedWorkspace = await navigate({ view: 'sales', saleId: item.sale_id, section: 'items' })
    if (loadedWorkspace === null) {
      return
    }
    const freshItem = loadedWorkspace?.items.find((candidate) => candidate.id === item.id) ?? item
    setSaleFilter('')
    beginEditingItem(freshItem, item.category_name ?? '')
    pendingScrollRef.current = `item-row-${item.id}`
  }


  const editingItem = itemForm.id === null ? undefined : workspace?.items.find((item) => item.id === itemForm.id)

  /** Correct how the latest sale (or an older, unrecorded one) was paid. */
  async function changePaymentMethod(item: ItemRead, method: PaymentMethod): Promise<void> {
    try {
      applySoldItem(await updateItemPaymentMethod(item.id, method))
    } catch (error) {
      setErrorMessage(`Could not change the payment method: ${error instanceof Error ? error.message : 'unknown error'}`)
    }
  }

  const itemEditorForm = (
    <form className="stack-form" onSubmit={(event) => void handleItemSubmit(event)}>
      {editingItem ? (
        <div className="editor-sell">
          <SellControls
            item={editingItem}
            large
            onSell={(target) => sellFlow.openSell(target)}
            onUndoSale={(target) => void sellFlow.undoSale(target)}
          />
          {soldUnits(editingItem) > 0 ? (
            <fieldset className="payment-choices">
              <legend>
                {soldUnits(editingItem)} sold for {formatCurrency(editingItem.sold_total ?? 0)} · paid by
              </legend>
              <div className="chip-row">
                {PAYMENT_METHODS.map((option) => (
                  <button
                    type="button"
                    key={option.key}
                    className={`chip payment-chip ${editingItem.payment_method === option.key ? 'active' : ''}`}
                    aria-pressed={editingItem.payment_method === option.key}
                    onClick={() => void changePaymentMethod(editingItem, option.key)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
      ) : null}
      <ItemPhotosPanel
        key={itemForm.id ?? 'new'}
        itemId={itemForm.id}
        itemTitle={itemForm.title}
        queuedFiles={queuedPhotos}
        onQueuedFilesChange={setQueuedPhotos}
        hasPricingPhoto={pricingImageFile !== null}
        onItemChanged={applyItemChange}
        onOpenViewer={setPhotoViewer}
      />
      <fieldset className="photo-field ai-pricing-field">
        <legend>AI pricing (optional)</legend>
        <p className="hint-copy">
          Take or pick one photo and AI suggests a name, details and price. That photo is also saved with the
          item, so there is no need to add it again above.
        </p>
        <div className="photo-actions">
          <label className="secondary-button">
            Take photo for pricing
            <input
              type="file"
              accept="image/*"
              capture="environment"
              hidden
              onChange={(event) => void handlePhotoSelected(event)}
            />
          </label>
          <label className="secondary-button">
            Upload photo for pricing
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(event) => void handlePhotoSelected(event)}
            />
          </label>
        </div>
      </fieldset>
      {pricingPreviewUrl ? (
        <img
          src={pricingPreviewUrl}
          alt="Item preview for pricing"
          className="pricing-preview"
        />
      ) : null}
      {pricingLoading ? <p className="hint-copy">Checking the photo and estimating price...</p> : null}
      {pricingError ? <div className="notice error">{pricingError}</div> : null}
      {pricingEstimate ? (
        <div className="pricing-card">
          <strong>
            Suggested price:{' '}
            {pricingEstimate.estimated_price === null
              ? 'No estimate yet'
              : formatCurrency(pricingEstimate.estimated_price)}
          </strong>
          <small>
            Range:{' '}
            {pricingEstimate.low_estimate !== null && pricingEstimate.high_estimate !== null
              ? `${formatCurrency(pricingEstimate.low_estimate)} to ${formatCurrency(pricingEstimate.high_estimate)}`
              : 'Not available'}
          </small>
          {pricingEstimate.reasoning ? <p>{pricingEstimate.reasoning}</p> : null}
          {pricingEstimate.follow_up_questions.length ? (
            <>
              <div className="question-list">
                {pricingEstimate.follow_up_questions.map((question) => (
                  <p key={question}>{question}</p>
                ))}
              </div>
              <label>
                Answers for the AI
                <textarea
                  rows={3}
                  value={pricingAnswers}
                  onChange={(event) => setPricingAnswers(event.target.value)}
                  placeholder="Example: solid oak, small chip on the top, 48 inches wide."
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleRefreshEstimate()}
                disabled={pricingLoading}
              >
                Update estimate
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      <label>
        Item name
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
          rows={2}
          value={itemForm.description}
          onChange={(event) =>
            setItemForm((current) => ({ ...current, description: event.target.value }))
          }
        />
      </label>
      <label>
        Condition
        <input
          type="text"
          list="item-conditions"
          value={itemForm.condition}
          onChange={(event) => setItemForm((current) => ({ ...current, condition: event.target.value }))}
        />
        <datalist id="item-conditions">
          {itemConditionOptions.map((condition) => (
            <option key={condition} value={condition} />
          ))}
        </datalist>
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
          Quantity
          <input
            type="number"
            min="1"
            step="1"
            inputMode="numeric"
            value={itemForm.quantity}
            onChange={(event) => setItemForm((current) => ({ ...current, quantity: event.target.value }))}
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
          <input
            type="text"
            list="saved-categories"
            placeholder="Type a category or pick one"
            value={itemForm.categoryName}
            onChange={(event) =>
              setItemForm((current) => ({ ...current, categoryName: event.target.value }))
            }
          />
          <datalist id="saved-categories">
            {(workspace?.categories ?? []).map((category) => (
              <option key={category.id} value={category.name} />
            ))}
          </datalist>
        </label>
        <label>
          Room
          <input
            type="text"
            list="saved-rooms"
            placeholder="Type a room or pick one"
            value={itemForm.room}
            onChange={(event) => setItemForm((current) => ({ ...current, room: event.target.value }))}
          />
          <datalist id="saved-rooms">
            {roomOptions.map((room) => (
              <option key={room} value={room} />
            ))}
          </datalist>
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
      {itemForm.id !== null ? (
        <div className="item-delete-zone">
          <button
            type="button"
            className="secondary-button danger-button"
            disabled={saving}
            onClick={() => void handleDeleteItem()}
          >
            Delete item
          </button>
        </div>
      ) : null}
    </form>
  )

  return (
    <div className="app-layout">
      <ToastHost />
      <QuickNav
        view={view}
        section={activeSection}
        saleId={workspace?.sale.id ?? null}
        saleTitle={workspace?.sale.title ?? null}
        onNavigate={(route) => void navigate(route)}
        onAddItem={() => void startAddingItem()}
      />
    <main className="app-shell">
      <header className="app-header">
        <h1>Muffin Manor Estate Sales</h1>
      </header>

      {errorMessage ? <div className="notice error">{errorMessage}</div> : null}
      {refreshFailed && workspace ? (
        <div className="notice error refresh-notice" role="status">
          <span>Your change was saved, but the totals could not be updated. Check the connection.</span>
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setRefreshFailed(false)
              void refreshQuietly(workspace.sale.id)
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {view === 'items' ? (
        <AllItemsView
          onOpenItem={(item) => void openItemFromAllItems(item)}
          onOpenPhoto={setPhotoViewer}
          onItemChanged={(item) => {
            upsertItem(item)
            if (workspace) {
              afterLocalChange(workspace.sale.id)
            }
          }}
        />
      ) : null}

      {view === 'sales' ? (
      <>
      <section className="surface" id="section-sales">
        <div className="section-heading">
          <div>
            <h2>Sales</h2>
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
          <details className="surface" id="section-items" open>
            <summary>Items</summary>
            <div className="details-body">
              <div className="item-list-block">
              <div className="toolbar">
                <div className="search-field">
                  <label>
                    Search items
                    <input
                      type="search"
                      placeholder="Search items"
                      autoComplete="off"
                      value={saleFilter}
                      onChange={(event) => setSaleFilter(event.target.value)}
                    />
                  </label>
                  {isSearching ? (
                    <button type="button" className="secondary-button" onClick={() => setSaleFilter('')}>
                      Clear
                    </button>
                  ) : null}
                </div>
                <PhotoSearchButton
                  active={photoSearchOpen}
                  onClick={() => {
                    void confirmDiscard('item').then((ok) => {
                      if (ok) {
                        resetItemEditor(false)
                        setPhotoSearchOpen((open) => !open)
                      }
                    })
                  }}
                />
                <button type="button" className="secondary-button" onClick={() => downloadItemsCsv()}>
                  Export CSV
                </button>
              </div>

              {photoSearchOpen ? (
                <PhotoSearchPanel
                  saleId={workspace.sale.id}
                  scopeLabel="this sale"
                  onClose={() => setPhotoSearchOpen(false)}
                  onOpenItem={async (item) => {
                    if (!(await confirmDiscard('item'))) {
                      return
                    }
                    // Same sale: open the item's editor under its row and scroll there.
                    setPhotoSearchOpen(false)
                    setSaleFilter('')
                    beginEditingItem(item, item.category_name ?? '')
                    pendingScrollRef.current = `item-row-${item.id}`
                  }}
                  onOpenPhoto={setPhotoViewer}
                />
              ) : (
              <>
              {isSearching ? (
                <p className="hint-copy search-count" aria-live="polite">
                  {filteredItems.length} of {workspace.items.length} items
                </p>
              ) : null}

              <div className="card-list">
                {filteredItems.length ? (
                  filteredItems.map((item) => (
                    <Fragment key={item.id}>
                    <div
                      id={`item-row-${item.id}`}
                      className={itemForm.id === item.id ? 'list-card item-row is-editing' : 'list-card item-row'}
                    >
                      <ItemThumbnail item={item} onOpen={setPhotoViewer} />
                      <button
                        type="button"
                        className="item-row-main"
                        aria-expanded={itemForm.id === item.id}
                        onClick={async () => {
                          if (!(await confirmDiscard('item'))) {
                            return
                          }
                          anchorRow(item.id)
                          if (itemForm.id === item.id) {
                            resetItemEditor(false)
                          } else {
                            beginEditingItem(item)
                          }
                        }}
                      >
                        <div>
                          <strong>{item.title}</strong>
                          <small>
                            {categoryLookup.get(item.category_id ?? -1) ?? 'Uncategorized'} · {item.room}
                          </small>
                        </div>
                        <div className="card-meta">
                          <strong>
                            {item.price === null ? 'Unpriced' : formatCurrency(item.price)}
                            {(item.quantity ?? 1) > 1 ? <span className="quantity-badge"> × {item.quantity}</span> : null}
                          </strong>
                        </div>
                      </button>
                      <div className="item-row-actions">
                        <StatusMenu
                          status={item.status}
                          itemTitle={item.title}
                          onChange={(status) =>
                            status === 'sold'
                              ? sellFlow.openSell(item, remainingUnits(item))
                              : void changeItemStatus(item, status)
                          }
                        />
                        <SellControls
                          item={item}
                          onSell={(target) => sellFlow.openSell(target)}
                          onUndoSale={(target) => void sellFlow.undoSale(target)}
                        />
                      </div>
                    </div>
                    {itemForm.id === item.id ? <div className="item-inline-editor">{itemEditorForm}</div> : null}
                    </Fragment>
                  ))
                ) : isSearching && workspace.items.length > 0 ? (
                  <div className="empty-search">
                    <p className="empty-copy">No items match &ldquo;{saleFilter.trim()}&rdquo;</p>
                    <button type="button" className="secondary-button" onClick={() => setSaleFilter('')}>
                      Clear search
                    </button>
                  </div>
                ) : (
                  <p className="empty-copy">No items yet.</p>
                )}
              </div>
              </>
              )}
              </div>

              <div className="section-heading" id="item-editor">
                <div>
                  <h3>Add item</h3>
                  <p>Tap an item above to edit it right there.</p>
                </div>
                <button type="button" className="secondary-button" onClick={() => void toggleItemForm()}>
                  {showItemForm && itemForm.id === null ? 'Close' : 'Add item'}
                </button>
              </div>

              {showItemForm && itemForm.id === null ? itemEditorForm : null}
            </div>
          </details>

          <details className="surface" id="section-tasks">
            <summary>Tasks</summary>
            <div className="details-body">
              <div className="card-list">
                {workspace.tasks.length ? (
                  workspace.tasks.map((task) => (
                    <button
                      type="button"
                      key={task.id}
                      className="list-card"
                      onClick={() => void beginEditingTask(task)}
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
                      onClick={() => {
                        void confirmDiscard('task').then((ok) => {
                          if (ok) {
                            setTaskForm(createEmptyTaskForm())
                            setTaskBaseline(createEmptyTaskForm())
                          }
                        })
                      }}
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

          <details className="surface" id="section-details">
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

          <details className="surface" id="section-categories">
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
                <div className="report-card">
                  <span>Still for sale</span>
                  <strong>{formatCurrency(workspace.report.total_remaining_value ?? 0)}</strong>
                </div>
              </div>
              {workspace.report.payment_breakdown?.length ? (
                <div className="payment-breakdown">
                  <h3>Received by payment method</h3>
                  <ul>
                    {workspace.report.payment_breakdown.map((row) => (
                      <li key={row.payment_method ?? 'none'}>
                        <span>{paymentLabel(row.payment_method)}</span>
                        <small>
                          {row.sale_count} {row.sale_count === 1 ? 'sale' : 'sales'}
                        </small>
                        <strong>{formatCurrency(row.total)}</strong>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
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
      </>
      ) : null}
    </main>
      {duplicatePrompt ? (
        <div className="modal-backdrop" onClick={() => setDuplicatePrompt(null)}>
          <div
            className="modal-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="duplicate-title"
            aria-describedby="duplicate-body"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="duplicate-summary">
              {getItemPhotoUrl(duplicatePrompt.existing) || duplicatePrompt.existing.photo_url ? (
                <img
                  className="duplicate-thumb"
                  src={getItemPhotoUrl(duplicatePrompt.existing) ?? duplicatePrompt.existing.photo_url ?? ''}
                  alt={`Photo of ${duplicatePrompt.existing.title}`}
                />
              ) : null}
              <div>
                <h3 id="duplicate-title">Already added?</h3>
                <p id="duplicate-body">
                  You already added &ldquo;{duplicatePrompt.existing.title}&rdquo; to this sale (qty{' '}
                  {duplicatePrompt.existing.quantity ?? 1}
                  {duplicatePrompt.existing.price === null
                    ? ', unpriced'
                    : `, ${formatCurrency(duplicatePrompt.existing.price)}`}
                  ).
                </p>
              </div>
            </div>
            <button
              type="button"
              className="primary-button"
              autoFocus
              disabled={saving}
              onClick={() => void handleDuplicateAddToQuantity()}
            >
              It&rsquo;s another one &mdash; add {duplicatePrompt.amount} to quantity
            </button>
            <button type="button" className="secondary-button" onClick={() => handleDuplicateMistake()}>
              It&rsquo;s a mistake &mdash; don&rsquo;t add
            </button>
            <button
              type="button"
              className="link-button"
              disabled={saving}
              onClick={() => void handleDuplicateAddSeparately()}
            >
              Add as a separate item
            </button>
          </div>
        </div>
      ) : null}

      {sellFlow.sheet}

      {discardPrompt ? (
        <div className="modal-backdrop" onClick={() => discardPrompt.resolve(false)}>
          <div
            className="modal-card"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="discard-title"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation()
                discardPrompt.resolve(false)
              }
            }}
          >
            <h3 id="discard-title">Discard changes to &ldquo;{discardPrompt.name}&rdquo;?</h3>
            <p>Your changes have not been saved.</p>
            <button type="button" className="primary-button" autoFocus onClick={() => discardPrompt.resolve(false)}>
              Keep editing
            </button>
            <button type="button" className="secondary-button danger-button" onClick={() => discardPrompt.resolve(true)}>
              Discard
            </button>
          </div>
        </div>
      ) : null}

      {photoViewer ? (
        <div
          className="photo-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={photoViewer.alt}
          onClick={() => setPhotoViewer(null)}
        >
          <img src={photoViewer.src} alt={photoViewer.alt} />
          <div className="photo-overlay-controls">
            {photoViewer.gallery ? (
              <button
                type="button"
                className="secondary-button"
                aria-label="Previous photo"
                onClick={(event) => {
                  event.stopPropagation()
                  setPhotoViewer((current) => stepPhotoViewer(current, -1))
                }}
              >
                ‹ Previous
              </button>
            ) : null}
            {photoViewer.gallery ? (
              <span className="photo-overlay-count" aria-live="polite">
                {(photoViewer.index ?? 0) + 1} of {photoViewer.gallery.length}
              </span>
            ) : null}
            {photoViewer.gallery ? (
              <button
                type="button"
                className="secondary-button"
                aria-label="Next photo"
                onClick={(event) => {
                  event.stopPropagation()
                  setPhotoViewer((current) => stepPhotoViewer(current, 1))
                }}
              >
                Next ›
              </button>
            ) : null}
            <button type="button" className="secondary-button" autoFocus onClick={() => setPhotoViewer(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export default App
