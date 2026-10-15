import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { captureSquareCallback } from './square/posLink'

// Back from the Square app: keep its answer and move to the Sale page before the app reads the URL.
captureSquareCallback()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
