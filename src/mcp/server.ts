#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { type Phase, PhaseSchema, type Plan, type State } from "../core/schemas.ts";
import {
  activePhase,
  activePhaseState,
  initState,
  logEvent,
  readState,
  writeHalt,
  writeState,
} from "../core/state.ts";
import { runVerifier } from "../core/verify.ts";

const cwd = process.env.AUTOPILOT_CWD || process.cwd();

const server = new McpServer({
  name: "autopilot",
  version: "0.1.0",
});

// ---------- start_plan ----------
server.registerTool(
  "start_plan",
  {
    title: "Start autopilot plan",
    description:
      "Initialize a multi-phase autopilot plan. Call exactly once after the user invokes /autopilot <goal>. " +
      "Each phase needs: id, goal, deliverable, verify, done_criteria, risky, max_retries. " +
      "verify is one of: shell, http, playwright, all, any. " +
      "Returns the first phase. After this, do the work for phase 1, then verify_phase, then mark_done.",
    inputSchema: {
      goal: z.string().min(1).max(1000).describe("Overall plan goal."),
      phases: z
        .array(PhaseSchema)
        .min(1)
        .max(50)
        .describe("Ordered phases. 3–10 is typical; up to 50 allowed."),
      max_continuations: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe("Hard cap on stop-hook forced continuations. Default 30."),
    },
  },
  async ({ goal, phases, max_continuations }) => {
    const existing = readState(cwd);
    if (existing && !existing.halted) {
      return errText(
        `A plan is already active (phase ${existing.current_phase_idx + 1}/${existing.plan.phases.length}). Call current_phase() to resume, or halt() then start_plan() to reset.`,
      );
    }
    const plan: Plan = { goal, phases };
    const state = initState(cwd, plan, { max_continuations });
    return ok({
      session_id: state.session_id,
      first_phase: phases[0],
      phase_count: phases.length,
      max_continuations: state.max_continuations,
    });
  },
);

// ---------- current_phase ----------
server.registerTool(
  "current_phase",
  {
    title: "Get active phase + status",
    description:
      "Return the active phase and its status. Always call this first thing on every turn (after the initial activation turn). " +
      "Branches: status='active' do work, 'awaiting_approval' surface the question, 'halted' stop, 'plan_complete' summarize, 'no_plan' wait for user activation.",
    inputSchema: {},
  },
  async () => {
    const state = readState(cwd);
    if (!state) {
      return ok({
        status: "no_plan",
        message: "No autopilot plan active. Wait for /autopilot <goal>.",
      });
    }
    if (state.halted) {
      return ok({ status: "halted", reason: state.halt_reason });
    }
    if (state.awaiting_approval) {
      return ok({
        status: "awaiting_approval",
        approval: state.awaiting_approval,
        instructions:
          "Surface the question to the user, then end the turn. On the next turn, after the user replies, call record_approval({ answer }).",
      });
    }
    const phase = activePhase(state);
    if (!phase) {
      return ok({
        status: "plan_complete",
        message: "All phases done.",
        followups: state.followup_queue,
        log_tail: state.log.slice(-5),
      });
    }
    const ps = activePhaseState(state)!;
    return ok({
      status: "active",
      phase_idx: state.current_phase_idx,
      total_phases: state.plan.phases.length,
      phase,
      phase_status: ps.status,
      retries: ps.retries,
      max_retries: phase.max_retries,
      last_failure: ps.last_failure,
      continuations_used: state.continuations_used,
      max_continuations: state.max_continuations,
    });
  },
);

