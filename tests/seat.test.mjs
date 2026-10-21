// seat.mjs runs one provider seat on another provider's CLI. These tests drive
// the real script against fake grok, codex, and claude executables on PATH, so
// they check argument handling, isolation, answer capture, and the dropout
// statuses without spending any provider's quota.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PROVIDERS, parseSeat } from "../plugins/pstack/skills/poteto-mode/scripts/seat.mjs";

const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/seat.mjs", import.meta.url));
const models = JSON.parse(readFileSync(fileURLToPath(new URL("../plugins/pstack/models.json", import.meta.url)), "utf8"));

// The script runs under node, as the skills invoke it; bun runs these tests.
// Take node's own binary path, since a version-manager shim on PATH stops
// working once a test narrows PATH.
const node = spawnSync("node", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).stdout.trim();

const home = mkdtempSync(join(tmpdir(), "pstack-seat-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const bin = join(home, "bin");
mkdirSync(bin);

// FAKE_MODE switches every fake: fail, sleep, empty, or error (claude's is_error).
const MODES = `case "$FAKE_MODE" in
  fail) echo "boom from fake" >&2; exit 3 ;;
  sleep) sleep 30 ;;
esac`;
const fakes = {
  grok: `#!/bin/sh
${MODES}
prompt=""
while [ $# -gt 0 ]; do case "$1" in --prompt-file) prompt="$2"; shift 2 ;; *) shift ;; esac; done
[ "$FAKE_MODE" = empty ] && { printf '{"text":""}\\n'; exit 0; }
printf '{"text":"grok saw %s; claude compat %s; cursor rules %s"}\\n' "$(head -n1 "$prompt")" "$GROK_CLAUDE_AGENTS_ENABLED" "$GROK_CURSOR_RULES_ENABLED"
`,
  codex: `#!/bin/sh
${MODES}
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; *) shift ;; esac; done
printf 'codex saw %s\\n' "$(head -n1)" > "$out"
`,
  claude: `#!/bin/sh
${MODES}
first=$(head -n1)
[ "$FAKE_MODE" = error ] && { printf '{"type":"result","is_error":true,"result":"usage limit reached"}\\n'; exit 0; }
printf '{"type":"result","is_error":false,"result":"claude saw %s"}\\n' "$first"
`,
};
for (const [name, body] of Object.entries(fakes)) {
  writeFileSync(join(bin, name), body);
  chmodSync(join(bin, name), 0o755);
}

const prompt = join(home, "prompt.md");
writeFileSync(prompt, "review this diff\nsecond line\n");

function seat(args, mode = "") {
  const r = spawnSync(node, [script, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_MODE: mode },
    encoding: "utf8",
  });
  const line = r.stdout.trim();
  return { status: r.status, summary: line ? JSON.parse(line) : null, err: r.stderr };
}
const run = (entry, mode, extra = []) => {
  const out = join(home, "answers", `${entry.split(":")[0]}-${mode || "ok"}.md`);
  return { out, ...seat(["--seat", entry, "--prompt-file", prompt, "--out", out, "--cwd", home, ...extra], mode) };
};

describe("seat.mjs levels", () => {
  test("each provider's levels match models.json", () => expect(PROVIDERS).toEqual(models.providers));

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
  const base = ["--prompt-file", prompt, "--out", join(home, "x.md")];

  test("rejects an unknown provider, naming the known ones", () =>
    expect(usage(["--seat", "gemini:gemini-3", ...base])).toEqual({
      status: 2,
      err: 'seat.mjs: unknown provider "gemini"; expected one of claude, codex, grok\n',
    }));

  test("rejects a level outside the provider's list", () =>
    expect(usage(["--seat", "claude:opus @ultra", ...base]).err).toContain('claude takes the levels low, medium, high, xhigh, max, not "ultra"'));

  test("rejects an entry without a provider prefix", () =>
    expect(usage(["--seat", "gpt-6-astra", ...base]).status).toBe(2));

  test("requires the prompt file to exist", () =>
    expect(usage(["--seat", "grok:grok-4.7", "--prompt-file", join(home, "none.md"), "--out", join(home, "x.md")]).err).toContain("is missing or empty"));

  test("names a missing required flag", () => expect(usage(["--seat", "grok:grok-4.7"]).err).toContain("--prompt-file is required"));
});

describe("seat.mjs commands", () => {
  const dry = (entry) => seat(["--seat", entry, "--prompt-file", prompt, "--out", join(home, "d.md"), "--cwd", home, "--dry-run"]).summary;

  test("grok runs headless, read-only, and without Claude Code or Cursor config", () => {
    const spec = dry("grok:grok-4.7 @xhigh");
    expect(spec.command).toBe("grok");
    expect(spec.args).toEqual(expect.arrayContaining(["--prompt-file", prompt, "-m", "grok-4.7", "--effort", "xhigh", "--no-subagents", "--disable-web-search"]));
    expect(spec.args.join(" ")).toContain("--tools read_file,grep,list_dir");
    expect(spec.env.GROK_CLAUDE_AGENTS_ENABLED).toBe("0");
    expect(spec.env.GROK_CURSOR_MCPS_ENABLED).toBe("0");
  });

  test("codex runs in the read-only sandbox without the user's config or rules", () => {
    const spec = dry("codex:gpt-6-astra @ultra");
    expect(spec.args.slice(0, 1)).toEqual(["exec"]);
    expect(spec.args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "-s", "read-only", "-m", "gpt-6-astra", 'model_reasoning_effort="ultra"']));
    expect(spec.stdin).toBe(prompt);
  });

  test("claude keeps its login but drops user settings and MCP servers", () => {
    const spec = dry("claude:opus @max");
    expect(spec.args).toEqual(expect.arrayContaining(["-p", "--model", "opus", "--effort", "max", "--setting-sources", "project,local", "--strict-mcp-config"]));
    expect(spec.args).not.toContain("--bare");
  });

  test("an entry without a level passes no effort flag", () => {
    expect(dry("grok:grok-4.7").args).not.toContain("--effort");
    expect(dry("codex:gpt-6-sol").args.join(" ")).not.toContain("model_reasoning_effort");
  });
});

describe("seat.mjs runs", () => {
  test.each([
    ["grok:grok-4.7 @xhigh", "grok saw review this diff; claude compat 0; cursor rules 0\n"],
    ["codex:gpt-6-astra @ultra", "codex saw review this diff\n"],
    ["claude:opus @max", "claude saw review this diff\n"],
  ])("%s writes its answer and reports ok", (entry, answer) => {
    const r = run(entry, "");
    expect(r.status).toBe(0);
    expect(r.summary).toMatchObject({ seat: entry, status: "ok", out: r.out });
    expect(readFileSync(r.out, "utf8")).toBe(answer);
    expect(existsSync(`${r.out}.log`)).toBe(true);
  });

  test("a CLI that exits non-zero is a failed seat with its stderr and no answer", () => {
    const r = run("codex:gpt-6-sol", "fail");
    expect(r.status).toBe(1);
    expect(r.summary.status).toBe("failed");
    expect(r.summary.error).toContain("codex exited 3: boom from fake");
    expect(existsSync(r.out)).toBe(false);
  });

  test("an empty answer is a failed seat", () => {
    const r = run("grok:grok-4.7", "empty");
    expect(r.summary).toMatchObject({ status: "failed", error: "the seat returned an empty answer" });
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
    const r = spawnSync(node, [script, "--seat", "grok:grok-4.7", "--prompt-file", prompt, "--out", join(home, "m.md")], {
      env: { ...process.env, PATH: "/usr/bin:/bin" },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("could not start grok");
  });
});
