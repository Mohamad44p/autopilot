# autopilot

Loop-keeper for AI coding agents. You write one prompt, walk away, come back to a finished plan.

```
/autopilot build a todo app with react, store in localStorage, deploy to vercel
```

The agent decomposes the goal into phases. For each phase it works, runs a verifier you've declared (`bun test`, an HTTP probe, a Playwright spec, …), and advances on pass. When the agent tries to stop, autopilot's stop hook intercepts: if work remains it force-continues; if done/blocked it allows the stop. You come back to a finished plan or one approval question.

Works in **Claude Code**, **Codex CLI**, and **Cursor**.

## Install

Requires [Bun](https://bun.sh) ≥ 1.1.0.

```bash
bun add -g autopilot
```

Or run without installing:

```bash
bunx autopilot init claude
```

## Quick start

```bash
cd your-project
autopilot init claude        # or: init codex  /  init cursor
```

Then open the project in your agent and type:

```
/autopilot <your goal>
```

That's the whole workflow.

## What you get

Each phase the agent declares looks like this:

```json
{
  "id": "phase-2-storage",
  "goal": "persist todos to localStorage",
  "deliverable": "todos survive page reload",
  "verify": { "type": "playwright", "spec": "tests/storage.spec.ts" },
  "done_criteria": "creating, reloading, and reading back works",
  "risky": false,
  "max_retries": 3
}
```

You don't write that — the agent does. You just write the goal.

## Verifier types

| Type | Use it for |
|---|---|
| `shell` | `bun test`, `cargo build`, `pytest`, anything CLI |
| `http` | endpoint health checks, status / body regex assertions |
| `playwright` | UI / browser flows via `bunx playwright test <spec>` |
| `all` | composite: every sub-verifier must pass |
| `any` | composite: first sub-verifier to pass wins |

```json
{ "type": "shell",      "cmd": "bun test",                 "timeout_ms": 120000, "expect_exit": 0 }
{ "type": "http",       "url": "http://localhost:3000/api/health", "expect_status": 200 }
{ "type": "playwright", "spec": "tests/phase-3.spec.ts" }
{ "type": "all",        "verifiers": [/* ... */] }
{ "type": "any",        "verifiers": [/* ... */] }
```

The verifier proves the deliverable. "It compiles" is rarely enough.

## CLI

| Command | What it does |
|---|---|
| `autopilot init <claude\|codex\|cursor>` | Scaffold the adapter into the current project |
| `autopilot status` | Show active plan state, phase progress, continuation count |
| `autopilot halt [reason]` | Hard-stop the active plan |
| `autopilot resume` | Clear halt marker |
| `autopilot reset` | Delete `.autopilot/state.json` and halt marker |
| `autopilot serve` | Run the MCP server on stdio (used internally by adapters) |

All commands accept `--cwd <path>` to target a different project.

## How it works

Three pieces:

1. **MCP server** (`autopilot serve`) — owns `.autopilot/state.json`. Exposes 9 tools the agent calls: `start_plan`, `current_phase`, `verify_phase`, `mark_done`, `revise_plan`, `request_approval`, `record_approval`, `queue_followup`, `halt`.
2. **Skill / rules / AGENTS.md** — teaches the agent the protocol: emit plan first, then loop `current_phase → work → verify → mark_done` until done.
3. **Stop hook** — fires when the agent stops. Reads state. Returns `{decision: "block", reason: "do phase N"}` (or `{followup_message: "..."}` for Cursor) to force continuation. Allows stop when the plan is complete, the cap is hit, the user is being asked for approval, or `halt` is set.

State is the source of truth. Sessions restart, contexts compact; the state file survives.

## Guardrails

- **Continuation cap** (default 30, configurable per plan) — hard limit on stop-hook forced continuations
- **Per-phase retry budget** — auto-escalates to user approval at `max_retries`
- **Halt file** (`.autopilot/halt`) — kill switch readable by the stop hook
- **Atomic state writes** (tmp + rename) — no torn reads
- **Cross-platform tree-kill** — runaway shell verifiers are SIGKILL'd (`taskkill /T /F` on Windows) with a 2s grace before force-resolving
- **Aborted-status respect** (Cursor) — never overrides a user-initiated abort
- **Failure-context retries** — verify failures are injected into the next stop-hook reason so the agent retries with the actual error, not blindly

## Supported agents

| Agent | Tier | Mechanism |
|---|---|---|
| Claude Code | 1 | Stop hook returns `{decision: "block", reason}`; SessionStart hook re-orients after compaction |
| Codex CLI | 1 | Same Stop hook contract as Claude Code |
| Cursor (≥1.7) | 1 | Stop hook returns `{followup_message}`; Cursor auto-submits as next user message |
| OpenCode | — | Out of scope. Plugin API lacks loop re-entry as of April 2026 ([issue #16626](https://github.com/anomalyco/opencode/issues/16626)) |

## Project layout

```
src/
  core/      schemas, atomic state IO, verifiers, continuation decider
  mcp/       MCP server with 9 tools
  adapters/  per-agent stop hook + skill + config templates
  cli/       autopilot init / serve / status / halt / resume / reset
tests/       Bun test suite (61 tests)
```

## Development

```bash
bun install
bun run typecheck    # tsc --noEmit
bun run lint         # biome check
bun test             # full suite (~5s)
```

## Contributing

Open issues and PRs at the repository. The design is intentionally small — the whole protocol is a stop hook + a state file + nine MCP tools. Keep it that way.

## License

[MIT](./LICENSE)
