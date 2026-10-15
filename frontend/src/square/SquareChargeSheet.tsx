import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ApiError } from '../api'
import { formatMoney } from '../format'
import type { CheckoutPayload } from '../types'
import {
  cancelSquarePayment,
  fakeSquarePay,
  getSquarePayment,
  getSquareStatus,
  lastFour,
  newClientKey,
  refundSquarePayment,
  sendSquarePosCallback,
  startSquareCharge,
} from './api'
import type { SquareKind, SquarePayment, SquareStatus } from './api'
import { buildPosUrl, clearSquareCallback, detectPlatform, posCallbackUrl, rememberPendingPos } from './posLink'
import type { PosCallback } from './posLink'

const LAST_DEVICE_KEY = 'muffines-square-device'
const POLL_MS = 2000

function readLastDevice(): number | null {
  try {
    return Number(window.localStorage.getItem(LAST_DEVICE_KEY)) || null
  } catch {
    return null
  }
}

function writeLastDevice(id: number): void {
  try {
    window.localStorage.setItem(LAST_DEVICE_KEY, String(id))
  } catch {
    // Not remembered; the first paired Terminal is picked next time.
  }
}

interface SquareChargeSheetProps {
  saleId: number
  total: number
  itemCount: number
  buildPayload: () => CheckoutPayload
  /** The Square app just sent the browser back: finish that charge instead of starting one. */
  resume: PosCallback | null
  onCompleted: (payment: SquarePayment) => void
  /** Items in the cart can no longer be sold (409 before any money was taken). */
  onUnavailable: (error: ApiError) => void
  onClose: () => void
}

function terminalLine(status: string): string {
  if (status === 'IN_PROGRESS') {
    return 'The customer is paying on the Terminal…'
  }
  if (status === 'CANCEL_REQUESTED') {
    return 'Canceling on the Terminal…'
  }
  return 'Sent to the Terminal. Ask the customer to tap, insert or swipe their card.'
}

/**
 * "Charge with Square": pick how (Terminal, the Square app on this device, or a
 * payment link), then follow the charge live. The sale is only recorded by the
 * server once Square confirms the money.
 */
