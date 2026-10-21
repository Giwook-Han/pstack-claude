// seat.mjs runs one provider seat on another provider's CLI. These tests drive
// the real script against fake grok, codex, and claude executables on PATH, so
// they check argument handling, isolation flags, the scrubbed environment,
// answer capture, and the dropout statuses without spending any provider's
// quota. The fakes print the JSON shapes the real CLIs print. The runner scrubs
// the environment, so each prompt carries the fake's mode and the directory it
// reports to.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels } from "../tools/generate.mjs";
import { PREAMBLE, PROVIDERS, parseSeat, seatEnv } from "../plugins/pstack/skills/poteto-mode/scripts/seat.mjs";

const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/seat.mjs", import.meta.url));
// The script runs under node, as the skills invoke it; bun runs these tests.
// Take node's own binary path, since a version-manager shim on PATH stops
// working once a test narrows PATH.
const node = spawnSync("node", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).stdout.trim();

const home = mkdtempSync(join(tmpdir(), "pstack-seat-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const bin = join(home, "bin");
mkdirSync(bin);

// Every fake reads its prompt (a file for grok, stdin for the others), records
// it and whether the parent's test secret reached it, then answers per mode.
const READ_CONTROL = `mode=$(sed -n 's/^mode=//p' "$prompt" | head -n1)
seen=$(sed -n 's/^seen=//p' "$prompt" | head -n1)
cp "$prompt" "$seen/$name.prompt"
printf '%s' "\${PSTACK_TEST_SECRET:-clean}" > "$seen/$name.secret"
last=$(tail -n1 "$prompt")
case "$mode" in
  fail) echo "boom from fake" >&2; exit 3 ;;
  sleep) echo $$ > "$seen/$name.pid"; exec sleep 30 ;;
esac`;
const fakes = {
  grok: `#!/bin/sh
name=grok
while [ $# -gt 0 ]; do case "$1" in --prompt-file) prompt="$2"; shift 2 ;; *) shift ;; esac; done
${READ_CONTROL}
printf '%s' "$GROK_CODEX_SKILLS_ENABLED $GROK_CLAUDE_HOOKS_ENABLED" > "$seen/grok.compat"
case "$mode" in
  empty) printf '{"text":"","stopReason":"end_turn"}\\n'; exit 0 ;;
  cut) printf '{"text":"half an answer","stopReason":"max_tokens"}\\n'; exit 0 ;;
  banner) echo "notice: a newer grok is available"; printf '{"text":"after the banner","stopReason":"EndTurn"}\\n'; exit 0 ;;
  big) awk 'BEGIN { s = ""; for (i = 0; i < 20000; i++) s = s "리뷰"; printf "{\\"text\\":\\"%s\\",\\"stopReason\\":\\"end_turn\\"}\\n", s }'; exit 0 ;;
esac
printf '{"text":"grok saw %s","stopReason":"end_turn","usage":{"input_tokens":5490}}\\n' "$last"
`,
  codex: `#!/bin/sh
name=codex
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
prompt=$(mktemp); cat > "$prompt"
${READ_CONTROL}
printf 'codex saw %s\\n' "$last" > "$out"
`,
  claude: `#!/bin/sh
name=claude
prompt=$(mktemp); cat > "$prompt"
${READ_CONTROL}
[ "$mode" = error ] && { printf '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"usage limit reached"}\\n'; exit 0; }
printf '{"type":"result","subtype":"success","is_error":false,"result":"claude saw %s"}\\n' "$last"
`,
};
for (const [name, body] of Object.entries(fakes)) {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
}

let case_ = 0;
// A fresh prompt, reporting directory, and answer path per run.
function setup(mode = "") {
  const dir = join(home, `case-${++case_}`);
  const seen = join(dir, "seen");
  mkdirSync(seen, { recursive: true });
  const prompt = join(dir, "prompt.md");
  writeFileSync(prompt, `mode=${mode}\nseen=${seen}\nreview this diff\n`);
  return { dir, seen, prompt, out: join(dir, "answers", "answer.md") };
}
const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra });
function run(entry, mode = "", extra = [], extraEnv = {}) {
  const c = setup(mode);
  const r = spawnSync(node, [script, "--seat", entry, "--prompt-file", c.prompt, "--out", c.out, "--cwd", c.dir, ...extra], {
    env: env(extraEnv),
    encoding: "utf8",
  });
  const line = r.stdout.trim();
  return { ...c, status: r.status, summary: line ? JSON.parse(line) : null, err: r.stderr };
}

