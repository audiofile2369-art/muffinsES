/**
 * Square Point of Sale API (mobile web): open the Square app to take a payment,
 * then read what it hands back on the callback page.
 *
 * Formats follow Square's "Mobile Web" Point of Sale API docs:
 * iOS  square-commerce-v1://payment/create?data=<JSON> (version 1.3), answer in `?data=<JSON>`;
 * Android  intent:#Intent;action=com.squareup.pos.action.CHARGE;...;end (API v2.1),
 * answer in `com.squareup.pos.*` query parameters.
 */

export type MobilePlatform = 'ios' | 'android' | null

export const POS_CALLBACK_PATH = '/square/callback'
const PENDING_KEY = 'muffines-square-pos-pending'
const CALLBACK_KEY = 'muffines-square-pos-callback'

export function detectPlatform(userAgent: string = navigator.userAgent): MobilePlatform {
  if (/android/i.test(userAgent)) {
    return 'android'
  }
  // iPadOS reports itself as a Mac; touch support tells them apart.
  if (/iphone|ipad|ipod/i.test(userAgent) || (/macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1)) {
    return 'ios'
  }
  return null
}

export function posCallbackUrl(): string {
  return `${window.location.origin}${POS_CALLBACK_PATH}`
}

export interface PosRequest {
  amountCents: number
  currency: string
  applicationId: string
  callbackUrl: string
  /** Our square_payment id, handed back by Square so we know which charge returned. */
  state: string
  note: string
}

// Card tenders only: a cash payment taken in the Square app has no transaction we can verify.
const IOS_TENDERS = ['CARD_FROM_READER', 'KEYED_IN_CARD', 'SQUARE_GIFT_CARD', 'CARD_ON_FILE']
const ANDROID_TENDERS = ['com.squareup.pos.TENDER_CARD', 'com.squareup.pos.TENDER_CARD_ON_FILE']

export function buildPosUrl(platform: Exclude<MobilePlatform, null>, request: PosRequest): string {
  if (platform === 'ios') {
    const data = {
      amount_money: { amount: request.amountCents, currency_code: request.currency },
      callback_url: request.callbackUrl,
      client_id: request.applicationId,
      version: '1.3',
      notes: request.note,
      state: request.state,
      options: { supported_tender_types: IOS_TENDERS },
    }
    return `square-commerce-v1://payment/create?data=${encodeURIComponent(JSON.stringify(data))}`
  }
  const extras = [
    'action=com.squareup.pos.action.CHARGE',
    'package=com.squareup',
    `S.com.squareup.pos.WEB_CALLBACK_URI=${encodeURIComponent(request.callbackUrl)}`,
    `S.com.squareup.pos.CLIENT_ID=${encodeURIComponent(request.applicationId)}`,
    'S.com.squareup.pos.API_VERSION=v2.1',
    `i.com.squareup.pos.TOTAL_AMOUNT=${request.amountCents}`,
    `S.com.squareup.pos.CURRENCY_CODE=${request.currency}`,
    `S.com.squareup.pos.TENDER_TYPES=${ANDROID_TENDERS.join(',')}`,
    `S.com.squareup.pos.NOTE=${encodeURIComponent(request.note)}`,
    `S.com.squareup.pos.REQUEST_METADATA=${encodeURIComponent(request.state)}`,
  ]
  return `intent:#Intent;${extras.join(';')};end`
}

export interface PosCallback {
  paymentId: number | null
  transactionId: string | null
  clientTransactionId: string | null
  errorCode: string | null
}

/** Read the Square app's answer from the callback page's query string (iOS or Android). */
export function parsePosCallback(search: string): PosCallback {
  const params = new URLSearchParams(search)
  const iosData = params.get('data')
  if (iosData) {
    try {
      const data = JSON.parse(iosData) as Record<string, unknown>
      const text = (value: unknown) => (typeof value === 'string' && value ? value : null)
      return {
        paymentId: Number(data.state) || null,
        transactionId: text(data.transaction_id),
        clientTransactionId: text(data.client_transaction_id),
        errorCode: text(data.error_code) ?? (data.status === 'error' ? 'error' : null),
      }
    } catch {
      return { paymentId: null, transactionId: null, clientTransactionId: null, errorCode: 'unreadable_response' }
    }
  }
  return {
    paymentId: Number(params.get('com.squareup.pos.REQUEST_METADATA')) || null,
    transactionId: params.get('com.squareup.pos.SERVER_TRANSACTION_ID'),
    clientTransactionId: params.get('com.squareup.pos.CLIENT_TRANSACTION_ID'),
    errorCode: params.get('com.squareup.pos.ERROR_CODE'),
  }
}

interface PendingPos {
  paymentId: number
  saleId: number
}

function safeSet(storage: Storage, key: string, value: string | null): void {
  try {
    if (value === null) {
      storage.removeItem(key)
    } else {
      storage.setItem(key, value)
    }
  } catch {
    // Private mode: the callback still carries the charge id.
  }
}

function safeGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function rememberPendingPos(pending: PendingPos): void {
  safeSet(window.localStorage, PENDING_KEY, JSON.stringify(pending))
}

/**
 * Called once before the app renders: if Square sent the browser back to
 * /square/callback, keep its answer and move to the Sale page, which finishes it.
 */
export function captureSquareCallback(): void {
  if (window.location.pathname !== POS_CALLBACK_PATH) {
    return
  }
  const callback = parsePosCallback(window.location.search)
  let saleId: number | null = null
  try {
    const pending = JSON.parse(safeGet(window.localStorage, PENDING_KEY) ?? 'null') as PendingPos | null
    if (pending) {
      saleId = pending.saleId
      callback.paymentId = callback.paymentId ?? pending.paymentId
    }
  } catch {
    // Ignore a damaged note; the callback may still carry the charge id.
  }
  safeSet(window.localStorage, PENDING_KEY, null)
  safeSet(window.localStorage, CALLBACK_KEY, JSON.stringify(callback))
  window.history.replaceState(null, '', saleId ? `/#/checkout/${saleId}` : '/#/checkout')
}

/** The Square app's answer waiting to be finished on the Sale page (cleared by `clearSquareCallback`). */
export function peekSquareCallback(): PosCallback | null {
  const raw = safeGet(window.localStorage, CALLBACK_KEY)
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as PosCallback
    return parsed.paymentId ? parsed : null
  } catch {
    return null
  }
}

export function clearSquareCallback(): void {
  safeSet(window.localStorage, CALLBACK_KEY, null)
}
