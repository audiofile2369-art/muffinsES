"""FastAPI application entrypoint for MuffinES."""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import Session, select

from backend.config.database import close_db, database, get_db
from backend.config.settings import get_logger, get_settings
from backend.core.bootstrap import initialize_database
from backend.core.models import Category, Item, Sale, Task
from backend.core.reporting import build_sale_summary, build_workspace_response
from backend.core.schemas import (
    BulkItemUpdate,
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    DashboardResponse,
    ItemCreate,
    ItemRead,
    ItemUpdate,
    SaleCreate,
    SaleRead,
    SaleUpdate,
    TaskCreate,
    TaskRead,
    TaskUpdate,
    WorkspaceResponse,
)

LOGGER = get_logger(__name__)
SETTINGS = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Initialize and close backend resources."""

    database.create_tables()
    with database.get_session() as session:
        initialize_database(session)
    yield
    close_db()


app = FastAPI(title=SETTINGS.app_name, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=list(SETTINGS.frontend_origins),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def get_sale_or_404(session: Session, sale_id: int) -> Sale:
    """Return a sale or raise a 404 error."""

    sale = session.get(Sale, sale_id)
    if sale is None:
        raise HTTPException(status_code=404, detail="Sale not found.")
    return sale


def get_category_or_404(session: Session, category_id: int) -> Category:
    """Return a category or raise a 404 error."""

    category = session.get(Category, category_id)
    if category is None:
        raise HTTPException(status_code=404, detail="Category not found.")
    return category


def get_item_or_404(session: Session, item_id: int) -> Item:
    """Return an item or raise a 404 error."""

    item = session.get(Item, item_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Item not found.")
    return item


def get_task_or_404(session: Session, task_id: int) -> Task:
    """Return a task or raise a 404 error."""

    task = session.get(Task, task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found.")
    return task


def load_workspace_records(
    session: Session,
    sale_id: int,
) -> tuple[Sale, list[Category], list[Item], list[Task]]:
    """Load the records needed for a workspace view."""

    sale = get_sale_or_404(session, sale_id)
    categories = session.exec(select(Category).order_by(Category.sort_order, Category.name)).all()
    items = session.exec(select(Item).where(Item.sale_id == sale_id).order_by(Item.created_at.desc())).all()
    tasks = session.exec(select(Task).where(Task.sale_id == sale_id).order_by(Task.status, Task.due_date)).all()
    return sale, categories, items, tasks


@app.get("/")
def read_root() -> dict[str, str]:
    """Return a lightweight API greeting."""

    return {"message": "MuffinES backend is running."}


@app.get(f"{SETTINGS.api_prefix}/health")
def read_health() -> dict[str, str]:
    """Return a simple health response."""

    return {"status": "ok"}


@app.get(f"{SETTINGS.api_prefix}/dashboard", response_model=DashboardResponse)
def read_dashboard(session: Session = Depends(get_db)) -> DashboardResponse:
    """Return sale summaries for the dashboard."""

    sales = session.exec(select(Sale).order_by(Sale.start_date)).all()
    summaries = []
    for sale in sales:
        items = session.exec(select(Item).where(Item.sale_id == sale.id)).all()
        tasks = session.exec(select(Task).where(Task.sale_id == sale.id)).all()
        summaries.append(build_sale_summary(sale, items, tasks))
    return DashboardResponse(sales=summaries)


@app.post(f"{SETTINGS.api_prefix}/sales", response_model=SaleRead)
def create_sale(payload: SaleCreate, session: Session = Depends(get_db)) -> SaleRead:
    """Create a new estate sale."""

    sale = Sale.model_validate(payload)
    session.add(sale)
    session.commit()
    session.refresh(sale)
    LOGGER.info("Created sale %s", sale.title)
    return SaleRead.model_validate(sale)


@app.patch(f"{SETTINGS.api_prefix}/sales/{{sale_id}}", response_model=SaleRead)
def update_sale(
    sale_id: int,
    payload: SaleUpdate,
    session: Session = Depends(get_db),
) -> SaleRead:
    """Update an existing sale."""

    sale = get_sale_or_404(session, sale_id)
    updates = payload.model_dump(exclude_unset=True)
    for field_name, value in updates.items():
        setattr(sale, field_name, value)
    session.add(sale)
    session.commit()
    session.refresh(sale)
    return SaleRead.model_validate(sale)


@app.get(f"{SETTINGS.api_prefix}/sales/{{sale_id}}/workspace", response_model=WorkspaceResponse)
def read_workspace(sale_id: int, session: Session = Depends(get_db)) -> WorkspaceResponse:
    """Return the full workspace payload for a sale."""

    sale, categories, items, tasks = load_workspace_records(session, sale_id)
    return build_workspace_response(sale, categories, items, tasks)


@app.get(f"{SETTINGS.api_prefix}/categories", response_model=list[CategoryRead])
def read_categories(session: Session = Depends(get_db)) -> list[CategoryRead]:
    """Return all categories."""

    categories = session.exec(select(Category).order_by(Category.sort_order, Category.name)).all()
    return [CategoryRead.model_validate(category) for category in categories]


@app.post(f"{SETTINGS.api_prefix}/categories", response_model=CategoryRead)
def create_category(
    payload: CategoryCreate,
    session: Session = Depends(get_db),
) -> CategoryRead:
    """Create a new item category."""

    category = Category.model_validate(payload)
    session.add(category)
    session.commit()
    session.refresh(category)
    return CategoryRead.model_validate(category)


@app.patch(f"{SETTINGS.api_prefix}/categories/{{category_id}}", response_model=CategoryRead)
def update_category(
    category_id: int,
    payload: CategoryUpdate,
    session: Session = Depends(get_db),
) -> CategoryRead:
    """Update an item category."""

    category = get_category_or_404(session, category_id)
    updates = payload.model_dump(exclude_unset=True)
    for field_name, value in updates.items():
        setattr(category, field_name, value)
    session.add(category)
    session.commit()
    session.refresh(category)
    return CategoryRead.model_validate(category)


@app.post(f"{SETTINGS.api_prefix}/items", response_model=ItemRead)
def create_item(payload: ItemCreate, session: Session = Depends(get_db)) -> ItemRead:
    """Create a new inventory item."""

    get_sale_or_404(session, payload.sale_id)
    if payload.category_id is not None:
        get_category_or_404(session, payload.category_id)

    item = Item.model_validate(payload)
    session.add(item)
    session.commit()
    session.refresh(item)
    return ItemRead.model_validate(item)


@app.patch(f"{SETTINGS.api_prefix}/items/{{item_id}}", response_model=ItemRead)
def update_item(
    item_id: int,
    payload: ItemUpdate,
    session: Session = Depends(get_db),
) -> ItemRead:
    """Update an inventory item."""

    item = get_item_or_404(session, item_id)
    if payload.category_id is not None:
        get_category_or_404(session, payload.category_id)

    updates = payload.model_dump(exclude_unset=True)
    for field_name, value in updates.items():
        setattr(item, field_name, value)
    session.add(item)
    session.commit()
    session.refresh(item)
    return ItemRead.model_validate(item)


@app.post(f"{SETTINGS.api_prefix}/items/bulk-update", response_model=list[ItemRead])
def bulk_update_items(
    payload: BulkItemUpdate,
    session: Session = Depends(get_db),
) -> list[ItemRead]:
    """Apply a shared update to many items."""

    if payload.category_id is not None:
        get_category_or_404(session, payload.category_id)

    updated_items: list[Item] = []
    for item_id in payload.item_ids:
        item = get_item_or_404(session, item_id)
        if payload.status is not None:
            item.status = payload.status
        if payload.category_id is not None:
            item.category_id = payload.category_id
        session.add(item)
        updated_items.append(item)

    session.commit()
    for item in updated_items:
        session.refresh(item)
    return [ItemRead.model_validate(item) for item in updated_items]


@app.post(f"{SETTINGS.api_prefix}/tasks", response_model=TaskRead)
def create_task(payload: TaskCreate, session: Session = Depends(get_db)) -> TaskRead:
    """Create a new sale preparation task."""

    get_sale_or_404(session, payload.sale_id)
    task = Task.model_validate(payload)
    session.add(task)
    session.commit()
    session.refresh(task)
    return TaskRead.model_validate(task)


@app.patch(f"{SETTINGS.api_prefix}/tasks/{{task_id}}", response_model=TaskRead)
def update_task(
    task_id: int,
    payload: TaskUpdate,
    session: Session = Depends(get_db),
) -> TaskRead:
    """Update a sale preparation task."""

    task = get_task_or_404(session, task_id)
    updates = payload.model_dump(exclude_unset=True)
    for field_name, value in updates.items():
        setattr(task, field_name, value)
    session.add(task)
    session.commit()
    session.refresh(task)
    return TaskRead.model_validate(task)
