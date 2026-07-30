"""Revenue reporting.

Every figure here is in minor units of the reporting currency, converted once at
the rate that applied on the order's own day. Reconverting historical revenue at
today's rate makes last quarter's numbers change overnight, which finance will
notice before you do.
"""

from dataclasses import dataclass
from datetime import date

from .db import connect
from .metrics import Window


@dataclass(frozen=True)
class RevenueRow:
    day: date
    gross_minor: int
    refunds_minor: int
    currency: str

    @property
    def net_minor(self) -> int:
        return self.gross_minor - self.refunds_minor


def gross_revenue(window: Window, currency: str = "USD") -> list[RevenueRow]:
    """Daily gross and refunded revenue over the window."""
    with connect() as conn:
        rows = conn.query(
            """
            SELECT placed_on, SUM(total_minor), SUM(refunded_minor)
            FROM orders_reporting
            WHERE placed_on BETWEEN %s AND %s AND reporting_currency = %s
            GROUP BY placed_on ORDER BY placed_on
            """,
            (window.start, window.end, currency),
        )
    return [RevenueRow(day=r[0], gross_minor=r[1], refunds_minor=r[2], currency=currency) for r in rows]


def net_revenue_minor(window: Window, currency: str = "USD") -> int:
    return sum(row.net_minor for row in gross_revenue(window, currency))


def mrr_minor(as_of: date, currency: str = "USD") -> int:
    """Monthly recurring revenue: active subscriptions normalised to a month."""
    with connect() as conn:
        rows = conn.query(
            """
            SELECT interval, SUM(plan_price_minor)
            FROM subscriptions_reporting
            WHERE status IN ('active', 'past_due') AND as_of = %s AND currency = %s
            GROUP BY interval
            """,
            (as_of, currency),
        )
    per_month = {"monthly": 1.0, "quarterly": 1 / 3, "yearly": 1 / 12}
    return int(round(sum(amount * per_month.get(interval, 0) for interval, amount in rows)))
