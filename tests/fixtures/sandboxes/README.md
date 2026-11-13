# Test sandboxes

Tiny projects that tests and manual runs point Dim Factory at. **Copy one into a temp directory before use**
(they live inside this repo's git work tree, so `plain-folder` is only "non-git" once copied out).

| Sandbox | What it is | Check |
|---|---|---|
| `ts-small` | TypeScript greeting CLI, no dependencies (Node strips types natively) | `npm test` (`node --test`) |
| `py-small` | Python module + unittest, no dependencies | `python -m unittest` |
| `plain-folder` | A few text files, no git, no build | — |
