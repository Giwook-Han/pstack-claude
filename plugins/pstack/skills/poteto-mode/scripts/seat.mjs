#!/usr/bin/env node
// Runs one provider seat on that provider's own CLI and subscription. A seat is
// any entry written `<provider>:<model>`, with an optional `@<level>`, on a
// pstack-models.md line that takes seats. The seat runs headless, isolated from
// this machine's agent configuration as far as each CLI allows, with read-only
// tools or, under --write, file tools that edit only the clean linked git
// worktree --cwd names. Its final answer lands in --out.
//
// Usage:
//   node seat.mjs --seat '<entry>' --prompt-file <file> --out <file>
//                 [--cwd <dir>] [--write] [--log <file>] [--timeout-sec <n>] [--dry-run]
//                 [--shell [--shell-read <path>]... [--shell-deny-read <path>]... [--shell-allow-host <host>]...]
//
// Prints one JSON line: { seat, provider, model, level, status, seconds, out, log,
// stopReason?, write?, changed?, shell?, blocked?, error? }. A write seat adds write: true
// and the paths it changed, and fails when it changed none, rewrote the worktree's .git
// file, or left a symlink that leads out of the worktree. A shell seat adds shell: true and
// the hosts its sandbox refused. Exit 0 when the seat answered, 1 when it failed or timed
// out, 2 on a usage error. A failed seat is never retried on another model; the caller
// records a dropout.
//
// --shell gives a Grok write seat Grok Build's shell tool, on macOS only. Grok's own sandbox
// cannot stop a child process from using the network on macOS, and a second sandbox cannot
// be applied inside it. So the runner sandboxes the whole Grok process with Seatbelt instead
// (a deny-default profile, shaped like the base policy of OpenAI's Codex CLI, Apache-2.0):
// writes only in the worktree, a private temp dir and Grok's session store, reads inside the
// home directory only where the task and its tools need them, and network only to a loopback
// proxy that tunnels to the model's own hosts. See references/provider-seats.md, Write mode.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Reasoning levels each provider's CLI accepts, stamped from models.json by
// tools/generate.mjs. A model may accept fewer; the CLI then fails the seat.
export const PROVIDERS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  grok: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
};

const DEFAULT_TIMEOUT_SEC = 3600;
const MAX_TIMEOUT_SEC = 86_400;
const KILL_GRACE_MS = 10_000;
const ERROR_TAIL = 600;
const WINDOWS = process.platform === "win32";

// A seat answers the task it is given; standing instructions it still loads
// (Codex keeps the user's AGENTS.md) must not route it into a skill or slash command.
export const PREAMBLE =
  "You are one seat of a pstack panel, run headless with read-only tools. Answer the task below directly " +
  "and completely in your final message. Do not invoke skills or slash commands, even if " +
  "standing instructions tell you to route work through a skill first. If the task asks you to write a " +
  "file, put its content in your final message instead.\n\n---\n\n";
export const WRITE_PREAMBLE =
  "You are one seat of a pstack panel, run headless in your own git worktree, which is the current directory. " +
  "Make the task's changes there with your file tools. You cannot write outside it, and a write outside it can " +
  "end your run. Do not commit. Do not invoke skills or slash commands, even if standing instructions " +
  "tell you to route work through a skill first. Your final message is your report on the task: what you changed " +
  "and why.\n\n---\n\n";
export const SHELL_PREAMBLE =
  "You are one seat of a pstack panel, run headless in your own git worktree, which is the current directory. " +
  "Make the task's changes there with your file tools, and use your shell to run the checks the task names. " +
  "The shell is sandboxed: it writes only inside the worktree and your private temp directory ($TMPDIR), it " +
  "has no network except the model's own endpoint, it cannot read the home directory beyond the toolchains " +
  "and config it needs, and git cannot change history here. Dependencies must already be installed in the " +
  "worktree, so do not try to install any. Do not try to get around the sandbox, and report a command it " +
  "blocks instead of retrying it. Do not " +
  "commit. Do not invoke skills or slash commands, even if standing instructions tell you to route work " +
  "through a skill first. Your final message is your report on the task: what you changed, which commands " +
  "you ran and what they printed, and why.\n\n---\n\n";

