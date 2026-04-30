import type { State } from "./schemas.ts";
import { activePhase, activePhaseState } from "./state.ts";

export type ContinuationDecision =
  | { action: "stop"; reason: string }
  | { action: "continue"; message: string };

export type DecideInput = {
  state: State | null;
  haltFileExists: boolean;
  hookActive?: boolean;
};

export function decide(input: DecideInput): ContinuationDecision {
  if (input.haltFileExists) {
    return { action: "stop", reason: "halt_file_present" };
  }
  if (!input.state) {
    return { action: "stop", reason: "no_state" };
  }
  const s = input.state;
  if (s.halted) {
    return { action: "stop", reason: `halted: ${s.halt_reason ?? "(no reason)"}` };
  }
  if (s.awaiting_approval) {
    return { action: "stop", reason: "awaiting_approval" };
  }
  if (s.continuations_used >= s.max_continuations) {
    return { action: "stop", reason: "continuation_cap_reached" };
  }
  const phase = activePhase(s);
  if (!phase) {
    return { action: "stop", reason: "plan_complete" };
  }
  const ps = activePhaseState(s);
  if (!ps) {
    return { action: "stop", reason: "no_phase_state" };
  }

  const idxLabel = `${s.current_phase_idx + 1}/${s.plan.phases.length}`;
  const counter = `[continuation ${s.continuations_used + 1}/${s.max_continuations}]`;
  const prefix = `Autopilot ${counter} — phase ${idxLabel} "${phase.id}".`;

  switch (ps.status) {
    case "pending":
    case "in_progress":
      return {
        action: "continue",
        message: [
          prefix,
          `Goal: ${phase.goal}`,
          `Deliverable: ${phase.deliverable}`,
          `Done criteria: ${phase.done_criteria}`,
          phase.risky ? "RISKY phase — call request_approval before doing irreversible work." : "",
          "Continue work, then call verify_phase() and mark_done(). Always call current_phase() first if unsure of state.",
        ]
          .filter(Boolean)
          .join("\n"),
      };
    case "verifying":
      return {
        action: "continue",
        message: `${prefix} Verification was in flight when you stopped. Call current_phase() to read the latest status, then proceed.`,
      };
    case "passed":
      return {
        action: "continue",
        message: `${prefix} Phase verified. Call mark_done({ evidence }) to advance to phase ${s.current_phase_idx + 2}.`,
      };
    case "failed": {
      const tries = `(retry ${ps.retries}/${phase.max_retries})`;
      const failure = ps.last_failure ?? "(no failure detail)";
      return {
        action: "continue",
        message: [
          `${prefix} verify_phase FAILED ${tries}.`,
          "--- failure ---",
          failure.slice(0, 3000),
          "--- end failure ---",
          "Read the failure above. Diagnose the root cause. Fix it. Then call verify_phase() again. Do not call mark_done() until verify returns ok=true.",
        ].join("\n"),
      };
    }
    case "blocked":
      return { action: "stop", reason: "phase_blocked_pending_approval" };
  }
}
