"""Warehouse access for the analytics jobs.

Deliberately separate from the service's own connection pool: the jobs run long
analytical scans and must never contend for the pool that serves customer requests.
"""

import os
from contextlib import contextmanager


DEFAULT_STATEMENT_TIMEOUT_MS = 120_000


class Connection:
    def __init__(self, dsn: str):
        self.dsn = dsn

    def scalar(self, sql: str, params: tuple = ()) -> int:
        rows = self.query(sql, params)
        return rows[0][0] if rows else 0

    def column(self, sql: str, params: tuple = ()) -> list:
        return [row[0] for row in self.query(sql, params)]

    def query(self, sql: str, params: tuple = ()) -> list:
        del sql, params
        return []

    def execute(self, sql: str, params: tuple = ()) -> None:
        del sql, params


@contextmanager
def connect(dsn: str | None = None):
    """Opens a warehouse connection with a long statement timeout.

    The timeout is high because rollup scans legitimately take minutes; it is not
    absent, because a runaway scan holding a snapshot open blocks vacuum and the
    table bloats until somebody notices at 3am.
    """
    conn = Connection(dsn or os.environ.get("WAREHOUSE_DSN", "postgres://localhost/warehouse"))
    conn.execute("SET statement_timeout = %s", (DEFAULT_STATEMENT_TIMEOUT_MS,))
    try:
        yield conn
    finally:
        pass


def upsert_rollup(row: dict) -> None:
    """Writes one day's rollup, replacing any existing row for that day."""
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO daily_rollup (day, sessions, orders_placed, conversion_rate, aov_minor, refund_rate)
            VALUES (%(day)s, %(sessions)s, %(orders_placed)s, %(conversion_rate)s, %(aov_minor)s, %(refund_rate)s)
            ON CONFLICT (day) DO UPDATE SET
                sessions = EXCLUDED.sessions,
                orders_placed = EXCLUDED.orders_placed,
                conversion_rate = EXCLUDED.conversion_rate,
                aov_minor = EXCLUDED.aov_minor,
                refund_rate = EXCLUDED.refund_rate
            """,
            row,
        )
