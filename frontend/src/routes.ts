export type AppView = 'sales' | 'items'
export type SaleSection = 'items' | 'tasks' | 'details' | 'categories'

export interface AppRoute {
  view: AppView
  saleId?: number | null
  section?: SaleSection | null
}

export const saleSections: Array<{ id: SaleSection; label: string }> = [
  { id: 'items', label: 'Items' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'details', label: 'Sale details' },
  { id: 'categories', label: 'Categories & stats' },
]

const sectionIds = new Set<string>(saleSections.map((section) => section.id))

/** Read a route from the URL hash: #/items, #/sale/3 or #/sale/3/tasks. */
export function parseRouteHash(hash: string): AppRoute {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean)
  if (parts[0] === 'items') {
    return { view: 'items' }
  }
  if (parts[0] === 'sale') {
    const saleId = Number(parts[1])
    const section = parts[2] && sectionIds.has(parts[2]) ? (parts[2] as SaleSection) : null
    return { view: 'sales', saleId: Number.isFinite(saleId) && saleId > 0 ? saleId : null, section }
  }
  return { view: 'sales' }
}

export function buildRouteHash(route: AppRoute): string {
  if (route.view === 'items') {
    return '#/items'
  }
  if (route.saleId === null || route.saleId === undefined) {
    return '#/sales'
  }
  return `#/sale/${route.saleId}${route.section ? `/${route.section}` : ''}`
}
