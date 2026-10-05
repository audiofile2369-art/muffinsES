import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { titleCase } from './format'
import type { ItemStatus } from './types'

const ITEM_STATUSES: ItemStatus[] = ['available', 'sold', 'discounted', 'reserved', 'donated', 'removed']

interface StatusMenuProps {
  status: ItemStatus
  itemTitle: string
  onChange: (status: ItemStatus) => void
}

/**
 * The status pill on an item row, as a control: tap it for a small menu of the
 * statuses (current one checked) with a quick "Mark sold" on top.
 * Lives outside the row's open-editor button, and stops clicks from reaching it.
 */
export function StatusMenu({ status, itemTitle, onChange }: StatusMenuProps) {
  const [open, setOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuId = useId()

  useEffect(() => {
    if (!open) {
      return
    }
    // Focus the first choice so the keyboard can move straight through the menu.
    menuRef.current?.querySelector<HTMLButtonElement>('[role^="menuitem"]')?.focus()

    function handlePointerDown(event: PointerEvent): void {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [open])

  function close(returnFocus: boolean): void {
    setOpen(false)
    if (returnFocus) {
      triggerRef.current?.focus()
    }
  }

  function choose(next: ItemStatus): void {
    close(true)
    if (next !== status) {
      onChange(next)
    }
  }

  function handleMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLButtonElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      items[(index + step + items.length) % items.length]?.focus()
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      items[event.key === 'Home' ? 0 : items.length - 1]?.focus()
    } else if (event.key === 'Tab') {
      close(false)
    }
  }

  return (
    <div
      className="status-menu"
      ref={wrapperRef}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        ref={triggerRef}
        className={`status-pill status-pill-button status-${status}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Status: ${titleCase(status)}. Change status of ${itemTitle}`}
        onClick={() => setOpen((current) => !current)}
      >
        {titleCase(status)} <span aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div
          className="status-menu-popover"
          role="menu"
          id={menuId}
          ref={menuRef}
          aria-label={`Status of ${itemTitle}`}
          onKeyDown={handleMenuKeyDown}
        >
          {status !== 'sold' ? (
            <button type="button" role="menuitem" className="status-menu-sold" onClick={() => choose('sold')}>
              Mark sold
            </button>
          ) : null}
          {ITEM_STATUSES.map((option) => (
            <button
              type="button"
              key={option}
              role="menuitemradio"
              aria-checked={option === status}
              className="status-menu-option"
              onClick={() => choose(option)}
            >
              <span className="status-menu-check" aria-hidden="true">
                {option === status ? '✓' : ''}
              </span>
              {titleCase(option)}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
