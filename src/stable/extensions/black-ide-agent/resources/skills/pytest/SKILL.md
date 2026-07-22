---
name: pytest
description: pytest testing idioms — fixtures, parametrize, structure (Python)
roles: [testing]
stacks: [pytest, python, django, fastapi, flask]
triggers: [pytest, fixture, parametrize, "def test_", conftest]
priority: 9
---
# pytest

## Conventions
- Test files `test_*.py`; functions `test_*`. Arrange–Act–Assert; one behavior per test.
- Share setup via `fixture`s (in `conftest.py` for cross-module); prefer function scope, widen only when needed.
- `@pytest.mark.parametrize` for input/expected tables instead of loops.
- Mock at boundaries with `monkeypatch`/`unittest.mock`; don't mock what you own deeply.
- pytest-django: use `@pytest.mark.django_db`; use factories (factory_boy) over fixtures-of-fixtures.

## Commands
- `pytest -q` · `pytest -k name` · `pytest --cov`.

## Pitfalls
- Order-dependent tests / shared mutable state. Over-broad fixture scope. Asserting on implementation, not behavior.
