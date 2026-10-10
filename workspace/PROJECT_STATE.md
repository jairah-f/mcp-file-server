# Project State

_Last updated: 2026-10-09 06:44 UTC by claude-m4-build_

## Project name

MCP File Server (`mcp-file-server`): a TypeScript MCP server that lets an MCP client work with files inside the `workspace/` folder only. School midterm project: build and deploy an MCP file-server connector, then prove it with a real multi-step task across more than one agent session.

## Current milestone

M4: agent handoff protocol + git-lite and search tools. M5 (real multi-agent proof) has NOT been started.

## Current status

M4 is implemented. On Linux the build and all three test suites pass (M2 125, M3 113, M4 213 checks). Not yet run on the user's own computer (Windows, VS Code). M5 starts only when the user says "Proceed to M5" and gives the M5 instructions.

## Completed milestones

- M1: MCP server skeleton with one tool, `list_files` (commit `bbc1f56`).
- M2: sandbox (`resolveSafePath`) and the five core file tools (commit `c30f288`).
- M3: Streamable HTTP at `/mcp`, PM2 configuration, ngrok instructions (commit `43e7a06`). The ngrok tunnel itself has not been tested by the assistant.

## Current task

Waiting for the M5 instructions. Nothing else is in progress.

## Implemented so far

- Core tools: `list_files`, `read_file`, `write_file`, `str_replace`, `delete_file`. All of them use `resolveSafePath()` in `src/tools.ts`.
- Handoff tools: `read_project_state`, `update_project_state`, `read_plan_log`, `update_plan_log`, `read_checkpoints`, `record_checkpoint`, `read_decisions`, `record_decision`.
- Git-lite tools (read-only): `git_status`, `git_diff`, `git_log`.
- Search tool: `search_files` (plain text, by content or by file name).
- Two ways to run the same server: stdio (`npm start`, MCP Inspector) and Streamable HTTP (`npm run start:http`, PM2, ngrok).

## Remaining work

- M5: run a real multi-step task across two or more agent sessions, using these state files for the handoff, then write the final demonstration and report.
- Not built, on purpose: authentication, a command-running tool, git commands that change anything.

## Important commands

```
npm install
npm run build
npm run start:http        # HTTP server on http://127.0.0.1:3000/mcp
npm run pm2:start         # same server under PM2
npm run test:all          # M2 + M3 + M4 tests
npm run check:endpoint    # read-only check of a running endpoint
```

## Important constraints

- All file access stays inside `workspace/` (sandbox). Never weaken `resolveSafePath()`.
- There is no authentication yet: anyone who has the ngrok URL can read and change files in `workspace/`. Keep nothing private there.
- Never put the ngrok token, passwords or other secrets in files, commits or chat.
- Do not push to GitHub unless the user asks.
- Only report tests that were really run.