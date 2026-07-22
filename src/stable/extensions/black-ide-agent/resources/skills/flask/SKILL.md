---
name: flask
description: Flask backend idioms — blueprints, app factory, extensions
roles: [backend]
stacks: [flask, python]
triggers: [flask, blueprint, "app.route", wsgi]
priority: 8
---
# Flask

## Conventions
- Use the **app factory** pattern (`create_app()`); register blueprints per feature.
- Keep extensions (SQLAlchemy, Migrate) module-global, initialized in the factory with `init_app`.
- Config via `app.config.from_object` + env; never commit secrets.
- Return `jsonify(...)` with explicit status codes; validate input (marshmallow/pydantic).

## Commands
- Dev: `flask --app app run --debug` · Migrations: `flask db migrate && flask db upgrade`
- Tests: `pytest` with the test client.

## Pitfalls
- Circular imports from a global `app`. Doing work at import time. Using the dev server in prod (use gunicorn).
