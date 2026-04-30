---
name: autopilot
description: Loop-keeper for multi-phase work. Activate with /autopilot <goal>. Plans phases, verifies each, auto-continues until done.
---

# Autopilot Protocol

You coordinate multi-phase work through the `autopilot` MCP server. A Stop hook is installed that intercepts your turn-end and forces continuation while phases remain — you do not need to manually loop.

## Activation

When the user types `/autopilot <goal>`:

1. Decompose the goal into 3–10 phases. Each phase is:
   - `id`: stable string, e.g. `"phase-1-scaffold"` (alphanumeric + `_-:.`)
   - `goal`: one sentence — what gets accomplished
   - `deliverable`: concrete artifact (file, endpoint, behavior)
   - `verify`: how to prove it works (see Verifiers below)
   - `done_criteria`: human-readable acceptance check
   - `risky`: `true` for irreversible operations (deletes, deploys, db migrations) — pauses for approval before work
   - `max_retries`: usually `3`
2. Call `start_plan({ goal, phases })`. Server returns the first phase.
3. Begin the work for phase 1.

If state.json already shows an active plan, **resume instead** — call `current_phase()` and proceed.

## Verifiers

Choose a verifier that actually proves the deliverable. "It compiles" is rarely enough.

```json
{ "type": "shell", "cmd": "bun test", "timeout_ms": 120000, "expect_exit": 0 }
{ "type": "http", "url": "http://localhost:3000/api/health", "expect_status": 200, "expect_body_regex": "\"ok\":true" }
{ "type": "playwright", "spec": "tests/phase-3.spec.ts", "timeout_ms": 180000 }
{ "type": "all", "verifiers": [ ...sub-verifiers... ] }
{ "type": "any", "verifiers": [ ...sub-verifiers... ] }
```

`all` requires every sub-verifier to pass. `any` accepts the first that passes.

## The loop (every turn after activation)

1. **First action of every turn:** call `current_phase()`. Branch:
   - `status: "active"` → do the work, then `verify_phase()`, then `mark_done()` if `ok=true`
   - `status: "awaiting_approval"` → surface the question to the user, then end the turn. Next turn, after the user replies, call `record_approval({ answer })` and proceed
   - `status: "halted"` → stop, do not call any other tools
   - `status: "plan_complete"` → tell the user, list any queued followups, stop
   - `status: "no_plan"` → wait for `/autopilot <goal>` from user
2. After the work is done, call `verify_phase()`. The server runs the phase's verifier and returns `{ ok, evidence, failures }`.
3. **If `ok: true`:** call `mark_done({ evidence: "<one-paragraph summary>" })`. Move to next phase.
4. **If `ok: false`:** read the failure carefully. Diagnose the **root cause** — do not just retry. Fix the underlying issue. Then call `verify_phase()` again. The server tracks retries; at `max_retries` it auto-escalates by setting `awaiting_approval`.
5. End your turn. The Stop hook will either force-continue you or allow stop based on state.

## Mid-plan revision

If you discover that remaining phases are wrong (new info, a phase is no longer needed, a dependency is missing), call `revise_plan({ from_phase_id, new_phases })`. Only the active phase or later can be revised; completed phases are immutable.

## Approvals (for risky phases)

Before doing irreversible work, call `request_approval({ question, options? })`. Then end your turn — surface the question clearly in your final message. The user replies in chat. Next turn, call `record_approval({ answer })` with their reply, then act on the answer (proceed, revise_plan, halt, …).

## Halt

For hard blockers (missing credentials, external dependency down, ambiguous spec): call `halt({ reason })`. The Stop hook will allow termination.

## Critical rules

- `current_phase()` first thing on every turn after activation. Always.
- Never call `mark_done()` without a passing `verify_phase()` first. The server will reject it.
- Never re-emit a plan if state shows one active. Resume instead.
- Treat user messages mid-loop as guidance — read them, incorporate, continue the loop.
- If `continuations_used` is approaching `max_continuations` (e.g., > 80%), summarize progress in your message so the user can intervene if needed.
- The Stop hook is the loop driver — do **not** try to manually re-prompt yourself. End your turn naturally; the hook will continue you.
