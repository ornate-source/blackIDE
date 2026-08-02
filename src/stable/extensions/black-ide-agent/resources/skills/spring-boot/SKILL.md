---
name: spring-boot
description: Spring Boot layering, dependency injection, JPA and testing idioms
roles: [backend]
stacks: [spring-boot, java, kotlin]
triggers: [spring, springboot, RestController, Service, Repository, application.yml, JpaRepository]
priority: 12
---
# Spring Boot

## Structure
- `controller/`, `service/`, `repository/`, `domain/`, `config/`. One aggregate per package when the domain is large.
- Configuration in `application.yml` with profile overlays (`application-prod.yml`), never hardcoded.

## Conventions
- Constructor injection only — no `@Autowired` on fields; it defeats immutability and makes testing require a container.
- `@Transactional` on the service, not the repository or the controller. Read-only queries get `@Transactional(readOnly = true)`.
- DTOs at the boundary; never return a JPA entity from a controller (lazy loading + serialization = surprise queries).
- `@ControllerAdvice` for exception mapping, so controllers do not repeat error handling.

## Commands
- `./mvnw test` or `./gradlew test` · `./mvnw spring-boot:run`
- Slice tests: `@WebMvcTest` for controllers, `@DataJpaTest` for repositories, full `@SpringBootTest` sparingly.

## Pitfalls
- `LazyInitializationException` outside a transaction — fetch what you need in the query.
- `@Transactional` on a private or self-invoked method does nothing (proxying).
- `spring.jpa.hibernate.ddl-auto` anything but `validate` in production.
