# Provider seats

A provider seat runs one role entry from `pstack-models.md` on another provider's model, through that provider's own CLI and subscription. The diverse-model panels in `arena`, `architect`, `interrogate`, and `thermos` take their signal from model diversity, and a runtime's own subagent tool reaches only its own provider's models. Seats let one panel mix providers. A seat can also give poteto-mode a second opinion or a verdict from another provider, run one arm of a `swarm` model race, or write an `arena` candidate's code in its own git worktree.

## Syntax

Write a seat as `<provider>:<model>`, with an optional `@<level>`. An entry without a prefix keeps its usual meaning on the runtime. Repeat an entry to run it more than once; each entry is one seat.

```text
architect runners: grok:grok-4.7 @xhigh, grok:grok-4.7 @xhigh, codex:gpt-6-astra @ultra, codex:gpt-6-astra @ultra, opus @max, opus @max
interrogate reviewers: grok:grok-4.7 @xhigh, opus @max
```

An entry without a level takes the sheet's `default effort` when that is one of its provider's levels; append it to the entry you pass the runner. `session` passes no level, so the CLI uses its own default.

## Levels

Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). A model can accept fewer levels than its provider lists; the provider's CLI then fails the seat.

| Provider | Levels |
| --- | --- |
| `claude` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `grok` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

## Where seats fit

Roles that take seats: `second opinions`, `arena runners`, `arena cross-judge pool`, `swarm race arms`, `architect runners`, `interrogate reviewers`, and `thermos reviewers`.

