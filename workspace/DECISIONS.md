# Decisions

_Last updated: 2026-10-09 06:44 UTC by claude-m4-build_

_Important technical decisions and the reasons for them. Newest entries are at the bottom._

## D-001: Every file tool is confined to the workspace/ folder
- Recorded: 2026-10-05 08:51 UTC by assistant
- Decision: All file access goes through one function, `resolveSafePath()`. It rejects absolute paths, `..` escapes, null bytes and symlinks that point outside `workspace/`.
- Reason: The server is meant to be reachable by an AI agent (and later over the internet). A single checked entry point is easier to test and harder to get wrong than checks scattered across tools.

## D-002: Streamable HTTP in stateless mode, only POST /mcp
- Recorded: 2026-10-05 09:01 UTC by assistant
- Decision: The HTTP server exposes only `POST /mcp`, creates a fresh MCP server per request, and answers with plain JSON.
- Reason: Streamable HTTP is the current MCP transport for remote servers. Stateless mode needs no session storage, so a restart loses nothing. No other routes means no way to download project files over HTTP.

## D-003: PM2 keeps the server running
- Recorded: 2026-10-05 09:01 UTC by assistant
- Decision: PM2 runs `dist/server-http.js` from `ecosystem.config.cjs` and restarts it after a crash.
- Reason: The server should stay up without a person watching a terminal. PM2 is installed globally, not as a project dependency.

## D-004: ngrok provides the HTTPS address
- Recorded: 2026-10-05 09:01 UTC by assistant
- Decision: The server listens on 127.0.0.1 only; ngrok forwards a public HTTPS URL to it.
- Reason: Remote MCP clients need an HTTPS URL. A tunnel avoids opening ports or handling certificates, and the tunnel can be stopped at any time.

## D-005: No authentication in M3 or M4
- Recorded: 2026-10-05 09:01 UTC by assistant
- Decision: No login or API key was added.
- Reason: It was out of scope for the milestone. Consequence: anyone who has the ngrok URL can read and change files in `workspace/`, so keep nothing private there and stop ngrok when not in use.

## D-006: Handoff state lives in plain Markdown files inside workspace/
- Recorded: 2026-10-09 06:44 UTC by claude-m4-build
- Decision: The agent handoff uses PROJECT_STATE.md, PLAN_LOG.md, CHECKPOINTS.md and DECISIONS.md, with small tools that edit them by section.
- Reason: A new session can read the same files with any tool, people can read and edit them too, and they go through the same sandbox. No database is needed.

## D-007: Git tools are fixed, read-only commands limited to workspace/
- Recorded: 2026-10-09 06:44 UTC by claude-m4-build
- Decision: `git_status`, `git_diff` and `git_log` each run one fixed git command with an argument list (no shell). Status and diff only show files inside `workspace/`. There is no tool that runs arbitrary commands or changes the repository.
- Reason: An agent must be able to see what changed, but must not be able to run commands or read source files outside the sandbox.

## D-008: search_files matches plain text, not regular expressions
- Recorded: 2026-10-09 06:44 UTC by claude-m4-build
- Decision: Search is a plain text match (case-insensitive by default) by file content or file name, with limits on results, files, bytes and time.
- Reason: A malicious regular expression can make a server hang. Plain text keeps the search safe and predictable.