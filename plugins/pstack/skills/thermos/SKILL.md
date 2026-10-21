---
name: thermos
description: "Launch both thermo-nuclear review subagents in parallel, then synthesize their findings. Use for thermos, double thermo review, or combined bug/security and code-quality branch audits."
---

# Thermos

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.

On Muse, read the [platform mapping](../poteto-mode/references/muse-tools.md), including its per-skill notes, before following this skill.

Run the two thermo review passes as async background subagents in parallel, once per configured reviewer, then synthesize their results.

## Workflow

1. Determine the review scope from the user request, PR, current branch, or relevant changed files.
2. Gather the diff and any file/context excerpts needed for reviewers to evaluate the change without guessing.
3. Take the reviewers from the `thermos reviewers` line in `pstack-models.md`, or the default in [Models](#models) if the sheet or that line is missing. For each entry, launch both passes, every pass in the same message with `run_in_background: true`:
   - `subagent_type: "pstack:thermo-nuclear-review-subagent"` for bugs, breakages, security, devex regressions, feature-flag leaks, and other branch-audit risks.
   - `subagent_type: "pstack:thermo-nuclear-code-quality-review-subagent"` for maintainability, structure, file-size growth, spaghetti, abstractions, and codebase-health risks.

   Set `model` and the level from the entry, and omit `model` for `inherit-parent` or `auto`. An entry with a provider prefix runs each pass as a provider seat per [Provider seats](#provider-seats). The seat's prompt is the pass's rubric skill, [thermo-nuclear-review](../thermo-nuclear-review/SKILL.md) or [thermo-nuclear-code-quality-review](../thermo-nuclear-code-quality-review/SKILL.md), followed by the scoped context.
4. Pass each subagent the same scoped diff/file context and ask it to return prioritized findings with file references and evidence.
5. After every pass finishes, synthesize the results with findings first, deduplicated across reviewers. Weight overlapping findings more heavily, most of all one that reviewers from different providers raised independently. Resolve disagreements with your own judgment and keep summaries brief.

If individual background summaries are already visible to the user, do not restate them wholesale. Surface the unified verdict, the highest-signal findings, and any remaining uncertainty.

## Models

Role defaults, stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). A matching role line in the `pstack-models.md` override sheet overrides each at runtime; `/setup-pstack` writes it and lists its path per runtime.

- thermos reviewers: `opus`

## Reasoning effort

A role value in the override sheet may name a reasoning effort after its model, as in `opus @xhigh`. Levels on Claude Code: `low`, `medium`, `high`, `xhigh`, `max`. Which ones apply depends on the model. A value without `@` takes the sheet's `default effort` line, a level or `session`, and `session` when the sheet has no such line. `session` sets no effort, so the dispatch is the usual one. Strip the suffix before reading the model: `inherit-parent` or `auto` still omits `model` at every level, and a model name is passed as `model`. Pass the level as the dispatch's effort field and keep the `subagent_type` you would otherwise use. That is `effort` on the Claude Code `Agent` call and `reasoning_effort` on Codex's `spawn_agent`. On Muse it is `effort` on a Workflow child; a `subagent_spawn` dispatch keeps the session's effort.

## Provider seats

A role entry written `<provider>:<model>`, with an optional `@<level>`, is a provider seat: it runs on that provider's own CLI and subscription. The providers are `claude`, `codex`, and `grok`. [Provider seats](../poteto-mode/references/provider-seats.md) lists the levels each takes and the seat runner's command. An entry for the runtime you are on, `claude:` on Claude Code or `codex:` on Codex, is an ordinary subagent with that model and level. Launch every other seat through the seat runner, in the background and in the same message as the subagent calls, with the same prompt written to a self-contained file, and read its output file when it finishes. A seat reads files under its working directory but cannot edit them, run commands, or reach this session's MCP tools, so it returns text: a design, a review, or a verdict. A provider counts as its own model family. A seat that fails is a dropout: continue with the rest, name the seat and its error in the output, and say that model diversity was reduced. Never rerun it on another model.
