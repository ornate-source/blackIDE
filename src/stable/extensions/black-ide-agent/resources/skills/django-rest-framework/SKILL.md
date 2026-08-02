---
name: django-rest-framework
description: DRF serializers, viewsets, routers, permissions and pagination
roles: [backend]
stacks: [django, drf, python]
triggers: [serializer, viewset, drf, rest_framework, permission_classes, router]
priority: 12
---
# Django Rest Framework

## Structure
- `serializers.py`, `views.py` (ViewSets), `permissions.py`, `filters.py` per app. Routers in the app's `urls.py`.

## Conventions
- Validate in the serializer (`validate_<field>`, `validate`), never in the view.
- `ModelViewSet` + `DefaultRouter` for CRUD; `APIView` only when the resource is not a model.
- Set `permission_classes` explicitly on every viewset — do not rely on the global default being right.
- `select_related`/`prefetch_related` in `get_queryset()`; a serializer with nested relations is an N+1 by default.
- Pagination is global (`DEFAULT_PAGINATION_CLASS`); a list endpoint without it is a future outage.

## Commands
- `pytest` with `pytest-django`, or `python manage.py test`.
- `python manage.py spectacular --file schema.yml` if drf-spectacular is installed.

## Pitfalls
- `SerializerMethodField` runs per object — do the query once in `get_queryset` and pass it through context.
- `read_only_fields` forgotten means a client can PATCH `id` or `created_at`.
- Returning `Response(serializer.data)` after `save()` without re-serializing loses computed fields.