// Shell seats reach the model through a loopback proxy that tunnels only to these hosts
// (and their subdomains) on port 443. Grok Build's own traffic needs nothing else.
export const SHELL_ALLOW_HOSTS = ["grok.com", "x.ai"];
// A shell seat's transcript goes to the model's provider, so the profile keeps the seat out of
// the home directory except for the roots it needs: its worktree, the repository's git
// directory, Grok's home, the directories on its PATH, and these runtime homes and config files.
// None holds credentials. That is why .cargo is not here whole (its config and credentials
// sit beside its registry), and why a key store such as .foundry is not either.
export const SHELL_READ_ROOTS = [
  ".asdf", ".nvm", ".volta", ".fnm", ".rustup", ".pyenv", ".rbenv", ".sdkman", "go", ".cargo/registry", ".cargo/git",
  ".gitconfig", ".config/git", ".tool-versions", ".asdfrc",
];
// Paths a shell seat cannot read even inside a root. The home directory is closed already, so this
// list backs up a root that turns out to hold a credential, and the caller adds project-specific
// ones with --shell-deny-read.
export const SHELL_DENY_READ = [
  ".ssh", ".aws", ".gnupg", ".codex", ".claude", ".azure", ".kube", ".docker", ".netrc", ".npmrc", ".git-credentials",
  ".config/gh", ".config/gcloud", ".config/op", "Library/Keychains",
];
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

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

// Grok Build reads Claude Code, Cursor, and Codex config by default: rules,
// CLAUDE.md, skills, hooks, MCP servers, and sessions. The strict sandbox below
// also keeps it from loading Claude Code plugins out of the home directory.
const GROK_ISOLATION = Object.fromEntries(
  ["CLAUDE", "CURSOR", "CODEX"].flatMap((vendor) =>
    ["AGENTS", "SKILLS", "HOOKS", "RULES", "MCPS", "SESSIONS"].map((kind) => [`GROK_${vendor}_${kind}_ENABLED`, "0"]),
  ),
);

// A seat gets the system basics, network and certificate settings, and its own
// provider's config and credential variables, not the parent's other secrets.
const ENV_KEEP = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "TZ",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
  "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "PATHEXT", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
];
const ENV_KEEP_PREFIXES = ["LC_", "XDG_"];
const PROVIDER_ENV = {
  claude: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN"],
  codex: ["CODEX_HOME", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
  grok: ["GROK_HOME", "XAI_API_KEY"],
};

export function seatEnv(provider, env = process.env) {
  const keep = new Set([...ENV_KEEP, ...PROVIDER_ENV[provider]]);
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => keep.has(key) || ENV_KEEP_PREFIXES.some((prefix) => key.startsWith(prefix))),
  );
}

// Whether a CONNECT target is an allowed host or a subdomain of one.
export function hostAllowed(host, allow) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => name === entry || name.endsWith(`.${entry}`));
}

