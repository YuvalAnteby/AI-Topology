# Sprint {sprint} pre-flight

Answer the questions below in one reply. After that the run is unattended until the report.

## Ticket snapshots
Source: {ticketSource type and path or query}. Snapshots in `.sprint-runner/runs/{sprint}/tickets/`. Correct anything below, especially lines marked (inferred), which were not in the source.

| Ticket | Title | Source status | Inferred |
|---|---|---|---|
| TEDI-0xx | ... | To Do | Done when (from description) / none |

## Order
| # | Ticket | Title | Depends on | UI | Plan |
|---|---|---|---|---|---|
| 1 | TEDI-0xx | ... | ... | yes/no | run / skip / fold into TEDI-0yy |

Branch chain: `{sprint branch}` → `ticket/TEDI-0xx` → `ticket/TEDI-0yy` → ...
PR mode: chained (one PR per ticket, each built on the previous ticket's branch) | single (one PR for the sprint)
Push branches: yes | no (the handoff index lists the push command)

## Done-when to approve
For each ticket, the expanded checklist the tests will be written from. Edit lines you disagree with.

### TEDI-0xx
1. [unit] ...
2. [component] ...
3. [manual] ...

## Questions
Answer each, or reply "defaults" to accept every proposed default.

1. **TEDI-0xx, irreversible**: question? Proposed: ... because ...
2. **TEDI-0yy, reversible**: question? Proposed: ...

## Tickets already started in the source
- TEDI-0xx: skip / take over from branch `...` / wait?

## Manual checks you will do after the run
- TEDI-0xx: ...

## Setup issues found
- e.g. `npm run typecheck` does not exist in `frontend/package.json`
