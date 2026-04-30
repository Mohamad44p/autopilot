#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { autopilotDir, haltPath, readState, statePath, writeHalt } from "../core/state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AUTOPILOT_PATH = ROOT;

type Adapter = "claude" | "codex" | "cursor";
const ADAPTERS: Adapter[] = ["claude", "codex", "cursor"];

function help(): void {
  process.stdout.write(`autopilot — loop-keeper for AI coding agents

Usage:
  autopilot init <claude|codex|cursor> [--cwd <path>] [--force]
      Scaffold the chosen adapter into a project. Idempotent: merges into
      existing config files where possible.

  autopilot serve
      Run the MCP server on stdio (used internally by adapters).

  autopilot status [--cwd <path>]
      Show the current plan state.

  autopilot halt [reason] [--cwd <path>]
      Mark the active plan halted.

  autopilot resume [--cwd <path>]
      Clear halt marker so the loop can continue.

  autopilot reset [--cwd <path>]
      Delete .autopilot/state.json and halt marker (irreversible).

  autopilot help
      Show this message.
`);
}

function parseFlag(args: string[], name: string): { value?: string; rest: string[] } {
  const idx = args.indexOf(name);
  if (idx < 0) return { rest: args };
  const value = args[idx + 1];
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)];
  return { value, rest };
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function resolveCwd(args: string[]): { cwd: string; rest: string[] } {
  const { value, rest } = parseFlag(args, "--cwd");
  return { cwd: value ? resolve(value) : process.cwd(), rest };
}

const args = process.argv.slice(2);
const cmd = args[0];

