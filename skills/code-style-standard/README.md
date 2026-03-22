# Code Style Standard

Teaches the agent the author's personal code design and style
preferences so that any code it produces reflects a consistent
philosophy of craftsmanship.

## What It Covers

- Language idiom as the highest priority (never fight the
  language)
- Codebase consistency over personal preference
- Read the codebase before writing new code
- Principle of least surprise as a first-class principle
  (names match behaviour, side effects are obvious, things
  live where they belong)
- Vertical and horizontal space discipline (earn every line;
  80-100 character width)
- Function design (screen-sized, single responsibility,
  top-down narrative ordering, expression-oriented)
- Clarity over cleverness (idiomatic terseness is fine,
  inscrutable cleverness is not)
- Domain-driven naming (shortest effective name, domain
  language, no utility modules)
- Control flow (guard clauses, early returns, clean happy
  paths, minimal nesting)
- Named parameters and callsite-driven parameter design
- Earned comments, inline comment formatting and warm doc
  comments on public interfaces
- DRY only for same-reason duplication
- Consumer-driven design at every scale (outside-in mindset,
  interface ergonomics)
- Just-in-time abstractions with focused responsibilities
- Composition over inheritance
- Consistent levels of abstraction within functions
- Domain-driven design, screaming architecture and bounded
  contexts
- Selective public interfaces and encapsulation
- Immutability (value objects always, entities when
  appropriate, pragmatism over purity)
- Idiomatic error handling with minimal re-wrapping
- Boundary validation over pervasive defensive coding
- Functional patterns when readable and idiomatic
- Concurrency and async only when genuinely needed
- Meaningful extraction of magic values
- Domain-organized file and module structure
- Behaviour-focused testing with Arrange/Act/Assert
  structure, narrative ordering and production-quality
  test code
- Test doubles: mock at boundaries, stub externals, assert
  across public contracts
- Dependency injection only when the language requires it
