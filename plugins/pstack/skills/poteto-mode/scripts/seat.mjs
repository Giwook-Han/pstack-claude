#!/usr/bin/env node
// Runs one provider seat: a panel, judge, or reviewer entry from pstack-models.md
// written `<provider>:<model>`, with an optional `@<level>`, on that provider's
// own CLI and subscription. The seat is read-only and isolated from this
// machine's agent config, and its final answer lands in --out.
//
// Usage:
//   node seat.mjs --seat '<entry>' --prompt-file <file> --out <file>
//                 [--cwd <dir>] [--timeout-sec <n>] [--dry-run]
//
// Prints one JSON line: { seat, provider, model, level, status, seconds, out, log, error? }.
// Exit 0 when the seat answered, 1 when it failed or timed out, 2 on a usage error.
// A failed seat is never retried on another model; the caller records a dropout.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reasoning levels each provider's CLI accepts. A model may accept fewer; the
// CLI then fails the seat. Kept equal to models.json's "providers" by a test.
export const PROVIDERS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

const DEFAULT_TIMEOUT_SEC = 3600;
const KILL_GRACE_MS = 10_000;
const ERROR_TAIL = 600;

class UsageError extends Error {}

const SEAT_RE = /^([a-z]+):([a-z0-9][a-z0-9.-]*)(?:\s+@([a-z]+))?$/;

export function parseSeat(entry) {
  const match = SEAT_RE.exec(String(entry ?? "").trim());
  if (!match) throw new UsageError(`seat "${entry}" is not <provider>:<model> [@level]`);
  const [, provider, model, level] = match;
  if (!Object.hasOwn(PROVIDERS, provider)) {
    throw new UsageError(`unknown provider "${provider}"; expected one of ${Object.keys(PROVIDERS).join(", ")}`);
  }
  if (level && !PROVIDERS[provider].includes(level)) {
    throw new UsageError(`${provider} takes the levels ${PROVIDERS[provider].join(", ")}, not "${level}"`);
  }
  return { provider, model, level: level ?? null };
}

// Grok Build loads Claude Code and Cursor config by default: CLAUDE.md, their
// skills, hooks, rules, and MCP servers. A seat answers from the prompt alone.
const GROK_ISOLATION = Object.fromEntries(
  ["CLAUDE", "CURSOR"].flatMap((vendor) =>
    ["AGENTS", "SKILLS", "HOOKS", "RULES", "MCPS"].map((kind) => [`GROK_${vendor}_${kind}_ENABLED`, "0"]),
  ),
);

// How each provider runs read-only and headless. `answer` names where the final
// message comes from: "text" (stdout JSON .text), "result" (stdout JSON .result),
// or "file" (the CLI writes --out itself).
export function seatCommand({ provider, model, level }, { promptFile, out, cwd }) {
  if (provider === "grok") {
    return {
      command: "grok",
      args: [
        "--prompt-file", promptFile,
        "-m", model,
        ...(level ? ["--effort", level] : []),
        "--output-format", "json",
        "--cwd", cwd,
        "--tools", "read_file,grep,list_dir",
        "--no-subagents",
        "--disable-web-search",
        "--no-auto-update",
      ],
      env: GROK_ISOLATION,
      cwd,
      stdin: null,
      answer: "text",
    };
  }
  if (provider === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "-s", "read-only",
        "-C", cwd,
        "-m", model,
        ...(level ? ["-c", `model_reasoning_effort="${level}"`] : []),
        "-o", out,
        "-",
      ],
      env: {},
      cwd,
      stdin: promptFile,
      answer: "file",
    };
  }
  // claude: user settings (plugins, hooks) and MCP servers stay off; OAuth
  // still works, which --bare would not allow.
  return {
    command: "claude",
    args: [
      "-p",
      "--model", model,
      ...(level ? ["--effort", level] : []),
      "--output-format", "json",
      "--permission-mode", "dontAsk",
      "--allowedTools", "Read,Grep,Glob",
      "--setting-sources", "project,local",
      "--strict-mcp-config",
      "--no-session-persistence",
    ],
    env: {},
    cwd,
    stdin: promptFile,
    answer: "result",
  };
}

