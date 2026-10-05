"""FastAPI application entrypoint for MuffinES."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

from datetime import datetime, timezone

from fastapi import Depends, FastAPI, File, Form, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, update
from sqlmodel import Session, select

from backend.config.database import close_db, database, get_db
from backend.config.settings import get_logger, get_settings
from backend.core.models import Category, Item, ItemGalleryPhoto, ItemPhoto, Sale, Task
from backend.core.pricing import (
    PricingConfigurationError,
    PricingEstimateService,
    PricingServiceError,
)
from backend.core.reporting import build_sale_summary, build_workspace_response
from backend.core.schemas import (
    BulkItemUpdate,
    CategoryCreate,
    CategoryRead,
    CategoryUpdate,
    DashboardResponse,
    ItemCreate,
    ItemPhotoRead,
    PricingEstimateResponse,
    ItemQuantityIncrement,
    ItemRead,
    ItemUpdate,
    ItemWithSale,
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

ALLOWED_PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}
MAX_ITEM_PHOTO_BYTES = 1024 * 1024
MAX_PHOTOS_PER_ITEM = 12


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Initialize and close backend resources."""

    database.create_tables()
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


def _parse_category_names(raw_value: str) -> list[str]:
    """Parse a JSON array (or comma-separated list) of category names from a form field."""

    if not raw_value.strip():
        return []
    try:
        parsed = json.loads(raw_value)
    except json.JSONDecodeError:
        parsed = raw_value.split(",")
    if not isinstance(parsed, list):
        return []
    return [str(name).strip() for name in parsed if str(name).strip()]


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


def photo_version_for(updated_at: datetime) -> str:
    """Turn a photo timestamp into a short cache-busting version string."""

    return updated_at.strftime("%Y%m%d%H%M%S%f")


def load_photo_versions(session: Session, item_ids: list[int]) -> dict[int, str]:
    """Return photo versions for the given items in a single query."""

    if not item_ids:
        return {}
    rows = session.exec(
        select(ItemPhoto.item_id, ItemPhoto.updated_at).where(ItemPhoto.item_id.in_(item_ids))
    ).all()
    return {item_id: photo_version_for(updated_at) for item_id, updated_at in rows}


def load_photo_fields(session: Session, item_ids: list[int]) -> dict[int, dict[str, object]]:
    """Return `photo_version` and `photo_count` per item in two queries total."""

    if not item_ids:
        return {}
    versions = load_photo_versions(session, item_ids)
    extra_counts = dict(
        session.exec(
            select(ItemGalleryPhoto.item_id, func.count(ItemGalleryPhoto.id))
            .where(ItemGalleryPhoto.item_id.in_(item_ids))
            .group_by(ItemGalleryPhoto.item_id)
        ).all()
    )
    return {
        item_id: {
            "photo_version": versions.get(item_id),
            "photo_count": (1 if item_id in versions else 0) + int(extra_counts.get(item_id, 0)),
        }
        for item_id in item_ids
    }


def build_item_read(session: Session, item: Item) -> ItemRead:
    """Serialize one item including its stored photo version and count."""

    fields = load_photo_fields(session, [item.id]) if item.id is not None else {}
    return ItemRead.model_validate(item, update=fields.get(item.id, {}))


def read_valid_photo_bytes(photo: UploadFile) -> bytes:
    """Validate an uploaded item photo and return its bytes (clear errors otherwise)."""

    if photo.content_type not in ALLOWED_PHOTO_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Please upload a JPG, PNG, or WEBP image.",
        )
    image_bytes = photo.file.read(MAX_ITEM_PHOTO_BYTES + 1)
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image was empty.")
    if len(image_bytes) > MAX_ITEM_PHOTO_BYTES:
        raise HTTPException(
            status_code=413,
            detail="That photo is too large to save. Please use a photo under 1 MB.",
        )
    return image_bytes