The sheet checker rejects a seat on any other line. `swarm workers` takes none, so a swarm slice worker never runs as a seat. A seat answers in text, and edits files only in [write mode](#write-mode), inside its own clean git worktree. What it produces depends on its line:

- On `architect runners`, each seat's sketch is its candidate.
- On `arena runners`, a seat's candidate is the text it returns when the artifact is text, such as a design, plan, or document. When candidates write code, the seat runs in write mode, and its candidate is its worktree's changes, with its final message as the rationale.
- On `arena cross-judge pool`, a seat gives the arena a judge from another provider.
- On `interrogate reviewers` and `thermos reviewers`, each seat is one reviewer.
- On `second opinions`, a seat gives a second opinion, or a verifier's verdict, from what it reads. A verifier that must drive the change through the driver skill runs as a subagent instead.
- On `swarm race arms`, each seat is one arm of a model race, and its result counts under the race's declared rule. An arm that writes runs in write mode.

## Native entries

An entry for the runtime you are on is an ordinary subagent, not a seat process:

- On Claude Code, `claude:<family>` is the `Agent` call with that family as `model` and its level as `effort`.
- On Codex, `codex:<model>` is `spawn_agent` with that model and its level as `reasoning_effort`.

Every other provider runs through the seat runner.

## Run a seat

1. Write the seat's prompt to its own file, outside the directory the seat reads. It must stand alone. A seat loads no skills and has no access to the plugin's files, so paste in every skill, principle, template, or reference file the skill's prompt names, with the diff or excerpts inline. Where the template asks for files to be written, ask for that content in the final message, unless the seat runs in [write mode](#write-mode). The runner puts a short preamble ahead of the prompt that tells the seat to answer directly and not to route through skills or slash commands.
2. From the installed plugin root, start one runner per seat with the shell tool in the background, in the same message as the skill's subagent calls:

   ```shell
   node skills/poteto-mode/scripts/seat.mjs --seat '<entry>' --prompt-file <prompt file> --out <answer file> --cwd <repository root>
   ```

   Put each answer file where the skill puts that seat's output, such as an arena candidate's directory. A seat that edits files also needs its own worktree and `--write`, as [Write mode](#write-mode) describes. The runner needs network access and writes under the provider's home directory (`~/.grok`, `~/.codex`, or `~/.claude`). From a sandboxed shell, such as Codex's default sandbox, request escalated permissions for the command, or every seat fails.
3. When a runner exits, its stdout is one JSON line with `status` (`ok`, `failed`, or `timeout`), `seconds`, `out`, `log`, and `error` when it failed. On `ok`, read the answer file as you would a subagent's report. The log keeps the CLI's raw output in the system temp directory, away from the answer, so a judge reading a candidate's directory cannot tell which provider wrote it. `--log` moves it.

`--timeout-sec` overrides the 3600-second limit, and `--dry-run` prints the resolved command without running it.

Label each seat by its entry in the skill's output, as in "Reviewer B: grok:grok-4.7 @xhigh", so the agreement map shows which provider raised what. Do not show those labels to an arena's cross-judge.

## What the runner runs

Every seat starts from a scrubbed environment that keeps the system basics, proxy and certificate settings, and its own provider's config and credential variables. Each provider then runs headless with its read tools only, unless the seat runs in [write mode](#write-mode):

- `grok`: Grok Build in its `strict` sandbox, which confines reads to the working directory, system paths, the temp directory, and `~/.grok`. Only its read, grep, and list tools are on; MCP tools are denied; subagents, web search, and update checks are off. Its Claude Code, Cursor, and Codex compatibility scans are off, and the sandbox keeps it from loading Claude Code plugins, so the seat sees none of their rules, skills, hooks, or MCP servers. Hooks under `~/.grok` still run.
- `codex`: `codex exec --ignore-user-config --ignore-rules` in the `read-only` sandbox, with hooks and memories off. It can read files and run commands that write nothing. It may start its own subagents. Each child inherits the seat's sandbox, so a read seat's child writes nothing, and a write seat's child writes only in the worktree and the private temp directory. The seat's output does not name a child's model or level. Codex saves each seat session, and each child's session, in its history under `~/.codex/sessions`. `--disable memories` keeps those sessions out of Codex's cross-session memory. The seat still receives the user's `AGENTS.md` and installed skills list, which the runner's preamble overrides for routing.
- `claude`: `claude -p` in safe mode, which drops `CLAUDE.md`, skills, plugins, hooks, and MCP servers but keeps the subscription login, with no settings files loaded. Restricted mode confines its file tools to the working directory, and only `Read`, `Grep`, and `Glob` exist.

## Write mode

A skill that lets a seat write, as `arena` does for a code-writing candidate and `swarm` for a race arm that writes, runs it in write mode. The seat edits files in its own clean linked git worktree and leaves the commit to you.

1. Create a fresh worktree for each writing seat. Name its path and branch for the candidate, not the provider, so a judge cannot tell which provider wrote it:

   ```shell
   git worktree add -b <branch> <worktree> <base commit>
   ```
2. Start the runner with that worktree as `--cwd`, add `--write`, and keep the answer file outside the worktree:

   ```shell
   node skills/poteto-mode/scripts/seat.mjs --seat '<entry>' --prompt-file <prompt file> --out <answer file> --cwd <worktree> --write
   ```

   The runner refuses `--write`, with a usage error and exit code 2, unless `--cwd` is the top of a linked worktree with nothing staged, modified, or untracked, and both `--out` and `--log` sit outside it. The main checkout never qualifies. The runner also refuses a worktree whose real path holds `*`, `?`, `[`, `]`, `{`, or `}`. It walks every entry under the worktree, ignored files and checked-out submodules included, and refuses the worktree if it holds a symlink that leads out of it or a file with more than one hard link. A refusal is not a dropout. Fix the setup and start the seat again.
3. The seat does not commit. Its final message lands in the answer file as its report. The runner's JSON line also carries `write: true` and `changed`, the paths that `git status` reports in the worktree. The runner never resets or deletes the worktree.
4. Read the diff, and never build or test inside the seat's worktree. `changed` and `git diff` leave out ignored files, which a seat can also write, so a build there can run code you never read. Apply the seat's tracked and untracked changes to a tree you control, and run them there. To copy them, run `git -C <worktree> add -A`, which stages them without the ignored files, then run `git -C <worktree> diff --cached --binary | git apply --index` from the top of your tree.

Each provider runs with these limits in write mode:

- `grok`: Grok Build in its strict sandbox, with its read and edit tools (`read_file`, `grep`, `list_dir`, `search_replace`, and `write`) and no shell. Its permission rules approve edits only under the worktree. An edit anywhere else needs an approval that a headless run cannot give, so Grok Build refuses it. On Grok Build 1.0.62 the turn then ended as `cancelled`, which fails the seat. The rules match an edit's path as written, so an edit could follow a symlink in the worktree, or a hard link, to a file outside it, such as one in the temp directory, which the strict sandbox leaves writable. The runner refuses a worktree that holds a symlink leading out of it or a file with more than one hard link, and one whose path holds a glob character, which the rules would read as a pattern. In testing, an edit outside the worktree, or through a tracked symlink into the home directory, ended the run, and one through a tracked symlink into `~/.grok` failed with EPERM.
- `codex`: `codex exec` in the `workspace-write` sandbox with network access off and `/tmp/` left out of its writable roots. Its shell and patches write only in the worktree and a private temp directory, which the seat's `TMPDIR`, `TMP`, and `TEMP` name and the runner removes afterwards. Its reads are unrestricted, as in read mode. On codex-cli 0.163.0, the sandbox refused a seat's hard link to a file outside the worktree. The seat could create a symlink to a file outside, but the sandbox refused a write through it. A codex seat therefore cannot write outside through a link it makes. It can still leave a symlink that leads out among its changes, and the runner then fails the seat.
- `claude`: `claude -p` in safe and restricted mode with `Read`, `Grep`, `Glob`, `Edit`, and `Write`, and no shell. The file tools reach only the worktree and refuse a symlink out of it.

## Before a long run

Check each provider once with `grok models`, `codex login status`, or `claude auth status`. A seat spends its provider's subscription quota, and the slowest seat sets the panel's wall-clock time.

## Failures

A seat fails when its CLI cannot start, exits with an error, times out, stops early (a refusal or a cut-off turn), or returns an empty answer. A write seat also fails when it changes no files, rewrites the worktree's `.git` file, or leaves a symlink that leads out of the worktree among its changes, and a `grok` write seat fails when it tries to edit outside its worktree. Whatever a failed write seat changed stays in its worktree and is not a candidate. A refusal before the seat starts, such as a worktree that holds a symlink leading out of it or a file with more than one hard link, or one whose path holds a glob character, is a usage error with exit code 2, not a dropout. A failed seat is a dropout. Continue with the other seats, list the dropped seat with its error in the skill's output, and say that model diversity was reduced. Do not rerun the seat on another model or provider, or hand its work to a subagent. A silent substitution hides the lost diversity the panel exists for. Stopping the runner stops its CLI. A review gate whose every reviewer dropped stays closed, as the Subagents section of the **poteto-mode** skill describes.
