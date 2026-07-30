"""Nightly rollup job.

Reads yesterday's raw events, computes the metrics in `metrics.py`, and upserts one
row per day into `daily_rollup`. Idempotent by design: rerunning a day overwrites it
rather than appending, because the job WILL be rerun — after a deploy, after a
backfill, after somebody clicks the retry button twice.
"""

import logging
from datetime import date, timedelta

from .db import connect, upsert_rollup
from .metrics import Window, average_order_value_minor, conversion_rate, refund_rate

log = logging.getLogger(__name__)


def run_daily_rollup(day: date | None = None) -> dict:
    """Computes and stores the rollup for `day` (defaults to yesterday)."""
    target = day or (date.today() - timedelta(days=1))
    window = Window(start=target, end=target)

    with connect() as conn:
        sessions = conn.scalar(
            "SELECT COUNT(*) FROM sessions WHERE started_on = %s", (target,)
        )
        totals = conn.column(
            "SELECT total_minor FROM orders WHERE placed_on = %s AND status <> 'draft'",
            (target,),
        )
        refunded = conn.scalar(
            "SELECT COUNT(*) FROM orders WHERE placed_on = %s AND status = 'refunded'",
            (target,),
        )

    row = {
        "day": target,
        "sessions": sessions,
        "orders_placed": len(totals),
        "conversion_rate": conversion_rate(sessions, len(totals)),
        "aov_minor": average_order_value_minor(totals),
        "refund_rate": refund_rate(len(totals), refunded),
        "window_days": window.days(),
    }

    upsert_rollup(row)
    log.info("rollup for %s: %s orders from %s sessions", target, row["orders_placed"], sessions)
    return row


def backfill(start: date, end: date) -> list[dict]:
    """Reruns the rollup day by day. Sequential on purpose — the warehouse is the
    bottleneck, and eight parallel scans make the whole thing slower, not faster."""
    rows = []
    current = start
    while current <= end:
        rows.append(run_daily_rollup(current))
        current += timedelta(days=1)
    return rows
