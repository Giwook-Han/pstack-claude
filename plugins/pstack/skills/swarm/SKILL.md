---
name: swarm
description: "Fan out N parallel workers, drain them, and return one report. Use for /swarm, 'swarm this', or parallel coverage, races, gauntlets, and exploration."
---

# Swarm

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.

On Muse, read the [platform mapping](../poteto-mode/references/muse-tools.md), including its per-skill notes, before following this skill.

## Start

Open a todolist with one entry per phase before launching anything.

1. Frame
2. Fan out
3. Aggregate
4. Report

## Phase A: Frame

1. State the done predicate and the artifact or report the swarm must return.
2. Choose the shape. Partition into slices, race N workers on identical briefs, or mix both. For a race or mixed shape, declare `first pass`, `rank all`, or `best-of` before spawning.
4. Pick the worker model from the `swarm workers` line in `pstack-models.md`. If the sheet or that line is missing, use the default in [Models](#models). For `auto` or `inherit-parent`, omit `model` so the workers run on the parent model. If the `Agent` tool rejects a slug, use the default and say so. If it rejects the default, use the closest valid slug of the same family from its error message. For a model race, name each arm's model up front. Unless the request names them, the arms come one per entry from the `swarm race arms` line, or from that role's defaults in [Models](#models). An arm with a provider prefix runs as a provider seat per [Provider seats](#provider-seats), and its result counts under the declared race rule like any other arm's. Slice workers never run as seats. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill.
5. Give each worker its own writable output when it writes. A seat arm that writes runs in write mode in its own fresh git worktree. When workers verify or measure commits, each brief names the exact SHAs. A measurement brief also names the method (sample count, what one sample is, order). The worker records both in its result.

## Phase B: Fan out

Spawn all N workers in one message with `subagent_type: "general-purpose"`, `run_in_background: true`, and the step 4 model, left unset for `auto` or `inherit-parent`. Claude Code subagents all run on this machine, so isolation comes from the worktree or output directory assigned in Phase A, not from a remote environment.

When a worker must start from a non-default branch, check that branch out in the worker's own worktree and name the worktree path in its brief.

Every brief stands alone. Include the goal, scope, exact slice or race arm, how to verify, and what to report. Reports use `PASS`, `ISSUES`, or `BLOCKED` with evidence. A worker that can prove a defect reports `ISSUES` and lists every issue it can prove, not only the first.

If a worker drops out, proceed with N-1 and note it.

## Phase C: Aggregate

Read the terminal results. Drop a result that does not record the SHAs and method its brief names, and respawn that worker once. After a second miss, record a gap. A gap does not count as a pass. For coverage, every required slice needs a result. For a race, apply the selection rule declared up front. Use first pass, rank all, or best-of. Do not paste raw worker dumps.

## Phase D: Report

Return one consolidated in-chat report with the table, issue one-liners, gaps or dropouts, and the race rule when used.

## Models

Role defaults, stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). A matching role line in the `pstack-models.md` override sheet overrides each at runtime; `/setup-pstack` writes it and lists its path per runtime.

- swarm workers: `opus`
- swarm race arms: `opus`, `fable`, `sonnet`, `haiku`

## Reasoning effort

A role value in the override sheet may name a reasoning effort after its model, as in `opus @xhigh`. Levels on Claude Code: `low`, `medium`, `high`, `xhigh`, `max`. Which ones apply depends on the model. A value without `@` takes the sheet's `default effort` line, a level or `session`, and `session` when the sheet has no such line. `session` sets no effort, so the dispatch is the usual one. Strip the suffix before reading the model: `inherit-parent` or `auto` still omits `model` at every level, and a model name is passed as `model`. Pass the level as the dispatch's effort field and keep the `subagent_type` you would otherwise use. That is `effort` on the Claude Code `Agent` call and `reasoning_effort` on Codex's `spawn_agent`. On Muse it is `effort` on a Workflow child; a `subagent_spawn` dispatch keeps the session's effort.

## Provider seats

A role entry written `<provider>:<model>`, with an optional `@<level>`, is a provider seat: it runs on that provider's own CLI and subscription. The providers are `claude`, `codex`, and `grok`. [Provider seats](../poteto-mode/references/provider-seats.md) lists the levels each takes and the seat runner's command. An entry for the runtime you are on, `claude:` on Claude Code or `codex:` on Codex, is an ordinary subagent with that model and level. Launch every other seat through the seat runner, in the background and in the same message as the subagent calls, and read its answer file when it finishes. The `Agent` rules in this skill, including any fallback for a rejected entry, apply only to entries without a prefix. A seat cannot load skills or reach this session's MCP tools, so its prompt file carries everything a subagent would get, with every skill or reference the prompt names pasted in. It returns text, such as a design, a review, or a verdict. Only `arena` and `swarm` let a seat edit files, in write mode inside its own clean git worktree. A seat's provider counts as a model family different from the parent's when the parent runs on another provider. A seat that fails is a dropout: continue with the rest, name the seat and its error in the output, and say that model diversity was reduced. Never rerun it on another model or hand its work to a subagent.
