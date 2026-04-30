#!/usr/bin/env bun
/**
 * Cursor Stop hook.
 * Cursor's stop hook output contract: {"followup_message":"<text>"} causes
 * Cursor to auto-submit that text as the next user message.
 * Empty / missing followup_message allows the stop.
 *
 * Cursor enforces a built-in loop_limit (default 5; we configure higher).
 * Our continuations counter still applies as the authoritative cap.
 */
import { decide } from "../../core/decide.ts";
import { isHalted, logEvent, readState, writeState } from "../../core/state.ts";

const cwd =
  process.env.CURSOR_PROJECT_DIR ||
  process.env.CURSOR_CWD ||
  process.env.AUTOPILOT_CWD ||
  process.cwd();

let input: { status?: string; loop_count?: number } = {};
try {
  const stdin = await Bun.stdin.text();
  if (stdin.trim()) input = JSON.parse(stdin);
} catch {}

let state = null;
try {
  state = readState(cwd);
} catch (err) {
  console.error(`autopilot stop hook: ${(err as Error).message}`);
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

// If user aborted in Cursor, respect that — never override with continuation.
if (input.status === "aborted") {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

const decision = decide({
  state,
  haltFileExists: isHalted(cwd),
});

if (decision.action === "stop") {
  process.stdout.write(JSON.stringify({}));
  process.exit(0);
}

if (state) {
  state.continuations_used += 1;
  logEvent(state, "stop_hook_continue", {
    continuations_used: state.continuations_used,
    cursor_loop_count: input.loop_count ?? null,
    reason_preview: decision.message.slice(0, 160),
  });
  try {
    writeState(cwd, state);
  } catch (err) {
    console.error(`autopilot stop hook: failed to write state: ${(err as Error).message}`);
  }
}

process.stdout.write(JSON.stringify({ followup_message: decision.message }));
process.exit(0);
