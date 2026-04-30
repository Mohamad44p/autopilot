import { spawn } from "node:child_process";
import type { Verify } from "./schemas.ts";

const IS_WINDOWS = process.platform === "win32";
const KILL_GRACE_MS = 2000;

export type VerifyResult = {
  ok: boolean;
  evidence: string;
  failures: string[];
};

export async function runVerifier(verify: Verify, defaultCwd: string): Promise<VerifyResult> {
  switch (verify.type) {
    case "shell":
      return runShell(verify, defaultCwd);
    case "http":
      return runHttp(verify);
    case "playwright":
      return runPlaywright(verify, defaultCwd);
    case "all":
      return runAll(verify, defaultCwd);
    case "any":
      return runAny(verify, defaultCwd);
  }
}

function shellQuote(s: string): string {
  if (process.platform === "win32") {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (IS_WINDOWS) {
      // /T = tree kill, /F = force, kill cmd.exe and all its descendants
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    // best-effort
  }
}

async function runShell(
  v: Extract<Verify, { type: "shell" }>,
  defaultCwd: string,
): Promise<VerifyResult> {
  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (result: VerifyResult): void => {
      if (resolved) return;
      resolved = true;
      resolve(result);
    };

    const child = spawn(v.cmd, {
      shell: true,
      cwd: v.cwd ?? defaultCwd,
      env: { ...process.env, ...(v.env ?? {}) },
      detached: !IS_WINDOWS, // unix process group for kill -pid
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let killFallback: NodeJS.Timeout | null = null;

    const killTimeout = setTimeout(() => {
      killed = true;
      killTree(child.pid);
      killFallback = setTimeout(() => {
        safeResolve({
          ok: false,
          evidence: [
            `cmd: ${v.cmd}`,
            `cwd: ${v.cwd ?? defaultCwd}`,
            `timeout after ${v.timeout_ms}ms; process did not exit within ${KILL_GRACE_MS}ms of SIGKILL`,
            "--- stdout ---",
            truncate(stdout, 4000),
            "--- stderr ---",
            truncate(stderr, 4000),
          ].join("\n"),
          failures: [`timeout after ${v.timeout_ms}ms`],
        });
      }, KILL_GRACE_MS);
    }, v.timeout_ms);

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 200_000) stdout = stdout.slice(-200_000);
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-200_000);
    });
    child.on("close", (code) => {
      clearTimeout(killTimeout);
      if (killFallback) clearTimeout(killFallback);
      const expected = v.expect_exit;
      const ok = !killed && code === expected;
      const evidence = [
        `cmd: ${v.cmd}`,
        `cwd: ${v.cwd ?? defaultCwd}`,
        `exit: ${code}${killed ? " (killed by timeout)" : ""}`,
        "--- stdout ---",
        truncate(stdout, 4000),
        "--- stderr ---",
        truncate(stderr, 4000),
      ].join("\n");
      safeResolve({
        ok,
        evidence,
        failures: ok
          ? []
          : [killed ? `timeout after ${v.timeout_ms}ms` : `exit ${code} != expected ${expected}`],
      });
    });
    child.on("error", (err) => {
      clearTimeout(killTimeout);
      if (killFallback) clearTimeout(killFallback);
      safeResolve({
        ok: false,
        evidence: `spawn error: ${err.message}\ncmd: ${v.cmd}`,
        failures: [err.message],
      });
    });
  });
}

async function runHttp(v: Extract<Verify, { type: "http" }>): Promise<VerifyResult> {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), v.timeout_ms);
  try {
    const res = await fetch(v.url, {
      method: v.method,
      headers: v.headers,
      body: v.body,
      signal: ctrl.signal,
    });
    const body = await res.text();
    const expectedStatuses = Array.isArray(v.expect_status) ? v.expect_status : [v.expect_status];
    const statusOk = expectedStatuses.includes(res.status);
    let bodyOk = true;
    let bodyErr = "";
    if (v.expect_body_regex) {
      try {
        const re = new RegExp(v.expect_body_regex);
        bodyOk = re.test(body);
        if (!bodyOk) bodyErr = `body did not match /${v.expect_body_regex}/`;
      } catch (err) {
        bodyOk = false;
        bodyErr = `invalid regex: ${(err as Error).message}`;
      }
    }
    const ok = statusOk && bodyOk;
    const failures: string[] = [];
    if (!statusOk) failures.push(`status ${res.status} not in [${expectedStatuses.join(",")}]`);
    if (!bodyOk) failures.push(bodyErr);
    return {
      ok,
      evidence: [
        `${v.method} ${v.url}`,
        `status: ${res.status}`,
        `body (first 500): ${truncate(body, 500)}`,
      ].join("\n"),
      failures,
    };
  } catch (err) {
    const e = err as Error;
    const msg = e.name === "AbortError" ? `timeout after ${v.timeout_ms}ms` : e.message;
    return {
      ok: false,
      evidence: `http error on ${v.method} ${v.url}: ${msg}`,
      failures: [msg],
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runPlaywright(
  v: Extract<Verify, { type: "playwright" }>,
  defaultCwd: string,
): Promise<VerifyResult> {
  const parts = ["bunx", "playwright", "test", shellQuote(v.spec)];
  if (v.config) parts.push("--config", shellQuote(v.config));
  return runShell(
    {
      type: "shell",
      cmd: parts.join(" "),
      cwd: v.cwd ?? defaultCwd,
      timeout_ms: v.timeout_ms,
      expect_exit: 0,
    },
    defaultCwd,
  );
}

async function runAll(v: Extract<Verify, { type: "all" }>, cwd: string): Promise<VerifyResult> {
  const results: VerifyResult[] = [];
  for (const sub of v.verifiers) {
    const r = await runVerifier(sub, cwd);
    results.push(r);
    if (!r.ok) break;
  }
  const ok = results.length === v.verifiers.length && results.every((r) => r.ok);
  return {
    ok,
    evidence: results
      .map((r, i) => `[all #${i}] ${r.ok ? "OK" : "FAIL"}\n${r.evidence}`)
      .join("\n\n"),
    failures: results.flatMap((r) => r.failures),
  };
}

async function runAny(v: Extract<Verify, { type: "any" }>, cwd: string): Promise<VerifyResult> {
  const results: VerifyResult[] = [];
  for (const sub of v.verifiers) {
    const r = await runVerifier(sub, cwd);
    results.push(r);
    if (r.ok) {
      return {
        ok: true,
        evidence: `[any #${results.length - 1}] OK\n${r.evidence}`,
        failures: [],
      };
    }
  }
  return {
    ok: false,
    evidence: results.map((r, i) => `[any #${i}] FAIL\n${r.evidence}`).join("\n\n"),
    failures: results.flatMap((r) => r.failures),
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}\n…(truncated, ${s.length - n} more chars)`;
}
