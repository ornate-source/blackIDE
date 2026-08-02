---
name: junit-mockito
description: JUnit 5 and Mockito structure, lifecycle and mocking discipline
roles: [testing]
stacks: [spring-boot, java, junit]
triggers: [junit, @Test, Mockito, when(, verify(, @Mock, assertThat]
priority: 10
---
# Junit Mockito

## Conventions
- JUnit 5: `@Test`, `@ParameterizedTest` + `@ValueSource`/`@CsvSource` for tables, `@BeforeEach` for setup.
- `@ExtendWith(MockitoExtension.class)` with `@Mock`/`@InjectMocks` rather than manual `mock()` wiring.
- Mock collaborators, never the class under test. If you need `@Spy` on it, the design is telling you something.
- AssertJ (`assertThat(x).isEqualTo(y)`) reads better and gives better failures than bare JUnit asserts.

## Commands
- `./mvnw test` · `./gradlew test` · single: `./mvnw test -Dtest=UserServiceTest`

## Pitfalls
- `when(...)` on a void method — use `doThrow().when(mock).method()`.
- Over-`verify`ing turns a behaviour test into a snapshot of the implementation.
- Strict stubs fail on unused stubbing, which is a feature: delete the stub.