def load_gallery_photos(session: Session, item_id: int) -> list[ItemGalleryPhoto]:
    """Return an item's extra photos in display order."""

    return list(
        session.exec(
            select(ItemGalleryPhoto)
            .where(ItemGalleryPhoto.item_id == item_id)
            .order_by(ItemGalleryPhoto.position, ItemGalleryPhoto.id)
        ).all()
    )


def promote_first_gallery_photo(session: Session, item_id: int) -> None:
    """Move the first extra photo into the main slot (the caller commits).

    Runs in the same transaction as removing the main photo, so an item never
    silently loses a photo if the request is interrupted.
    """

    gallery = load_gallery_photos(session, item_id)
    if not gallery:
        return
    first = gallery[0]
    session.add(
        ItemPhoto(
            item_id=item_id,
            content_type=first.content_type,
            data=first.data,
            updated_at=datetime.now(timezone.utc),
        )
    )
    session.delete(first)


@app.get("/")
def read_root() -> dict[str, str]:
    """Return a lightweight API greeting."""

    return {"message": "MuffinES backend is running."}


@app.get(f"{SETTINGS.api_prefix}/health")
def read_health() -> dict[str, str]:
    """Return a simple health response."""

    return {"status": "ok"}


@app.post(
    f"{SETTINGS.api_prefix}/pricing/estimate",
    response_model=PricingEstimateResponse,
)
def estimate_item_price(
    photo: UploadFile = File(...),
    category_hint: str = Form(default=""),
    room_hint: str = Form(default=""),
    notes: str = Form(default=""),
    follow_up_answers: str = Form(default=""),
    categories: str = Form(default=""),
) -> PricingEstimateResponse:
    """Estimate an item price and form details from a photo.

    Runs as a sync route so the blocking OpenAI call happens in the threadpool.
    `categories` is an optional JSON array of the sale's category names.
    """

    if photo.content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(
            status_code=400,
            detail="Please upload a JPG, PNG, or WEBP image.",
        )

    image_bytes = photo.file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded image was empty.")

    try:
        pricing_service = PricingEstimateService.from_settings()
        return pricing_service.estimate_from_image(
            image_bytes=image_bytes,
            media_type=photo.content_type,
            category_hint=category_hint,
            room_hint=room_hint,
            notes=notes,
            follow_up_answers=follow_up_answers,
            categories=_parse_category_names(categories),
        )
    except PricingConfigurationError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except PricingServiceError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=502, detail=str(error)) from error


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
    photo_fields = load_photo_fields(session, [item.id for item in items if item.id is not None])
    return build_workspace_response(sale, categories, items, tasks, photo_fields)


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


@app.get(f"{SETTINGS.api_prefix}/items", response_model=list[ItemWithSale])
def read_all_items(session: Session = Depends(get_db)) -> list[ItemWithSale]:
    """Return every item across all sales, newest first, in two queries (no photo bytes)."""

    rows = session.exec(
        select(Item, Sale.title, Category.name)
        .join(Sale, Item.sale_id == Sale.id)
        .outerjoin(Category, Item.category_id == Category.id)
        .order_by(Item.created_at.desc(), Item.id.desc())
    ).all()
    photo_fields = load_photo_fields(session, [item.id for item, _, _ in rows if item.id is not None])
    return [
        ItemWithSale.model_validate(
            item,
            update={
                **photo_fields.get(item.id, {}),
                "sale_title": sale_title,
                "category_name": category_name,
            },
        )
        for item, sale_title, category_name in rows
    ]


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
    return build_item_read(session, item)


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
    return build_item_read(session, item)


