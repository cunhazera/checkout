---
name: interview
description: Interview the user about a topic to extract requirements and build a specification. User-triggered when they want a spec for a feature, system, or change — don't auto-invoke.
argument-hint: "[topic]"
allowed-tools: Read,Write,AskUserQuestion
model: opus
# Workaround: `disable-model-invocation: true` removed because /<name> routes via Skill tool in this harness, which honors the flag and blocks invocation. Re-add once the harness routes slash commands directly.
---

Interview the user about: $ARGUMENTS

Run an adaptive interview with the `AskUserQuestion` tool, then write the spec.

## Steps

**1. Scope.** Open broad — what problem this solves, who consumes it, expected scale. The answers
decide whether one round covers it or the topic needs several.

**2. Deep dive.** Up to 4 questions per round, aimed at whatever is still ambiguous: architecture
and data model, behavior at the edges and on failure, interaction and performance expectations,
tradeoffs and what's out.

Challenge stated requirements with "what problem does that solve?" — the ask is often a solution
the user already picked. When an answer is "it depends", make them name the conditions. Restate
your understanding before moving on. Keep probing until 95% confident about what the user actually
wants, not what they think they should want; stop when answers start repeating.

**3. Write the spec.** Under a page. Decisions made, not possibilities discussed.

```
## <topic>

<one paragraph: what this is and why it matters>

### Requirements
- Functional: what it does
- Non-functional: how well it does it
- Constraints and assumptions

### Technical decisions
<the architectural choices made in the interview, each with its reason>

### Open questions
<unresolved items that need investigation>

### Out of scope
<what this explicitly does not include>
```
