# Provider seats

A provider seat runs one panel, judge, or reviewer entry from `pstack-models.md` on another provider's model, through that provider's own CLI and subscription. The diverse-model panels in `arena`, `architect`, `interrogate`, and `thermos` take their signal from model diversity, and a runtime's own subagent tool reaches only its own provider's models. Seats let one panel mix providers.

## Syntax

Write a seat as `<provider>:<model>`, with an optional `@<level>`. An entry without a prefix keeps its usual meaning on the runtime. Repeat an entry to run it more than once; each entry is one seat.

```text
architect runners: grok:grok-4.7 @xhigh, grok:grok-4.7 @xhigh, codex:gpt-6-astra @ultra, codex:gpt-6-astra @ultra, opus @max, opus @max
interrogate reviewers: grok:grok-4.7 @xhigh, opus @max
```

## Levels

Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). A model can accept fewer levels than its provider lists; the provider's CLI then fails the seat.

| Provider | Levels |
| --- | --- |
| `claude` | `low`, `medium`, `high`, `xhigh`, `max` |
| `codex` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `grok` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |

## Where seats fit

A seat reads files under its working directory and returns one answer. It cannot edit files, run shell commands, spawn subagents, search the web, or use this session's MCP tools. Put seats on lines whose subagents return text:

- `architect runners`: each seat returns its sketch, which becomes its candidate.
- `arena runners`, when the artifact is text, such as a design, plan, or document. Candidates that must write code in their own worktree stay on the runtime's subagents.
- `arena cross-judge pool`: a seat gives the arena a judge from another provider.
- `interrogate reviewers` and `thermos reviewers`.

Keep the other roles on the runtime's own models. Their subagents edit code, run commands, or gather evidence through MCP tools.

## Native entries

An entry for the runtime you are on is an ordinary subagent, not a seat process:

- On Claude Code, `claude:<family>` is the `Agent` call with that family as `model` and its level as `effort`.
- On Codex, `codex:<model>` is `spawn_agent` with that model and its level as `reasoning_effort`.

Every other provider runs through the seat runner.

## Run a seat

1. Write the seat's prompt to its own file. It must stand alone: the template and fill-ins the skill gives a subagent, absolute paths for any file the seat should read, and the diff or excerpts inline. Ask for the whole answer as the final message.
2. From the installed plugin root, start one runner per seat with the shell tool in the background, in the same message as the skill's subagent calls:

   ```shell
   node skills/poteto-mode/scripts/seat.mjs --seat '<entry>' --prompt-file <prompt file> --out <answer file> --cwd <repository root>
   ```

   Put each answer file where the skill puts that seat's output, such as an arena candidate's directory.
3. When a runner exits, its stdout is one JSON line with `status` (`ok`, `failed`, or `timeout`), `seconds`, `out`, `log`, and `error` when it failed. On `ok`, read the answer file as you would a subagent's report. The `log` file keeps the CLI's raw output for debugging.

`--timeout-sec` overrides the 3600-second limit, and `--dry-run` prints the resolved command without running it.

Label each seat by its entry in the skill's output, as in "Reviewer B: grok:grok-4.7 @xhigh", so the agreement map shows which provider raised what.

## What the runner runs

Each provider runs read-only and headless, isolated from this machine's agent configuration:

- `grok`: Grok Build with `--prompt-file` and JSON output, its read, grep, and list tools only, and subagents, web search, and update checks off. Its Claude Code and Cursor compatibility scans are off, so the seat loads none of this machine's `CLAUDE.md`, Claude skills, hooks, rules, or MCP servers.
- `codex`: `codex exec --ephemeral --ignore-user-config --ignore-rules` in the `read-only` sandbox, with the prompt on stdin and the final message written by `-o`.
- `claude`: `claude -p` in the `dontAsk` permission mode with only `Read`, `Grep`, and `Glob` allowed, user settings and MCP servers off, and no saved session. It keeps the subscription login, which `--bare` would drop.

## Before a long run

Check each provider once with `grok models`, `codex login status`, or `claude auth status`. A seat spends its provider's subscription quota, and the slowest seat sets the panel's wall-clock time.

## Failures

A seat that fails, times out, or returns an empty answer is a dropout. Continue with the other seats, list the dropped seat with its error in the skill's output, and say that model diversity was reduced. Do not rerun the seat on another model or provider: a silent substitution hides the lost diversity the panel exists for. A review gate whose every reviewer dropped stays closed, as the Subagents section of the **poteto-mode** skill describes.
