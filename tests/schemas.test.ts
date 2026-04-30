import { describe, expect, test } from "bun:test";
import { PhaseSchema, PlanSchema, StateSchema, VerifySchema } from "../src/core/schemas.ts";

describe("VerifySchema", () => {
  test("accepts shell verifier with defaults", () => {
    const v = VerifySchema.parse({ type: "shell", cmd: "bun test" });
    expect(v.type).toBe("shell");
    if (v.type === "shell") {
      expect(v.timeout_ms).toBe(120_000);
      expect(v.expect_exit).toBe(0);
    }
  });

  test("accepts http verifier with array status", () => {
    const v = VerifySchema.parse({
      type: "http",
      url: "http://localhost:3000/health",
      expect_status: [200, 204],
    });
    expect(v.type).toBe("http");
  });

  test("accepts playwright verifier", () => {
    const v = VerifySchema.parse({ type: "playwright", spec: "tests/foo.spec.ts" });
    expect(v.type).toBe("playwright");
  });

  test("accepts composite all", () => {
    const v = VerifySchema.parse({
      type: "all",
      verifiers: [
        { type: "shell", cmd: "bun test" },
        { type: "http", url: "http://localhost:3000/health" },
      ],
    });
    expect(v.type).toBe("all");
  });

  test("rejects unknown verifier type", () => {
    expect(() => VerifySchema.parse({ type: "telepathy", target: "user" })).toThrow();
  });

  test("rejects shell with empty cmd", () => {
    expect(() => VerifySchema.parse({ type: "shell", cmd: "" })).toThrow();
  });
});

describe("PhaseSchema", () => {
  test("accepts minimal phase", () => {
    const p = PhaseSchema.parse({
      id: "phase-1",
      goal: "build it",
      deliverable: "a thing",
      verify: { type: "shell", cmd: "true" },
      done_criteria: "thing exists",
    });
    expect(p.risky).toBe(false);
    expect(p.max_retries).toBe(3);
  });

  test("rejects bad id chars", () => {
    expect(() =>
      PhaseSchema.parse({
        id: "phase 1!",
        goal: "g",
        deliverable: "d",
        verify: { type: "shell", cmd: "true" },
        done_criteria: "c",
      }),
    ).toThrow();
  });
});

describe("PlanSchema", () => {
  test("rejects duplicate phase ids", () => {
    expect(() =>
      PlanSchema.parse({
        goal: "g",
        phases: [
          {
            id: "p1",
            goal: "g",
            deliverable: "d",
            verify: { type: "shell", cmd: "true" },
            done_criteria: "c",
          },
          {
            id: "p1",
            goal: "g",
            deliverable: "d",
            verify: { type: "shell", cmd: "true" },
            done_criteria: "c",
          },
        ],
      }),
    ).toThrow(/duplicate phase id/);
  });

  test("accepts valid plan", () => {
    const plan = PlanSchema.parse({
      goal: "g",
      phases: [
        {
          id: "p1",
          goal: "g",
          deliverable: "d",
          verify: { type: "shell", cmd: "true" },
          done_criteria: "c",
        },
      ],
    });
    expect(plan.phases.length).toBe(1);
  });
});

describe("StateSchema", () => {
  test("applies defaults", () => {
    const s = StateSchema.parse({
      version: 1,
      session_id: "x",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      plan: {
        goal: "g",
        phases: [
          {
            id: "p1",
            goal: "g",
            deliverable: "d",
            verify: { type: "shell", cmd: "true" },
            done_criteria: "c",
          },
        ],
      },
      current_phase_idx: 0,
      phase_state: {
        p1: { status: "pending" },
      },
    });
    expect(s.continuations_used).toBe(0);
    expect(s.max_continuations).toBe(30);
    expect(s.halted).toBe(false);
    expect(s.followup_queue).toEqual([]);
  });
});
