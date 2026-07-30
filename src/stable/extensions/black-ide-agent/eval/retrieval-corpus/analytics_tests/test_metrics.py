from datetime import date

import pytest

from analytics.metrics import (
    Window,
    average_order_value_minor,
    cohort_retention,
    conversion_rate,
    refund_rate,
)


def test_conversion_rate_of_a_quiet_window_is_zero_not_an_error():
    assert conversion_rate(sessions=0, orders_placed=0) == 0.0


def test_conversion_rate_is_orders_over_sessions():
    assert conversion_rate(sessions=200, orders_placed=15) == pytest.approx(0.075)


def test_average_order_value_rounds_to_whole_minor_units():
    assert average_order_value_minor([1000, 1001]) == 1001


def test_average_order_value_of_no_orders_is_zero():
    assert average_order_value_minor([]) == 0


def test_refund_rate_handles_a_day_with_no_orders():
    assert refund_rate(orders_placed=0, orders_refunded=0) == 0.0


def test_trailing_window_is_inclusive_on_both_ends():
    window = Window.trailing(7, ending=date(2026, 3, 10))
    assert window.start == date(2026, 3, 4)
    assert window.days() == 7


def test_cohort_retention_counts_only_repeat_orders_inside_the_window():
    window = Window(start=date(2026, 3, 1), end=date(2026, 3, 31))
    first = {"u1": date(2026, 3, 2), "u2": date(2026, 3, 5), "u3": date(2026, 2, 20)}
    repeats = [("u1", date(2026, 3, 20)), ("u3", date(2026, 3, 21))]
    # u3 is outside the cohort, so only u1 of the two-person cohort returned.
    assert cohort_retention(first, repeats, window) == pytest.approx(0.5)
