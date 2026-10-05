import type { ItemRead } from './types'

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

export function titleCase(value: string): string {
  return value
    .split('_')
    .join(' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/** Split a search box value into lowercase words. */
export function searchTerms(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * True when every word typed appears somewhere in the item (any field, any order).
 * `extraText` adds context such as the category or sale name.
 */
export function itemMatchesSearch(item: ItemRead, terms: string[], extraText: string[] = []): boolean {
  if (terms.length === 0) {
    return true
  }

  const searchableText = [
    item.title,
    item.description,
    ...extraText,
    item.room,
    item.condition,
    item.notes,
    item.price === null ? '' : `${item.price} ${item.price.toFixed(2)} ${formatCurrency(item.price)}`,
  ]
    .join(' ')
    .toLowerCase()

  return terms.every((term) => searchableText.includes(term))
}

/** Money to the cent ("$12.50"), for prices and totals at the till. */
export function formatMoney(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value)
}