describe("seat.mjs levels", () => {
  test("each provider's levels are the stamped models.json providers", () => expect(PROVIDERS).toEqual(loadModels().providers));

  test("parses an entry into provider, model, and level", () => {
    expect(parseSeat("grok:grok-4.7 @xhigh")).toEqual({ provider: "grok", model: "grok-4.7", level: "xhigh" });
    expect(parseSeat(" codex:gpt-6-astra ")).toEqual({ provider: "codex", model: "gpt-6-astra", level: null });
  });
});

describe("seat.mjs usage", () => {
  const usage = (args) => {
    const r = spawnSync(node, [script, ...args], { encoding: "utf8" });
    return { status: r.status, err: r.stderr };
  };
  const c = setup();
  const base = ["--prompt-file", c.prompt, "--out", c.out];

  test("rejects an unknown provider, naming the known ones", () =>
    expect(usage(["--seat", "gemini:gemini-3", ...base])).toEqual({
      status: 2,
      err: 'seat.mjs: unknown provider "gemini"; expected one of claude, codex, grok\n',
    }));

  test("rejects a level outside the provider's list", () =>
    expect(usage(["--seat", "claude:opus @ultra", ...base]).err).toContain('claude takes the levels low, medium, high, xhigh, max, not "ultra"'));

  test("rejects an entry without a provider prefix", () => expect(usage(["--seat", "gpt-6-astra", ...base]).status).toBe(2));

  test("requires the prompt file to exist", () =>
    expect(usage(["--seat", "grok:grok-4.7", "--prompt-file", join(c.dir, "none.md"), "--out", c.out]).err).toContain("is missing or empty"));

  test("names a missing required flag", () => expect(usage(["--seat", "grok:grok-4.7"]).err).toContain("--prompt-file is required"));

  test("refuses an answer path that is a directory or the prompt itself", () => {
    expect(usage(["--seat", "grok:grok-4.7", "--prompt-file", c.prompt, "--out", c.dir]).err).toContain("is a directory");
    expect(usage(["--seat", "grok:grok-4.7", "--prompt-file", c.prompt, "--out", c.prompt]).err).toContain("must differ from --prompt-file");
    expect(existsSync(c.prompt)).toBe(true);
  });

  test("refuses a timeout past one day", () =>
    expect(usage(["--seat", "grok:grok-4.7", ...base, "--timeout-sec", "2147484"]).err).toContain("from 1 to 86400"));
});

