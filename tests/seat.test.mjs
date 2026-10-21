// The runner scrubs the environment, so each prompt carries the fake CLI's mode
// and the directory it reports to.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadModels } from "../tools/generate.mjs";
import { PREAMBLE, PROVIDERS, WRITE_PREAMBLE, parseSeat, seatEnv } from "../plugins/pstack/skills/poteto-mode/scripts/seat.mjs";

const script = fileURLToPath(new URL("../plugins/pstack/skills/poteto-mode/scripts/seat.mjs", import.meta.url));
// The script runs under node, as the skills invoke it; bun runs these tests.
// Take node's own binary path, since a version-manager shim on PATH stops
// working once a test narrows PATH.
const node = spawnSync("node", ["-e", "process.stdout.write(process.execPath)"], { encoding: "utf8" }).stdout.trim();

const home = mkdtempSync(join(tmpdir(), "pstack-seat-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const bin = join(home, "bin");
mkdirSync(bin);

const READ_CONTROL = `mode=$(sed -n 's/^mode=//p' "$prompt" | head -n1)
seen=$(sed -n 's/^seen=//p' "$prompt" | head -n1)
cp "$prompt" "$seen/$name.prompt"
printf '%s' "\${PSTACK_TEST_SECRET:-clean}" > "$seen/$name.secret"
printf '%s\\n' "$TMPDIR" "$TMP" "$TEMP" "$([ -d "$TMPDIR" ] && echo dir)" > "$seen/$name.tmpdir"
last=$(tail -n1 "$prompt")
case "$mode" in
  edit|editfail) echo "changed by $name" > edited.txt ;;
  gitfile|gitfail) echo "changed by $name" > edited.txt; echo "gitdir: /elsewhere" > .git ;;
  rename) git mv README.md RENAMED.md ;;
  linkout|linkoutfail) ln -s "$seen" escape ;;
  linkin) ln -s README.md readme ;;
  dirtofile) rm -r dir; echo "changed by $name" > dir ;;
esac
case "$mode" in
  fail|editfail|gitfail|linkoutfail) echo "boom from fake" >&2; exit 3 ;;
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
  return { dir, seen, prompt, out: join(dir, "answers", "answer.md"), cwd: dir };
}

const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd,
    env: gitEnv,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

function worktreeSetup(mode = "", { name = "wt", prepare = () => {} } = {}) {
  const c = setup(mode);
  const repo = join(c.dir, "repo");
  const wt = join(c.dir, name);
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "fixture\n");
  prepare(repo);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "fixture");
  git(repo, "worktree", "add", "-q", "--detach", wt);
  return { ...c, repo, wt, cwd: wt, real: realpathSync.native(wt) };
}

const env = (extra = {}) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, ...extra });
// A flag in `extra` overrides the case's own, since the runner keeps the last.
function seat(c, entry, extra = [], extraEnv = {}) {
  const r = spawnSync(node, [script, "--seat", entry, "--prompt-file", c.prompt, "--out", c.out, "--cwd", c.cwd, ...extra], {
    env: env(extraEnv),
    encoding: "utf8",
  });
  const line = r.stdout.trim();
  return { ...c, status: r.status, stdout: r.stdout, summary: line ? JSON.parse(line) : null, err: r.stderr };
}
const run = (entry, mode = "", extra = [], extraEnv = {}) => seat(setup(mode), entry, extra, extraEnv);
const write = (entry, mode = "") => seat(worktreeSetup(mode), entry, ["--write"]);
const values = (args, flag) => args.flatMap((arg, i) => (arg === flag ? [args[i + 1]] : []));

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

describe("seat.mjs write usage", () => {
  const refused = (r, message) => {
    expect(r.err).toContain(message);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  };

  test("--write needs --cwd", () => {
    const c = setup();
    const r = spawnSync(node, [script, "--seat", "grok:grok-4.7", "--prompt-file", c.prompt, "--out", c.out, "--write"], {
      cwd: c.dir,
      env: env(),
      encoding: "utf8",
    });
    refused({ status: r.status, stdout: r.stdout, err: r.stderr }, "--write needs --cwd");
  });

  test("refuses a directory that is not the top level of a git worktree", () => {
    const c = worktreeSetup();
    const sub = join(c.wt, "sub");
    mkdirSync(sub);
    refused(seat(c, "grok:grok-4.7", ["--write", "--cwd", sub]), `--cwd ${sub} is not the top level of a git worktree`);
    refused(seat(c, "grok:grok-4.7", ["--write", "--cwd", c.seen]), `--cwd ${c.seen} is not the top level of a git worktree`);
  });

  test("refuses the repository's main checkout", () => {
    const c = worktreeSetup();
    refused(seat(c, "grok:grok-4.7", ["--write", "--cwd", c.repo]), `--cwd ${c.repo} is the repository's main checkout`);
  });

  test("refuses a worktree with changes, in a dry run too", () => {
    const c = worktreeSetup();
    writeFileSync(join(c.wt, "stray.txt"), "left over\n");
    refused(seat(c, "grok:grok-4.7", ["--write"]), `--cwd ${c.wt} has changes`);
    refused(seat(c, "grok:grok-4.7", ["--write", "--dry-run"]), `--cwd ${c.wt} has changes`);
  });

  test("refuses an answer or log path inside the worktree, also through a symlink to a directory not made yet", () => {
    const c = worktreeSetup();
    const link = join(c.dir, "into-wt");
    symlinkSync(c.wt, link);
    for (const [flag, path] of [
      ["--out", join(c.wt, "answer.md")],
      ["--out", join(link, "new", "answer.md")],
      ["--log", join(c.wt, "seat.log")],
    ]) {
      refused(seat(c, "grok:grok-4.7", ["--write", flag, path]), `${flag} ${path} is inside the worktree`);
    }
  });

  test.each([
    ["to an absolute path that does not exist yet", (dir) => join(dir, "outside", "new.txt")],
    ["to a relative path", () => "../outside.txt"],
    ["whose .. climbs out after an in-tree symlink", () => "deep/up/../outside.txt"],
  ])("refuses a worktree that tracks a symlink out of it, %s", (_, target) => {
    const c = worktreeSetup("", {
      prepare: (repo) => {
        mkdirSync(join(repo, "deep"));
        symlinkSync("..", join(repo, "deep", "up"));
        symlinkSync(target(dirname(repo)), join(repo, "escape"));
      },
    });
    refused(seat(c, "grok:grok-4.7", ["--write"]), `--cwd ${c.wt} holds escape, a symlink that leads out of the worktree`);
  });

  test("accepts a worktree whose tracked symlinks stay inside it, including one whose target does not exist yet", () => {
    const c = worktreeSetup("edit", {
      prepare: (repo) => {
        symlinkSync("README.md", join(repo, "readme"));
        symlinkSync("later.txt", join(repo, "later"));
        symlinkSync(join(dirname(repo), "wt", "README.md"), join(repo, "absolute"));
      },
    });
    expect(seat(c, "grok:grok-4.7", ["--write"]).summary).toMatchObject({ status: "ok", changed: ["edited.txt"] });
  });

  // `git status` leaves out an ignored entry, so these worktrees pass the clean check.
  const withIgnoredDir = (mode = "") => {
    const c = worktreeSetup(mode, { prepare: (repo) => writeFileSync(join(repo, ".gitignore"), "ignored/\n") });
    mkdirSync(join(c.wt, "ignored"));
    return c;
  };

  test("refuses a worktree that holds an ignored symlink out of it", () => {
    const c = withIgnoredDir();
    symlinkSync(join(c.dir, "outside.txt"), join(c.wt, "ignored", "escape"));
    refused(seat(c, "grok:grok-4.7", ["--write"]), `--cwd ${c.wt} holds ignored/escape, a symlink that leads out of the worktree`);
  });

  test("refuses a worktree that holds a hard link to a file outside it, under an ignored name", () => {
    const c = withIgnoredDir();
    writeFileSync(join(c.dir, "outside.txt"), "outside\n");
    linkSync(join(c.dir, "outside.txt"), join(c.wt, "ignored", "hard.txt"));
    refused(seat(c, "grok:grok-4.7", ["--write"]), `--cwd ${c.wt} holds ignored/hard.txt, a file with more than one hard link`);
  });

  test("accepts a worktree whose ignored symlink stays inside it", () => {
    const c = withIgnoredDir("edit");
    symlinkSync("../README.md", join(c.wt, "ignored", "readme"));
    expect(seat(c, "grok:grok-4.7", ["--write"]).summary).toMatchObject({ status: "ok", changed: ["edited.txt"] });
  });

  test("refuses a worktree whose checked-out submodule holds a symlink out of it", () => {
    const c = worktreeSetup();
    const sub = join(c.dir, "sub");
    mkdirSync(sub);
    symlinkSync(join(c.dir, "outside.txt"), join(sub, "escape"));
    git(sub, "init", "-q");
    git(sub, "add", "-A");
    git(sub, "commit", "-q", "-m", "submodule");
    git(c.wt, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
    git(c.wt, "commit", "-q", "-m", "add the submodule");
    refused(seat(c, "grok:grok-4.7", ["--write"]), `--cwd ${c.wt} holds sub/escape, a symlink that leads out of the worktree`);
  });

  test.each(["*", "?", "[", "]", "{", "}"])("refuses a worktree whose real path holds %s, also through a plain symlink", (glob) => {
    const c = worktreeSetup("", { name: `wt${glob}x` });
    const link = join(c.dir, "plain");
    symlinkSync(c.wt, link);
    for (const cwd of [c.wt, link]) refused(seat(c, "grok:grok-4.7", ["--write", "--cwd", cwd]), `--cwd ${cwd} has a glob character in its real path`);
  });

  test("accepts a worktree path with spaces and parentheses", () => {
    const c = worktreeSetup("edit", { name: "wt (copy) 2" });
    expect(seat(c, "grok:grok-4.7", ["--write"]).summary).toMatchObject({ status: "ok", changed: ["edited.txt"] });
  });
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
    expect(values(spec.args, "--tools")).toEqual(["read_file,grep,list_dir"]);
    expect(spec.args).not.toContain("--allow");
    for (const vendor of ["CLAUDE", "CURSOR", "CODEX"]) {
      for (const kind of ["AGENTS", "SKILLS", "HOOKS", "RULES", "MCPS", "SESSIONS"]) expect(spec.env[`GROK_${vendor}_${kind}_ENABLED`]).toBe("0");
    }
  });

  test("codex runs in the read-only sandbox without hooks, memories, the user's config, or rules, and keeps its subagents", () => {
    const spec = dry("codex:gpt-6-astra @ultra");
    expect(spec.args[0]).toBe("exec");
    expect(spec.args).toEqual(expect.arrayContaining(["--ignore-user-config", "--ignore-rules", "-s", "read-only", 'model_reasoning_effort="ultra"']));
    expect(values(spec.args, "--disable").sort()).toEqual(["hooks", "memories"]);
    expect(spec.args).not.toContain("--ephemeral");
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

  const dryWrite = (entry) => {
    const c = worktreeSetup();
    const link = join(c.dir, "wt-link");
    symlinkSync(c.wt, link);
    const r = seat(c, entry, ["--write", "--cwd", link, "--dry-run"]);
    expect(r.status).toBe(0);
    return { spec: r.summary, real: c.real };
  };

  test("a grok write seat gets the edit tools in its strict sandbox, allowed only inside the worktree's real path", () => {
    const { spec, real } = dryWrite("grok:grok-4.7 @xhigh");
    expect(values(spec.args, "--tools")).toEqual(["read_file,grep,list_dir,search_replace,write"]);
    expect(values(spec.args, "--allow")).toEqual([`Edit(${real}/**)`, `Write(${real}/**)`]);
    expect(values(spec.args, "--sandbox")).toEqual(["strict"]);
    expect(spec.args).toEqual(expect.arrayContaining(["--deny", "MCPTool", "--no-subagents", "--disable-web-search"]));
    expect(values(spec.args, "--cwd")).toEqual([real]);
    expect(spec.cwd).toBe(real);
    expect(spec.env.GROK_CLAUDE_SKILLS_ENABLED).toBe("0");
  });

  test("a codex write seat runs in the workspace-write sandbox with the network, hooks, and memories off, and keeps its subagents", () => {
    const { spec, real } = dryWrite("codex:gpt-6-astra @ultra");
    expect(values(spec.args, "-s")).toEqual(["workspace-write"]);
    expect(values(spec.args, "-c")).toContain("sandbox_workspace_write.network_access=false");
    expect(values(spec.args, "--disable").sort()).toEqual(["hooks", "memories"]);
    expect(spec.args).not.toContain("--ephemeral");
    expect(values(spec.args, "-C")).toEqual([real]);
    expect(spec.cwd).toBe(real);
  });

  // The sandbox keeps TMPDIR writable unless exclude_tmpdir_env_var is set.
  test("a codex write seat drops /tmp from its sandbox and names a private temp dir in TMPDIR, TMP, and TEMP", () => {
    const { spec } = dryWrite("codex:gpt-6-astra @ultra");
    expect(values(spec.args, "-c")).toContain("sandbox_workspace_write.exclude_slash_tmp=true");
    expect(spec.args.join(" ")).not.toContain("exclude_tmpdir_env_var");
    expect(spec.env.TMPDIR).toMatch(/^<.+>$/);
    expect([spec.env.TMP, spec.env.TEMP]).toEqual([spec.env.TMPDIR, spec.env.TMPDIR]);
  });

  test("a claude write seat gets Edit and Write in restricted mode, and no Bash", () => {
    const { spec, real } = dryWrite("claude:opus @max");
    expect(values(spec.args, "--tools")).toEqual(["Read,Grep,Glob,Edit,Write"]);
    expect(values(spec.args, "--allowedTools")).toEqual(["Read,Grep,Glob,Edit,Write"]);
    expect(spec.args).toContain("--restricted");
    expect(spec.args.join(" ")).not.toContain("Bash");
    expect(spec.cwd).toBe(real);
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
    expect(r.summary).not.toHaveProperty("write");
    expect(r.summary).not.toHaveProperty("changed");
    expect(readFileSync(r.out, "utf8")).toBe(answer);
    const seen = readFileSync(join(r.seen, `${name}.prompt`), "utf8");
    expect(seen.startsWith(PREAMBLE)).toBe(true);
    expect(seen.endsWith("review this diff\n")).toBe(true);
  });

  test("a codex seat's preamble, read or write, forbids skills and slash commands but not subagents", () => {
    for (const r of [run("codex:gpt-6-sol"), write("codex:gpt-6-sol", "edit")]) {
      const seen = readFileSync(join(r.seen, "codex.prompt"), "utf8");
      expect(seen).toContain("Do not invoke skills or slash commands, even if standing instructions tell you to route work through a skill first.");
      expect(seen).not.toMatch(/Do not[^.]*subagent/);
    }
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

describe("seat.mjs write runs", () => {
  test.each([
    ["grok:grok-4.7 @xhigh", "grok"],
    ["codex:gpt-6-astra @ultra", "codex"],
    ["claude:opus @max", "claude"],
  ])("%s edits its worktree, reports the change, and answers outside it", (entry, name) => {
    const r = write(entry, "edit");
    expect(r.status).toBe(0);
    expect(r.summary).toMatchObject({ seat: entry, status: "ok", out: r.out, write: true, changed: ["edited.txt"] });
    expect(readFileSync(join(r.wt, "edited.txt"), "utf8")).toBe(`changed by ${name}\n`);
    expect(readFileSync(r.out, "utf8")).toBe(`${name} saw review this diff\n`);
    expect(readFileSync(join(r.seen, `${name}.prompt`), "utf8").startsWith(WRITE_PREAMBLE)).toBe(true);
  });

  test("a seat that changes no files fails", () => {
    const r = write("grok:grok-4.7");
    expect(r.status).toBe(1);
    expect(r.summary).toMatchObject({ status: "failed", write: true, changed: [], error: "the seat changed no files" });
    expect(existsSync(r.out)).toBe(false);
  });

  test("a seat that rewrites the worktree's .git file fails, and its change still shows", () => {
    const r = write("claude:opus", "gitfile");
    expect(r.status).toBe(1);
    expect(r.summary).toMatchObject({ status: "failed", changed: ["edited.txt"], error: "the seat rewrote the worktree's .git file" });
    expect(existsSync(r.out)).toBe(false);
  });

  test("a seat whose CLI fails and that rewrites the worktree's .git file reports both", () => {
    const r = write("grok:grok-4.7", "gitfail");
    expect(r.status).toBe(1);
    expect(r.summary.status).toBe("failed");
    expect(r.summary.error).toContain("grok exited 3: boom from fake");
    expect(r.summary.error).toContain("the seat rewrote the worktree's .git file");
  });

  test("a seat that leaves a symlink out of the worktree fails, and the link still shows", () => {
    const r = write("codex:gpt-6-sol", "linkout");
    expect(r.status).toBe(1);
    expect(r.summary).toMatchObject({ status: "failed", changed: ["escape"], error: "the seat left escape, a symlink that leads out of the worktree" });
    expect(existsSync(r.out)).toBe(false);
  });

  test("a seat whose CLI fails and that leaves a symlink out of the worktree reports both", () => {
    const r = write("codex:gpt-6-sol", "linkoutfail");
    expect(r.status).toBe(1);
    expect(r.summary.error).toContain("codex exited 3: boom from fake");
    expect(r.summary.error).toContain("the seat left escape, a symlink that leads out of the worktree");
  });

  test("a seat may leave a symlink that stays inside the worktree", () =>
    expect(write("codex:gpt-6-sol", "linkin").summary).toMatchObject({ status: "ok", changed: ["readme"] }));

  test("a seat that replaces a tracked directory with a file still gets a summary of its changes", () => {
    const c = worktreeSetup("dirtofile", {
      prepare: (repo) => {
        mkdirSync(join(repo, "dir"));
        writeFileSync(join(repo, "dir", "file.txt"), "fixture\n");
      },
    });
    const r = seat(c, "codex:gpt-6-sol", ["--write"]);
    expect(r.summary.status).toBe("ok");
    expect(r.summary.changed.sort()).toEqual(["dir", "dir/file.txt"]);
  });

  test("a codex write seat gets a private temp dir that the runner removes, and a read seat keeps the parent's", () => {
    const c = worktreeSetup("edit");
    const parentTmp = join(c.dir, "parent-tmp");
    mkdirSync(parentTmp);
    const r = seat(c, "codex:gpt-6-sol", ["--write"], { TMPDIR: parentTmp });
    expect(r.summary).toMatchObject({ status: "ok", changed: ["edited.txt"] });
    const [tmp, tmpAlias, temp, kind] = readFileSync(join(r.seen, "codex.tmpdir"), "utf8").split("\n");
    expect(kind).toBe("dir");
    expect(tmp).not.toBe(parentTmp);
    expect([tmpAlias, temp]).toEqual([tmp, tmp]);
    expect(existsSync(tmp)).toBe(false);
    const read = run("codex:gpt-6-sol", "", [], { TMPDIR: parentTmp });
    expect(readFileSync(join(read.seen, "codex.tmpdir"), "utf8").split("\n")[0]).toBe(parentTmp);
  });

  test("a seat whose CLI fails reports what it left, and the runner keeps it", () => {
    const r = write("codex:gpt-6-sol", "editfail");
    expect(r.status).toBe(1);
    expect(r.summary).toMatchObject({ status: "failed", write: true, changed: ["edited.txt"] });
    expect(r.summary.error).toContain("codex exited 3: boom from fake");
    expect(readFileSync(join(r.wt, "edited.txt"), "utf8")).toBe("changed by codex\n");
  });

  test("names a renamed file once, by its new path", () =>
    expect(write("grok:grok-4.7", "rename").summary).toMatchObject({ status: "ok", changed: ["RENAMED.md"] }));

  test("an inherited GIT_DIR cannot point the checks at another repository", () => {
    const c = worktreeSetup("edit");
    const r = seat(c, "grok:grok-4.7", ["--write"], { GIT_DIR: join(c.repo, ".git"), GIT_WORK_TREE: c.repo });
    expect(r.summary).toMatchObject({ status: "ok", changed: ["edited.txt"] });
  });
});
