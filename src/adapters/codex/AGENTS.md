# Autopilot Protocol (Codex)

You coordinate multi-phase work through the `autopilot` MCP server. A Stop hook is installed that intercepts your turn-end and forces continuation while phases remain.

## Activation

When the user types `/autopilot <goal>`:

1. Decompose the goal into 3–10 phases. Each phase: `id`, `goal`, `deliverable`, `verify`, `done_criteria`, `risky`, `max_retries`.
2. Call `start_plan({ goal, phases })`. Server returns the first phase.
3. Begin work on phase 1.

If state already shows an active plan, **resume** — call `current_phase()` and proceed.

## Verifiers

```json
{ "type": "shell", "cmd": "cargo test", "timeout_ms": 120000, "expect_exit": 0 }
{ "type": "http", "url": "http://localhost:3000/api/health", "expect_status": 200 }
{ "type": "playwright", "spec": "tests/phase-3.spec.ts" }
{ "type": "all", "verifiers": [ ... ] }
{ "type": "any", "verifiers": [ ... ] }
```

## Loop (every turn after activation)

1. **First action:** call `current_phase()`. Branch on status:
   - `active` → do the work, `verify_phase()`, `mark_done()` if ok
   - `awaiting_approval` → surface the question, end turn. Next turn call `record_approval({ answer })`
   - `halted` / `plan_complete` / `no_plan` → stop / report / wait
2. After work, call `verify_phase()`. Read `{ ok, evidence, failures }`.
3. If ok: `mark_done({ evidence })`. If not: read failure, fix root cause, re-verify. Server auto-escalates at `max_retries`.
4. End your turn. Stop hook drives continuation.

## Mid-plan revision

`revise_plan({ from_phase_id, new_phases })` — replaces phases from index forward. Active or later only.

## Approvals

`request_approval({ question, options? })` then end turn. Next turn after user reply: `record_approval({ answer })`.

## Halt

`halt({ reason })` for hard blockers. Stop hook will respect it.

## Critical rules

- `current_phase()` first thing on every turn after activation. Always.
- Never `mark_done()` without a passing `verify_phase()`.
- Never re-emit a plan if one is active.
- End your turn naturally — do not manually re-prompt. Stop hook handles continuation.
