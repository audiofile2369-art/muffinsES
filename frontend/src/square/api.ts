/** Square payments: calls to the backend (which talks to Square; the browser never does). */
import { ApiError, getDataSourceMode, request } from '../api'
import type { CheckoutPayload, OrderRead } from '../types'

export type SquareKind = 'terminal' | 'pos_app' | 'payment_link'
export type SquarePaymentStatus = 'pending' | 'completed' | 'canceled' | 'failed' | 'refunded' | 'conflict'

export interface SquareDevice {
  id: number
  name: string
  paired: boolean
  code: string | null
  code_status: string
  pair_by: string | null
  last_used_at: string | null
}

export interface SquareStatus {
  configured: boolean
  connected: boolean
  fake: boolean
  environment: string
  location_name: string
  application_id: string
  error: string
  callback_path: string
  api_version: string
  devices: SquareDevice[]
}

export interface SquarePayment {
  id: number
  sale_id: number
  kind: SquareKind
  status: SquarePaymentStatus
  amount: number
  amount_cents: number
  currency: string
  square_status: string
  message: string
  link_url: string | null
  square_payment_id: string | null
  order: OrderRead | null
  application_id: string
  created_at: string
}

export interface SquareChargePayload {
  client_key: string
  kind: SquareKind
  device_id?: number | null
  redirect_url?: string | null
  checkout: CheckoutPayload
}

function backendOnly(): void {
  if (getDataSourceMode() !== 'backend') {
    throw new ApiError('Square needs the online app.', 503)
  }
}

export function getSquareStatus(): Promise<SquareStatus> {
  backendOnly()
  return request<SquareStatus>('/square/status')
}

export function listSquareDevices(): Promise<SquareDevice[]> {
  backendOnly()
  return request<SquareDevice[]>('/square/devices')
}

export function pairSquareDevice(name: string): Promise<SquareDevice> {
  backendOnly()
  return request<SquareDevice>('/square/devices', { method: 'POST', body: JSON.stringify({ name }) })
}

export function removeSquareDevice(id: number): Promise<unknown> {
  backendOnly()
  return request<unknown>(`/square/devices/${id}`, { method: 'DELETE' })
}

export function startSquareCharge(saleId: number, payload: SquareChargePayload): Promise<SquarePayment> {
  backendOnly()
  return request<SquarePayment>(`/sales/${saleId}/square/charges`, { method: 'POST', body: JSON.stringify(payload) })
}

export function getSquarePayment(id: number): Promise<SquarePayment> {
  return request<SquarePayment>(`/square/payments/${id}`)
}

export function cancelSquarePayment(id: number): Promise<SquarePayment> {
  return request<SquarePayment>(`/square/payments/${id}/cancel`, { method: 'POST' })
}

export function refundSquarePayment(id: number): Promise<SquarePayment> {
  return request<SquarePayment>(`/square/payments/${id}/refund`, { method: 'POST' })
}

export function sendSquarePosCallback(payload: {
  payment_id: number
  transaction_id: string | null
  client_transaction_id: string | null
  error_code: string | null
}): Promise<SquarePayment> {
  return request<SquarePayment>('/square/pos-callback', { method: 'POST', body: JSON.stringify(payload) })
}

/** Refund a Square-paid sale in Square, then void it. Nothing is voided if the refund fails. */
export function refundAndVoidOrder(saleId: number, orderId: number): Promise<OrderRead> {
  return request<OrderRead>(`/sales/${saleId}/orders/${orderId}/refund-and-void`, { method: 'POST' })
}

/** Fake Square only (local development): pretend the customer paid. */
export function fakeSquarePay(id: number): Promise<{ ok: boolean; transaction_id?: string }> {
  return request<{ ok: boolean; transaction_id?: string }>(`/square/fake/payments/${id}/pay`, { method: 'POST' })
}

export function newClientKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID().replace(/-/g, '')
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`
}

/** The end of a Square payment id, for showing the cashier ("…1234"). */
export function lastFour(id: string | null | undefined): string {
  return id ? `…${id.slice(-4)}` : ''
}
