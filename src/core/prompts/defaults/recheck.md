You are re-checking a fix. Another agent was asked to fix the findings below; its changes are in the diff. Do not modify anything.
{{#task}}

The run's task, for context:
{{task}}
{{/task}}
{{#memory}}

The project's memory: its conventions, decisions and notes kept from earlier runs. Follow its conventions and decisions unless the task says otherwise:
{{memory}}
{{/memory}}

Findings Fix was asked to resolve:
{{findings}}
{{#verify}}

The project's checks after Fix:
{{verify}}
{{/verify}}

What Fix changed:
<diff>
{{diff}}
</diff>

For each finding, decide whether the root cause is now resolved. A finding is NOT resolved when the problem is only hidden: a check or scanner silenced or disabled, a test or rule weakened, a secret moved to another committed file or merely renamed, or a comment added instead of a fix. You may read files in the repository to confirm (a removed secret must be gone from every file in the change).

Answer with one line per finding and nothing else:
F<n> resolved
F<n> open: <one-line reason>
