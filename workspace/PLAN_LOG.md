# Plan Log

_Last updated: 2026-10-09 06:44 UTC by claude-m4-build_

## Current step

M4 is implemented. The next action belongs to the user: run `npm run test:all` on their own computer.

## Next step

M5: wait for "Proceed to M5" and the M5 instructions. Do not start M5 before that.

## Planned

- [2026-10-09 06:44 UTC] (claude-m4-build) M5: real multi-step task across two or more agent sessions, final demonstration and report.

## Completed

- [2026-10-05 02:00 UTC] (assistant) M1: MCP server skeleton with `list_files`.
- [2026-10-05 08:51 UTC] (assistant) M2: sandbox and five core file tools, with path-traversal tests.
- [2026-10-05 09:01 UTC] (assistant) M3: Streamable HTTP, PM2 configuration, ngrok instructions.
- [2026-10-09 06:44 UTC] (claude-m4-build) M4: handoff files and tools, git_status / git_diff / git_log, search_files.

## Notes

- [2026-10-09 06:44 UTC] (claude-m4-build) Shared code (sandbox, five core tools) is in `src/tools.ts`. The M4 tools are in `src/handoff.ts`, `src/git-tools.ts` and `src/search.ts`. `src/server-factory.ts` puts them all on one server.
- [2026-10-09 06:44 UTC] (claude-m4-build) A new session should call `read_project_state`, `read_plan_log`, `read_checkpoints` and `read_decisions` first, then `git_status` and `git_log`.