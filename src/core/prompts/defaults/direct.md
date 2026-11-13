{{task}}
{{#state}}

{{state}}
{{/state}}
{{#brief}}

The user's brief for this work:
{{brief}}
{{/brief}}
{{#memory}}

Notes kept from earlier work in this project:
{{memory}}
{{/memory}}
{{#acceptance}}

What the result must do:
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

Notes from Dim Factory, which checks the work afterwards:
- Do not commit, push or switch git branches.
- Never put secrets or API keys in code that runs in a browser or is committed; read them from the environment.
- When you fix a bug, add a test that would have caught it; when you add behaviour, test it. Use the project's own test setup; if it has none, do not add a test framework just for this.
- When something people see or type changes (a new command, flag or option), update the README or usage text.
- Error messages name the bad value and say what was expected. Handle missing, repeated and malformed input.
- If the person is not technical, prefer a result that opens without installing anything when that meets the need, and say plainly when something needs a server, an account or other setup.
