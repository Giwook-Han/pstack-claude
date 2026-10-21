---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
---

# Arena

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.

On Muse, read the [platform mapping](../poteto-mode/references/muse-tools.md), including its per-skill notes, before following this skill.

Open a todolist with one entry per phase (Frame, Fan out, Cross-judge, Pick, Graft, Verify) before launching anything.

## Phase A: Frame

Every candidate gets the same prompt, so the prompt is the contract.

1. State the artifact each candidate is producing.
2. Derive the rubric, 3-6 concrete gradeable criteria for what success looks like on *this* task. It is the picker's tool in Phase D. Candidates only see the task.
3. Pick the runners. Use the `arena runners` line in `pstack-models.md`. If the sheet or that line is missing, run one each on the defaults in [Models](#models). An `auto` or `inherit-parent` entry in this line or the cross-judge line means the parent model, so omit `model` for it. If the `Agent` tool rejects a configured entry, run that seat on its family's default and say so. Families go by model name, such as Opus, Fable, or Sonnet. With no family match, use the single-role default in [Models](#models). If it rejects a default, use the closest valid slug of the same family from its error message. Spawn more runners when the arena covers multiple design directions. Use the same model N times when the work is generation-bound rather than judgment-sensitive. Pick each subagent's reasoning level for the job, per the Subagents section of the **poteto-mode** skill. An entry with a provider prefix, in this line or the cross-judge line, runs as a provider seat per [Provider seats](#provider-seats), and the `Agent` fallback above applies only to entries without one. A seat's candidate is the text it returns, saved in its output location. When candidates write code, a seat runs in write mode in its own fresh git worktree per [Provider seats](#provider-seats), and its candidate is the worktree's changes, with its final message as the rationale.
4. Give each candidate its own output location (a git worktree where possible, otherwise `/tmp/arena-<slug>/candidate-<n>/`), per the **separate-before-serializing-shared-state** principle skill. A seat that writes code needs a fresh linked worktree, with its answer file outside the worktree.

## Phase B: Fan out

Spawn all N subagents in one message with `run_in_background: true`, each with the task, the path to the shared grounding, its own output path, and instructions to produce the artifact and a short rationale naming the alternatives it considered and what it rejected.

If a candidate produces no output, proceed with N-1 and note the dropout.

## Phase C: Cross-judge

After all Phase B candidates complete, choose one model from the `arena cross-judge pool` line in `pstack-models.md`. If the sheet or that line is missing, choose from the runner defaults in [Models](#models). Prefer a different model family from the parent's. Spawn one readonly judge subagent on that model, or a provider seat when the entry has a prefix. It sees the rubric and the candidates by path label, scores each criterion, and recommends a base with rationale. It runs in parallel with your reading in Phase D. Don't spawn it while candidates are still writing.

## Phase D: Pick a base

Read every candidate end to end before picking. Score each against the rubric criterion by criterion, not on holistic feel, and compare with the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous. Read both rationales before deciding.

Pick the base a future maintainer can extend most easily without breaking invariants. When two feel tied, prefer the cleaner boundary or smaller API, per the Laziness Protocol.

## Phase E: Graft

Walk each losing candidate once more for what is worth porting into the base, usually one or two things per candidate, not most of it. Fold each graft in by hand, per the **redesign-from-first-principles** principle skill, so the result stays coherent under one mental model. Don't paste mechanically.

If the candidates converge on one shape, that is strong agreement. Note it and ship the consensus shape. No graft is needed. If they wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

Verify the synthesized artifact like any other output, per the **prove-it-works** principle skill. If verification finds a problem the arena missed, either Phase A was wrong (re-frame and re-run) or a candidate caught it and you missed the graft (go back to Phase E). Don't paper over it.

## Outputs

One synthesized artifact, with a short synthesis note alongside naming the base and why, the cross-judge's verdict, each graft with its source candidate, what was rejected and why, any convergence or dropouts, and the verification result.

## Models

Role defaults, stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`). A matching role line in the `pstack-models.md` override sheet overrides each at runtime; `/setup-pstack` writes it and lists its path per runtime.

- arena runners: `opus`, `fable`, `sonnet`, `haiku`
- arena cross-judge pool: `opus`, `fable`, `sonnet`, `haiku`

## Reasoning effort

A role value in the override sheet may name a reasoning effort after its model, as in `opus @xhigh`. Levels on Claude Code: `low`, `medium`, `high`, `xhigh`, `max`. Which ones apply depends on the model. A value without `@` takes the sheet's `default effort` line, a level or `session`, and `session` when the sheet has no such line. `session` sets no effort, so the dispatch is the usual one. Strip the suffix before reading the model: `inherit-parent` or `auto` still omits `model` at every level, and a model name is passed as `model`. Pass the level as the dispatch's effort field and keep the `subagent_type` you would otherwise use. That is `effort` on the Claude Code `Agent` call and `reasoning_effort` on Codex's `spawn_agent`. On Muse it is `effort` on a Workflow child; a `subagent_spawn` dispatch keeps the session's effort.

## Provider seats

A role entry written `<provider>:<model>`, with an optional `@<level>`, is a provider seat: it runs on that provider's own CLI and subscription. The providers are `claude`, `codex`, and `grok`. [Provider seats](../poteto-mode/references/provider-seats.md) lists the levels each takes and the seat runner's command. An entry for the runtime you are on, `claude:` on Claude Code or `codex:` on Codex, is an ordinary subagent with that model and level. Launch every other seat through the seat runner, in the background and in the same message as the subagent calls, and read its answer file when it finishes. The `Agent` rules in this skill, including any fallback for a rejected entry, apply only to entries without a prefix. A seat cannot load skills or reach this session's MCP tools, so its prompt file carries everything a subagent would get, with every skill or reference the prompt names pasted in. It returns text, such as a design, a review, or a verdict. Only `arena` and `swarm` let a seat edit files, in write mode inside its own clean git worktree. A seat's provider counts as a model family different from the parent's when the parent runs on another provider. A seat that fails is a dropout: continue with the rest, name the seat and its error in the output, and say that model diversity was reduced. Never rerun it on another model or hand its work to a subagent.