describe("seat.mjs commands", () => {
  const dry = (entry) => {
    const c = setup();
    const r = spawnSync(node, [script, "--seat", entry, "--prompt-file", c.prompt, "--out", c.out, "--cwd", c.dir, "--dry-run"], { encoding: "utf8" });
    return JSON.parse(r.stdout);
  };

  test("grok runs in its strict sandbox with read tools only and every compatibility scan off", () => {
    const spec = dry("grok:grok-4.7 @xhigh");
    expect(spec.command).toBe("grok");
    expect(spec.args).toEqual(
      expect.arrayContaining(["-m", "grok-4.7", "--effort", "xhigh", "--sandbox", "strict", "--deny", "MCPTool", "--no-subagents", "--disable-web-search"]),
    );
    expect(spec.args.join(" ")).toContain("--tools read_file,grep,list_dir");
    for (const vendor of ["CLAUDE", "CURSOR", "CODEX"]) {
      for (const kind of ["AGENTS", "SKILLS", "HOOKS", "RULES", "MCPS", "SESSIONS"]) expect(spec.env[`GROK_${vendor}_${kind}_ENABLED`]).toBe("0");
    }
  });

  test("codex runs in the read-only sandbox without subagents, hooks, the user's config, or rules", () => {
    const spec = dry("codex:gpt-6-astra @ultra");
    expect(spec.args[0]).toBe("exec");
    expect(spec.args).toEqual(
      expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "multi_agent", "hooks", 'model_reasoning_effort="ultra"']),
    );
  });

  test("claude keeps its login but runs in safe and restricted mode with the read tools only", () => {
    const spec = dry("claude:opus @max");
    expect(spec.args).toEqual(expect.arrayContaining(["-p", "--model", "opus", "--effort", "max", "--safe-mode", "--restricted", "--strict-mcp-config"]));
    expect(spec.args[spec.args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(spec.args[spec.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(spec.args).not.toContain("--bare");
  });

  test("an entry without a level passes no effort flag", () => {
    expect(dry("grok:grok-4.7").args).not.toContain("--effort");
    expect(dry("codex:gpt-6-sol").args.join(" ")).not.toContain("model_reasoning_effort");
  });
});

describe("seat.mjs environment", () => {
  test("keeps the system basics and the seat's own provider variables only", () => {
    const parent = { PATH: "/bin", HOME: "/h", LC_ALL: "C", GH_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", XAI_API_KEY: "x", OPENAI_API_KEY: "x" };
    expect(Object.keys(seatEnv("grok", parent)).sort()).toEqual(["HOME", "LC_ALL", "PATH", "XAI_API_KEY"]);
    expect(Object.keys(seatEnv("codex", parent)).sort()).toEqual(["HOME", "LC_ALL", "OPENAI_API_KEY", "PATH"]);
  });

  test("a secret in the parent's environment never reaches the CLI", () => {
    const r = run("grok:grok-4.7", "", [], { PSTACK_TEST_SECRET: "leaked" });
    expect(r.summary.status).toBe("ok");
    expect(readFileSync(join(r.seen, "grok.secret"), "utf8")).toBe("clean");
    expect(readFileSync(join(r.seen, "grok.compat"), "utf8")).toBe("0 0");
  });
});

describe("seat.mjs runs", () => {
  test.each([
    ["grok:grok-4.7 @xhigh", "grok", "grok saw review this diff\n"],
    ["codex:gpt-6-astra @ultra", "codex", "codex saw review this diff\n"],
    ["claude:opus @max", "claude", "claude saw review this diff\n"],
  ])("%s writes its answer, after the preamble reached the CLI", (entry, name, answer) => {
    const r = run(entry);
    expect(r.status).toBe(0);
    expect(r.summary).toMatchObject({ seat: entry, status: "ok", out: r.out });
    expect(readFileSync(r.out, "utf8")).toBe(answer);
    const seen = readFileSync(join(r.seen, `${name}.prompt`), "utf8");
    expect(seen.startsWith(PREAMBLE)).toBe(true);
    expect(seen.endsWith("review this diff\n")).toBe(true);
  });

  test("keeps the log away from the answer's directory", () => {
    const r = run("grok:grok-4.7");
    expect(existsSync(r.summary.log)).toBe(true);
    expect(dirname(r.summary.log)).not.toBe(dirname(r.out));
  });

  test("a CLI that exits non-zero is a failed seat with its stderr and no answer", () => {
    const r = run("codex:gpt-6-sol", "fail");
    expect(r.status).toBe(1);
    expect(r.summary.status).toBe("failed");
    expect(r.summary.error).toContain("codex exited 3: boom from fake");
    expect(existsSync(r.out)).toBe(false);
  });

  test("an empty answer is a failed seat", () =>
    expect(run("grok:grok-4.7", "empty").summary).toMatchObject({ status: "failed", error: "the seat returned an empty answer" }));

  test("a turn that stopped early is a failed seat, not a short answer", () => {
    const r = run("grok:grok-4.7", "cut");
    expect(r.summary).toMatchObject({ status: "failed", stopReason: "max_tokens", error: "grok stopped early (max_tokens)" });
    expect(existsSync(r.out)).toBe(false);
  });

  test("reads the JSON result past a banner line", () => {
    const r = run("grok:grok-4.7", "banner");
    expect(r.summary.status).toBe("ok");
    expect(readFileSync(r.out, "utf8")).toBe("after the banner\n");
  });

  test("keeps multibyte text intact across pipe reads", () => {
    const r = run("grok:grok-4.7", "big");
    expect(r.summary.status).toBe("ok");
    expect(readFileSync(r.out, "utf8")).toBe("리뷰".repeat(20000) + "\n");
  });

  test("a CLI that reports an error is a failed seat", () => {
    const r = run("claude:opus", "error");
    expect(r.summary.status).toBe("failed");
    expect(r.summary.error).toContain("usage limit reached");
  });

  test("a seat past its time limit is stopped and reported as a timeout", () => {
    const r = run("grok:grok-4.7", "sleep", ["--timeout-sec", "1"]);
    expect(r.status).toBe(1);
    expect(r.summary).toMatchObject({ status: "timeout", error: "no answer within 1s" });
  });

  test("a missing CLI is a failed seat, not a crash", () => {
    const c = setup();
    const r = spawnSync(node, [script, "--seat", "grok:grok-4.7", "--prompt-file", c.prompt, "--out", c.out], {
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("could not start grok");
  });

  test("stopping the runner stops its CLI", async () => {
    const c = setup("sleep");
    const child = spawn(node, [script, "--seat", "grok:grok-4.7", "--prompt-file", c.prompt, "--out", c.out, "--cwd", c.dir], { env: env() });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const pidFile = join(c.seen, "grok.pid");
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(50);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const exited = new Promise((resolve) => child.on("close", resolve));
    child.kill("SIGTERM");
    expect(await exited).toBe(1);
    expect(JSON.parse(stdout.trim())).toMatchObject({ status: "failed", error: "the runner was stopped by SIGTERM" });
    let alive = true;
    for (let i = 0; i < 40 && alive; i++) {
      try {
        process.kill(pid, 0);
        await Bun.sleep(50);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });
});
