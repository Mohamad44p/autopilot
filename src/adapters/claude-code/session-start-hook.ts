#!/usr/bin/env bun
/**
 * Claude Code SessionStart hook.
 * If an autopilot plan is active in this directory, inject a re-orientation
 * prompt so the agent knows to call current_phase() first thing.
 * Critical for surviving auto-compaction and session restarts.
 */
import { activePhase, activePhaseState, isHalted, readState } from "../../core/state.ts";

const cwd = process.env.CLAUDE_PROJECT_DIR || process.env.AUTOPILOT_CWD || process.cwd();

const state = (() => {
  try {
    return readState(cwd);
  } catch {
    return null;
  }
})();

if (!state || state.halted || isHalted(cwd)) {
  process.exit(0);
}

const phase = activePhase(state);
if (!phase) process.exit(0);
const ps = activePhaseState(state);

const lines = [
  "An autopilot plan is in progress in this project.",
  `- Goal: ${state.plan.goal}`,
  `- Active phase: ${state.current_phase_idx + 1}/${state.plan.phases.length} — "${phase.id}"`,
  `- Phase status: ${ps?.status ?? "unknown"}`,
  `- Continuations used: ${state.continuations_used}/${state.max_continuations}`,
  "",
  "Call current_phase() now via the autopilot MCP server to re-orient, then continue the autopilot protocol (work → verify_phase → mark_done).",
];
if (state.awaiting_approval) {
  lines.push("");
  lines.push(`Pending approval: ${state.awaiting_approval.question}`);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: lines.join("\n"),
    },
  }),
);
process.exit(0);
