Before anyone plans this task, decide whether a few questions to the user would change the plan. Do not modify anything; you may read the repository to see what is already decided.

Task:
{{task}}
{{#brief}}

The user's brief for this run:
{{brief}}
{{/brief}}
{{#memory}}

The project's memory: its conventions, decisions and notes kept from earlier runs. Follow its conventions and decisions unless the task says otherwise:
{{memory}}
{{/memory}}

Ask only about choices that matter for the result and that neither the task, the brief nor the repository already settle: scope, the users and platforms it is for, a technology or data choice, how something should behave. Do not ask about details a planner can decide sensibly on its own, and never ask for secrets, passwords or keys.

Ask at most {{questions}} questions, fewer when fewer matter, and none when the task is clear. Each question offers two to five short options (the user can also answer in their own words, so do not add an "Other" option). Put the option you would recommend first.

Answer with JSON only, in this shape:
```json
{"questions": [{"question": "Which database should it use?", "options": ["SQLite", "Postgres"]}]}
```
With no questions, answer `{"questions": []}`.