try {
  switch (cmd) {
    case "init":
      await initCmd(args.slice(1));
      break;
    case "serve":
      await serveCmd();
      break;
    case "status":
      await statusCmd(args.slice(1));
      break;
    case "halt":
      await haltCmd(args.slice(1));
      break;
    case "resume":
      await resumeCmd(args.slice(1));
      break;
    case "reset":
      await resetCmd(args.slice(1));
      break;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      help();
      break;
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`);
      help();
      process.exit(1);
  }
} catch (err) {
  process.stderr.write(`error: ${(err as Error).message}\n`);
  process.exit(1);
}

async function initCmd(rawArgs: string[]): Promise<void> {
  const adapter = rawArgs[0] as Adapter | undefined;
  if (!adapter || !ADAPTERS.includes(adapter)) {
    process.stderr.write("usage: autopilot init <claude|codex|cursor> [--cwd <path>] [--force]\n");
    process.exit(1);
  }
  const { cwd, rest } = resolveCwd(rawArgs.slice(1));
  const force = hasFlag(rest, "--force");

  const vars = {
    AUTOPILOT_PATH: AUTOPILOT_PATH.replace(/\\/g, "/"),
    PROJECT_CWD: cwd.replace(/\\/g, "/"),
  };

  switch (adapter) {
    case "claude":
      initClaude(cwd, vars, force);
      break;
    case "codex":
      initCodex(cwd, vars, force);
      break;
    case "cursor":
      initCursor(cwd, vars, force);
      break;
  }

  // ensure .autopilot dir
  mkdirSync(join(cwd, ".autopilot"), { recursive: true });

  process.stdout.write(`✓ autopilot installed for ${adapter} in ${cwd}\n`);
  process.stdout.write(`  start a session: open the project in ${adapter} and type:\n`);
  process.stdout.write("    /autopilot <your goal>\n");
}

function readTemplate(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf-8");
}

function substitute(content: string, vars: Record<string, string>): string {
  let out = content;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  return out;
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function mergeJson(targetPath: string, patch: Record<string, unknown>, force: boolean): void {
  let existing: Record<string, unknown> = {};
  if (existsSync(targetPath)) {
    if (force) {
      existing = {};
    } else {
      try {
        existing = JSON.parse(readFileSync(targetPath, "utf-8"));
      } catch {
        process.stderr.write(`warn: ${targetPath} is not valid JSON, overwriting\n`);
        existing = {};
      }
    }
  }
  const merged = deepMerge(existing, patch);
  writeFile(targetPath, JSON.stringify(merged, null, 2));
}

function deepMerge(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const existing = out[k];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      v &&
      typeof v === "object" &&
      !Array.isArray(v)
    ) {
      out[k] = deepMerge(existing as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function initClaude(cwd: string, vars: Record<string, string>, force: boolean): void {
  const settingsTpl = JSON.parse(
    substitute(readTemplate("src/adapters/claude-code/settings.template.json"), vars),
  );
  const mcpTpl = JSON.parse(
    substitute(readTemplate("src/adapters/claude-code/mcp.template.json"), vars),
  );

  mergeJson(join(cwd, ".claude", "settings.json"), settingsTpl, force);
  mergeJson(join(cwd, ".mcp.json"), mcpTpl, force);

  const skillContent = readTemplate("src/adapters/claude-code/skill.md");
  writeFile(join(cwd, ".claude", "skills", "autopilot", "SKILL.md"), skillContent);
}

function initCodex(cwd: string, vars: Record<string, string>, force: boolean): void {
  const hooksTpl = JSON.parse(
    substitute(readTemplate("src/adapters/codex/hooks.template.json"), vars),
  );
  const tomlTpl = substitute(readTemplate("src/adapters/codex/config.template.toml"), vars);

  mergeJson(join(cwd, ".codex", "hooks.json"), hooksTpl, force);

  const tomlPath = join(cwd, ".codex", "autopilot.toml");
  writeFile(tomlPath, tomlTpl);

  const agents = readTemplate("src/adapters/codex/AGENTS.md");
  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath) && !force) {
    const current = readFileSync(agentsPath, "utf-8");
    if (!current.includes("# Autopilot Protocol")) {
      writeFile(agentsPath, `${current.trimEnd()}\n\n${agents}`);
    }
  } else {
    writeFile(agentsPath, agents);
  }
}

function initCursor(cwd: string, vars: Record<string, string>, force: boolean): void {
  const hooksTpl = JSON.parse(
    substitute(readTemplate("src/adapters/cursor/hooks.template.json"), vars),
  );
  const mcpTpl = JSON.parse(
    substitute(readTemplate("src/adapters/cursor/mcp.template.json"), vars),
  );

  mergeJson(join(cwd, ".cursor", "hooks.json"), hooksTpl, force);
  mergeJson(join(cwd, ".cursor", "mcp.json"), mcpTpl, force);

  const rules = readTemplate("src/adapters/cursor/rules.mdc");
  writeFile(join(cwd, ".cursor", "rules", "autopilot.mdc"), rules);
}

async function serveCmd(): Promise<void> {
  await import("../mcp/server.ts");
}

async function statusCmd(rawArgs: string[]): Promise<void> {
  const { cwd } = resolveCwd(rawArgs);
  const state = readState(cwd);
  if (!state) {
    process.stdout.write(`no autopilot plan in ${cwd}\n`);
    return;
  }
  const phase = state.plan.phases[state.current_phase_idx];
  const ps = phase ? state.phase_state[phase.id] : null;
  process.stdout.write(`autopilot status — ${cwd}\n`);
  process.stdout.write(`  session: ${state.session_id}\n`);
  process.stdout.write(`  goal: ${state.plan.goal}\n`);
  process.stdout.write(
    `  progress: ${state.current_phase_idx}/${state.plan.phases.length} phases\n`,
  );
  if (phase) {
    process.stdout.write(`  active phase: ${phase.id} — ${phase.goal}\n`);
    process.stdout.write(
      `  phase status: ${ps?.status} (retries ${ps?.retries}/${phase.max_retries})\n`,
    );
  } else {
    process.stdout.write("  active phase: none (plan complete)\n");
  }
  process.stdout.write(`  continuations: ${state.continuations_used}/${state.max_continuations}\n`);
  if (state.halted) process.stdout.write(`  HALTED: ${state.halt_reason}\n`);
  if (state.awaiting_approval) {
    process.stdout.write(
      `  AWAITING APPROVAL: ${state.awaiting_approval.question.slice(0, 200)}\n`,
    );
  }
  if (state.followup_queue.length) {
    process.stdout.write(`  followups queued: ${state.followup_queue.length}\n`);
  }
}

async function haltCmd(rawArgs: string[]): Promise<void> {
  const { cwd, rest } = resolveCwd(rawArgs);
  const reason = rest.join(" ") || "user halt via CLI";
  writeHalt(cwd, reason);
  const state = readState(cwd);
  if (state) {
    state.halted = true;
    state.halt_reason = reason;
    const { writeState, logEvent } = await import("../core/state.ts");
    logEvent(state, "cli_halt", { reason });
    writeState(cwd, state);
  }
  process.stdout.write(`✓ halted: ${reason}\n`);
}

async function resumeCmd(rawArgs: string[]): Promise<void> {
  const { cwd } = resolveCwd(rawArgs);
  const hp = haltPath(cwd);
  if (existsSync(hp)) unlinkSync(hp);
  const state = readState(cwd);
  if (state?.halted) {
    state.halted = false;
    state.halt_reason = null;
    const { writeState, logEvent } = await import("../core/state.ts");
    logEvent(state, "cli_resume");
    writeState(cwd, state);
  }
  process.stdout.write("✓ halt cleared\n");
}

async function resetCmd(rawArgs: string[]): Promise<void> {
  const { cwd } = resolveCwd(rawArgs);
  const sp = statePath(cwd);
  const hp = haltPath(cwd);
  let removed = 0;
  if (existsSync(sp)) {
    unlinkSync(sp);
    removed += 1;
  }
  if (existsSync(hp)) {
    unlinkSync(hp);
    removed += 1;
  }
  process.stdout.write(`✓ reset complete (${removed} files removed in ${autopilotDir(cwd)})\n`);
}