@app.post(f"{SETTINGS.api_prefix}/items/{{item_id}}/quantity/increment", response_model=ItemRead)
def increment_item_quantity(
    item_id: int,
    payload: ItemQuantityIncrement,
    session: Session = Depends(get_db),
) -> ItemRead:
    """Add more of an already-listed item without touching its other fields.

    Done as one `quantity = quantity + amount` UPDATE so concurrent taps or a
    stale browser copy of the item can never overwrite other changes.
    """

    get_item_or_404(session, item_id)
    session.exec(
        update(Item).where(Item.id == item_id).values(quantity=Item.quantity + payload.amount)
    )
    session.commit()
    item = get_item_or_404(session, item_id)
    session.refresh(item)
    return build_item_read(session, item)


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
    photo_fields = load_photo_fields(session, [item.id for item in updated_items if item.id is not None])
    return [
        ItemRead.model_validate(item, update=photo_fields.get(item.id, {}))
        for item in updated_items
    ]


@app.put(f"{SETTINGS.api_prefix}/items/{{item_id}}/photo", response_model=ItemRead)
def upload_item_photo(
    item_id: int,
    photo: UploadFile = File(...),
    session: Session = Depends(get_db),
) -> ItemRead:
    """Store (or replace) the small thumbnail photo for an item."""

    item = get_item_or_404(session, item_id)
    image_bytes = read_valid_photo_bytes(photo)

    item_photo = session.get(ItemPhoto, item_id)
    if item_photo is None:
        item_photo = ItemPhoto(item_id=item_id, content_type=photo.content_type, data=image_bytes)
    else:
        item_photo.content_type = photo.content_type
        item_photo.data = image_bytes
        item_photo.updated_at = datetime.now(timezone.utc)
    session.add(item_photo)
    session.commit()
    return build_item_read(session, item)