// A loopback CONNECT proxy for a shell seat. It tunnels to the allowed hosts on the allowed
// ports (443 unless a test says otherwise) and refuses everything else, plain HTTP included,
// and it remembers each refusal so the caller sees what a seat tried to reach.
export async function startAllowProxy(allow, ports = ["443"]) {
  const blocked = new Set();
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  };
  const server = createServer((req, res) => {
    blocked.add(`http ${req.headers.host ?? req.url}`);
    res.writeHead(403, { Connection: "close" }).end("plain HTTP is refused\n");
  });
  server.on("connection", track);
  server.on("connect", (req, client, head) => {
    const colon = req.url.lastIndexOf(":");
    const host = (colon > 0 ? req.url.slice(0, colon) : req.url).replace(/^\[|\]$/g, "");
    const port = colon > 0 ? req.url.slice(colon + 1) : "";
    if (!ports.includes(port) || !hostAllowed(host, allow)) {
      blocked.add(`${host}:${port}`);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = connect({ host, port: Number(port) });
    track(upstream);
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", drop);
    client.on("error", drop);
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", done);
  });
  return {
    port: server.address().port,
    blocked: () => [...blocked].sort(),
    close() {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}

// A path goes into the Seatbelt profile as a quoted string, so a quote, a backslash, or a
// control character in it is refused instead of escaped.
function sbString(path) {
  if (/[\u0000-\u001f"\\]/.test(path)) throw new UsageError(`${JSON.stringify(path)} holds a quote, a backslash, or a control character, which the shell sandbox profile cannot carry`);
  return `"${path}"`;
}

// The Seatbelt profile for one Grok shell seat, deny by default. `system.sb` supplies what any
// process needs to start, the rest follows the shape of the Codex CLI's macOS base policy
// (https://github.com/openai/codex, Apache-2.0), and the network rule names the proxy's port only.
// Every path must be a real path, since Seatbelt matches the resolved one.
export function shellProfile({ worktree, tmpDir, grokHome, proxyPort, home, readRoots, denyRead }) {
  const subpaths = (paths) => paths.map((path) => `(subpath ${sbString(path)})`);
  const writable = subpaths([worktree, tmpDir, join(grokHome, "sessions"), "/private/tmp/sessions"]);
  const readable = subpaths([...new Set(readRoots)]);
  const unreadable = subpaths([...new Set(denyRead.flatMap((path) => [path, existsSync(path) ? realpathSync.native(path) : path]))]);
  return `${[
    "(version 1)",
    "; Deny by default, then allow what Grok Build and a test run need.",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow user-preference-read)",
    "; Reads: everything outside the home directory, and inside it only the roots below, because the",
    "; seat's transcript goes to the model's provider. The metadata rule lets a path resolve.",
    "(allow file-read*)",
    `(deny file-read* (subpath ${sbString(home)}))`,
    `(allow file-read-metadata (subpath ${sbString(home)}))`,
    ...(readable.length ? [`(allow file-read* ${readable.join(" ")})`] : []),
    ...(unreadable.length ? [`(deny file-read* ${unreadable.join(" ")})`] : []),
    "; Writes: the worktree, the seat's private temp dir, Grok's session store, and the terminals.",
    `(allow file-write* ${writable.join(" ")} (literal "/dev/null") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+") (subpath "/dev/fd"))`,
    "(allow pseudo-tty)",
    '(allow file-read* file-write* file-ioctl (literal "/dev/ptmx"))',
    "; Network: the loopback proxy only, which tunnels to the model's own hosts.",
    `(allow network-outbound (remote ip "localhost:${proxyPort}"))`,
    "; Platform services for TLS and file watching. The security server is left out on purpose: it fronts the",
    "; keychain, and Grok Build's TLS works without it.",
    "(allow mach-lookup",
    ...[
      "com.apple.trustd.agent", "com.apple.ocspd", "com.apple.networkd", "com.apple.TrustEvaluationAgent",
      "com.apple.SystemConfiguration.configd", "com.apple.SystemConfiguration.DNSConfiguration", "com.apple.FSEvents",
    ].map((name) => `  (global-name "${name}")`),
    ")",
    "(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))",
  ].join("\n")}\n`;
}

// The roots a shell seat may read inside the home directory, as real paths that exist: its
// worktree, the repository's git directory, Grok's home, each directory on its PATH that lies
// under the home directory, the runtime homes and config files in SHELL_READ_ROOTS, and what the
// caller adds.
export function shellReadRoots({ home, worktree, commonDir, grokHome, searchPath, extra = [] }) {
  const roots = new Set();
  const add = (path) => {
    if (path && existsSync(path)) roots.add(realpathSync.native(path));
  };
  for (const path of [worktree, commonDir, grokHome, ...extra]) add(path);
  for (const dir of String(searchPath ?? "").split(delimiter)) {
    if (dir && existsSync(dir) && realpathSync.native(dir).startsWith(`${home}${sep}`)) add(dir);
  }
  for (const path of SHELL_READ_ROOTS) add(join(home, path));
  return [...roots].sort();
}

function findExecutable(name, searchPath) {
  for (const dir of String(searchPath ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

// Grok Build's shell tool sources the user's login shell, which would hand the seat every
// variable a shell startup file exports, so SHELL names plain sh. Tools that write caches
// are pointed at the private temp dir, and every proxy variable names the loopback proxy.
const SHELL_UNSET_ENV = ["NO_PROXY", "no_proxy"];
function shellEnv({ tmpDir, proxyUrl }) {
  return {
    SHELL: "/bin/sh",
    TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir,
    XDG_CACHE_HOME: join(tmpDir, "cache"), XDG_STATE_HOME: join(tmpDir, "state"), XDG_DATA_HOME: join(tmpDir, "data"),
    GOCACHE: join(tmpDir, "go-build"), npm_config_cache: join(tmpDir, "npm"),
    HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl, http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl,
  };
}

// Headless grok refuses an edit no allow rule approves and ends its turn as
// cancelled, so a write seat's rules approve edits under the worktree only. A
// codex write seat's sandbox keeps TMPDIR writable, so TMPDIR names a private
// dir, away from the shared temp directories that hold other seats' files.
const ACCESS = {
  grok: {
    read: { tools: "read_file,grep,list_dir", allow: [] },
    write: { tools: "read_file,grep,list_dir,search_replace,write", allow: ["Edit", "Write"] },
    // The shell tool is run_terminal_cmd. Headless Grok will not run a command that no rule
    // approves, and a rule cannot cover a redirect or a command substitution, so a shell seat
    // runs in always-approve mode and the Seatbelt profile does the confining.
    shell: { tools: "read_file,grep,list_dir,search_replace,write,run_terminal_cmd" },
  },
  codex: {
    read: { sandbox: ["-s", "read-only"] },
    write: {
      sandbox: ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=false", "-c", "sandbox_workspace_write.exclude_slash_tmp=true"],
      privateTmp: true,
    },
  },
  claude: {
    read: { tools: "Read,Grep,Glob" },
    write: { tools: "Read,Grep,Glob,Edit,Write" },
  },
};

// `promptFile` is the staged copy (preamble plus prompt) in the temp directory,
// which Grok's strict sandbox can read. `answer` names where the final message
// comes from: "text" (stdout JSON .text), "result" (stdout JSON .result), or
// "file" (the CLI writes --out itself).
export function seatCommand({ provider, model, level }, { promptFile, tmpDir, out, cwd, write, shell, grok, profileFile, proxyUrl }) {
  const access = ACCESS[provider][write ? "write" : "read"];
  if (provider === "grok" && shell) {
    // Grok's own sandbox is off here: Seatbelt cannot nest, so sandbox-exec wraps the whole
    // process and confines Grok and every command it runs.
    return {
      command: SANDBOX_EXEC,
      args: [
        "-f", profileFile,
        grok,
        "--prompt-file", promptFile,
        "-m", model,
        ...(level ? ["--effort", level] : []),
        "--output-format", "json",
        "--cwd", cwd,
        "--sandbox", "off",
        "--tools", ACCESS.grok.shell.tools,
        "--always-approve",
        "--deny", "MCPTool",
        "--no-subagents",
        "--disable-web-search",
        "--no-auto-update",
      ],
      env: { ...GROK_ISOLATION, ...shellEnv({ tmpDir, proxyUrl }) },
      unsetEnv: SHELL_UNSET_ENV,
      cwd,
      stdin: null,
      answer: "text",
    };
  }
  if (provider === "grok") {
    return {
      command: "grok",
      args: [
        "--prompt-file", promptFile,
        "-m", model,
        ...(level ? ["--effort", level] : []),
        "--output-format", "json",
        "--cwd", cwd,
        "--sandbox", "strict",
        "--tools", access.tools,
        ...access.allow.flatMap((tool) => ["--allow", `${tool}(${cwd}/**)`]),
        "--deny", "MCPTool",
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
  // A codex seat may start subagents, which inherit its sandbox. It runs without
  // --ephemeral, which makes spawn_agent fail, so Codex saves the seat's session
  // and each child's in its history. --disable memories keeps those sessions out
  // of Codex's cross-session memory if that feature ever defaults to on.
  if (provider === "codex") {
    return {
      command: "codex",
      args: [
        "exec",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        ...access.sandbox,
        "--disable", "hooks",
        "--disable", "memories",
        "-C", cwd,
        "-m", model,
        ...(level ? ["-c", `model_reasoning_effort="${level}"`] : []),
        "-o", out,
        "-",
      ],
      env: access.privateTmp ? { TMPDIR: tmpDir, TMP: tmpDir, TEMP: tmpDir } : {},
      cwd,
      stdin: promptFile,
      answer: "file",
    };
  }
  // claude: --safe-mode drops CLAUDE.md, skills, plugins, hooks, and MCP
  // servers but keeps the subscription login, which --bare would not.
  // --restricted confines the file tools to the working directory, and --tools
  // leaves only the mode's tools, whatever a settings file allows.
  return {
    command: "claude",
    args: [
      "-p",
      "--model", model,
      ...(level ? ["--effort", level] : []),
      "--output-format", "json",
      "--safe-mode",
      "--restricted",
      "--setting-sources", "",
      "--tools", access.tools,
      "--allowedTools", access.tools,
      "--permission-mode", "dontAsk",
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
  const opts = { timeoutSec: DEFAULT_TIMEOUT_SEC, dryRun: false, write: false, shell: false, shellAllowHosts: [], shellDenyRead: [], shellRead: [] };
  const takes = {
    "--seat": "seat", "--prompt-file": "promptFile", "--out": "out", "--cwd": "cwd", "--log": "log", "--timeout-sec": "timeoutSec",
  };
  const repeats = { "--shell-allow-host": "shellAllowHosts", "--shell-deny-read": "shellDenyRead", "--shell-read": "shellRead" };
  const switches = { "--dry-run": "dryRun", "--write": "write", "--shell": "shell" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (Object.hasOwn(switches, arg)) {
      opts[switches[arg]] = true;
      continue;
    }
    const eq = arg.indexOf("=");
    const [flag, inline] = eq > 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    if (!Object.hasOwn(takes, flag) && !Object.hasOwn(repeats, flag)) throw new UsageError(`unknown argument "${arg}"`);
    const value = inline ?? argv[++i];
    if (value === undefined || value === "") throw new UsageError(`${flag} needs a value`);
    if (Object.hasOwn(repeats, flag)) opts[repeats[flag]].push(value);
    else opts[takes[flag]] = value;
  }
  for (const flag of ["--seat", "--prompt-file", "--out"]) {
    if (!opts[takes[flag]]) throw new UsageError(`${flag} is required`);
  }
  if (opts.write && !opts.cwd) throw new UsageError("--write needs --cwd <worktree>");
  opts.timeoutSec = Number(opts.timeoutSec);
  if (!Number.isFinite(opts.timeoutSec) || opts.timeoutSec <= 0 || opts.timeoutSec > MAX_TIMEOUT_SEC) {
    throw new UsageError(`--timeout-sec must be a number of seconds from 1 to ${MAX_TIMEOUT_SEC}`);
  }
  opts.promptFile = resolve(opts.promptFile);
  opts.out = resolve(opts.out);
  opts.cwd = resolve(opts.cwd ?? process.cwd());
  if (!existsSync(opts.promptFile) || statSync(opts.promptFile).size === 0) {
    throw new UsageError(`prompt file ${opts.promptFile} is missing or empty`);
  }
  if (opts.out === opts.promptFile) throw new UsageError("--out must differ from --prompt-file");
  if (existsSync(opts.out) && statSync(opts.out).isDirectory()) throw new UsageError(`--out ${opts.out} is a directory; name a file`);
  if (!existsSync(opts.cwd) || !statSync(opts.cwd).isDirectory()) throw new UsageError(`--cwd ${opts.cwd} is not a directory`);
  if (opts.log) opts.log = resolve(opts.log);
  return opts.write ? { ...opts, ...parseWorktree(opts) } : opts;
}

// --shell is a Grok write seat on macOS, and its two options mean nothing without it.
function checkShell(opts, { provider }, home) {
  if (!opts.shell) {
    if (opts.shellAllowHosts.length || opts.shellDenyRead.length || opts.shellRead.length) {
      throw new UsageError("--shell-allow-host, --shell-deny-read, and --shell-read need --shell");
    }
    return;
  }
  if (provider !== "grok") throw new UsageError(`--shell is only for grok seats, not ${provider}`);
  if (!opts.write) throw new UsageError("--shell needs --write, because a shell seat works in its own clean worktree");
  if (platform() !== "darwin") throw new UsageError("--shell needs macOS, where the runner sandboxes the seat with Seatbelt");
  if (!existsSync(SANDBOX_EXEC)) throw new UsageError(`--shell needs ${SANDBOX_EXEC}`);
  for (const host of opts.shellAllowHosts) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host)) throw new UsageError(`--shell-allow-host ${host} is not a host name`);
  }
  opts.shellAllowHosts = opts.shellAllowHosts.map((host) => host.toLowerCase());
  const absolute = (flag, path) => {
    const full = path.startsWith("~/") ? join(home, path.slice(2)) : path;
    if (!isAbsolute(full)) throw new UsageError(`${flag} ${path} must be an absolute path or start with ~/`);
    return full;
  };
  opts.shellRead = opts.shellRead.map((path) => {
    const full = absolute("--shell-read", path);
    if (!existsSync(full)) throw new UsageError(`--shell-read ${path} does not exist`);
    return full;
  });
  opts.shellDenyRead = opts.shellDenyRead.map((path) => {
    const full = absolute("--shell-deny-read", path);
    // A deny rule on the worktree or a parent of it would shut the seat out of its own files.
    if (contains(realTarget(full), opts.cwd)) throw new UsageError(`--shell-deny-read ${path} holds the worktree, so the seat could not read its own files`);
    return full;
  });
  const builtIn = SHELL_DENY_READ.map((path) => join(home, path)).find((path) => contains(realTarget(path), opts.cwd));
  if (builtIn) throw new UsageError(`the worktree sits under ${builtIn}, which a shell seat cannot read, so the seat could not read its own files; use a worktree elsewhere`);
}

// An inherited GIT_DIR or GIT_WORK_TREE would point git at another repository.
function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: Infinity, windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

// Read through `gitDir`, captured before the run, rather than the worktree's
// .git file, which a seat could rewrite. The -z form puts an R or C entry's
// original path in a field of its own after the new one.
function changedPaths(gitDir, root) {
  const status = git(root, [`--git-dir=${gitDir}`, `--work-tree=${root}`, "status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return null;
  const fields = status.split("\0");
  const paths = [];
  for (let i = 0; i < fields.length - 1; i++) {
    paths.push(fields[i].slice(3));
    if (/[RC]/.test(fields[i].slice(0, 2))) i++;
  }
  return paths;
}

function realTarget(path) {
  if (existsSync(path)) return realpathSync.native(path);
  const parent = dirname(path);
  return parent === path ? path : join(realTarget(parent), basename(path));
}

const contains = (root, real) => real === root || real.startsWith(root + sep);

// A relative target joins the link's directory without lexical cleanup, so the
// kernel resolves each `..` after the links before it, as an edit through the
// link would. A path that is not a symlink leads to itself, also when a seat
// deleted it or replaced a directory above it with a file.
function linkTarget(link) {
  let target;
  try {
    target = readlinkSync(link);
  } catch {
    return link;
  }
  return realTarget(isAbsolute(target) ? target : dirname(link) + sep + target);
}

function firstLinkOut(root, dir = root) {
  for (const name of readdirSync(dir).sort()) {
    if (name === ".git") continue;
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() && !contains(root, linkTarget(path))) {
      return `${relative(root, path)}, a symlink that leads out of the worktree`;
    }
    if (!stat.isDirectory() && stat.nlink > 1) return `${relative(root, path)}, a file with more than one hard link`;
    const inner = stat.isDirectory() && firstLinkOut(root, path);
    if (inner) return inner;
  }
  return null;
}

// Grok's allow rules splice the worktree's path into a glob and match an edit's
// path as written, so the path may hold no glob character, and no entry under
// it, ignored files and checked-out submodules included, may be a symlink that
// leads out or a file with another hard link, whose other name can sit anywhere.
function parseWorktree({ cwd, out, log }) {
  const root = realpathSync.native(cwd);
  if (/[*?[\]{}]/.test(root)) throw new UsageError(`--cwd ${cwd} has a glob character in its real path; --write needs a worktree path without * ? [ ] { }`);
  const revParse = (flag) => {
    const path = git(root, ["rev-parse", flag])?.replace(/\n$/, "");
    return path && realpathSync.native(resolve(root, path));
  };
  if (revParse("--show-toplevel") !== root) throw new UsageError(`--cwd ${cwd} is not the top level of a git worktree`);
  const gitDir = revParse("--absolute-git-dir");
  const commonDir = revParse("--git-common-dir");
  if (gitDir === commonDir) {
    throw new UsageError(`--cwd ${cwd} is the repository's main checkout; --write needs a linked worktree`);
  }
  for (const [flag, path] of [["--out", out], ["--log", log]]) {
    if (path && contains(root, realTarget(path))) throw new UsageError(`${flag} ${path} is inside the worktree`);
  }
  const changed = changedPaths(gitDir, root);
  if (!changed) throw new UsageError(`git status failed in --cwd ${cwd}`);
  if (changed.length) throw new UsageError(`--cwd ${cwd} has changes; --write needs a clean worktree`);
  const link = firstLinkOut(root);
  if (link) throw new UsageError(`--cwd ${cwd} holds ${link}`);
  return { cwd: root, gitDir, commonDir, dotGit: readFileSync(join(root, ".git")) };
}

function holds(path, bytes) {
  try {
    return readFileSync(path).equals(bytes);
  } catch {
    return false;
  }
}

const tail = (text) => {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > ERROR_TAIL ? "..." + trimmed.slice(-ERROR_TAIL) : trimmed;
};

// The CLI's JSON result, read whole or, past a banner or log line, from its
// last line that parses.
function parseResult(command, stdout) {
  const text = stdout.trim();
  try {
    return JSON.parse(text);
  } catch {}
  for (const line of text.split("\n").reverse()) {
    if (!line.trim().startsWith("{")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  throw new Error(`${command} printed no JSON result: ${tail(stdout)}`);
}

// The seat's answer, or an error when the turn ended early.
function extractAnswer(spec, stdout, out) {
  if (spec.answer === "file") return { answer: existsSync(out) ? readFileSync(out, "utf8") : "" };
  const parsed = parseResult(spec.command, stdout);
  const stopReason = typeof parsed.stopReason === "string" ? parsed.stopReason : undefined;
  if (stopReason && stopReason.toLowerCase().replace(/[^a-z]/g, "") !== "endturn") {
    return { stopReason, error: `${spec.command} stopped early (${stopReason})` };
  }
  if (spec.answer === "result" && (parsed.is_error || (parsed.subtype && parsed.subtype !== "success"))) {
    return { error: `${spec.command} reported ${parsed.subtype ?? "an error"}: ${tail(parsed.result)}` };
  }
  const answer = parsed[spec.answer];
  return { stopReason, answer: typeof answer === "string" ? answer : "" };
}

function killTree(child, signal) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    if (WINDOWS) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    else process.kill(-child.pid, signal);
  } catch {}
}

function runSeat(spec, opts) {
  return new Promise((done) => {
    const started = Date.now();
    const childEnv = { ...seatEnv(spec.provider), ...spec.env };
    for (const key of spec.unsetEnv ?? []) delete childEnv[key];
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: childEnv,
      stdio: [spec.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      detached: !WINDOWS,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    if (spec.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(readFileSync(spec.stdin));
    }
    const stop = (signal) => {
      killTree(child, signal);
      setTimeout(() => killTree(child, "SIGKILL"), KILL_GRACE_MS).unref();
    };
    // A stopped runner takes its CLI with it, so a cancelled seat spends no quota.
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const onSignal = (signal) => {
      interrupted = signal;
      stop("SIGTERM");
    };
    for (const signal of signals) process.on(signal, onSignal);
    const timer = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, opts.timeoutSec * 1000);
    let finished = false;
    const finish = (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const signal of signals) process.off(signal, onSignal);
      done({ code, spawnError, stdout, stderr, timedOut, interrupted, seconds: Math.round((Date.now() - started) / 100) / 10 });
    };
    child.on("error", (error) => finish(null, error));
    child.on("close", (code) => finish(code, null));
  });
}

function defaultLog(provider) {
  const dir = join(tmpdir(), "pstack-seats");
  mkdirSync(dir, { recursive: true });
  return join(dir, `${Date.now()}-${process.pid}-${provider}.log`);
}

async function main(argv) {
  let opts;
  let seat;
  const home = process.env.HOME ?? homedir();
  try {
    opts = parseArgs(argv);
    seat = parseSeat(opts.seat);
    checkShell(opts, seat, home);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`seat.mjs: ${error.message}\n`);
    return 2;
  }
  // Seatbelt matches resolved paths, and Grok's home may not exist yet, so resolve its nearest existing ancestor.
  const grokHome = () => realTarget(seatEnv("grok").GROK_HOME ?? join(home, ".grok"));
  const denyRead = () => [...SHELL_DENY_READ.map((path) => join(home, path)), ...opts.shellDenyRead];
  const readRoots = (grokDir) =>
    shellReadRoots({ home: realTarget(home), worktree: opts.cwd, commonDir: opts.commonDir, grokHome: grokDir, searchPath: seatEnv("grok").PATH, extra: opts.shellRead });
  if (opts.dryRun) {
    const shell = opts.shell
      ? {
          grok: findExecutable("grok", seatEnv("grok").PATH) ?? "grok",
          profileFile: "<profile file>",
          proxyUrl: "http://127.0.0.1:<proxy port>",
        }
      : {};
    const spec = seatCommand(seat, { ...opts, ...shell, promptFile: `<staged copy of ${opts.promptFile}>`, tmpDir: "<private temp dir>" });
    const sandboxProfile = opts.shell
      ? shellProfile({ worktree: opts.cwd, tmpDir: "<private temp dir>", grokHome: grokHome(), proxyPort: "<proxy port>", home: realTarget(home), readRoots: readRoots(grokHome()), denyRead: denyRead() })
      : undefined;
    process.stdout.write(JSON.stringify({ ...seat, ...spec, env: { ...spec.env }, keptEnv: Object.keys(seatEnv(seat.provider)), sandboxProfile }) + "\n");
    return 0;
  }
  const summary = { seat: opts.seat.trim(), ...seat, status: "ok", seconds: 0, out: opts.out, log: opts.log ?? null };
  let staged = null;
  let proxy = null;
  let error = null;
  try {
    // The log stays out of --out's directory, so an arena judge reading a
    // candidate's directory cannot tell which provider wrote it.
    summary.log = opts.log ?? defaultLog(seat.provider);
    mkdirSync(dirname(summary.log), { recursive: true });
    mkdirSync(dirname(opts.out), { recursive: true });
    rmSync(opts.out, { force: true });
    staged = mkdtempSync(join(tmpdir(), "pstack-seat-"));
    const promptFile = join(staged, basename(opts.promptFile));
    writeFileSync(promptFile, (opts.shell ? SHELL_PREAMBLE : opts.write ? WRITE_PREAMBLE : PREAMBLE) + readFileSync(opts.promptFile, "utf8"));
    let tmpDir = mkdtempSync(join(staged, "tmp-"));
    let shell = {};
    if (opts.shell) {
      const grok = findExecutable("grok", seatEnv("grok").PATH);
      if (!grok) throw new Error("could not start grok: it is not on PATH");
      tmpDir = realpathSync.native(tmpDir);
      const grokDir = grokHome();
      mkdirSync(join(grokDir, "sessions"), { recursive: true });
      mkdirSync("/private/tmp/sessions", { recursive: true });
      proxy = await startAllowProxy([...SHELL_ALLOW_HOSTS, ...opts.shellAllowHosts]);
      const profileFile = join(staged, "shell.sb");
      writeFileSync(profileFile, shellProfile({ worktree: opts.cwd, tmpDir, grokHome: grokDir, proxyPort: proxy.port, home: realTarget(home), readRoots: readRoots(grokDir), denyRead: denyRead() }));
      shell = { shell: true, grok, profileFile, proxyUrl: `http://127.0.0.1:${proxy.port}` };
    }
    const spec = { ...seatCommand(seat, { ...opts, ...shell, promptFile, tmpDir }), provider: seat.provider };
    const result = await runSeat(spec, opts);
    summary.seconds = result.seconds;
    writeFileSync(summary.log, `$ ${spec.command} ${spec.args.join(" ")}\n\n[stdout]\n${result.stdout}\n[stderr]\n${result.stderr}`);
    if (result.spawnError) error = `could not start ${spec.command}: ${result.spawnError.message}`;
    else if (result.interrupted) error = `the runner was stopped by ${result.interrupted}`;
    else if (result.timedOut) {
      summary.status = "timeout";
      error = `no answer within ${opts.timeoutSec}s`;
    } else if (result.code !== 0) error = `${spec.command} exited ${result.code}: ${tail(result.stderr || result.stdout)}`;
    else {
      const got = extractAnswer(spec, result.stdout, opts.out);
      if (got.stopReason) summary.stopReason = got.stopReason;
      if (got.error) error = got.error;
      else if (!got.answer.trim()) error = "the seat returned an empty answer";
      else writeFileSync(opts.out, got.answer.endsWith("\n") ? got.answer : got.answer + "\n");
    }
  } catch (failure) {
    error = failure.message;
  } finally {
    if (proxy) {
      summary.shell = true;
      summary.blocked = proxy.blocked();
      proxy.close();
    }
    if (staged) rmSync(staged, { recursive: true, force: true });
  }
  if (opts.write) {
    const changed = changedPaths(opts.gitDir, opts.cwd);
    summary.write = true;
    summary.changed = changed ?? [];
    const append = (problem) => (error = error ? `${error}; ${problem}` : problem);
    if (!holds(join(opts.cwd, ".git"), opts.dotGit)) append("the seat rewrote the worktree's .git file");
    else if (!changed) error ??= "git status failed in the worktree";
    else if (!changed.length) error ??= "the seat changed no files";
    const escape = changed?.find((path) => !contains(opts.cwd, linkTarget(join(opts.cwd, path))));
    if (escape) append(`the seat left ${escape}, a symlink that leads out of the worktree`);
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
