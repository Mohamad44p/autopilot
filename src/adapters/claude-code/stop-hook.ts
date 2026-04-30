#!/usr/bin/env bun
/**
 * Claude Code Stop hook.
 * Reads stdin (hook payload), reads .autopilot/state.json, decides whether to
 * force a continuation or allow the stop. Outputs JSON to stdout per CC's
 * Stop hook contract: {"decision":"block","reason":"..."} to continue, or
 * empty / no decision to allow stop.
 *
 * Loop-prevention: we maintain our own continuations counter in state.json.
 * stop_hook_active from CC is read but not relied upon (CC docs vary).
 */
import { decide } from "../../core/decide.ts";
import { isHalted, logEvent, readState, writeState } from "../../core/state.ts";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.env.AUTOPILOT_CWD || process.cwd();

let input: { stop_hook_active?: boolean } = {};
try {
  const stdin = await Bun.stdin.text();
  if (stdin.trim()) input = JSON.parse(stdin);
} catch {
  // tolerate missing/malformed stdin
}

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
  // allow stop — emit nothing, exit 0
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
