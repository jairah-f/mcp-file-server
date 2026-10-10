# Checkpoints

_Last updated: 2026-10-09 06:44 UTC by claude-m4-build_

_Milestone and checkpoint history. Newest entries are at the bottom._

## M1 — completed
- Recorded: 2026-10-05 02:00 UTC by assistant
- Notes: MCP server skeleton with one tool, `list_files`, over stdio. Commit `bbc1f56`.
- Testing: run with MCP Inspector by the user; `list_files` worked on the workspace folder.

## M2 — completed
- Recorded: 2026-10-05 08:51 UTC by assistant
- Notes: Five tools (`list_files`, `read_file`, `write_file`, `str_replace`, `delete_file`) behind one central `resolveSafePath()` sandbox. Commit `c30f288`.
- Testing: automated test script (stdio) with path-traversal, absolute-path and symlink attacks. 125 checks passed on Linux. Not run on Windows by the assistant.

## M3 — completed
- Recorded: 2026-10-05 09:01 UTC by assistant
- Notes: Streamable HTTP at `/mcp` (port 3000, stateless), PM2 configuration, ngrok instructions and README. Commit `43e7a06`.
- Testing: automated HTTP test script, 113 checks passed on Linux. PM2 start, restart after a crash, stop and delete worked on Linux. The ngrok tunnel was NOT tested by the assistant. Windows was not tested by the assistant.

## M4 — completed
- Recorded: 2026-10-09 06:44 UTC by claude-m4-build
- Notes: Handoff files and eight handoff tools; git_status, git_diff and git_log (read-only, fixed commands, limited to workspace/); search_files (plain text, by content or file name). New code is in `src/handoff.ts`, `src/git-tools.ts`, `src/search.ts` and `src/server-factory.ts`; `src/tools.ts` only got `export` keywords and a renamed factory function.
- Testing: on Linux, `npm run build` passed and all three test suites passed: M2 125/125, M3 113/113, M4 213/213. Deliberately broken copies (no search sandbox, git run through a shell, no heading escaping, no git path sandbox, no file lock) made the M4 tests fail, so the tests do catch those mistakes. NOT tested: Windows / the user's own computer, the ngrok tunnel, a real remote MCP client.git add