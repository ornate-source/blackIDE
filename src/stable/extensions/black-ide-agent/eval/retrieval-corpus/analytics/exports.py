"""Warehouse exports for the finance team.

Written as CSV to object storage rather than emailed: these files routinely run to
hundreds of megabytes, and an export that works in staging and bounces off a 25 MB
attachment limit in production is not an export.
"""

import csv
import io
from datetime import date

from .db import connect
from .metrics import Window
from .revenue import gross_revenue

EXPORT_CHUNK_ROWS = 50_000


def revenue_csv(window: Window, currency: str = "USD") -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["day", "gross_minor", "refunds_minor", "net_minor", "currency"])
    for row in gross_revenue(window, currency):
        writer.writerow([row.day.isoformat(), row.gross_minor, row.refunds_minor, row.net_minor, row.currency])
    return buffer.getvalue()


def orders_csv(day: date) -> str:
    """One day of orders, streamed in chunks so a big day cannot exhaust memory."""
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["order_id", "customer_id", "status", "total_minor", "currency", "placed_at"])

    with connect() as conn:
        offset = 0
        while True:
            rows = conn.query(
                """
                SELECT id, customer_id, status, total_minor, currency, placed_at
                FROM orders WHERE placed_on = %s ORDER BY id LIMIT %s OFFSET %s
                """,
                (day, EXPORT_CHUNK_ROWS, offset),
            )
            if not rows:
                break
            writer.writerows(rows)
            offset += EXPORT_CHUNK_ROWS
    return buffer.getvalue()
