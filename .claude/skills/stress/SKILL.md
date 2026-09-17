---
name: stress
description: Stress-test a spec or plan with a premortem — assume it shipped and failed, work backwards to why, then fold the risks into the spec. User-triggered once a spec exists, often on /interview output — don't auto-invoke.
argument-hint: "[spec file or topic]"
allowed-tools: Read,Edit,AskUserQuestion
model: opus
# Workaround: `disable-model-invocation: true` removed because /<name> routes via Skill tool in this harness, which honors the flag and blocks invocation. Re-add once the harness routes slash commands directly.
---

Stress-test: $ARGUMENTS

## Subject

If `$ARGUMENTS` is a path, read it. If it's a topic, look for a recent spec under `.claude/` that covers it. If neither resolves, treat the current branch diff as the implicit plan. State in one line what you're stress-testing before starting.

## Premortem

It's six months later. This shipped and failed badly enough that the team is writing a retro. Write that retro — concrete narratives, not hedged maybes. "The spec didn't handle X" is not a failure story; "a user did X on day three, which hit Y, and we lost a week to Z" is.

Generate 2–3 failures in each lens so no single axis dominates:

- **Scale/load** — where the ceiling is and what breaks first when it's hit
- **Integration** — the external API, schema, or system assumption that turns out wrong
- **The unspecified case** — what the spec is silent on that a user hits in week one
- **Human/process** — misuse, the migration nobody ran, config that drifts
- **The premise** — it worked exactly as specced and still didn't solve the problem

Rules:

- Cap at 8 failure modes total, two or three sentences each. Rank by expected damage; cut the rest.
- Every failure must name a specific requirement, component, or decision from the spec. Generic entries ("insufficient testing", "scope creep") are banned.

## Triage

One AskUserQuestion round: present the failures as options (multiSelect) and ask which are real enough to spend spec changes on. The user holds context you don't — traffic numbers, team appetite, what's deliberately throwaway.

## Fold back

Edit the spec in place — no separate report:

- Each failure the user accepted as real: change the requirement it threatens inline, then record it under `## Risks — Mitigated` with the one-line change it caused.
- Each failure the user waved off: record it under `## Risks — Accepted` with one line of why it's fine.

The spec gets sharper; nothing is orphaned.
