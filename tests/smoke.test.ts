import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Plan } from "../src/core/schemas.ts";
import { initState, readState } from "../src/core/state.ts";

const ROOT = resolve(import.meta.dir, "..");

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "autopilot-smoke-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const plan: Plan = {
  goal: "smoke test plan",
  phases: [
    {
      id: "p1",
      goal: "first goal",
      deliverable: "first deliverable",
      verify: { type: "shell", cmd: "exit 0", timeout_ms: 5000, expect_exit: 0 },
      done_criteria: "ok",
      risky: false,
      max_retries: 3,
    },
  ],
};

async function runHook(
  scriptRel: string,
  env: Record<string, string>,
  stdin = "{}",
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const proc = Bun.spawn({
    cmd: ["bun", join(ROOT, scriptRel)],
    env: { ...process.env, ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(stdin);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("stop hooks — Claude Code adapter", () => {
  test("no state → allow stop (empty stdout)", async () => {
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/stop-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("active in_progress phase → block with phase guidance", async () => {
    initState(tmp, plan);
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/stop-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("p1");
    expect(out.reason).toContain("verify_phase");
  });

  test("halted state → allow stop", async () => {
    const s = initState(tmp, plan);
    s.halted = true;
    s.halt_reason = "manual";
    const { writeState } = await import("../src/core/state.ts");
    writeState(tmp, s);
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/stop-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("awaiting approval → allow stop (let user reply)", async () => {
    const s = initState(tmp, plan);
    s.awaiting_approval = {
      question: "ok to proceed?",
      asked_at: "2026-01-01T00:00:00Z",
    };
    const { writeState } = await import("../src/core/state.ts");
    writeState(tmp, s);
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/stop-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("continuations counter increments per block", async () => {
    initState(tmp, plan);
    const before = readState(tmp);
    expect(before?.continuations_used).toBe(0);

    await runHook("src/adapters/claude-code/stop-hook.ts", { AUTOPILOT_CWD: tmp });
    const after1 = readState(tmp);
    expect(after1?.continuations_used).toBe(1);

    await runHook("src/adapters/claude-code/stop-hook.ts", { AUTOPILOT_CWD: tmp });
    const after2 = readState(tmp);
    expect(after2?.continuations_used).toBe(2);
  });

  test("continuation cap reached → allow stop", async () => {
    const s = initState(tmp, plan);
    s.continuations_used = s.max_continuations;
    const { writeState } = await import("../src/core/state.ts");
    writeState(tmp, s);
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/stop-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });
});

describe("stop hooks — Cursor adapter", () => {
  test("active phase → followup_message", async () => {
    initState(tmp, plan);
    const { stdout, exitCode } = await runHook(
      "src/adapters/cursor/stop-hook.ts",
      { AUTOPILOT_CWD: tmp },
      JSON.stringify({ status: "completed", loop_count: 0 }),
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.followup_message).toBeDefined();
    expect(out.followup_message).toContain("p1");
  });

  test("aborted status → respect, no followup", async () => {
    initState(tmp, plan);
    const { stdout, exitCode } = await runHook(
      "src/adapters/cursor/stop-hook.ts",
      { AUTOPILOT_CWD: tmp },
      JSON.stringify({ status: "aborted", loop_count: 0 }),
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.followup_message).toBeUndefined();
  });

  test("no state → empty json (allow stop)", async () => {
    const { stdout, exitCode } = await runHook(
      "src/adapters/cursor/stop-hook.ts",
      { AUTOPILOT_CWD: tmp },
      JSON.stringify({ status: "completed", loop_count: 0 }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toBe("{}");
  });
});

describe("stop hooks — Codex adapter", () => {
  test("active phase → block decision (CC-compatible output)", async () => {
    initState(tmp, plan);
    const { stdout, exitCode } = await runHook(
      "src/adapters/codex/stop-hook.ts",
      { AUTOPILOT_CWD: tmp },
      JSON.stringify({ stop_hook_active: false }),
    );
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toContain("p1");
  });
});

describe("SessionStart hook — Claude Code", () => {
  test("no plan → silent exit", async () => {
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/session-start-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toBe("");
  });

  test("active plan → injects re-orientation context", async () => {
    initState(tmp, plan);
    const { stdout, exitCode } = await runHook("src/adapters/claude-code/session-start-hook.ts", {
      AUTOPILOT_CWD: tmp,
    });
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("autopilot plan");
    expect(out.hookSpecificOutput.additionalContext).toContain("p1");
  });
});

describe("CLI init", () => {
  test("init claude creates expected files", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(ROOT, "src/cli/index.ts"), "init", "claude", "--cwd", tmp],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(existsSync(join(tmp, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(tmp, ".mcp.json"))).toBe(true);
    expect(existsSync(join(tmp, ".claude", "skills", "autopilot", "SKILL.md"))).toBe(true);
  });

  test("init cursor creates expected files", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(ROOT, "src/cli/index.ts"), "init", "cursor", "--cwd", tmp],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(existsSync(join(tmp, ".cursor", "hooks.json"))).toBe(true);
    expect(existsSync(join(tmp, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(tmp, ".cursor", "rules", "autopilot.mdc"))).toBe(true);
  });

  test("init codex creates expected files", async () => {
    const proc = Bun.spawn({
      cmd: ["bun", join(ROOT, "src/cli/index.ts"), "init", "codex", "--cwd", tmp],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    expect(existsSync(join(tmp, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(tmp, ".codex", "autopilot.toml"))).toBe(true);
    expect(existsSync(join(tmp, "AGENTS.md"))).toBe(true);
  });
});
