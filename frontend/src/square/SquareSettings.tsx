import { useCallback, useEffect, useState } from 'react'
import { getSquareStatus, pairSquareDevice, removeSquareDevice } from './api'
import type { SquareStatus } from './api'
import { posCallbackUrl } from './posLink'

/** Square payments setup: connection check, Terminal pairing, and what to set up in Square. */
export function SquareSettings() {
  const [status, setStatus] = useState<SquareStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('Square Terminal')

  const load = useCallback(async (): Promise<void> => {
    try {
      setStatus(await getSquareStatus())
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Could not check Square.')
    }
  }, [])

  useEffect(() => {
    let alive = true
    getSquareStatus()
      .then((loaded) => alive && setStatus(loaded))
      .catch((loadError: unknown) => alive && setError(loadError instanceof Error ? loadError.message : 'Could not check Square.'))
    return () => {
      alive = false
    }
  }, [])

  const waitingCode = status?.devices.some((device) => !device.paired && device.code_status === 'UNPAIRED') ?? false

  // While a pairing code is waiting to be typed in, check every few seconds.
  useEffect(() => {
    if (!waitingCode) {
      return
    }
    const timer = window.setInterval(() => void load(), 4000)
    return () => window.clearInterval(timer)
  }, [waitingCode, load])

  async function pair(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await pairSquareDevice(name.trim() || 'Square Terminal')
      await load()
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : 'Could not get a pairing code.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(id: number, label: string): Promise<void> {
    if (!window.confirm(`Remove "${label}" from this app?`)) {
      return
    }
    setBusy(true)
    try {
      await removeSquareDevice(id)
      await load()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Could not remove the Terminal.')
    } finally {
      setBusy(false)
    }
  }

  const connected = Boolean(status?.connected)

  return (
    <section className="surface square-settings" aria-labelledby="square-settings-title">
      <div className="section-heading">
        <h2 id="square-settings-title">Square payments</h2>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void load()}>
          Check again
        </button>
      </div>

      {status === null && !error ? <p className="empty-copy">Checking Square…</p> : null}
      {status ? (
        <div className={`square-connection ${connected ? 'is-on' : 'is-off'}`} role="status">
          <strong>{connected ? 'Connected to Square' : 'Not connected'}</strong>
          {connected ? (
            <span>
              Location: {status.location_name || 'unnamed'} · {status.environment === 'sandbox' ? 'Sandbox (test money)' : 'Live payments'}
              {status.fake ? ' · fake Square for testing' : ''}
            </span>
          ) : (
            <span>{status.error || "Square isn't connected yet — ask Saar."}</span>
          )}
        </div>
      ) : null}
      {error ? (
        <p className="notice error" role="alert">
          {error}
        </p>
      ) : null}

      {connected && status ? (
        <>
          <h3>Square Terminal</h3>
          <p className="hint-copy">
            Pair a Terminal once. On the Terminal: Settings → Device → Pair for Terminal API (sign out of Point of
            Sale first if asked), then type the code shown here.
          </p>
          {status.devices.length ? (
            <ul className="square-devices">
              {status.devices.map((device) => (
                <li key={device.id}>
                  <div>
                    <strong>{device.name}</strong>
                    {device.paired ? (
                      <span>Paired</span>
                    ) : device.code_status === 'UNPAIRED' ? (
                      <span>
                        Type this code on the Terminal: <code className="square-code">{device.code}</code>
                      </span>
                    ) : (
                      <span>Code {device.code_status.toLowerCase()}. Remove it and get a new one.</span>
                    )}
                  </div>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy}
                    onClick={() => void remove(device.id, device.name)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-copy">No Terminal paired yet.</p>
          )}
          <div className="square-pair">
            <label>
              Name
              <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
            </label>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void pair()}>
              Pair a Terminal
            </button>
          </div>

          <h3>Square app on this phone or tablet</h3>
          {status.application_id ? (
            <p className="hint-copy">Ready. When charging, pick “Square app on this tablet”.</p>
          ) : (
            <p className="hint-copy">Not set up yet: needs the Square Application ID (ask Saar).</p>
          )}
          <p className="hint-copy">
            In the Square Developer Dashboard, open this app → Point of Sale API, and add this Web callback URL:
          </p>
          <p>
            <code className="square-url">{posCallbackUrl()}</code>
          </p>

          <h3>Payment link</h3>
          <p className="hint-copy">Always available: the customer pays on their own phone with a Square link.</p>
        </>
      ) : null}

      {status && !connected ? (
        <div className="square-help">
          <h3>Setting up Square</h3>
          <ol>
            <li>Saar adds the Square access token to the app (SQUARE_ACCESS_TOKEN).</li>
            <li>For the Square app option he also adds the Application ID (SQUARE_APPLICATION_ID).</li>
            <li>
              In the Square Developer Dashboard → Point of Sale API, add the Web callback URL{' '}
              <code className="square-url">{posCallbackUrl()}</code>
            </li>
            <li>Come back here and press “Check again”, then pair a Terminal if you have one.</li>
          </ol>
          <p className="hint-copy">Until then, pick Card, Cash or another method when selling.</p>
        </div>
      ) : null}
    </section>
  )
}
