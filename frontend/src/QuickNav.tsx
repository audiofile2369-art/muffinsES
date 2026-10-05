import { useState } from 'react'
import type { ReactNode } from 'react'
import { saleSections } from './routes'
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

const icons: Record<'sales' | 'all' | 'add' | SaleSection | 'more' | 'saleDay', ReactNode> = {
  saleDay: (
    <Icon>
      <rect {...stroke} x="3" y="6" width="18" height="12" rx="2" />
      <circle {...stroke} cx="12" cy="12" r="2.5" />
      <path {...stroke} d="M6 9v.01M18 15v.01" />
    </Icon>
  ),
  sales: (
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
 * tablets and phones. CSS decides which of the two is shown.
 */
export function QuickNav({ view, section, saleId, saleTitle, onNavigate, onAddItem }: QuickNavProps) {
  const [moreOpen, setMoreOpen] = useState(false)
  const hasSale = saleId !== null && saleTitle !== null
  const salesActive = view === 'sales' && section === null
  const moreSections = saleSections.filter((entry) => entry.id !== 'items')
  const moreActive =
    view === 'sale-day' || (view === 'sales' && moreSections.some((entry) => entry.id === section))

  function go(route: AppRoute): void {
    setMoreOpen(false)
    onNavigate(route)
  }

  function current(active: boolean): { 'aria-current'?: 'page' } {
    return active ? { 'aria-current': 'page' } : {}
  }

  return (
    <>
      <nav className="side-nav" aria-label="Main menu">
        <p className="side-nav-brand">Muffin Manor</p>
        <button
          type="button"
          className={`nav-link ${salesActive ? 'active' : ''}`}
          {...current(salesActive)}
          onClick={() => go({ view: 'sales', saleId, section: null })}
        >
          {icons.sales}
          <span>Sales</span>
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

        {hasSale ? (
          <div className="side-nav-group">
            <p className="side-nav-label" title={saleTitle}>
              {saleTitle}
            </p>
            <button type="button" className="primary-button nav-add" onClick={() => {
                setMoreOpen(false)
                onAddItem()
              }}>
              {icons.add}
              <span>Add item</span>
            </button>
            <button
              type="button"
              className={`nav-link ${view === 'sale-day' ? 'active' : ''}`}
              {...current(view === 'sale-day')}
              onClick={() => go({ view: 'sale-day', saleId })}
            >
              {icons.saleDay}
              <span>Sale day</span>
            </button>
            {saleSections.map((entry) => {
              const active = view === 'sales' && section === entry.id
              return (
                <button
                  type="button"
                  key={entry.id}
                  className={`nav-link ${active ? 'active' : ''}`}
                  {...current(active)}
                  onClick={() => go({ view: 'sales', saleId, section: entry.id })}
                >
                  {icons[entry.id]}
                  <span>{entry.label}</span>
                </button>
              )
            })}
          </div>
        ) : null}
      </nav>

      {moreOpen && hasSale ? (
        <div className="nav-sheet-backdrop" onClick={() => setMoreOpen(false)}>
          <div
            className="nav-sheet"
            role="menu"
            aria-label={`More for ${saleTitle}`}
            onClick={(event) => event.stopPropagation()}
          >
            <p className="side-nav-label">{saleTitle}</p>
            <button
              type="button"
              role="menuitem"
              className={`nav-link ${view === 'sale-day' ? 'active' : ''}`}
              onClick={() => go({ view: 'sale-day', saleId })}
            >
              {icons.saleDay}
              <span>Sale day</span>
            </button>
            {moreSections.map((entry) => (
              <button
                type="button"
                role="menuitem"
                key={entry.id}
                className={`nav-link ${view === 'sales' && section === entry.id ? 'active' : ''}`}
                onClick={() => go({ view: 'sales', saleId, section: entry.id })}
              >
                {icons[entry.id]}
                <span>{entry.label}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <nav className="bottom-nav" aria-label="Quick menu">
        <button
          type="button"
          className={`tab-link ${salesActive ? 'active' : ''}`}
          {...current(salesActive)}
          onClick={() => go({ view: 'sales', saleId, section: null })}
        >
          {icons.sales}
          <span>Sales</span>
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
          className="tab-link tab-add"
          disabled={!hasSale}
          onClick={() => {
            setMoreOpen(false)
            onAddItem()
          }}
        >
          <span className="tab-add-circle">{icons.add}</span>
          <span>Add item</span>
        </button>
        <button
          type="button"
          className={`tab-link ${view === 'sales' && section === 'items' ? 'active' : ''}`}
          {...current(view === 'sales' && section === 'items')}
          disabled={!hasSale}
          onClick={() => go({ view: 'sales', saleId, section: 'items' })}
        >
          {icons.items}
          <span>Sale items</span>
        </button>
        <button
          type="button"
          className={`tab-link ${moreActive || moreOpen ? 'active' : ''}`}
          aria-expanded={moreOpen}
          aria-haspopup="menu"
          disabled={!hasSale}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {icons.more}
          <span>More</span>
        </button>
      </nav>
    </>
  )
}
