/**
 * Screens: `checkout` is the Sale page (ring up a customer), `sales` the open
 * estate sale (its inventory and, further down, its setup sections), `items`
 * every item across all estate sales.
 */
export type AppView = 'checkout' | 'sales' | 'items'
export type SaleSection = 'items' | 'tasks' | 'details' | 'categories'

export interface AppRoute {
  view: AppView
  saleId?: number | null
  section?: SaleSection | null
}

export const saleSections: Array<{ id: SaleSection; label: string }> = [
  { id: 'items', label: 'Items' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'details', label: 'Estate sale details' },
  { id: 'categories', label: 'Categories & stats' },
]

const sectionIds = new Set<string>(saleSections.map((section) => section.id))

function validId(value: string | undefined): number | null {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Read a route from the URL hash: #/items, #/checkout/3, #/sales, #/sale/3 or #/sale/3/tasks.
 * The old Sale day address (#/sale/3/sale-day) opens the Sale page.
 */
export function parseRouteHash(hash: string): AppRoute {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'items') {
    return { view: 'items' }
  }
  if (parts[0] === 'checkout') {
    return { view: 'checkout', saleId: validId(parts[1]) }
  }
  if (parts[0] === 'sale') {
    const saleId = validId(parts[1])
    if (parts[2] === 'sale-day') {
      return { view: 'checkout', saleId }
    }
    const section = parts[2] && sectionIds.has(parts[2]) ? (parts[2] as SaleSection) : null
    return { view: 'sales', saleId, section }
  }
  if (parts[0] === 'sales') {
    return { view: 'sales', section: null }
  }
  // Opening the app lands on the open estate sale's items.
  return { view: 'sales', section: 'items' }
}

export function buildRouteHash(route: AppRoute): string {
  if (route.view === 'items') {
    return '#/items'
  }
  if (route.view === 'checkout') {
    return route.saleId == null ? '#/checkout' : `#/checkout/${route.saleId}`
  }
  if (route.saleId === null || route.saleId === undefined) {
    return route.section === 'items' ? '#/' : '#/sales'
  }
  return `#/sale/${route.saleId}${route.section ? `/${route.section}` : ''}`
}
