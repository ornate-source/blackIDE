---
name: docker
description: Dockerfile layering, image size, caching and container hygiene
roles: [devops]
stacks: [docker]
triggers: [dockerfile, docker-compose, image, container, ENTRYPOINT, multi-stage]
priority: 8
---
# Docker

## Conventions
- Multi-stage: build in a full image, copy only the artifact into a slim or distroless runtime.
- Order layers cheapest-changing first — dependency manifests and install *before* the source copy, or every code edit rebuilds the world.
- Pin base images by tag *and* digest for reproducibility.
- Run as a non-root `USER`. A container running as root is one escape from being root.
- One process per container; use `ENTRYPOINT` for the binary and `CMD` for its default arguments.

## Commands
- `docker build -t app:dev .` · `docker run --rm -it app:dev` · `docker compose up --build`

## Pitfalls
- `COPY . .` before installing dependencies invalidates the cache on every change.
- Secrets in build args or `ENV` end up in the image history — use build secrets or runtime injection.
- No `.dockerignore` means `node_modules` and `.git` ship in the context.
