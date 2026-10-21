# Provider seats

A provider seat runs one panel, judge, or reviewer entry from `pstack-models.md` on another provider's model, through that provider's own CLI and subscription. The diverse-model panels in `arena`, `architect`, `interrogate`, and `thermos` take their signal from model diversity, and a runtime's own subagent tool reaches only its own provider's models. Seats let one panel mix providers.

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

Roles that take seats: `arena runners`, `arena cross-judge pool`, `architect runners`, `interrogate reviewers`, and `thermos reviewers`.

The sheet checker rejects a seat on any other line. A seat answers in text and cannot edit files, so:

- On `architect runners`, each seat's sketch is its candidate.
- On `arena runners`, use seats only when the artifact is text, such as a design, plan, or document. When candidates write code in their own worktrees, keep every runner on the runtime's subagents.
- On `arena cross-judge pool`, a seat gives the arena a judge from another provider.
- On `interrogate reviewers` and `thermos reviewers`, each seat is one reviewer.

## Native entries

An entry for the runtime you are on is an ordinary subagent, not a seat process:

- On Claude Code, `claude:<family>` is the `Agent` call with that family as `model` and its level as `effort`.
- On Codex, `codex:<model>` is `spawn_agent` with that model and its level as `reasoning_effort`.

Every other provider runs through the seat runner.

## Run a seat

1. Write the seat's prompt to its own file, outside the directory the seat reads. It must stand alone. A seat loads no skills and has no access to the plugin's files, so paste in every skill, principle, template, or reference file the skill's prompt names, with the diff or excerpts inline. Where the template asks for files to be written, ask for that content in the final message. The runner puts a short preamble ahead of the prompt that tells the seat to answer directly and not to route through skills or subagents.
2. From the installed plugin root, start one runner per seat with the shell tool in the background, in the same message as the skill's subagent calls:

   ```shell
   node skills/poteto-mode/scripts/seat.mjs --seat '<entry>' --prompt-file <prompt file> --out <answer file> --cwd <repository root>
   ```

   Put each answer file where the skill puts that seat's output, such as an arena candidate's directory. The runner needs network access and writes under the provider's home directory (`~/.grok`, `~/.codex`, or `~/.claude`). From a sandboxed shell, such as Codex's default sandbox, request escalated permissions for the command, or every seat fails.
3. When a runner exits, its stdout is one JSON line with `status` (`ok`, `failed`, or `timeout`), `seconds`, `out`, `log`, and `error` when it failed. On `ok`, read the answer file as you would a subagent's report. The log keeps the CLI's raw output in the system temp directory, away from the answer, so a judge reading a candidate's directory cannot tell which provider wrote it. `--log` moves it.

`--timeout-sec` overrides the 3600-second limit, and `--dry-run` prints the resolved command without running it.

Label each seat by its entry in the skill's output, as in "Reviewer B: grok:grok-4.7 @xhigh", so the agreement map shows which provider raised what. Do not show those labels to an arena's cross-judge.

## What the runner runs

Every seat starts from a scrubbed environment that keeps the system basics, proxy and certificate settings, and its own provider's config and credential variables. Each provider then runs headless with its read tools only:

- `grok`: Grok Build in its `strict` sandbox, which confines reads to the working directory, system paths, the temp directory, and `~/.grok`. Only its read, grep, and list tools are on; MCP tools are denied; subagents, web search, and update checks are off. Its Claude Code, Cursor, and Codex compatibility scans are off, and the sandbox keeps it from loading Claude Code plugins, so the seat sees none of their rules, skills, hooks, or MCP servers. Hooks under `~/.grok` still run.
- `codex`: `codex exec --ephemeral --ignore-user-config --ignore-rules` in the `read-only` sandbox, with subagents and hooks off. It can read files and run commands that write nothing. It still receives the user's `AGENTS.md` and installed skills list, which the runner's preamble overrides for routing.
- `claude`: `claude -p` in safe mode, which drops `CLAUDE.md`, skills, plugins, hooks, and MCP servers but keeps the subscription login, with no settings files loaded. Restricted mode confines its file tools to the working directory, and only `Read`, `Grep`, and `Glob` exist.

## Before a long run

Check each provider once with `grok models`, `codex login status`, or `claude auth status`. A seat spends its provider's subscription quota, and the slowest seat sets the panel's wall-clock time.

## Failures

A seat fails when its CLI cannot start, exits with an error, times out, stops early (a refusal or a cut-off turn), or returns an empty answer. A failed seat is a dropout. Continue with the other seats, list the dropped seat with its error in the skill's output, and say that model diversity was reduced. Do not rerun the seat on another model or provider: a silent substitution hides the lost diversity the panel exists for. Stopping the runner stops its CLI. A review gate whose every reviewer dropped stays closed, as the Subagents section of the **poteto-mode** skill describes.
