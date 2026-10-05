import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AppRoute, AppView, SaleSection } from './routes'

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="nav-icon" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      {children}
    </svg>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
}

type IconName = 'sell' | 'estates' | 'all' | 'add' | 'items' | 'tasks' | 'details' | 'categories' | 'more'

const icons: Record<IconName, ReactNode> = {
  sell: (
    <Icon>
      <rect {...stroke} x="3" y="6" width="18" height="12" rx="2" />
      <circle {...stroke} cx="12" cy="12" r="2.5" />
      <path {...stroke} d="M6 9v.01M18 15v.01" />
    </Icon>
  ),
  estates: (
    <Icon>
      <path {...stroke} d="M3 10.5 12 4l9 6.5M5 9.5V20h14V9.5M10 20v-5h4v5" />
    </Icon>
  ),
  all: (
    <Icon>
      <rect {...stroke} x="4" y="4" width="7" height="7" rx="1.5" />
      <rect {...stroke} x="13" y="4" width="7" height="7" rx="1.5" />
      <rect {...stroke} x="4" y="13" width="7" height="7" rx="1.5" />
      <rect {...stroke} x="13" y="13" width="7" height="7" rx="1.5" />
    </Icon>
  ),
  add: (
    <Icon>
      <path {...stroke} d="M12 5v14M5 12h14" />
    </Icon>
  ),
  items: (
    <Icon>
      <path {...stroke} d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.5" cy="7.5" r="1.5" fill="currentColor" />
    </Icon>
  ),
  tasks: (
    <Icon>
      <path {...stroke} d="M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" />
    </Icon>
  ),
  details: (
    <Icon>
      <path {...stroke} d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle {...stroke} cx="12" cy="9.5" r="2.5" />
    </Icon>
  ),
  categories: (
    <Icon>
      <path {...stroke} d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </Icon>
  ),
  more: (
    <Icon>
      <circle cx="5" cy="12" r="1.8" fill="currentColor" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
      <circle cx="19" cy="12" r="1.8" fill="currentColor" />
    </Icon>
  ),
}

/** Setting up and running the estate sale itself (the event at a house). */
const setupEntries: Array<{ section: SaleSection | null; label: string; icon: IconName }> = [
  { section: null, label: 'Estate sales', icon: 'estates' },
  { section: 'details', label: 'Estate sale details', icon: 'details' },
  { section: 'tasks', label: 'Tasks', icon: 'tasks' },
  { section: 'categories', label: 'Categories & stats', icon: 'categories' },
]

interface QuickNavProps {
  view: AppView
  section: SaleSection | null
  saleId: number | null
  saleTitle: string | null
  onNavigate: (route: AppRoute) => void
  onAddItem: () => void
}

/**
 * The always-visible menu: a left sidebar on laptops and a bottom tab bar on
 * tablets and phones (CSS decides which). Daily work first -- Sale (ring up a
 * customer), Items, Add item, All items -- then, set apart, everything about
 * the estate sale itself: the list of estate sales (switch or create), its
 * details, tasks, categories & stats. On the bottom bar those live under More.
 */
export function QuickNav({ view, section, saleId, saleTitle, onNavigate, onAddItem }: QuickNavProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const hasSale = saleId !== null && saleTitle !== null
  const saleActive = view === 'checkout'
  const itemsActive = view === 'sales' && section === 'items'
  const setupActive = view === 'sales' && section !== 'items'

  function go(route: AppRoute): void {
    setMoreOpen(false)
    onNavigate(route)
  }

  function addItem(): void {
    setMoreOpen(false)
    onAddItem()
  }

  function current(active: boolean): { 'aria-current'?: 'page' } {
    return active ? { 'aria-current': 'page' } : {}
  }

  const visibleSetup = setupEntries.filter((entry) => hasSale || entry.section === null)

  function setupLinks(role?: 'menuitem') {
    return visibleSetup.map((entry) => {
      const active = view === 'sales' && section === entry.section
      return (
        <button
          type="button"
          role={role}
          key={entry.label}
          className={`nav-link ${active ? 'active' : ''}`}
          {...current(active)}
          onClick={() => go({ view: 'sales', saleId, section: entry.section })}
        >
          {icons[entry.icon]}
          <span>{entry.label}</span>
        </button>
      )
    })
  }

  return (
    <>
      <nav className="side-nav" aria-label="Main menu">
        <p className="side-nav-brand">Muffin Manor</p>
        <div className="nav-current-estate">
          <span>Estate sale</span>
          <strong title={saleTitle ?? undefined}>{saleTitle ?? 'None yet'}</strong>
        </div>
        <button
          type="button"
          className={`nav-link nav-sale ${saleActive ? 'active' : ''}`}
          {...current(saleActive)}
          disabled={!hasSale}
          onClick={() => go({ view: 'checkout', saleId })}
        >
          {icons.sell}
          <span>Sale</span>
        </button>
        <button
          type="button"
          className={`nav-link ${itemsActive ? 'active' : ''}`}
          {...current(itemsActive)}
          disabled={!hasSale}
          onClick={() => go({ view: 'sales', saleId, section: 'items' })}
        >
          {icons.items}
          <span>Items</span>
        </button>
        <button type="button" className="primary-button nav-add" disabled={!hasSale} onClick={addItem}>
          {icons.add}
          <span>Add item</span>
        </button>
        <button
          type="button"
          className={`nav-link ${view === 'items' ? 'active' : ''}`}
          {...current(view === 'items')}
          onClick={() => go({ view: 'items' })}
        >
          {icons.all}
          <span>All items</span>
        </button>

        <div className="side-nav-group">
          <p className="side-nav-label">Estate sales</p>
          {setupLinks()}
        </div>
      </nav>

      {moreOpen ? (
        <div className="nav-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            className="nav-sheet"
            role="menu"
            aria-label="Estate sales"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="side-nav-label">{saleTitle ? `Estate sale: ${saleTitle}` : 'Estate sales'}</p>
            {setupLinks('menuitem')}
          </div>
        </div>
      ) : null}

      <nav className="bottom-nav" aria-label="Quick menu">
        <button
          type="button"
          className={`tab-link tab-sale ${saleActive ? 'active' : ''}`}
          {...current(saleActive)}
          disabled={!hasSale}
          onClick={() => go({ view: 'checkout', saleId })}
        >
          {icons.sell}
          <span>Sale</span>
        </button>
        <button
          type="button"
          className={`tab-link ${itemsActive ? 'active' : ''}`}
          {...current(itemsActive)}
          disabled={!hasSale}
          onClick={() => go({ view: 'sales', saleId, section: 'items' })}
        >
          {icons.items}
          <span>Items</span>
        </button>
        <button type="button" className="tab-link tab-add" disabled={!hasSale} onClick={addItem}>
          <span className="tab-add-circle">{icons.add}</span>
          <span>Add item</span>
        </button>
        <button
          type="button"
          className={`tab-link ${view === 'items' ? 'active' : ''}`}
          {...current(view === 'items')}
          onClick={() => go({ view: 'items' })}
        >
          {icons.all}
          <span>All items</span>
        </button>
        <button
          type="button"
          className={`tab-link ${setupActive || moreOpen ? 'active' : ''}`}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          onClick={() => setMoreOpen((open) => !open)}
        >
          {icons.more}
          <span>More</span>
        </button>
      </nav>
    </>
  )
}
