# MCP File Server

A school project: a small [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server, written in TypeScript, that lets an MCP client (an AI agent) work with files inside a designated `workspace/` folder, and cannot reach anything outside it.

## Project status: M1–M5 implemented

The project is organized into five milestones. The server currently registers **17 MCP tools** and supports both stdio and Streamable HTTP transports. M5 authentication and workflow code is implemented; some environment-specific and live-demo checks still need to be verified on the machine where you deploy it.

### Milestone roadmap

| Milestone | What was built | Main files / features | Verification |
| --- | --- | --- | --- |
| **M1 — Project skeleton** | TypeScript MCP server foundation and initial `list_files` tool. | `src/server.ts`, `package.json`, `tsconfig.json` | Install dependencies, build, and launch the stdio server / MCP Inspector. |
| **M2 — Core file tools and sandbox** | Five workspace file tools with path validation to keep file access inside `workspace/`; text-file size limits. | `src/tools.ts`; `list_files`, `read_file`, `write_file`, `str_replace`, `delete_file` | `npm test` |
| **M3 — HTTP deployment** | Streamable HTTP endpoint at `/mcp`, endpoint checker, ngrok tunnelling instructions, and PM2 process configuration. | `src/server-http.ts`, `test/m3-http-test.ts`, `ecosystem.config.cjs` | `npm run test:http`; then verify the local endpoint. ngrok and Windows deployment require local checks. |
| **M4 — Agent handoff and workspace utilities** | Shared state/plan/checkpoint/decision files, read-only Git status/diff/log tools, and workspace text search. | `src/handoff.ts`, `src/git-tools.ts`, `src/search.ts`, `workspace/` | `npm run test:m4` |
| **M5 — Authentication and multi-step workflow** | Bearer-token authentication for HTTP requests plus a documented workflow for agents to hand off work through shared project-state files. | `MCP_AUTH_TOKEN`; auth checks in the HTTP tests; handoff tools from M4 | `npm run test:all`; verify valid and invalid tokens locally and demonstrate a handoff with your MCP client. |

**Recommended order for a new user:** follow the setup and testing instructions below first, then read the milestone guide for the feature you want to run. The table describes the project's milestone progression; it does not mean ngrok, Windows, or a live remote multi-agent demonstration have already been verified in every environment.

```

Remote MCP client --HTTPS--> ngrok URL --> localhost:3000 --> /mcp --> check the token --> MCP server --> workspace/

```

## Follow the milestones

These milestones build on one another. If you are setting up the repository from GitHub, start with the common setup, then use the matching milestone section.

### Before you start

- Install Node.js **18.18 or newer** and npm.
- Install Git and make sure it is available in your terminal.
- Clone the repository and open the project folder in VS Code.
- In the VS Code terminal, run:

```bash
npm install
npm run build
```

### M1 — Create and run the MCP server skeleton

M1 establishes the TypeScript project and the initial `list_files` MCP tool. The stdio entry point is used for local clients and MCP Inspector.

```bash
npm run build
npm start
```

To inspect the stdio server with MCP Inspector, use a separate terminal and run `npm run inspect`. Leave the server running while you inspect it.

### M2 — Add file tools and workspace sandbox

M2 adds `list_files`, `read_file`, `write_file`, `str_replace`, and `delete_file`. These tools use paths relative to `workspace/`; the sandbox rejects paths that escape the workspace.

```bash
npm test
```

Only use test files and sample content when trying write or delete operations. The tools can modify or delete files inside `workspace/`.

### M3 — Run the HTTP endpoint and optional remote tunnel

M3 adds the Streamable HTTP endpoint at `http://127.0.0.1:3000/mcp`. M5 authentication now applies to this endpoint, so set `MCP_AUTH_TOKEN` before starting the HTTP server. Follow the **Authentication (M5)** and **M3 step by step** sections below for PowerShell, ngrok, and PM2 instructions.

```bash
npm run test:http
```

### M4 — Use handoff, Git-lite, and search tools

M4 adds four workspace handoff files, eight handoff tools, three read-only Git-lite tools, and `search_files`. The handoff files allow a new agent session to read the latest project status and continue from the recorded plan.

```bash
npm run test:m4
```

Before starting a new agent session, call `read_project_state`, `read_plan_log`, `read_checkpoints`, and `read_decisions`. The Git-lite tools are read-only; they cannot commit or push changes.

### M5 — Authenticate requests and demonstrate a multi-step handoff

M5 protects the HTTP endpoint with a bearer token and combines authentication with the M4 handoff workflow. Set `MCP_AUTH_TOKEN` in the same terminal used to start the HTTP server, and configure the MCP client to send that value as its bearer token. Do not save the real token in this README, source code, screenshots, or Git.

1. Start the authenticated HTTP server using the instructions in **Authentication (M5)**.
2. Confirm that a request without the token is rejected with HTTP `401`.
3. Connect using the valid token and confirm the MCP tools are available.
4. In the first agent session, read the handoff files and complete a small task.
5. Update the plan and project state, and record a checkpoint or decision if appropriate.
6. Start a second agent session, read the handoff files, and continue from the recorded state.
7. Record which parts were actually demonstrated in your environment. Automated tests alone do not prove that a live ngrok connection or remote multi-agent handoff has been completed.

Run the complete automated test suite after setup:

```bash
npm run test:all
```

## All tools (17)

All paths are **relative to the `workspace/` folder**.

### Core file tools (M2)

| Tool | What it does |

| --- | --- |

| `list_files` | List files and folders (input: `path`, optional, default `"."`). |

| `read_file` | Return a text file's contents (input: `path`). Max 1 MB. |

| `write_file` | Create or overwrite a file (inputs: `path`, `content`). Parent folders are created. Max 1 MB. |

| `str_replace` | Replace one exact piece of text (inputs: `path`, `old`, `new`). `old` must appear exactly once, otherwise nothing changes. |

| `delete_file` | Delete one file (input: `path`). Folders cannot be deleted. |

### Handoff tools (M4)

| Tool | What it does |

| --- | --- |

| `read_project_state` | Return `PROJECT_STATE.md`. **Call this first in a new session.** |

| `update_project_state` | Replace one section of `PROJECT_STATE.md` (inputs: `section`, `content`, optional `agent`). |

| `read_plan_log` | Return `PLAN_LOG.md`. |

| `update_plan_log` | Change `PLAN_LOG.md` (inputs: `kind` = `current` / `next` / `planned` / `completed` / `note`, `text`, optional `agent`). `current` and `next` replace; the others add a timestamped bullet. |

| `read_checkpoints` | Return `CHECKPOINTS.md`. |

| `record_checkpoint` | Add a checkpoint (inputs: `name`, `status` = `planned` / `in_progress` / `completed` / `blocked`, `notes`, optional `testing`, optional `agent`). |

| `read_decisions` | Return `DECISIONS.md`. |

| `record_decision` | Add a numbered decision (inputs: `title`, `decision`, `reason`, optional `agent`). |

### Git-lite tools (M4, read-only)

| Tool | What it does |

| --- | --- |

| `git_status` | Branch and changed files in `workspace/` (`??` new, `M` modified, `A` added, `D` deleted). |

| `git_diff` | What changed in tracked files of `workspace/` (inputs, all optional: `path`, `staged`, `stat_only`). |

| `git_log` | Recent commits: short hash, date, message (inputs, optional: `limit` 1–50, `path`). No author names or e-mail addresses. |

### Search tool (M4)

| Tool | What it does |

| --- | --- |

| `search_files` | Find text in the workspace. Inputs: `query`, optional `path`, `mode` (`content` or `filename`), `case_sensitive`, `max_results` (1–200, default 50). Result lines look like `folder/file.txt:12: the matching line`. |

## The handoff protocol (how a new agent session continues the work)

An AI agent session forgets everything when it ends. To let a **new session pick up where the old one stopped**, the project keeps four ordinary Markdown files **inside `workspace/`**. There is no database: it is just files, protected by the same sandbox as every other file.

| File | Purpose |

| --- | --- |

| `PROJECT_STATE.md` | **Where the project stands right now:** project name, current milestone, status, completed milestones, current task, what is implemented, what remains, important commands, important constraints. |

| `PLAN_LOG.md` | **The plan:** current step, next step, planned work, completed work, and useful notes. |

| `CHECKPOINTS.md` | **History of milestones/checkpoints** (M1, M2, M3, M4 ...), with testing notes. Entries are only added, never edited. Newest at the bottom. |

| `DECISIONS.md` | **Important decisions and why** (sandbox, Streamable HTTP, PM2, ngrok, ...). Numbered D-001, D-002, ... Entries are only added, never edited. |

**How a session should use them**

1\. **Start:** call `read_project_state`, `read_plan_log`, `read_checkpoints`, `read_decisions`. Then `git_status` and `git_log` to see what changed.

2\. **Work:** after each meaningful step, `update_plan_log` (move `current` / `next` forward, add `completed` items).

3\. **Important choices:** `record_decision`.

4\. **Milestones:** `record_checkpoint`, including what was **really** tested.

5\. **Stop:** `update_project_state` so the next session starts from the truth.

Pass `agent` (for example `"session-1"`) so the files show who wrote what.

**How the files are kept tidy.** The tools edit by section (`## heading`), so one update cannot wreck the rest of the file. Text an agent writes cannot create fake `##` headings (they are escaped) or leave a code block open. Two writes at the same moment are handled one after the other, so none is lost. If a file is deleted, the next read re-creates an empty version. The files can also be read and edited with the normal file tools or by a person.

## Git-lite: what it can and cannot do
- Only three commands exist: **status**, **diff**, **log**. All are read-only. There is no add, commit, push, checkout or anything that changes the repository.
- There is **no tool that runs a command.** Each tool builds one fixed `git` command and starts it with an argument list, **without a shell**, so characters like `;`, `|`, `&` or `$( )` in an argument are just text.
- The only free-text argument is `path`. It must pass the **workspace sandbox** first, and it reaches git as a literal file name after `--` (so `--output=...` or `-p` is a file name, not an option).
- `git_status` and `git_diff` only show files inside `workspace/`. Changes to source code outside `workspace/` are deliberately **not** shown, because an agent confined to the workspace should not be able to read the server's own code through git.
- `git_diff` does not show brand-new (untracked) files; `git_status` lists them.
- Output is shortened after about 300 lines.
- If Git is not installed, or the project folder is not a Git repository, the tools say so in plain words. A repository in a **parent** folder is never used.

## Search: what it can and cannot do
- Searches **only inside `workspace/`** (starting at `path`). The start path goes through the sandbox, so `../`, absolute paths and links pointing outside are refused.
- **Symbolic links are never followed.** Folders named `.git` and `node_modules`, binary files and files over 1 MB are skipped (the answer tells you how many).
- **Plain text only, no regular expressions.** A malicious pattern can freeze a server, so `.*` is searched as the two characters `.` and `*`.
- Limits keep it fast and small: at most 200 results (default 50), 10 per file, 2000 files, 20 MB of text, 5 seconds, long lines are cut to a snippet.

## How the sandbox works

Every file tool, every handoff tool and `search_files` use the same helper, `resolveSafePath()` in `src/tools.ts`, **before** touching the disk. It rejects null bytes and absolute paths (Windows and POSIX styles), resolves the path against `workspace/`, checks it is still inside, and follows symlinks/junctions so a link cannot lead outside. Error messages never show absolute system paths. M4 did not change this logic.

Valid: `notes.txt`, `folder/notes.txt`, `folder/../notes.txt` (the `..` stays inside).

Rejected: `../package.json`, `../../package.json`, `../src/server.ts`, `folder/../../package.json`, `..`, `C:\Windows\win.ini`, `/etc/passwd`, and links that point outside.

## Project structure

```

mcp-file-server/

├── src/

│   ├── tools.ts           # sandbox (resolveSafePath) + the five core tools

│   ├── handoff.ts         # M4: the eight handoff tools

│   ├── git-tools.ts       # M4: git_status, git_diff, git_log

│   ├── search.ts          # M4: search_files

│   ├── server-factory.ts  # puts all 17 tools on one server (used by both entry points)

│   ├── server.ts          # entry point 1: MCP over stdio (Inspector)

│   └── server-http.ts     # entry point 2: MCP over Streamable HTTP (M3)

├── test/

│   ├── m2-test.ts         # sandbox + core tool tests over stdio

│   ├── m3-http-test.ts    # HTTP server tests

│   ├── m4-test.ts         # handoff, git-lite and search tests

│   ├── check-endpoint.ts  # quick read-only check of any MCP URL

│   └── tsconfig.json      # editor settings for the test folder

├── workspace/             # the only folder the tools may touch

│   ├── PROJECT_STATE.md   # M4 handoff files

│   ├── PLAN_LOG.md

│   ├── CHECKPOINTS.md

│   └── DECISIONS.md

├── ecosystem.config.cjs   # PM2 configuration

├── package.json

├── tsconfig.json

└── README.md

```

## Requirements
- Node.js 18.18 or newer (developed with Node 22) and npm
- **Git** installed and on the PATH (for the git tools), and the project folder must be a Git repository (`git init`)
- For M3: a free [ngrok](https://ngrok.com) account and the ngrok agent, and PM2 (`npm install -g pm2`)

## Commands

| Command | What it does |

| --- | --- |

| `npm install` | Install dependencies |

| `npm run build` | Compile TypeScript into `dist/` |

| `npm run typecheck` | Type-check without producing files |

| `npm start` | Run the **stdio** server (for MCP Inspector) |

| `npm run inspect` | Open MCP Inspector connected to the stdio server |

| `npm run start:http` | Run the **HTTP** server from source (development). **Needs `MCP_AUTH_TOKEN`** |

| `npm run start:http:built` | Run the compiled HTTP server (`dist/server-http.js`). **Needs `MCP_AUTH_TOKEN`** |

| `npm run check:endpoint` | Check an MCP URL (default `http://127.0.0.1:3000/mcp`). Uses `MCP_AUTH_TOKEN` from your terminal |

| `npm run pm2:start` | Build, then start (or restart) the HTTP server under PM2 |

| `npm run pm2:status` / `pm2:logs` / `pm2:restart` / `pm2:stop` / `pm2:delete` | Manage the PM2 process |

| `npm test` | M2 tests (stdio) |

| `npm run test:http` | M3 tests (HTTP) |

| `npm run test:m4` | M4 tests (handoff, git-lite, search) |

| `npm run test:all` | All three test suites |

## How to test the project (M1–M5)

```

npm install

npm run build

npm run test:all

```

`npm run test:m4` on its own takes about half a minute. It copies the project into a temporary folder and runs everything there (including its own throwaway Git repositories), so your real files, your real Git history and your `workspace/` are never touched. It ends with `Result: N passed, 0 failed`.

To try the tools by hand: start the server (`npm run start:http`), then in a second terminal run `npm run check:endpoint`, or open MCP Inspector with `npm run inspect` and call `read_project_state`, `git_status`, or `search_files` with `{"query": "M4"}`.

## M5: Authentication and multi-step agent workflow

M5 brings together the authentication layer and the shared-state handoff protocol so that an MCP client can securely access the workspace and agent sessions can continue work from recorded project state.

### M5 workflow
1. Start the HTTP server with `MCP_AUTH_TOKEN` set in the terminal environment.
2. Expose the local HTTP server through ngrok when remote access is needed.
3. Configure the MCP client to use the HTTPS endpoint ending in `/mcp` and provide the bearer token through the client's secure configuration.
4. In the first agent session, read `PROJECT_STATE.md`, `PLAN_LOG.md`, `CHECKPOINTS.md`, and `DECISIONS.md` before working.
5. Complete a bounded task using the file, search, and read-only Git-lite tools.
6. Update the plan and project state and record relevant checkpoints or decisions.
7. In a second agent session, read the handoff files and continue the task based on the recorded state.
8. Verify the resulting workspace files and confirm that requests without a valid bearer token receive HTTP `401`.

### M5 security and verification
- The HTTP endpoint requires a bearer token; missing or incorrect credentials are rejected before MCP tools run.
- The token is supplied through `MCP_AUTH_TOKEN` and must not be committed or included in screenshots, chat transcripts, or the README.
- Automated tests reported below cover authentication behavior, including missing, incorrect, and valid tokens.
- A successful automated test run is not the same as a live remote demonstration. The live ngrok and multi-agent workflow must be tested in the target environment before describing that particular integration as verified.

## Authentication (M5): the bearer token

The HTTP server **refuses to start** unless the environment variable `MCP_AUTH_TOKEN` is set to a secret of at least 16 characters. Every `POST /mcp` must then carry:

```

Authorization: Bearer <the same secret>

```

A missing or wrong token gets **HTTP 401** before the request body is read and before any MCP tool can run. The token is compared in constant time, is never logged, and exists only in your terminal's environment (never in a file in this project, `package.json`, `ecosystem.config.cjs` or Git). The stdio server (`npm start`, MCP Inspector) is not affected: it is not reachable from the network.

What this does and does not do: HTTPS (ngrok) hides the token on its way across the internet. The token is what decides who may use the tools. It is one shared secret: anyone who gets it can read, write and delete in `workspace/`. Keep it out of screenshots, chats and Git, and make a new one for each demo.

### Make a token and start the server (Windows PowerShell)

Run these in the VS Code terminal, in the project folder. The variable lives only in that terminal window and disappears when you close it.

```powershell

# 1. Make a long random token (32 random bytes as 64 hex characters) and keep it in this terminal only.

$bytes = New-Object byte[] 32

[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)

$env:MCP_AUTH_TOKEN = -join ($bytes | ForEach-Object { $_.ToString("x2") })

# 2. Optional: copy it to the clipboard to paste into a password manager later (nothing is printed).

$env:MCP_AUTH_TOKEN | Set-Clipboard

# 3. Start the server in this same terminal.

npm run start:http

```

Do not run `echo $env:MCP_AUTH_TOKEN`, and do not screenshot the terminal while the token is visible. To use a token you already have, replace step 1 with `$env:MCP_AUTH_TOKEN = "<your-long-random-token>"`. The text `<your-long-random-token>` is only a placeholder.

If you forget to set it, the server stops at once with: `MCP_AUTH_TOKEN is not set (or is empty). The HTTP server refuses to start...`.

To check it from a **second** terminal, set the same variable there first (the checker reads it and sends it; it never prints it):

```powershell

$env:MCP_AUTH_TOKEN = "<paste the same token>"

npm run check:endpoint

```

Quick proof that a request **without** the token is refused (expect `401`; the body can be anything because the token is checked first):

```powershell

curl.exe -s -o NUL -w "%{http_code}`n" -X POST http://127.0.0.1:3000/mcp -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d "{}"

```

**PM2:** PM2 copies the environment of the terminal that runs `npm run pm2:start`. Set `MCP_AUTH_TOKEN` in that terminal first. If you later change the token, run `pm2 restart mcp-file-server --update-env` in a terminal that has the new value. Without a token the server exits at once and PM2 gives up after 10 tries (see `npm run pm2:logs`).

## M3 step by step (HTTP, ngrok, PM2)

### 1. Install and build

```

npm install

npm run build

```

### 2. Start the local HTTP server

Set `MCP_AUTH_TOKEN` first (see "Authentication" above), then:

```

npm run start:http

```

You should see:

```

MCP File Server (Streamable HTTP) listening on http://127.0.0.1:3000/mcp

Workspace: ...\mcp-file-server\workspace

```

The port comes from the `PORT` environment variable (default `3000`). To use another port:
- PowerShell: `$env:PORT = 3001; npm run start:http`
- Command Prompt: `set PORT=3001 && npm run start:http`

Stop it with **Ctrl+C**.

### 3. The local MCP endpoint

```

http://127.0.0.1:3000/mcp

```

(`http://localhost:3000/mcp` normally works too.) The server accepts **only `POST /mcp`**, and only with the bearer token (otherwise 401). Every other path returns 404, and other methods on `/mcp` return 405. It runs in stateless mode and answers with plain JSON.

Check it from a second terminal:

```

npm run check:endpoint

```

It connects like a real MCP client, lists the tools and lists the workspace. It is read-only. Expected ending: `OK: the endpoint is working.`

### 4. Set up ngrok (one time)

1\. Create a free account at <https://ngrok.com>.

2\. Install the ngrok agent from <https://download.ngrok.com> and check it with `ngrok version`.

3\. Copy your authtoken from the ngrok dashboard and run:

   ```

   ngrok config add-authtoken YOUR_TOKEN_HERE

   ```

   The token is saved in ngrok's own config file in your user profile. **Never** put it in this project, a `.env` file you commit, a README, a commit message, or a chat.

### 5. Start the tunnel

Keep the HTTP server running, then in a **second** terminal:

```

ngrok http 3000

```

ngrok shows a line like `Forwarding  https://<something>.ngrok-free.app -> http://localhost:3000`. If ngrok reports it cannot reach the local server, try `ngrok http 127.0.0.1:3000`.

### 6. The remote MCP endpoint

```

https://<ngrok-domain>/mcp

```

It must end with `/mcp`. Verify it end to end:

```

npm run check:endpoint -- https://<ngrok-domain>/mcp

```

(Replace `<ngrok-domain>` with the domain ngrok printed. It is generated when you run ngrok; nothing here is a real URL.)

### 7. Static domain (optional)

Per ngrok's documentation, a free account gets **one auto-assigned dev domain**; you cannot choose or change its name, and custom names need a paid plan. You can find your domain in the ngrok dashboard under **Domains**. To tell ngrok explicitly to use a domain, add `--url`:

```

ngrok http 3000 --url https://YOUR-DOMAIN

```

If you have no static domain, the temporary HTTPS URL that `ngrok http 3000` prints is enough for testing (it may be different the next time you start ngrok).

### 8. Keep the server running with PM2

Install PM2 once:

```

npm install -g pm2

```

Then, from the project folder:

```

npm run pm2:start     # builds, then starts the server under PM2

npm run pm2:status    # shows the process list (look for "online")

npm run pm2:logs      # follow the logs (Ctrl+C stops following, not the server)

npm run pm2:restart   # restart it

npm run pm2:stop      # stop it

npm run pm2:delete    # remove it from PM2

```

`ecosystem.config.cjs` runs `dist/server-http.js`, restarts it if it crashes (2 second delay, giving up after 10 failed starts in a row), and sets `PORT` (edit it there if you need another port). The server writes one log line per request (time, method, path, status, MCP method and tool name; never file contents). PM2 stores logs in its own folder (`~/.pm2/logs`, on Windows `%USERPROFILE%\\.pm2\logs`).

PM2 keeps the **server** running. ngrok is a separate program: start it in its own terminal as shown above. Starting PM2 automatically after a reboot is not set up. After you change the code, run `npm run pm2:start` again so PM2 runs the new build.

## Security notes
- The only remote interface is `POST /mcp`. There is no static file serving, so the project folder and source files are not reachable over HTTP.
- The server listens on `127.0.0.1` only; ngrok runs on the same computer and forwards to it.
- The workspace sandbox applies to every file tool, every handoff tool and the search tool. The git tools run fixed read-only commands without a shell and only show `workspace/`.
- **Authentication (M5):** `POST /mcp` needs `Authorization: Bearer <MCP_AUTH_TOKEN>`; without it the answer is 401 and no tool runs. It is a single shared secret with no expiry and no per-user rights, and there is no rate limiting. The `404` and `405` answers do not need the token (they reveal nothing). Anyone who has the token can read, write and delete inside `workspace/`, **including the handoff files**, so keep it out of screenshots, chats and Git, keep nothing private in `workspace/`, and stop ngrok (Ctrl+C) when you are not using it.
- HTTPS alone is **not** authorization. It protects the token and the data on the way; the token check decides who gets in.
- An agent that reads the handoff files should treat their content as notes, not as commands it must obey, because anyone who can write to `workspace/` can change them.
- No secrets are stored in the project. `.env`, `.env.*` and `*.log` are listed in `.gitignore`. Tool output never contains absolute paths, environment variables or tokens.
- Requests larger than 4 MB are refused; no CORS headers are sent.

## What was actually tested

Tested on Linux (Node 22, Git 2.43, PM2 7.0.4) in throwaway copies of the project:

| Check | Result |

| --- | --- |

| `npm run build` | passed |

| `npm test` (M2: core tools + sandbox over stdio) | 125 passed, 0 failed |

| `npm run test:http` (M3: HTTP server, now including the M5 authentication checks) | 157 passed, 0 failed |

| `npm run test:m4` (M4: handoff, git-lite, search, over HTTP, plus a stdio check) | 213 passed, 0 failed |

| Compiled server (`node dist/server-http.js`) starts, lists 17 tools, answers, stops cleanly on SIGTERM | passed |

| M4 tests also fail when the code is deliberately broken (search without the sandbox, git run through a shell, handoff text not escaped, git path without the sandbox, no file lock) | confirmed |

| M5 authentication: the new auth tests also fail when the check is deliberately broken (always authorised; accepting a token that only starts with the right one) | confirmed |

| Compiled server on a local port: no token -> 401, wrong token -> 401, right token -> 200, `check:endpoint` works with the token and explains the 401 without it, the log holds no token, and the server exits with code 1 when `MCP_AUTH_TOKEN` is missing | passed |

| M4 build under PM2 (isolated scratch copy): starts `online`, serves 17 tools, `kill -9` is followed by an automatic restart (new process id) that answers again, `pm2 stop` closes the port | passed |

**Not yet verified in the reported development environment:**
- **ngrok tunnel.** It requires your own ngrok account and authtoken, so it was not run in the development environment. Verify it locally.
- **Windows.** Everything above ran on Linux. Run `npm run test:all` on your machine. (The M4 tests skip the checks that need Linux, such as the "Git not installed" check and signal handling.)
- **PM2 on Windows** (PM2 was tested on Linux only), and **PM2 with the M5 token** was not re-tested at all.
- **A live end-to-end M5 demonstration:** the HTTP authentication and handoff components are implemented, but the original test report does not confirm a real remote MCP client connecting over the internet and completing a task across two or more agent sessions. Run and document this demonstration locally before claiming that live integration was verified.

## Troubleshooting
- **"MCP_AUTH_TOKEN is not set" when starting the server:** set the variable in the same terminal first (see "Authentication"). A new terminal window has no token.
- **`401 Unauthorized` from `check:endpoint` or a client:** the token sent is missing or differs from the one the server was started with. Set the same value in the client's terminal. After changing the token, restart the server (and PM2 with `--update-env`).
- **Git tools say "not a Git repository":** run `git init` in the project folder (not inside `workspace/`).
- **Git tools say "Git is not installed":** install Git and restart the server (and PM2: `npm run pm2:restart`).
- **Git tools mention "ownership" / `safe.directory`:** Git does not trust a folder owned by another user. Run the command Git suggests, `git config --global --add safe.directory <the project folder>`, once.

## Known limits
- Text files only (UTF-8), up to 1 MB per read or write.
- The handoff files are locked per file inside one server process (which is how this project runs: one PM2 instance). Two separate server processes writing at the same moment are not coordinated.
- Designed for one local user: it does not defend against another process swapping a folder for a symlink in the split second between the safety check and the file operation.
