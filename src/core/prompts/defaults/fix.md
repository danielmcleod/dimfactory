Address the findings below in this repository.
{{#state}}

{{state}}
{{/state}}
{{#task}}

You are continuing this task in a fresh session.
Task:
{{task}}
{{/task}}
{{#plan}}

Plan:
{{plan}}
{{/plan}}
{{#brief}}

The user's brief for this run:
{{brief}}
{{/brief}}
{{#memory}}

The project's memory: its conventions, decisions and notes kept from earlier runs. Follow its conventions and decisions unless the task says otherwise:
{{memory}}
{{/memory}}
{{#tests}}

Test-first: these tests were written before Implement. Keep them; do not weaken, skip or delete them:
{{tests}}
{{/tests}}
{{#diff}}

Changes made so far by this run:
<diff>
{{diff}}
</diff>
{{/diff}}
{{#summary}}

What the person was told about the result before these fixes (your summary replaces it: keep what is still true, correct what your fixes change):
{{summary}}
{{/summary}}
{{#acceptance}}

The plan's acceptance criteria (keep meeting them):
{{acceptance}}
{{/acceptance}}

Findings to address (selected by the user, [must] first):
{{findings}}
{{#security}}

Security findings (marked [security:<level>]): {{security}}
- Fix the root cause: remove a committed secret from the code (read it from the environment or a secret store instead, and say in one line that the leaked value must be rotated), validate and encode input, add the missing check.
- Never silence a check: do not disable, skip or weaken a scanner, a linter rule, a test or an audit, and do not add allowlist entries or ignore comments to hide a finding.
- For a vulnerable dependency, upgrade to a fixed version or replace it; do not pin around the advisory.
{{/security}}
{{#verify}}

Latest automated check results:
{{verify}}
{{/verify}}
{{#run}}

Running it:
{{run}}
{{/run}}

Rules:
- Fix every [must]. Fix a [should] when the fix is small and safe; otherwise skip it and say why.
- When a finding is a bug and the project has tests, add a test that would have caught it.
- A finding can be wrong. If you check and disagree, leave the code as is and explain in one line.
- Respect the notes: do not redo changes the user reverted, and keep the user's own edits.
- Leave failures marked "already failing before this run" alone unless your change caused them.
- Do not commit, push, or switch git branches.

Finish with one line per finding: `F<n> fixed` | `F<n> skipped: <reason>` | `F<n> disputed: <reason>`.

Then end with a `## Summary` heading. Your closing message goes under it: about the whole result, not just these fixes.
