import { describe, expect, test } from "bun:test";
import { runVerifier } from "../src/core/verify.ts";

describe("runVerifier — shell", () => {
  test("exit 0 → ok=true", async () => {
    const r = await runVerifier(
      { type: "shell", cmd: 'node -e "process.exit(0)"', timeout_ms: 10_000, expect_exit: 0 },
      process.cwd(),
    );
    expect(r.ok).toBe(true);
  });

  test("exit non-zero → ok=false", async () => {
    const r = await runVerifier(
      { type: "shell", cmd: 'node -e "process.exit(1)"', timeout_ms: 10_000, expect_exit: 0 },
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failures.length).toBeGreaterThan(0);
  });

  test("timeout kills process and reports failure", async () => {
    const r = await runVerifier(
      {
        type: "shell",
        cmd: 'node -e "setTimeout(()=>{}, 60000)"',
        timeout_ms: 500,
        expect_exit: 0,
      },
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain("timeout");
  }, 10_000);

  test("captures stdout in evidence", async () => {
    const r = await runVerifier(
      {
        type: "shell",
        cmd: "node -e \"console.log('hello-marker')\"",
        timeout_ms: 10_000,
        expect_exit: 0,
      },
      process.cwd(),
    );
    expect(r.ok).toBe(true);
    expect(r.evidence).toContain("hello-marker");
  });
});

describe("runVerifier — composites", () => {
  const ok = {
    type: "shell" as const,
    cmd: 'node -e "process.exit(0)"',
    timeout_ms: 5000,
    expect_exit: 0,
  };
  const fail = {
    type: "shell" as const,
    cmd: 'node -e "process.exit(1)"',
    timeout_ms: 5000,
    expect_exit: 0,
  };

  test("all: every must pass", async () => {
    const r = await runVerifier({ type: "all", verifiers: [ok, ok] }, process.cwd());
    expect(r.ok).toBe(true);
  });

  test("all: stops at first failure", async () => {
    const r = await runVerifier({ type: "all", verifiers: [ok, fail, ok] }, process.cwd());
    expect(r.ok).toBe(false);
  });

  test("any: first pass wins", async () => {
    const r = await runVerifier({ type: "any", verifiers: [fail, ok, fail] }, process.cwd());
    expect(r.ok).toBe(true);
  });

  test("any: all fail → fail", async () => {
    const r = await runVerifier({ type: "any", verifiers: [fail, fail] }, process.cwd());
    expect(r.ok).toBe(false);
  });
});
