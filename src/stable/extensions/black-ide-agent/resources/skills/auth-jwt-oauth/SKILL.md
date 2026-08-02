---
name: auth-jwt-oauth
description: Token-based auth: JWT handling, OAuth flows and session pitfalls
roles: [backend, architect]
stacks: [express, fastapi, django, spring-boot, aspnet-core, nestjs, rails]
triggers: [jwt, oauth, refresh token, bearer, authentication, session, pkce]
priority: 6
---
# Auth Jwt Oauth

## Conventions
- Validate `iss`, `aud`, `exp` and the signature — and pin the algorithm. Accepting whatever `alg` the token claims is the classic JWT vulnerability (`none`, or HMAC-verified against a public key).
- Short-lived access tokens (minutes) plus a rotating refresh token. A long-lived access token cannot be revoked.
- Store tokens in `httpOnly`, `Secure`, `SameSite` cookies for browsers; `localStorage` is readable by any XSS.
- Authorization Code + PKCE for anything user-facing. The implicit flow is deprecated.
- Authorize on the server for every request. A claim in a token is an assertion, not a permission.

## Pitfalls
- Rolling your own crypto or your own token format.
- Treating a decoded token as verified — decoding is not validating.
- No revocation path: keep a deny list keyed by `jti` for logout and compromise.
- Clock skew: allow a small leeway on `exp`/`nbf`, not an unlimited one.
