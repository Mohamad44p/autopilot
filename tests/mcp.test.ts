import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dir, "..");

let tmp: string;
let client: Client;
let transport: StdioClientTransport;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "autopilot-mcp-"));
  transport = new StdioClientTransport({
    command: "bun",
    args: [join(ROOT, "src/mcp/server.ts")],
    env: { ...process.env, AUTOPILOT_CWD: tmp },
  });
  client = new Client({ name: "autopilot-test", version: "0.1.0" });
  await client.connect(transport);
});

afterEach(async () => {
  await client.close();
  rmSync(tmp, { recursive: true, force: true });
});

const samplePhases = [
  {
    id: "p1",
    goal: "build the thing",
    deliverable: "thing.txt exists",
    verify: { type: "shell", cmd: "exit 0", timeout_ms: 5000, expect_exit: 0 },
    done_criteria: "exists",
    risky: false,
    max_retries: 3,
  },
  {
    id: "p2",
    goal: "test the thing",
    deliverable: "tests pass",
    verify: { type: "shell", cmd: "exit 0", timeout_ms: 5000, expect_exit: 0 },
    done_criteria: "tests green",
    risky: false,
    max_retries: 3,
  },
];

function parseToolText(result: unknown): unknown {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

describe("MCP server — tool surface", () => {
  test("lists 9 tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "current_phase",
      "halt",
      "mark_done",
      "queue_followup",
      "record_approval",
      "request_approval",
      "revise_plan",
      "start_plan",
      "verify_phase",
    ]);
  });
});

