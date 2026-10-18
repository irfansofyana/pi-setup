# Provenance and evaluation

Original package-owned instructions, informed by public writing guidance reviewed on 2026-10-18. Upstream skill text is not copied into `SKILL.md`; no third-party runtime, installation or configuration is required.

## Design references

- [Humanizer](https://github.com/blader/humanizer/blob/main/SKILL.md): preserve supplied facts and voice; use final-text-only output for embedded editing. Main declared 3.0.0 when reviewed, not a pinned release.
- [Stop Slop](https://github.com/hardikpandya/stop-slop/blob/main/SKILL.md): concrete wording and less formulaic prose. This skill does not adopt blanket bans on adverbs, passive voice or fixed sentence patterns.
- [Writing Clearly and Concisely](https://github.com/obra/the-elements-of-style/blob/main/skills/writing-clearly-and-concisely/SKILL.md): clarity and concision, without loading the full historical reference or copying the modern wrapper.
- [Wikipedia's AI-writing indicators](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing): descriptive clues, not proof of authorship. Em-dash avoidance here is a user preference, not an AI detector.

Humanizer and Stop Slop use MIT licenses. If future changes copy substantial upstream text, retain the applicable copyright and permission notices. The modern Obra wrapper's licensing was not established during this review; do not infer permission from the historical book's status.

## Verification boundary

[Evaluation cases](../evals/evals.json) are authored scenarios, **not run** model evaluations or effectiveness measurements. Static tests validate packaging, policy, routing documentation and the real Caveman phrase-trigger function. They do not prove prose quality, model selection or adherence across providers.

For future behavioral evaluation, run each case both with and without this skill in fresh contexts, using the indicated Caveman level without changing live user preferences. Compare facts and protected literals first, style second. The `active_caveman` field describes a test condition; it does not configure the extension. Review results with a human before claiming improved writing or compatibility.

No skill body should contain Caveman's activation/deactivation phrases: explicit skill expansion can place its text in a user prompt and accidentally trigger a level change. The contract test guards this boundary. Skill selection remains best-effort; `/skill:natural-writing` explicitly loads it. Existing role-specific skill allowlists remain unchanged.