function parseArgs(argv) {
  const opts = { timeoutSec: DEFAULT_TIMEOUT_SEC, dryRun: false };
  const takes = { "--seat": "seat", "--prompt-file": "promptFile", "--out": "out", "--cwd": "cwd", "--timeout-sec": "timeoutSec" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
      continue;
    }
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (!Object.hasOwn(takes, flag)) throw new UsageError(`unknown argument "${arg}"`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") throw new UsageError(`${flag} needs a value`);
    opts[takes[flag]] = value;
  }
  for (const flag of ["--seat", "--prompt-file", "--out"]) {
    if (!opts[takes[flag]]) throw new UsageError(`${flag} is required`);
  }
  opts.timeoutSec = Number(opts.timeoutSec);
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0) throw new UsageError("--timeout-sec must be a positive number");
  opts.promptFile = resolve(opts.promptFile);
  opts.out = resolve(opts.out);
  opts.cwd = resolve(opts.cwd ?? process.cwd());
  if (!existsSync(opts.promptFile) || statSync(opts.promptFile).size === 0) {
    throw new UsageError(`prompt file ${opts.promptFile} is missing or empty`);
  }
  if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) throw new UsageError(`--cwd ${opts.cwd} is not a directory`);
  return opts;
}

const tail = (text) => {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > ERROR_TAIL ? "..." + trimmed.slice(-ERROR_TAIL) : trimmed;
};

function extractAnswer(spec, stdout, out) {
  if (spec.answer === "file") return existsSync(out) ? readFileSync(out, "utf8") : "";
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`${spec.command} printed no JSON result: ${tail(stdout)}`);
  }
  if (spec.answer === "result" && parsed.is_error) throw new Error(`${spec.command} reported an error: ${tail(parsed.result)}`);
  const answer = parsed[spec.answer];
  return typeof answer === "string" ? answer : "";
}

function runSeat(spec, opts) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (spec.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(readFileSync(spec.stdin));
    }
    const kill = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, opts.timeoutSec * 1000);
    const finish = (code, spawnError) => {
      clearTimeout(timer);
      done({ code, spawnError, stdout, stderr, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10 });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

async function main(argv) {
  let opts;
  let seat;
  try {
    opts = parseArgs(argv);
    seat = parseSeat(opts.seat);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`seat.mjs: ${error.message}\n`);
    return 2;
  }
  const spec = seatCommand(seat, opts);
  if (opts.dryRun) {
    process.stdout.write(JSON.stringify({ ...seat, ...spec }) + "\n");
    return 0;
  }
  mkdirSync(dirname(opts.out), { recursive: true });
  rmSync(opts.out, { force: true });
  const log = `${opts.out}.log`;
  const result = await runSeat(spec, opts);
  writeFileSync(log, `$ ${spec.command} ${spec.args.join(" ")}\n\n[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`);
  const summary = { seat: opts.seat.trim(), ...seat, status: "ok", seconds: result.seconds, out: opts.out, log };
  let error = null;
  if (result.spawnError) error = `could not start ${spec.command}: ${result.spawnError.message}`;
  else if (result.timedOut) {
    summary.status = "timeout";
    error = `no answer within ${opts.timeoutSec}s`;
  } else if (result.code !== 0) error = `${spec.command} exited ${result.code}: ${tail(result.stderr || result.stdout)}`;
  else {
    try {
      const answer = extractAnswer(spec, result.stdout, opts.out);
      if (!answer.trim()) error = "the seat returned an empty answer";
      else writeFileSync(opts.out, answer.endsWith("\n") ? answer : answer + "\n");
    } catch (failure) {
      error = failure.message;
    }
  }
  if (error) {
    if (summary.status === "ok") summary.status = "failed";
    summary.error = error;
    rmSync(opts.out, { force: true });
  }
  process.stdout.write(JSON.stringify(summary) + "\n");
  return error ? 1 : 0;
}

// Run only as a script, so tests can import the exports. argv[1] may be a
// symlinked plugin path or not a file at all under a test runner.
function invokedDirectly() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) process.exitCode = await main(process.argv.slice(2));