describe("MCP server — full plan lifecycle", () => {
  test("start_plan → current_phase → verify_phase → mark_done × 2 = plan_complete", async () => {
    const start = await client.callTool({
      name: "start_plan",
      arguments: { goal: "smoke test goal", phases: samplePhases },
    });
    const startData = parseToolText(start) as { first_phase: { id: string }; phase_count: number };
    expect(startData.first_phase.id).toBe("p1");
    expect(startData.phase_count).toBe(2);

    const cp1 = await client.callTool({ name: "current_phase", arguments: {} });
    const cp1Data = parseToolText(cp1) as { status: string; phase: { id: string } };
    expect(cp1Data.status).toBe("active");
    expect(cp1Data.phase.id).toBe("p1");

    const verify1 = await client.callTool({ name: "verify_phase", arguments: {} });
    const v1Data = parseToolText(verify1) as { ok: boolean };
    expect(v1Data.ok).toBe(true);

    const done1 = await client.callTool({
      name: "mark_done",
      arguments: { evidence: "thing.txt was created" },
    });
    const d1Data = parseToolText(done1) as {
      plan_complete: boolean;
      next_phase: { id: string } | null;
    };
    expect(d1Data.plan_complete).toBe(false);
    expect(d1Data.next_phase?.id).toBe("p2");

    const verify2 = await client.callTool({ name: "verify_phase", arguments: {} });
    expect((parseToolText(verify2) as { ok: boolean }).ok).toBe(true);

    const done2 = await client.callTool({
      name: "mark_done",
      arguments: { evidence: "tests pass" },
    });
    const d2Data = parseToolText(done2) as { plan_complete: boolean };
    expect(d2Data.plan_complete).toBe(true);

    const cpFinal = await client.callTool({ name: "current_phase", arguments: {} });
    expect((parseToolText(cpFinal) as { status: string }).status).toBe("plan_complete");
  });

  test("verify failure → retry counter increments", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: {
        goal: "fail test",
        phases: [
          {
            id: "fail-1",
            goal: "g",
            deliverable: "d",
            verify: { type: "shell", cmd: "exit 1", timeout_ms: 5000, expect_exit: 0 },
            done_criteria: "c",
            risky: false,
            max_retries: 3,
          },
        ],
      },
    });
    const v1 = await client.callTool({ name: "verify_phase", arguments: {} });
    expect((parseToolText(v1) as { ok: boolean; retries: number }).ok).toBe(false);
    expect((parseToolText(v1) as { retries: number }).retries).toBe(1);

    const v2 = await client.callTool({ name: "verify_phase", arguments: {} });
    expect((parseToolText(v2) as { retries: number }).retries).toBe(2);
  });

  test("verify_phase escalates after max_retries", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: {
        goal: "escalation test",
        phases: [
          {
            id: "fail-1",
            goal: "g",
            deliverable: "d",
            verify: { type: "shell", cmd: "exit 1", timeout_ms: 5000, expect_exit: 0 },
            done_criteria: "c",
            risky: false,
            max_retries: 2,
          },
        ],
      },
    });
    await client.callTool({ name: "verify_phase", arguments: {} });
    const v2 = await client.callTool({ name: "verify_phase", arguments: {} });
    const v2Data = parseToolText(v2) as { escalated: boolean };
    expect(v2Data.escalated).toBe(true);

    const cp = await client.callTool({ name: "current_phase", arguments: {} });
    expect((parseToolText(cp) as { status: string }).status).toBe("awaiting_approval");
  });

  test("mark_done rejected when phase not passed", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: { goal: "g", phases: samplePhases },
    });
    // skip verify_phase
    const done = await client.callTool({
      name: "mark_done",
      arguments: { evidence: "lying about it" },
    });
    expect(done.isError).toBe(true);
  });

  test("revise_plan replaces remaining phases", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: { goal: "g", phases: samplePhases },
    });
    const revised = await client.callTool({
      name: "revise_plan",
      arguments: {
        from_phase_id: "p1",
        new_phases: [
          {
            id: "p1-new",
            goal: "revised goal",
            deliverable: "d",
            verify: { type: "shell", cmd: "exit 0", timeout_ms: 5000, expect_exit: 0 },
            done_criteria: "c",
            risky: false,
            max_retries: 3,
          },
        ],
      },
    });
    const data = parseToolText(revised) as {
      active_phase: { id: string };
      new_phase_count: number;
    };
    expect(data.active_phase.id).toBe("p1-new");
    expect(data.new_phase_count).toBe(1);
  });

  test("request_approval → record_approval round trip", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: { goal: "g", phases: samplePhases },
    });
    await client.callTool({
      name: "request_approval",
      arguments: { question: "Proceed?", options: ["yes", "no"] },
    });
    const cp = await client.callTool({ name: "current_phase", arguments: {} });
    expect((parseToolText(cp) as { status: string }).status).toBe("awaiting_approval");

    await client.callTool({
      name: "record_approval",
      arguments: { answer: "yes" },
    });
    const cp2 = await client.callTool({ name: "current_phase", arguments: {} });
    expect((parseToolText(cp2) as { status: string }).status).toBe("active");
  });

  test("halt blocks subsequent calls", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: { goal: "g", phases: samplePhases },
    });
    await client.callTool({ name: "halt", arguments: { reason: "test halt" } });
    const cp = await client.callTool({ name: "current_phase", arguments: {} });
    const data = parseToolText(cp) as { status: string; reason: string };
    expect(data.status).toBe("halted");
    expect(data.reason).toBe("test halt");

    const verify = await client.callTool({ name: "verify_phase", arguments: {} });
    expect(verify.isError).toBe(true);
  });

  test("queue_followup persists", async () => {
    await client.callTool({
      name: "start_plan",
      arguments: { goal: "g", phases: samplePhases },
    });
    await client.callTool({
      name: "queue_followup",
      arguments: { prompt: "consider migrating module X" },
    });
    await client.callTool({
      name: "queue_followup",
      arguments: { prompt: "review tech debt in dir Y" },
    });
    const result = await client.callTool({
      name: "queue_followup",
      arguments: { prompt: "third one" },
    });
    expect((parseToolText(result) as { queued: number }).queued).toBe(3);
  });
});
