import { describe, expect, test } from "bun:test";
import { decide } from "../src/core/decide.ts";
import type { Plan, State } from "../src/core/schemas.ts";

const plan: Plan = {
  goal: "test",
  phases: [
    {
      id: "p1",
      goal: "g1",
      deliverable: "d1",
      verify: { type: "shell", cmd: "true", timeout_ms: 1000, expect_exit: 0 },
      done_criteria: "c1",
      risky: false,
      max_retries: 3,
    },
    {
      id: "p2",
      goal: "g2",
      deliverable: "d2",
      verify: { type: "shell", cmd: "true", timeout_ms: 1000, expect_exit: 0 },
      done_criteria: "c2",
      risky: false,
      max_retries: 3,
    },
  ],
};

function mkState(overrides: Partial<State> = {}): State {
  const base: State = {
    version: 1,
    session_id: "s",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    plan,
    current_phase_idx: 0,
    phase_state: {
      p1: {
        status: "in_progress",
        retries: 0,
        evidence: null,
        last_failure: null,
        started_at: null,
        completed_at: null,
      },
      p2: {
        status: "pending",
        retries: 0,
        evidence: null,
        last_failure: null,
        started_at: null,
        completed_at: null,
      },
    },
    continuations_used: 0,
    max_continuations: 30,
    awaiting_approval: null,
    followup_queue: [],
    halted: false,
    halt_reason: null,
    log: [],
  };
  return { ...base, ...overrides };
}

describe("decide", () => {
  test("no state → stop", () => {
    expect(decide({ state: null, haltFileExists: false })).toEqual({
      action: "stop",
      reason: "no_state",
    });
  });

  test("halt file → stop", () => {
    const s = mkState();
    expect(decide({ state: s, haltFileExists: true }).action).toBe("stop");
  });

  test("halted state → stop", () => {
    const s = mkState({ halted: true, halt_reason: "user" });
    expect(decide({ state: s, haltFileExists: false }).action).toBe("stop");
  });

  test("awaiting_approval → stop", () => {
    const s = mkState({
      awaiting_approval: {
        question: "?",
        asked_at: "2026-01-01T00:00:00Z",
      },
    });
    expect(decide({ state: s, haltFileExists: false }).action).toBe("stop");
  });

  test("continuation cap → stop", () => {
    const s = mkState({ continuations_used: 30, max_continuations: 30 });
    expect(decide({ state: s, haltFileExists: false }).action).toBe("stop");
  });

  test("plan complete → stop", () => {
    const s = mkState({ current_phase_idx: 2 });
    expect(decide({ state: s, haltFileExists: false }).action).toBe("stop");
  });

  test("in_progress → continue with phase goal", () => {
    const s = mkState();
    const d = decide({ state: s, haltFileExists: false });
    expect(d.action).toBe("continue");
    if (d.action === "continue") {
      expect(d.message).toContain("p1");
      expect(d.message).toContain("g1");
      expect(d.message).toContain("verify_phase");
    }
  });

  test("passed but not marked done → continue with mark_done nudge", () => {
    const s = mkState();
    s.phase_state.p1!.status = "passed";
    const d = decide({ state: s, haltFileExists: false });
    expect(d.action).toBe("continue");
    if (d.action === "continue") {
      expect(d.message).toContain("mark_done");
    }
  });

  test("failed → continue with failure detail", () => {
    const s = mkState();
    s.phase_state.p1!.status = "failed";
    s.phase_state.p1!.retries = 1;
    s.phase_state.p1!.last_failure = "test xyz failed: assertion AAA";
    const d = decide({ state: s, haltFileExists: false });
    expect(d.action).toBe("continue");
    if (d.action === "continue") {
      expect(d.message).toContain("FAILED");
      expect(d.message).toContain("AAA");
      expect(d.message).toContain("retry 1/3");
    }
  });

  test("blocked → stop (escalation)", () => {
    const s = mkState();
    s.phase_state.p1!.status = "blocked";
    expect(decide({ state: s, haltFileExists: false }).action).toBe("stop");
  });

  test("risky phase mentions approval guidance", () => {
    const s = mkState();
    s.plan.phases[0]!.risky = true;
    const d = decide({ state: s, haltFileExists: false });
    if (d.action === "continue") {
      expect(d.message).toContain("RISKY");
    }
  });
});