@app.get(f"{SETTINGS.api_prefix}/items/{{item_id}}/photo")
def read_item_photo(item_id: int, session: Session = Depends(get_db)) -> Response:
    """Return the stored photo bytes for an item."""

    item_photo = session.get(ItemPhoto, item_id)
    if item_photo is None:
        raise HTTPException(status_code=404, detail="This item has no saved photo.")
    # The URL carries a ?v=<photo_version> cache buster, so a long cache is safe.
    return Response(
        content=item_photo.data,
        media_type=item_photo.content_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@app.delete(f"{SETTINGS.api_prefix}/items/{{item_id}}/photo", response_model=ItemRead)
def delete_item_photo(item_id: int, session: Session = Depends(get_db)) -> ItemRead:
    """Remove the main photo for an item; its next photo (if any) becomes the main one."""

    item = get_item_or_404(session, item_id)
    item_photo = session.get(ItemPhoto, item_id)
    if item_photo is not None:
        session.delete(item_photo)
        session.flush()
        promote_first_gallery_photo(session, item_id)
        session.commit()
    return build_item_read(session, item)


@app.get(f"{SETTINGS.api_prefix}/items/{{item_id}}/photos", response_model=list[ItemPhotoRead])
def list_item_photos(item_id: int, session: Session = Depends(get_db)) -> list[ItemPhotoRead]:
    """List an item's photos (main first) without any image bytes."""

    get_item_or_404(session, item_id)
    photos: list[ItemPhotoRead] = []
    main_rows = session.exec(select(ItemPhoto.updated_at).where(ItemPhoto.item_id == item_id)).all()
    for updated_at in main_rows:
        photos.append(ItemPhotoRead(id=None, is_main=True, version=photo_version_for(updated_at)))
    gallery_rows = session.exec(
        select(ItemGalleryPhoto.id, ItemGalleryPhoto.updated_at)
        .where(ItemGalleryPhoto.item_id == item_id)
        .order_by(ItemGalleryPhoto.position, ItemGalleryPhoto.id)
    ).all()
    for photo_id, updated_at in gallery_rows:
        photos.append(ItemPhotoRead(id=photo_id, is_main=False, version=photo_version_for(updated_at)))
    return photos


@app.post(f"{SETTINGS.api_prefix}/items/{{item_id}}/photos", response_model=ItemRead)
def add_item_photo(
    item_id: int,
    photo: UploadFile = File(...),
    session: Session = Depends(get_db),
) -> ItemRead:
    """Add one more photo to an item; an item's first photo becomes its main photo."""

    item = get_item_or_404(session, item_id)
    image_bytes = read_valid_photo_bytes(photo)
    fields = load_photo_fields(session, [item_id])[item_id]
    if int(fields["photo_count"]) >= MAX_PHOTOS_PER_ITEM:
        raise HTTPException(
            status_code=400,
            detail=f"This item already has {MAX_PHOTOS_PER_ITEM} photos. Remove one to add another.",
        )
    if fields["photo_version"] is None:
        session.add(ItemPhoto(item_id=item_id, content_type=photo.content_type, data=image_bytes))
    else:
        last_position = session.exec(
            select(func.max(ItemGalleryPhoto.position)).where(ItemGalleryPhoto.item_id == item_id)
        ).one()
        session.add(
            ItemGalleryPhoto(
                item_id=item_id,
                content_type=photo.content_type,
                data=image_bytes,
                position=(last_position or 0) + 1,
            )
        )
    session.commit()
    return build_item_read(session, item)


def get_gallery_photo_or_404(session: Session, item_id: int, photo_id: int) -> ItemGalleryPhoto:
    """Return one extra photo of an item or raise a 404."""

    gallery_photo = session.get(ItemGalleryPhoto, photo_id)
    if gallery_photo is None or gallery_photo.item_id != item_id:
        raise HTTPException(status_code=404, detail="That photo was not found.")
    return gallery_photo


@app.get(f"{SETTINGS.api_prefix}/items/{{item_id}}/photos/{{photo_id}}")
def read_gallery_photo(item_id: int, photo_id: int, session: Session = Depends(get_db)) -> Response:
    """Return the bytes of one extra item photo."""

    gallery_photo = get_gallery_photo_or_404(session, item_id, photo_id)
    # The URL carries a ?v=<version> cache buster, so a long cache is safe.
    return Response(
        content=gallery_photo.data,
        media_type=gallery_photo.content_type,
        headers={"Cache-Control": "private, max-age=31536000, immutable"},
    )


@app.delete(f"{SETTINGS.api_prefix}/items/{{item_id}}/photos/{{photo_id}}", response_model=ItemRead)
def delete_gallery_photo(item_id: int, photo_id: int, session: Session = Depends(get_db)) -> ItemRead:
    """Remove one extra item photo (the main photo is removed via `/photo`)."""

    item = get_item_or_404(session, item_id)
    session.delete(get_gallery_photo_or_404(session, item_id, photo_id))
    session.commit()
    return build_item_read(session, item)


@app.post(f"{SETTINGS.api_prefix}/items/{{item_id}}/photos/{{photo_id}}/main", response_model=ItemRead)
def set_main_item_photo(item_id: int, photo_id: int, session: Session = Depends(get_db)) -> ItemRead:
    """Make an extra photo the main one by swapping it with the current main photo.

    Both rows change in one transaction, so an interruption leaves either the
    old or the new arrangement, never a lost or duplicated photo.
    """

    item = get_item_or_404(session, item_id)
    gallery_photo = get_gallery_photo_or_404(session, item_id, photo_id)
    now = datetime.now(timezone.utc)
    main_photo = session.get(ItemPhoto, item_id)
    if main_photo is None:
        session.add(
            ItemPhoto(
                item_id=item_id,
                content_type=gallery_photo.content_type,
                data=gallery_photo.data,
                updated_at=now,
            )
        )
        session.delete(gallery_photo)
    else:
        old_type, old_data = main_photo.content_type, main_photo.data
        main_photo.content_type, main_photo.data = gallery_photo.content_type, gallery_photo.data
        main_photo.updated_at = now
        gallery_photo.content_type, gallery_photo.data = old_type, old_data
        gallery_photo.updated_at = now
        session.add(main_photo)
        session.add(gallery_photo)
    session.commit()
    return build_item_read(session, item)


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