// ---------- verify_phase ----------
server.registerTool(
  "verify_phase",
  {
    title: "Run active phase verifier",
    description:
      "Execute the active phase's verifier (shell/http/playwright/composite). " +
      "Updates phase status to passed or failed. After ok=true, call mark_done(). " +
      "After ok=false, read evidence, fix the root cause, and call verify_phase again. " +
      "At max_retries the server auto-escalates to awaiting_approval.",
    inputSchema: {},
  },
  async () => {
    const state = readState(cwd);
    if (!state) return errText("no plan active");
    if (state.halted) return errText("plan halted");
    const phase = activePhase(state);
    if (!phase) return errText("no active phase (plan complete)");
    const ps = state.phase_state[phase.id]!;

    ps.status = "verifying";
    writeState(cwd, state);

    const result = await runVerifier(phase.verify, cwd);

    if (result.ok) {
      ps.status = "passed";
      ps.evidence = result.evidence;
      ps.last_failure = null;
    } else {
      ps.status = "failed";
      ps.retries += 1;
      ps.last_failure = result.evidence;
      if (ps.retries >= phase.max_retries) {
        state.awaiting_approval = {
          question: `Phase "${phase.id}" failed ${ps.retries} times (max_retries=${phase.max_retries}).\n\nLatest failure:\n${truncate(result.evidence, 1500)}\n\nReply with one of: 'retry' (give it another attempt), 'revise' (rewrite the plan from this phase), or 'halt' (stop the plan).`,
          options: ["retry", "revise", "halt"],
          asked_at: new Date().toISOString(),
        };
        ps.status = "blocked";
      }
    }
    logEvent(state, "verify_phase", {
      phase_id: phase.id,
      ok: result.ok,
      retries: ps.retries,
      escalated: ps.status === "blocked",
    });
    writeState(cwd, state);

    return ok({
      ok: result.ok,
      evidence: result.evidence,
      failures: result.failures,
      retries: ps.retries,
      max_retries: phase.max_retries,
      escalated: ps.status === "blocked",
    });
  },
);

// ---------- mark_done ----------
server.registerTool(
  "mark_done",
  {
    title: "Mark active phase complete",
    description:
      "Mark the active phase done. Only succeeds if verify_phase last returned ok=true (status='passed'). Advances to the next phase. " +
      "If no next phase, the plan is complete and the loop will stop.",
    inputSchema: {
      evidence: z
        .string()
        .min(1)
        .max(2000)
        .describe("One-paragraph human-readable summary of what was delivered."),
    },
  },
  async ({ evidence }) => {
    const state = readState(cwd);
    if (!state) return errText("no plan active");
    if (state.halted) return errText("plan halted");
    const phase = activePhase(state);
    if (!phase) return errText("no active phase");
    const ps = state.phase_state[phase.id]!;
    if (ps.status !== "passed") {
      return errText(
        `Cannot mark_done — phase status is "${ps.status}", expected "passed". Call verify_phase() first and ensure ok=true.`,
      );
    }
    ps.completed_at = new Date().toISOString();
    ps.evidence = evidence;

    state.current_phase_idx += 1;
    const nextPhase = state.plan.phases[state.current_phase_idx];
    if (nextPhase) {
      const nps = state.phase_state[nextPhase.id]!;
      nps.status = "in_progress";
      nps.started_at = new Date().toISOString();
    }
    logEvent(state, "mark_done", { phase_id: phase.id });
    writeState(cwd, state);

    return ok({
      completed: phase.id,
      next_phase: nextPhase ?? null,
      plan_complete: !nextPhase,
      progress: `${state.current_phase_idx}/${state.plan.phases.length}`,
    });
  },
);

// ---------- revise_plan ----------
server.registerTool(
  "revise_plan",
  {
    title: "Revise remaining phases",
    description:
      "Replace phases starting at from_phase_id. Use when remaining phases are wrong (new info, blocked dependency). " +
      "Cannot revise already-completed phases. The first new phase becomes active.",
    inputSchema: {
      from_phase_id: z
        .string()
        .min(1)
        .describe("First phase id to replace. Must be the active phase or a later one."),
      new_phases: z.array(PhaseSchema).min(1).max(50).describe("Replacement phases."),
    },
  },
  async ({ from_phase_id, new_phases }) => {
    const state = readState(cwd);
    if (!state) return errText("no plan active");
    if (state.halted) return errText("plan halted");

    const idx = state.plan.phases.findIndex((p) => p.id === from_phase_id);
    if (idx < 0) return errText(`phase "${from_phase_id}" not found`);
    if (idx < state.current_phase_idx) {
      return errText(
        `Cannot revise completed phases. Active phase index is ${state.current_phase_idx}, but ${from_phase_id} is at ${idx}.`,
      );
    }

    const newIds = new Set(new_phases.map((p) => p.id));
    if (newIds.size !== new_phases.length) {
      return errText("duplicate phase ids in new_phases");
    }
    const completedIds = new Set(state.plan.phases.slice(0, idx).map((p) => p.id));
    for (const np of new_phases) {
      if (completedIds.has(np.id)) {
        return errText(`phase id "${np.id}" collides with a completed phase`);
      }
    }

    state.plan.phases = [...state.plan.phases.slice(0, idx), ...new_phases];
    for (const p of new_phases) {
      if (!state.phase_state[p.id]) {
        state.phase_state[p.id] = {
          status: "pending",
          retries: 0,
          evidence: null,
          last_failure: null,
          started_at: null,
          completed_at: null,
        };
      }
    }
    state.current_phase_idx = idx;
    const firstNew = new_phases[0]!;
    const firstPs = state.phase_state[firstNew.id]!;
    firstPs.status = "in_progress";
    firstPs.started_at = new Date().toISOString();
    firstPs.retries = 0;
    firstPs.last_failure = null;

    logEvent(state, "revise_plan", { from: from_phase_id, count: new_phases.length });
    writeState(cwd, state);

    return ok({
      new_phase_count: state.plan.phases.length,
      active_phase: firstNew,
    });
  },
);

