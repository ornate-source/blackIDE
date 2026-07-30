"""Cohort construction.

A cohort is defined by the month of a customer's FIRST order, and membership never
changes afterwards. Recomputing cohorts from a rolling window instead is the most
common way these charts end up lying: yesterday's numbers move every night.
"""

from collections import defaultdict
from datetime import date

from .db import connect


def first_order_by_customer(before: date) -> dict[str, date]:
    with connect() as conn:
        rows = conn.query(
            "SELECT customer_id, MIN(placed_on) FROM orders WHERE placed_on < %s GROUP BY customer_id",
            (before,),
        )
    return {customer_id: first for customer_id, first in rows}


def cohort_key(first_order: date) -> str:
    return f"{first_order.year:04d}-{first_order.month:02d}"


def build_cohorts(before: date) -> dict[str, set[str]]:
    cohorts: dict[str, set[str]] = defaultdict(set)
    for customer_id, first in first_order_by_customer(before).items():
        cohorts[cohort_key(first)].add(customer_id)
    return dict(cohorts)


def cohort_sizes(before: date) -> dict[str, int]:
    return {key: len(members) for key, members in build_cohorts(before).items()}


def repeat_purchase_rate(cohort_month: str, before: date) -> float:
    """Share of a cohort that has placed a second order."""
    cohorts = build_cohorts(before)
    members = cohorts.get(cohort_month, set())
    if not members:
        return 0.0
    with connect() as conn:
        rows = conn.query(
            "SELECT customer_id, COUNT(*) FROM orders WHERE placed_on < %s GROUP BY customer_id HAVING COUNT(*) > 1",
            (before,),
        )
    repeaters = {customer_id for customer_id, _ in rows}
    return len(members & repeaters) / len(members)
