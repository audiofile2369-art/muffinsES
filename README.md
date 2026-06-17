# MuffinES

MuffinES is a responsive estate sale management app for Amanda to manage multiple sales, track inventory, organize categories, stay on top of prep tasks, and review simple reports from one dashboard.

## What it includes

- Multi-sale dashboard with summary metrics
- Sale workspace with overview, items, categories, tasks, and reports
- SQLite-backed FastAPI backend
- React + TypeScript frontend optimized for laptop and tablet use
- Bulk item status updates and CSV export for sale inventory

## Project structure

- `backend/` - FastAPI app, SQLite models, initialization helpers, and tests
- `frontend/` - Vite React app and UI
- `data/` - runtime SQLite database and uploads directory, created automatically
- `neon_db.txt` - local-only Neon connection string file for the backend (ignored by Git)
- `open api.txt` - local-only OpenAI API key file for AI pricing (ignored by Git)

## Run the backend

```powershell
Set-Location C:\Users\saarm\Projects\MuffinES
.\.venv\Scripts\python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

The backend now prefers the Neon connection string stored in `neon_db.txt`. If that file is missing, it falls back to local SQLite.

For AI pricing, the backend reads the OpenAI key from `open api.txt` or the `OPENAI_API_KEY` environment variable.

## Run the frontend

```powershell
Set-Location C:\Users\saarm\Projects\MuffinES\frontend
npm run dev
```

The frontend now binds to **`http://127.0.0.1:5173`** by default and proxies `/api` requests to the backend at `http://127.0.0.1:8000` during local development.

## Vercel deployment

- `vercel.json` is configured so Vercel can build the Vite app from the repo root even though the frontend lives in `frontend/`.
- When no `VITE_API_BASE_URL` is configured, the deployed frontend falls back to a **browser storage mode** so the app still works on Vercel without the local backend.
- To use a real hosted backend later, set `VITE_API_BASE_URL` in Vercel to the backend's `/api` base URL.

## Validation commands

```powershell
Set-Location C:\Users\saarm\Projects\MuffinES
.\.venv\Scripts\python -m pytest backend\tests -q

Set-Location C:\Users\saarm\Projects\MuffinES\frontend
npm run lint
npm run build
```
