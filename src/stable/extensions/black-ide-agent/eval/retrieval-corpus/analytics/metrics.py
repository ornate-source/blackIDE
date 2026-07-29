"""Business metrics computed over the orders table.

Every function here takes an explicit date window. A metric with an implicit
"since forever" window is the fastest way to a dashboard that silently drifts as
the table grows.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Iterable, Sequence


@dataclass(frozen=True)
class Window:
    start: date
    end: date

    def days(self) -> int:
        return (self.end - self.start).days + 1

    @staticmethod
    def trailing(days: int, ending: date | None = None) -> "Window":
        end = ending or date.today()
        return Window(start=end - timedelta(days=days - 1), end=end)


def conversion_rate(sessions: int, orders_placed: int) -> float:
    """Fraction of sessions that ended in a placed order.

    Returns 0.0 rather than raising on a zero-session window: a quiet hour is not
    an error, and a dashboard that 500s at 4am wakes somebody up for nothing.
    """
    if sessions <= 0:
        return 0.0
    return orders_placed / sessions


def average_order_value_minor(order_totals_minor: Sequence[int]) -> int:
    """Mean order value, rounded to whole minor units (half away from zero)."""
    if not order_totals_minor:
        return 0
    total = sum(order_totals_minor)
    return int(round(total / len(order_totals_minor)))


def refund_rate(orders_placed: int, orders_refunded: int) -> float:
    if orders_placed <= 0:
        return 0.0
    return orders_refunded / orders_placed


def cohort_retention(first_orders: dict[str, date], repeat_orders: Iterable[tuple[str, date]],
                     window: Window) -> float:
    """Share of the window's new customers who ordered again inside the window."""
    cohort = {uid for uid, d in first_orders.items() if window.start <= d <= window.end}
    if not cohort:
        return 0.0
    returned = {uid for uid, d in repeat_orders if uid in cohort and window.start <= d <= window.end}
    return len(returned) / len(cohort)
