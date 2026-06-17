"""Database seeding for first-run experience."""

from __future__ import annotations

from datetime import date, timedelta

from sqlmodel import Session, select

from backend.core.models import Category, Item, ItemStatus, Sale, SaleStatus, Task, TaskStatus


def seed_demo_data(session: Session) -> None:
    """Seed demo content when the database is empty."""

    existing_sale = session.exec(select(Sale.id)).first()
    if existing_sale is not None:
        return

    categories = [
        Category(name="Furniture", color="#8b5cf6", sort_order=1),
        Category(name="Kitchen", color="#f97316", sort_order=2),
        Category(name="Decor", color="#ec4899", sort_order=3),
        Category(name="Tools", color="#0ea5e9", sort_order=4),
        Category(name="Collectibles", color="#10b981", sort_order=5),
        Category(name="Books", color="#f59e0b", sort_order=6),
    ]
    session.add_all(categories)
    session.commit()

    category_lookup = {
        category.name: category.id
        for category in session.exec(select(Category).order_by(Category.sort_order)).all()
    }

    today = date.today()
    sales = [
        Sale(
            title="Willow Creek Estate Sale",
            address="214 Willow Creek Lane, Franklin, TN",
            start_date=today + timedelta(days=10),
            end_date=today + timedelta(days=12),
            status=SaleStatus.READY,
            notes="Three-bedroom home with vintage furniture, kitchenware, and a packed garage.",
        ),
        Sale(
            title="Magnolia Downsizing Sale",
            address="58 Magnolia Drive, Murfreesboro, TN",
            start_date=today + timedelta(days=24),
            end_date=today + timedelta(days=25),
            status=SaleStatus.PLANNING,
            notes="Focus on cataloging decor, books, and holiday storage before pricing the furniture.",
        ),
    ]
    session.add_all(sales)
    session.commit()

    persisted_sales = session.exec(select(Sale).order_by(Sale.start_date)).all()
    sale_lookup = {sale.title: sale.id for sale in persisted_sales}

    items = [
        Item(
            sale_id=sale_lookup["Willow Creek Estate Sale"],
            category_id=category_lookup["Furniture"],
            title="Mid-century walnut dining table",
            description="Seats six with two leaves tucked underneath.",
            room="Dining room",
            condition="Very good",
            price=425.0,
            status=ItemStatus.AVAILABLE,
            notes="Needs a fresh tag and a photo from the window side.",
        ),
        Item(
            sale_id=sale_lookup["Willow Creek Estate Sale"],
            category_id=category_lookup["Kitchen"],
            title="Le Creuset dutch oven set",
            description="Three enamel pieces in flame orange.",
            room="Kitchen",
            condition="Good",
            price=210.0,
            status=ItemStatus.SOLD,
            notes="Sold during preview appointment.",
        ),
        Item(
            sale_id=sale_lookup["Willow Creek Estate Sale"],
            category_id=category_lookup["Tools"],
            title="Craftsman rolling tool chest",
            description="Loaded with assorted hand tools.",
            room="Garage",
            condition="Good",
            price=315.0,
            status=ItemStatus.DISCOUNTED,
            notes="Flag for 15% markdown on day two.",
        ),
        Item(
            sale_id=sale_lookup["Willow Creek Estate Sale"],
            category_id=category_lookup["Decor"],
            title="Pair of brass table lamps",
            description="Working set with pleated shades.",
            room="Living room",
            condition="Fair",
            price=95.0,
            status=ItemStatus.AVAILABLE,
            notes="Replace one harp before staging.",
        ),
        Item(
            sale_id=sale_lookup["Magnolia Downsizing Sale"],
            category_id=category_lookup["Books"],
            title="Vintage gardening reference set",
            description="Twelve hardcover volumes with illustrated plates.",
            room="Study",
            condition="Good",
            price=72.0,
            status=ItemStatus.AVAILABLE,
            notes="Bundle as a full set, do not split.",
        ),
        Item(
            sale_id=sale_lookup["Magnolia Downsizing Sale"],
            category_id=category_lookup["Collectibles"],
            title="Lenox holiday village collection",
            description="Eight porcelain houses with power cords and boxes.",
            room="Bonus room",
            condition="Very good",
            price=360.0,
            status=ItemStatus.RESERVED,
            notes="Reserved for neighbor pickup on Friday morning.",
        ),
    ]
    session.add_all(items)

    tasks = [
        Task(
            sale_id=sale_lookup["Willow Creek Estate Sale"],
            title="Finish garage pricing",
            due_date=today + timedelta(days=4),
            status=TaskStatus.IN_PROGRESS,
            notes="Tools and lawn equipment are the last major section.",
        ),
        Task(
            sale_id=sale_lookup["Willow Creek Estate Sale"],
            title="Print directional signage",
            due_date=today + timedelta(days=7),
            status=TaskStatus.TODO,
            notes="Need driveway arrows and checkout parking signs.",
        ),
        Task(
            sale_id=sale_lookup["Magnolia Downsizing Sale"],
            title="Photograph holiday inventory",
            due_date=today + timedelta(days=15),
            status=TaskStatus.TODO,
            notes="Use brighter lighting than the first pass.",
        ),
    ]
    session.add_all(tasks)
    session.commit()