export function SquareChargeSheet({
  saleId,
  total,
  itemCount,
  buildPayload,
  resume,
  onCompleted,
  onUnavailable,
  onClose,
}: SquareChargeSheetProps) {
  const [status, setStatus] = useState<SquareStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<number | null>(readLastDevice)
  const [payment, setPayment] = useState<SquarePayment | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pollTrouble, setPollTrouble] = useState(false)
  const [copied, setCopied] = useState(false)
  const [verifying, setVerifying] = useState(resume !== null)
  const clientKey = useRef(newClientKey())
  const completedRef = useRef(false)
  const platform = detectPlatform()

  useEffect(() => {
    let alive = true
    getSquareStatus()
      .then((loaded) => {
        if (alive) {
          setStatus(loaded)
        }
      })
      .catch((loadError: unknown) => {
        if (alive) {
          setStatusError(loadError instanceof Error ? loadError.message : 'Could not check Square.')
        }
      })
    return () => {
      alive = false
    }
  }, [])

  // Back from the Square app: verify that charge on the server.
  useEffect(() => {
    if (!resume || resume.paymentId === null) {
      return
    }
    let alive = true
    sendSquarePosCallback({
      payment_id: resume.paymentId,
      transaction_id: resume.transactionId,
      client_transaction_id: resume.clientTransactionId,
      error_code: resume.errorCode,
    })
      .then((result) => {
        clearSquareCallback()
        if (alive) {
          setPayment(result)
        }
      })
      .catch((callbackError: unknown) => {
        if (alive) {
          setError(callbackError instanceof Error ? callbackError.message : 'Could not check the payment with Square.')
        }
      })
      .finally(() => {
        if (alive) {
          setVerifying(false)
        }
      })
    return () => {
      alive = false
    }
  }, [resume])

  const pending = payment?.status === 'pending'
  const paymentId = payment?.id ?? null
  const kind = payment?.kind ?? null

  // Follow a Terminal or payment-link charge until Square says how it ended.
  useEffect(() => {
    if (!pending || paymentId === null || kind === 'pos_app') {
      return
    }
    let alive = true
    let inFlight = false
    const timer = window.setInterval(() => {
      if (inFlight) {
        return
      }
      inFlight = true
      getSquarePayment(paymentId)
        .then((next) => {
          if (alive) {
            setPollTrouble(false)
            setPayment(next)
          }
        })
        .catch(() => {
          if (alive) {
            setPollTrouble(true)
          }
        })
        .finally(() => {
          inFlight = false
        })
    }, POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [pending, paymentId, kind])

  useEffect(() => {
    if (payment?.status === 'completed' && payment.order && !completedRef.current) {
      completedRef.current = true
      onCompleted(payment)
    }
  }, [payment, onCompleted])

  const pairedDevices = (status?.devices ?? []).filter((device) => device.paired)
  const chosenDevice = pairedDevices.find((device) => device.id === deviceId) ?? pairedDevices[0] ?? null
  const posAvailable = Boolean(status?.application_id) && (platform !== null || Boolean(status?.fake))

  function openSquareApp(started: SquarePayment): void {
    if (status?.fake) {
      // Fake Square: pretend the app took the card and came back with an answer.
      void fakeSquarePay(started.id).then((result) => {
        const data = JSON.stringify({ status: 'ok', transaction_id: result.transaction_id, state: String(started.id) })
        window.location.assign(`${posCallbackUrl()}?data=${encodeURIComponent(data)}`)
      })
      return
    }
    if (!platform) {
      return
    }
    window.location.assign(
      buildPosUrl(platform, {
        amountCents: started.amount_cents,
        currency: started.currency,
        applicationId: started.application_id,
        callbackUrl: posCallbackUrl(),
        state: String(started.id),
        note: `Muffin Manor sale #${started.id}`,
      }),
    )
  }

  async function start(chosen: SquareKind): Promise<void> {
    if (busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const started = await startSquareCharge(saleId, {
        client_key: clientKey.current,
        kind: chosen,
        device_id: chosen === 'terminal' ? (chosenDevice?.id ?? null) : null,
        checkout: buildPayload(),
      })
      if (chosen === 'terminal' && chosenDevice) {
        writeLastDevice(chosenDevice.id)
      }
      setPayment(started)
      if (chosen === 'pos_app' && started.status === 'pending') {
        rememberPendingPos({ paymentId: started.id, saleId })
        openSquareApp(started)
      }
    } catch (startError) {
      if (startError instanceof ApiError && startError.status === 409 && startError.unavailable.length) {
        onUnavailable(startError)
        return
      }
      setError(startError instanceof Error ? startError.message : 'Square could not start the charge.')
      clientKey.current = newClientKey()
    } finally {
      setBusy(false)
    }
  }

  async function act(action: () => Promise<SquarePayment>, fallback: string): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setPayment(await action())
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : fallback)
    } finally {
      setBusy(false)
    }
  }

  function tryAgain(): void {
    clientKey.current = newClientKey()
    completedRef.current = false
    setPayment(null)
    setError(null)
  }

  async function copyLink(url: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      window.prompt('Copy this payment link:', url)
    }
  }

  const amountText = formatMoney(payment?.amount ?? total)
  const canClose = !pending && !busy && !verifying

  let body: ReactNode
  if (verifying) {
    body = <p className="square-live" role="status">Checking the payment with Square…</p>
  } else if (!payment) {
    if (!status && !statusError) {
      body = <p className="square-live">Checking the Square connection…</p>
    } else if (statusError || !status?.configured || !status.connected) {
      body = (
        <p className="notice error" role="alert">
          {statusError ?? status?.error ?? "Square isn't connected yet — ask Saar."}
        </p>
      )
    } else {
      body = (
        <div className="square-options">
          <div className="square-option">
            <div>
              <strong>Square Terminal</strong>
              <span>The customer pays on the Terminal device.</span>
            </div>
            {pairedDevices.length ? (
              <>
                {pairedDevices.length > 1 ? (
                  <select
                    aria-label="Terminal"
                    value={chosenDevice?.id ?? ''}
                    onChange={(event) => setDeviceId(Number(event.target.value))}
                  >
                    {pairedDevices.map((device) => (
                      <option key={device.id} value={device.id}>
                        {device.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button type="button" className="primary-button" disabled={busy} onClick={() => void start('terminal')}>
                  Charge on {chosenDevice?.name ?? 'Terminal'}
                </button>
              </>
            ) : (
              <span className="hint-copy">No Terminal paired yet. Pair one under More → Square payments.</span>
            )}
          </div>
          {posAvailable ? (
            <div className="square-option">
              <div>
                <strong>Square app on this {platform === 'android' ? 'device' : 'tablet'}</strong>
                <span>Opens Square Point of Sale, then comes back here.</span>
              </div>
              <button type="button" className="primary-button" disabled={busy} onClick={() => void start('pos_app')}>
                Open Square app
              </button>
            </div>
          ) : null}
          <div className="square-option">
            <div>
              <strong>Payment link</strong>
              <span>The customer pays on their own phone.</span>
            </div>
            <button type="button" className="secondary-button" disabled={busy} onClick={() => void start('payment_link')}>
              Make a payment link
            </button>
          </div>
        </div>
      )
    }
  } else if (payment.status === 'pending') {
    body = (
      <div className="square-working">
        {payment.kind === 'terminal' ? <p className="square-live" role="status">{terminalLine(payment.square_status)}</p> : null}
        {payment.kind === 'payment_link' && payment.link_url ? (
          <>
            <p className="square-live" role="status">Waiting for the customer to pay with this link…</p>
            <a className="square-link" href={payment.link_url} target="_blank" rel="noreferrer">
              {payment.link_url}
            </a>
            <div className="checkout-actions">
              <button type="button" className="secondary-button" onClick={() => void copyLink(payment.link_url ?? '')}>
                {copied ? 'Copied' : 'Copy link'}
              </button>
              {typeof navigator.share === 'function' ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void navigator.share({ title: 'Pay Muffin Manor', url: payment.link_url ?? '' }).catch(() => undefined)}
                >
                  Send link…
                </button>
              ) : null}
            </div>
          </>
        ) : null}
        {payment.kind === 'pos_app' ? (
          <>
            <p className="square-live" role="status">Finish the payment in the Square app. This page updates when it comes back.</p>
            <button type="button" className="secondary-button" onClick={() => openSquareApp(payment)}>
              Open Square app again
            </button>
          </>
        ) : null}
        {pollTrouble ? <p className="hint-copy">Can't reach the server right now. Still trying…</p> : null}
        {status?.fake ? (
          <button
            type="button"
            className="secondary-button"
            onClick={() => void fakeSquarePay(payment.id).then(() => getSquarePayment(payment.id)).then(setPayment)}
          >
            Simulate the customer paying (fake Square)
          </button>
        ) : null}
        <button
          type="button"
          className="secondary-button danger-button"
          disabled={busy}
          onClick={() => void act(() => cancelSquarePayment(payment.id), 'Could not cancel the charge.')}
        >
          Cancel charge
        </button>
      </div>
    )
  } else if (payment.status === 'completed') {
    body = <p className="square-live" role="status">Paid with Square {lastFour(payment.square_payment_id)}</p>
  } else if (payment.status === 'conflict') {
    body = (
      <div className="square-conflict" role="alert">
        <strong>Square took the money, but the sale was not recorded.</strong>
        <p>{payment.message}</p>
        <button
          type="button"
          className="primary-button danger-button"
          disabled={busy}
          onClick={() => void act(() => refundSquarePayment(payment.id), 'The refund failed. Refund it in the Square app.')}
        >
          Refund {amountText} in Square
        </button>
      </div>
    )
  } else {
    body = (
      <div className="square-working">
        <p className={payment.status === 'refunded' ? 'square-live' : 'notice error'} role="alert">
          {payment.message || (payment.status === 'canceled' ? 'Canceled. Nothing was charged.' : 'The payment did not go through.')}
        </p>
        {payment.status === 'failed' && payment.square_payment_id ? (
          <button
            type="button"
            className="secondary-button danger-button"
            disabled={busy}
            onClick={() => void act(() => refundSquarePayment(payment.id), 'The refund failed. Refund it in the Square app.')}
          >
            Refund {amountText} in Square
          </button>
        ) : null}
        {payment.status !== 'refunded' ? (
          <button type="button" className="primary-button" onClick={tryAgain}>
            Try again
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="modal-backdrop" onClick={() => (canClose ? onClose() : undefined)}>
      <div
        className="modal-card square-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="square-sheet-title"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && canClose) {
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <div className="square-sheet-heading">
          <h3 id="square-sheet-title">Charge {amountText} with Square</h3>
          {itemCount ? <p className="hint-copy">{itemCount === 1 ? '1 item' : `${itemCount} items`}{status?.fake ? ' · fake Square (testing)' : ''}</p> : null}
        </div>
        {body}
        {error ? (
          <p className="notice error" role="alert">
            {error}
          </p>
        ) : null}
        {canClose ? (
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        ) : null}
      </div>
    </div>
  )
}
