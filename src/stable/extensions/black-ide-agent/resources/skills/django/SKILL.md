---
name: django
description: Django + DRF backend idioms, project layout, migrations, and pitfalls
roles: [backend]
stacks: [django, python]
triggers: [django, models.py, migrations, serializer, drf, views.py]
priority: 10
---
# Django

## Project layout
- `<project>/settings/` split into `base.py`, `dev.py`, `prod.py`; never hardcode secrets — read from env.
- Apps are self-contained: `models.py`, `views.py`, `serializers.py`, `urls.py`, `admin.py`, `tests/`.

## Conventions
- Prefer the ORM; avoid raw SQL. Use `select_related`/`prefetch_related` to kill N+1 queries.
- Every model change ⇒ `makemigrations` + `migrate`; commit the migration file.
- Fat models / thin views. Business logic in model methods or a `services.py`, not in views.
- DRF: `ViewSet` + `Serializer` + `Router`; validate in the serializer, not the view.
- Use `settings.AUTH_USER_MODEL`, never import `User` directly.

## Commands
- `python manage.py makemigrations && python manage.py migrate`
- `python manage.py runserver` · `python manage.py createsuperuser`
- Tests: `pytest` (with `pytest-django`) or `python manage.py test`.

## Pitfalls
- Missing migrations after a model edit. Mutable default args on fields. Querysets are lazy — evaluate intentionally. Don't put queries at module import time.
