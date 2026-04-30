import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/core/schemas.ts";
import {
  activePhase,
  activePhaseState,
  initState,
  isHalted,
  readState,
  writeHalt,
  writeState,
} from "../src/core/state.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "autopilot-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const plan: Plan = {
  goal: "test plan",
  phases: [
    {
      id: "p1",
      goal: "first",
      deliverable: "x",
      verify: { type: "shell", cmd: "true", timeout_ms: 5000, expect_exit: 0 },
      done_criteria: "ok",
      risky: false,
      max_retries: 3,
    },
    {
      id: "p2",
      goal: "second",
      deliverable: "y",
      verify: { type: "shell", cmd: "true", timeout_ms: 5000, expect_exit: 0 },
      done_criteria: "ok",
      risky: false,
      max_retries: 3,
    },
  ],
};

describe("state lifecycle", () => {
  test("initState writes a state file with first phase in_progress", () => {
    const s = initState(tmp, plan);
    expect(s.current_phase_idx).toBe(0);
    expect(s.phase_state.p1?.status).toBe("in_progress");
    expect(s.phase_state.p2?.status).toBe("pending");

    const reread = readState(tmp);
    expect(reread).not.toBeNull();
    expect(reread?.session_id).toBe(s.session_id);
  });

  test("activePhase / activePhaseState return current", () => {
    const s = initState(tmp, plan);
    expect(activePhase(s)?.id).toBe("p1");
    expect(activePhaseState(s)?.status).toBe("in_progress");
  });

  test("readState returns null when no state", () => {
    expect(readState(tmp)).toBeNull();
  });

  test("writeState atomic write survives concurrent reads", () => {
    const s = initState(tmp, plan);
    s.continuations_used = 5;
    writeState(tmp, s);
    const r = readState(tmp);
    expect(r?.continuations_used).toBe(5);
  });

  test("halt file is detected", () => {
    expect(isHalted(tmp)).toBe(false);
    writeHalt(tmp, "manual");
    expect(isHalted(tmp)).toBe(true);
  });

  test("advancing through phases", () => {
    const s = initState(tmp, plan);
    s.phase_state.p1!.status = "passed";
    s.current_phase_idx = 1;
    s.phase_state.p2!.status = "in_progress";
    writeState(tmp, s);

    const r = readState(tmp)!;
    expect(activePhase(r)?.id).toBe("p2");
  });

  test("plan complete when current_phase_idx beyond phases", () => {
    const s = initState(tmp, plan);
    s.current_phase_idx = plan.phases.length;
    writeState(tmp, s);
    const r = readState(tmp)!;
    expect(activePhase(r)).toBeNull();
  });
});
