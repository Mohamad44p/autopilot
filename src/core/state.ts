import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type Phase, type PhaseState, type Plan, type State, StateSchema } from "./schemas.ts";

export const AUTOPILOT_DIR = ".autopilot";
export const STATE_FILE = "state.json";
export const HALT_FILE = "halt";

export function autopilotDir(cwd: string): string {
  return join(cwd, AUTOPILOT_DIR);
}

export function statePath(cwd: string): string {
  return join(autopilotDir(cwd), STATE_FILE);
}

export function haltPath(cwd: string): string {
  return join(autopilotDir(cwd), HALT_FILE);
}

export function ensureDir(cwd: string): void {
  const dir = autopilotDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function readState(cwd: string): State | null {
  const p = statePath(cwd);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf-8");
  if (!raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`autopilot: state.json is not valid JSON (${(err as Error).message})`);
  }
  return StateSchema.parse(parsed);
}

export function writeState(cwd: string, state: State): void {
  ensureDir(cwd);
  const p = statePath(cwd);
  state.updated_at = new Date().toISOString();
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  renameSync(tmp, p);
}

export function isHalted(cwd: string): boolean {
  return existsSync(haltPath(cwd));
}

export function writeHalt(cwd: string, reason: string): void {
  ensureDir(cwd);
  writeFileSync(haltPath(cwd), reason, "utf-8");
}

export function clearHalt(cwd: string): void {
  const p = haltPath(cwd);
  if (existsSync(p)) unlinkSync(p);
}

export type InitOpts = {
  max_continuations?: number;
  session_id?: string;
};

export function initState(cwd: string, plan: Plan, opts: InitOpts = {}): State {
  const now = new Date().toISOString();
  const phase_state: Record<string, PhaseState> = {};
  for (const phase of plan.phases) {
    phase_state[phase.id] = {
      status: "pending",
      retries: 0,
      evidence: null,
      last_failure: null,
      started_at: null,
      completed_at: null,
    };
  }
  const first = plan.phases[0];
  if (first) {
    const ps = phase_state[first.id]!;
    ps.status = "in_progress";
    ps.started_at = now;
  }
  const state: State = {
    version: 1,
    session_id: opts.session_id ?? randomUUID(),
    created_at: now,
    updated_at: now,
    plan,
    current_phase_idx: 0,
    phase_state,
    continuations_used: 0,
    max_continuations: opts.max_continuations ?? 30,
    awaiting_approval: null,
    followup_queue: [],
    halted: false,
    halt_reason: null,
    log: [
      {
        ts: now,
        kind: "start_plan",
        data: { goal: plan.goal, phase_count: plan.phases.length },
      },
    ],
  };
  writeState(cwd, state);
  return state;
}

export function activePhase(state: State): Phase | null {
  return state.plan.phases[state.current_phase_idx] ?? null;
}

export function activePhaseState(state: State): PhaseState | null {
  const phase = activePhase(state);
  if (!phase) return null;
  return state.phase_state[phase.id] ?? null;
}

export function logEvent(state: State, kind: string, data?: unknown): void {
  state.log.push({ ts: new Date().toISOString(), kind, data });
  if (state.log.length > 500) {
    state.log = state.log.slice(-500);
  }
}
