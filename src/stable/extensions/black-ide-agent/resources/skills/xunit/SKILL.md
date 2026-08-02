---
name: xunit
description: xUnit test structure, fixtures and assertion idioms for .NET
roles: [testing]
stacks: [aspnet-core, csharp, xunit]
triggers: [xunit, Fact, Theory, InlineData, IClassFixture, Assert]
priority: 10
---
# Xunit

## Conventions
- `[Fact]` for one case, `[Theory]` + `[InlineData]`/`[MemberData]` for a table. A loop inside a `[Fact]` hides which case failed.
- Constructor for setup, `IDisposable` for teardown — xUnit builds a new instance per test, which is what keeps them isolated.
- `IClassFixture<T>` for expensive shared setup; `ICollectionFixture<T>` to share across classes.
- Name tests `Method_Scenario_ExpectedResult`.

## Commands
- `dotnet test` · `dotnet test --filter FullyQualifiedName~Users`

## Pitfalls
- Static state leaks across tests that xUnit otherwise isolates.
- `Assert.Equal` argument order is (expected, actual) — reversed, the failure message lies.
- `async void` tests never fail; use `async Task`.
