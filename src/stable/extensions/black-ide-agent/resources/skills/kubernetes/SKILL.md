---
name: kubernetes
description: Kubernetes manifests, probes, resources and rollout safety
roles: [devops]
stacks: [kubernetes]
triggers: [kubernetes, k8s, deployment, service, ingress, helm, kubectl, manifest]
priority: 8
---
# Kubernetes

## Conventions
- Always set resource `requests` and `limits`. Without requests the scheduler is guessing; without limits one pod can starve a node.
- Liveness *and* readiness probes, and make them different: readiness gates traffic, liveness restarts. A liveness probe that checks a dependency causes restart storms during that dependency's outage.
- `RollingUpdate` with `maxUnavailable: 0` for anything user-facing, plus a `PodDisruptionBudget`.
- Config in `ConfigMap`, secrets in `Secret` (and a real secret manager behind it). Neither belongs in the image.

## Commands
- `kubectl apply -f k8s/` · `kubectl rollout status deploy/app` · `kubectl logs -f deploy/app --all-containers`
- `kubectl describe pod <p>` first when something is Pending — it is almost always resources or a volume.

## Pitfalls
- `latest` tags make a rollout non-reproducible and a rollback meaningless.
- No `terminationGracePeriodSeconds` handling means in-flight requests are cut on deploy.
