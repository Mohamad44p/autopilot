#!/usr/bin/env bun
/**
 * Codex Stop hook.
 * Same JSON output contract as Claude Code: {"decision":"block","reason":"..."}.
 * Codex's Stop event input may include stop_hook_active and last_assistant_message.
 */
import { decide } from "../../core/decide.ts";
import { isHalted, logEvent, readState, writeState } from "../../core/state.ts";

const cwd =
  process.env.CODEX_PROJECT_DIR ||
  process.env.CODEX_CWD ||
  process.env.AUTOPILOT_CWD ||
  process.cwd();

let input: { stop_hook_active?: boolean; last_assistant_message?: string } = {};
try {
  const stdin = await Bun.stdin.text();
  if (stdin.trim()) input = JSON.parse(stdin);
} catch {}

let state = null;
try {
  state = readState(cwd);
} catch (err) {
  console.error(`autopilot stop hook: ${(err as Error).message}`);
  process.exit(0);
}

const decision = decide({
  state,
  haltFileExists: isHalted(cwd),
  hookActive: input.stop_hook_active === true,
});

if (decision.action === "stop") {
  process.exit(0);
}

if (state) {
  state.continuations_used += 1;
  logEvent(state, "stop_hook_continue", {
    continuations_used: state.continuations_used,
    reason_preview: decision.message.slice(0, 160),
  });
  try {
    writeState(cwd, state);
  } catch (err) {
    console.error(`autopilot stop hook: failed to write state: ${(err as Error).message}`);
  }
}

process.stdout.write(
  JSON.stringify({
    decision: "block",
    reason: decision.message,
  }),
);
process.exit(0);
