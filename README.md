# MuffinES

MuffinES is a responsive estate sale management app for Amanda to manage multiple sales, track inventory, organize categories, stay on top of prep tasks, and review simple reports from one dashboard.

## What it includes

- Multi-sale dashboard with summary metrics
- Sale workspace with overview, items, categories, tasks, and reports
- SQLite-backed FastAPI backend with seeded example data
- React + TypeScript frontend optimized for laptop and tablet use
- Bulk item status updates and CSV export for sale inventory

## Project structure

- `backend/` - FastAPI app, SQLite models, seed data, and tests
- `frontend/` - Vite React app and UI
- `data/` - runtime SQLite database and uploads directory, created automatically

## Run the backend

```powershell
Set-Location C:\Users\saarm\Projects\MuffinES
.\.venv\Scripts\python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

## Run the frontend

```powershell
Set-Location C:\Users\saarm\Projects\MuffinES\frontend
npm run dev
```

The frontend now binds to **`http://127.0.0.1:5173`** by default and proxies `/api` requests to the backend at `http://127.0.0.1:8000` during local development.

## Validation commands

```powershell
Set-Location C:\Users\saarm\Projects\MuffinES
.\.venv\Scripts\python -m pytest backend\tests -q

Set-Location C:\Users\saarm\Projects\MuffinES\frontend
npm run lint
npm run build
```
