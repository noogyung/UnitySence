# CLAUDE.md

This workspace uses `@AGENTS.md` as the universal autonomous execution policy, `@PROGRESS.json` as the live checkpoint state, `@PLAN.md` as the master architecture & data contract, and `@docs/AI_EXECUTION_PLAYBOOK.md` as the step-by-step execution guide.

## Mandatory Autonomous Execution Directives

1. Follow every rule in `@AGENTS.md` without exception.
2. Always read `@PROGRESS.json` first, resume any `"in_progress"` or next `"pending"` step from `completedFiles`, update `PROGRESS.json` after each file, and create a `git commit` checkpoint after passing each step's verification commands.
3. Never pause to ask the user for confirmation or permission to proceed when the specification is already defined in `@PLAN.md` and `@docs/plans/01-*.md` through `06-*.md`.
4. Keep all file operations strictly inside `d:\Noogs\NextCloud\Projects\UnityBrain`.
5. Run commands one by one using clean, single-binary prefixes (`pnpm ...`, `dotnet ...`, `git ...`, `node ...`) without shell chaining (`;`, `&&`), variable expansion (`$VAR`), or command substitution (`$(...)`) so permission rules match automatically.
6. On any compile or test failure, fix the implementation and re-run tests autonomously until every check passes cleanly before reporting completion.
