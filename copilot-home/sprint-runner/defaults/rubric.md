# Quality rubric

The implementer applies this in REFACTOR and the reviewer scores every diff against it. This is the default for every project. To change it for one project, copy it to `.sprint-runner/rubric.md` in that repository and edit the copy. It is locked while a sprint run is in progress.

## Fit the codebase
- [ ] Reuses existing helpers, services, hooks, components and types before adding new ones.
- [ ] Follows the patterns already used in the same module: naming, folder layout, error handling, test style.
- [ ] No new dependency unless `decisions.md` approves it.

## Simple
- [ ] The simplest design that satisfies the ticket. No abstraction with a single user, no options nobody asked for, no "for later" code.
- [ ] Functions do one thing and are named for what they do. A reader understands each in one pass.
- [ ] No duplicated logic. Two copies is a smell, three is a finding.
- [ ] No dead code, commented-out code, debug logging, unused exports or stray TODOs without a ticket id.

## Correct and safe
- [ ] Input is validated at the boundary: DTOs with class-validator on every NestJS controller input.
- [ ] Every new endpoint and action checks authorization (admin vs regular user) with the project's guards, not inline checks.
- [ ] Errors are handled where they can be acted on and surface as clear HTTP errors or UI states. Nothing is swallowed.
- [ ] Explicit types. No `any`, no non-null assertions to silence the compiler.

## NestJS (edit or delete for other stacks)
- [ ] Controllers stay thin: parse, authorize, delegate. Business logic lives in services.
- [ ] Database access goes through the existing repository or ORM pattern. Migrations are explicit and reversible.

## React (edit or delete for other stacks)
- [ ] Components are small and render from props and state. Logic that is not rendering lives in hooks or plain functions.
- [ ] Server state goes through the existing data-fetching layer. No ad hoc fetch calls in components.
- [ ] Accessible by default: real buttons and labels, keyboard reachable, visible focus.

## Tests
- [ ] Each test name reads as a behavior spec.
- [ ] Tests assert observable behavior and would fail if that behavior broke.
- [ ] Mocks only at real boundaries.
