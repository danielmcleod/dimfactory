Implement the following task.
{{#state}}

{{state}}
{{/state}}

Task:
{{task}}
{{#plan}}

Approved plan — follow it. The user may have edited it; this version wins:
{{plan}}
{{/plan}}
{{#brief}}

The user's brief:
{{brief}}
{{/brief}}
{{#memory}}

The project's memory: its conventions, decisions and notes kept from earlier runs. Follow its conventions and decisions unless the task says otherwise:
{{memory}}
{{/memory}}
{{#acceptance}}

Acceptance criteria (build to meet each one):
{{acceptance}}
{{/acceptance}}
{{#tests}}

Tests written first (they fail now; make them pass, never weaken, skip or delete them):
{{tests}}
{{/tests}}
{{#run}}

Running it:
{{run}}
{{/run}}

Rules:
- Stay within the plan's scope.
- Match the existing style, patterns and libraries.
- If the project has tests, test new behaviour, and each bug fix with a test that would have caught it.
- Update the README and usage text for changes users see.
- Errors name the bad value; handle missing, repeated and malformed input.
- Do not commit, push, or switch git branches.
- If a plan step is wrong, do the closest correct thing; say why.