// ---------- request_approval ----------
server.registerTool(
  "request_approval",
  {
    title: "Pause for user approval",
    description:
      "Pause autopilot for user approval before doing something risky or ambiguous. " +
      "After this, surface the question in your final message and end the turn. " +
      "On the next turn, call record_approval({ answer }) with the user's reply.",
    inputSchema: {
      question: z.string().min(1).max(2000).describe("Question to surface to the user."),
      options: z
        .array(z.string())
        .max(10)
        .optional()
        .describe("Optional list of suggested response options."),
    },
  },
  async ({ question, options }) => {
    const state = readState(cwd);
    if (!state) return errText("no plan active");
    state.awaiting_approval = {
      question,
      options,
      asked_at: new Date().toISOString(),
    };
    logEvent(state, "request_approval", { question });
    writeState(cwd, state);
    return ok({
      paused: true,
      instructions:
        "End your turn now. Surface the question clearly in your final message. The stop hook will allow stop while awaiting_approval is set.",
    });
  },
);

// ---------- record_approval ----------
server.registerTool(
  "record_approval",
  {
    title: "Record user's approval answer",
    description:
      "Record the user's answer to a pending approval and clear the pause. Call this on the turn after the user replies. " +
      "Then act on the answer (proceed, revise_plan, halt, etc.).",
    inputSchema: {
      answer: z.string().min(1).max(4000).describe("The user's answer, verbatim or summarized."),
    },
  },
  async ({ answer }) => {
    const state = readState(cwd);
    if (!state) return errText("no plan active");
    if (!state.awaiting_approval) return errText("no pending approval");
    logEvent(state, "record_approval", {
      question: state.awaiting_approval.question,
      answer,
    });
    state.awaiting_approval = null;
    writeState(cwd, state);
    return ok({ resumed: true });
  },
);

// ---------- queue_followup ----------
server.registerTool(
  "queue_followup",
  {
    title: "Queue follow-up suggestion",
    description:
      "Queue a follow-up prompt to surface to the user after the plan completes (e.g., 'consider migrating module X next').",
    inputSchema: {
      prompt: z.string().min(1).max(2000),
    },
  },
  async ({ prompt }) => {
    const state = readState(cwd);
    if (!state) return errText("no plan active");
    state.followup_queue.push(prompt);
    logEvent(state, "queue_followup", { prompt });
    writeState(cwd, state);
    return ok({ queued: state.followup_queue.length });
  },
);

// ---------- halt ----------
server.registerTool(
  "halt",
  {
    title: "Hard-stop autopilot",
    description:
      "Hard-stop the autopilot. Use when blocked by a missing credential, external dependency down, or unrecoverable error. " +
      "Writes a halt marker; the stop hook will respect it and allow termination.",
    inputSchema: {
      reason: z.string().min(1).max(2000),
    },
  },
  async ({ reason }) => {
    const state = readState(cwd);
    if (state) {
      state.halted = true;
      state.halt_reason = reason;
      logEvent(state, "halt", { reason });
      writeState(cwd, state);
    }
    writeHalt(cwd, reason);
    return ok({ halted: true, reason });
  },
);

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errText(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}\n…(truncated, ${s.length - n} more chars)`;
}

const transport = new StdioServerTransport();
await server.connect(transport);
