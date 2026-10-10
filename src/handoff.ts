// M4, part A: the agent handoff protocol.
//
// Four ordinary Markdown files live INSIDE the sandbox workspace:
//   PROJECT_STATE.md  where the project stands right now
//   PLAN_LOG.md       what is planned, done, current and next
//   CHECKPOINTS.md    milestone / checkpoint history (append-only)
//   DECISIONS.md      important decisions and why (append-only)
//
// A NEW agent session reads them to learn what the previous session was doing,
// and writes to them before it stops. There is no database: it is just files.
//
// Every file access goes through resolveSafePath() from tools.ts, exactly like
// the five core tools, so these tools can never touch anything outside workspace/.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import { MAX_FILE_BYTES, SandboxError, assertReadableFile, fail, ok, resolveSafePath } from "./tools.js";

// ---------------------------------------------------------------------------
// The four files
// ---------------------------------------------------------------------------

type FileKey = "state" | "plan" | "checkpoints" | "decisions";

const EMPTY = "_Nothing recorded yet._";

// The headings (## ...) the tools know about.
const PROJECT_STATE_SECTIONS = [
  "Project name",
  "Current milestone",
  "Current status",
  "Completed milestones",
  "Current task",
  "Implemented so far",
  "Remaining work",
  "Important commands",
  "Important constraints",
] as const;

const PLAN_KINDS = {
  current: "Current step",
  next: "Next step",
  planned: "Planned",
  completed: "Completed",
  note: "Notes",
} as const;

function emptyTemplate(title: string, intro: string, sections: readonly string[]): string {
  const body = sections.map((s) => `## ${s}\n\n${EMPTY}\n`).join("\n");
  return `# ${title}\n\n${intro}\n\n${body}`;
}

// Used only when a file is missing (for example somebody deleted it):
// the tools re-create it as an empty skeleton instead of failing.
const FILES: Record<FileKey, { name: string; template: () => string }> = {
  state: {
    name: "PROJECT_STATE.md",
    template: () => emptyTemplate("Project State", "_Where the project stands right now. Update it before you stop._", PROJECT_STATE_SECTIONS),
  },
  plan: {
    name: "PLAN_LOG.md",
    template: () =>
      emptyTemplate(
        "Plan Log",
        "_Planned work, completed work, the current step and the next step._",
        Object.values(PLAN_KINDS)
      ),
  },
  checkpoints: {
    name: "CHECKPOINTS.md",
    template: () => "# Checkpoints\n\n_Milestone and checkpoint history. Newest entries are at the bottom._\n",
  },
  decisions: {
    name: "DECISIONS.md",
    template: () => "# Decisions\n\n_Important technical decisions and the reasons for them. Newest entries are at the bottom._\n",
  },
};

// ---------------------------------------------------------------------------
// Small text helpers (Markdown is edited by HEADING, so headings must stay trustworthy)
// ---------------------------------------------------------------------------

const MAX_READ_CHARS = 20000; // keep tool output reasonably small

// Which kind of code fence does this line open/close? ("`", "~" or none)
function fenceChar(line: string): string | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  return m ? m[1]![0]! : null;
}

// Find every "## heading" that is NOT inside a code block.
function findSections(lines: string[]): Array<{ name: string; start: number; end: number }> {
  const found: Array<{ name: string; start: number; end: number }> = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = fenceChar(line);
    if (f && (fence === null || fence === f)) {
      fence = fence === null ? f : null;
      return;
    }
    if (fence === null) {
      const m = /^## (.*)$/.exec(line);
      if (m) found.push({ name: m[1]!.trim(), start: i, end: lines.length });
    }
  });
  found.forEach((s, i) => {
    if (i + 1 < found.length) s.end = found[i + 1]!.start;
  });
  return found;
}

// Text written by an agent must not be able to fake a new "## section" or leave a
// code block open, because that would confuse the next agent that edits the file.
//   - "# x" and "## x" lines are escaped (\## x shows as plain text)
//   - an unclosed code block is closed
function cleanBody(text: string): string {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""));
  let fence: string | null = null;
  const out = lines.map((line) => {
    const f = fenceChar(line);
    if (f && (fence === null || fence === f)) {
      fence = fence === null ? f : null;
      return line;
    }
    return fence === null && /^ {0,3}#{1,2}(\s|$)/.test(line) ? line.replace("#", "\\#") : line;
  });
  if (fence !== null) out.push(fence === "`" ? "```" : "~~~");
  return out.join("\n").trim();
}

// Titles, names and agent labels: one line, no control characters, no leading "#".
function oneLine(text: string, max: number): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[#\s]+/, "")
    .trim()
    .slice(0, max);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function agentName(agent: string | undefined): string {
  return oneLine(agent ?? "", 60) || "unknown-agent";
}

// "- Label: text", with extra lines indented so they stay inside the bullet.
function field(label: string, text: string): string {
  return `- ${label}: ${cleanBody(text).split("\n").join("\n  ")}`;
}

// Replace the body of "## name" (or add the section at the end if it is missing).
function replaceSection(text: string, name: string, body: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const section = findSections(lines).find((s) => s.name === name);
  const newLines = [`## ${name}`, "", ...body.split("\n"), ""];
  if (!section) return [...lines, "", ...newLines].join("\n") + "\n";
  return [...lines.slice(0, section.start), ...newLines, ...lines.slice(section.end)].join("\n").replace(/\n+$/, "") + "\n";
}

// Add one bullet at the end of "## name" (creating the section if it is missing).
function appendToSection(text: string, name: string, bullet: string): string {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  const section = findSections(lines).find((s) => s.name === name);
  if (!section) return [...lines, "", `## ${name}`, "", bullet, ""].join("\n");
  const body = lines.slice(section.start + 1, section.end).filter((l) => l.trim() !== EMPTY);
  while (body.length > 0 && body[0]!.trim() === "") body.shift();
  while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
  return [...lines.slice(0, section.start), `## ${name}`, "", ...body, bullet, "", ...lines.slice(section.end)].join("\n").replace(/\n+$/, "") + "\n";
}

// Keep the "_Last updated: ..._" line under the title current.
function setLastUpdated(text: string, agent: string): string {
  const line = `_Last updated: ${stamp()} by ${agent}_`;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const existing = lines.findIndex((l, i) => i < 6 && l.startsWith("_Last updated:"));
  if (existing >= 0) {
    lines[existing] = line;
    return lines.join("\n");
  }
  const title = lines.findIndex((l) => l.startsWith("# "));
  lines.splice(title + 1, 0, "", line);
  return lines.join("\n");
}

// The text a read tool returns. Too-long files are cut, with a note.
function limitText(text: string, keep: "start" | "end"): string {
  if (text.length <= MAX_READ_CHARS) return text;
  const note = "(The file is long and was cut here. Use read_file for the complete file.)";
  return keep === "start"
    ? `${text.slice(0, MAX_READ_CHARS)}\n\n${note}`
    : `${note} Older entries are omitted.\n\n${text.slice(-MAX_READ_CHARS)}`;
}

// ---------------------------------------------------------------------------
// Reading and writing (one at a time per file, so two agents cannot overwrite each other)
// ---------------------------------------------------------------------------

const queues = new Map<string, Promise<void>>();

// Runs `job` after every earlier job for the same file has finished.
// (Works for one server process, which is how this project runs: PM2 uses a single instance.)
function withFileLock<T>(key: FileKey, job: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const result = previous.then(job);
  const tail = result.then(
    () => undefined,
    () => undefined
  );
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

async function loadFile(key: FileKey): Promise<{ target: string; text: string }> {
  const target = await resolveSafePath(FILES[key].name); // the sandbox check
  try {
    await assertReadableFile(target);
    return { target, text: await fs.readFile(target, "utf8") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Missing: create an empty skeleton ("wx" = never overwrite an existing file).
    const text = FILES[key].template();
    await fs.writeFile(target, text, { encoding: "utf8", flag: "wx" });
    return { target, text };
  }
}

async function saveFile(target: string, text: string): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    throw new SandboxError("The file would become too large (limit is 1 MB). Nothing was written.");
  }
  await fs.writeFile(target, text, "utf8");
}

// Read, change, write: all inside the lock.
function editFile(key: FileKey, change: (text: string) => string): Promise<void> {
  return withFileLock(key, async () => {
    const { target, text } = await loadFile(key);
    await saveFile(target, change(text));
  });
}

function readFileText(key: FileKey): Promise<string> {
  return withFileLock(key, async () => (await loadFile(key)).text);
}

// ---------------------------------------------------------------------------
// The eight MCP tools
// ---------------------------------------------------------------------------

const agentField = z.string().max(60).optional().describe("Optional label for who is writing, e.g. 'agent-1' or 'session-2'.");

export function registerHandoffTools(server: McpServer): void {
  const readOnly = { readOnlyHint: true } as const;

  // 1. read_project_state
  server.registerTool(
    "read_project_state",
    {
      description:
        "Read workspace/PROJECT_STATE.md: where the project stands (milestone, status, current task, what is done and what remains). " +
        "Call this FIRST when you start a new session.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async () => {
      try {
        return ok(limitText(await readFileText("state"), "start"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 2. update_project_state
  server.registerTool(
    "update_project_state",
    {
      description:
        "Replace ONE section of workspace/PROJECT_STATE.md. Update it whenever the project status changes and before you stop.",
      inputSchema: z.strictObject({
        section: z.enum(PROJECT_STATE_SECTIONS).describe("Which section to replace."),
        content: z.string().min(1).max(6000).describe("The new text for that section (Markdown)."),
        agent: agentField,
      }),
    },
    async ({ section, content, agent }) => {
      try {
        await editFile("state", (text) => setLastUpdated(replaceSection(text, section, cleanBody(content)), agentName(agent)));
        return ok(`Updated section "${section}" in workspace/${FILES.state.name}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 3. read_plan_log
  server.registerTool(
    "read_plan_log",
    {
      description: "Read workspace/PLAN_LOG.md: planned work, completed work, the current step and the next step.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async () => {
      try {
        return ok(limitText(await readFileText("plan"), "start"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 4. update_plan_log
  server.registerTool(
    "update_plan_log",
    {
      description:
        "Update workspace/PLAN_LOG.md. kind 'current' or 'next' REPLACES the Current step / Next step. " +
        "kind 'planned', 'completed' or 'note' ADDS a timestamped bullet to that list.",
      inputSchema: z.strictObject({
        kind: z.enum(["current", "next", "planned", "completed", "note"]).describe("Which part of the plan log to change."),
        text: z.string().min(1).max(4000).describe("The text to record."),
        agent: agentField,
      }),
    },
    async ({ kind, text, agent }) => {
      try {
        const who = agentName(agent);
        const heading = PLAN_KINDS[kind];
        const body = cleanBody(text);
        await editFile("plan", (current) => {
          const changed =
            kind === "current" || kind === "next"
              ? replaceSection(current, heading, body)
              : appendToSection(current, heading, `- [${stamp()}] (${who}) ${body.split("\n").join("\n  ")}`);
          return setLastUpdated(changed, who);
        });
        return ok(`Recorded in "${heading}" of workspace/${FILES.plan.name}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 5. read_checkpoints
  server.registerTool(
    "read_checkpoints",
    {
      description: "Read workspace/CHECKPOINTS.md: the milestone / checkpoint history, newest at the bottom.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async () => {
      try {
        return ok(limitText(await readFileText("checkpoints"), "end"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 6. record_checkpoint
  server.registerTool(
    "record_checkpoint",
    {
      description:
        "Add a checkpoint entry to workspace/CHECKPOINTS.md (entries are only ever added, never edited). " +
        "Only report tests you actually ran.",
      inputSchema: z.strictObject({
        name: z.string().min(1).max(80).describe("Checkpoint name, e.g. 'M4' or 'Step 3: search added'."),
        status: z.enum(["planned", "in_progress", "completed", "blocked"]).describe("Where this checkpoint stands."),
        notes: z.string().min(1).max(4000).describe("What happened / what was done."),
        testing: z.string().max(2000).optional().describe("Optional: what was tested and the real result."),
        agent: agentField,
      }),
    },
    async ({ name, status, notes, testing, agent }) => {
      try {
        const who = agentName(agent);
        const title = oneLine(name, 80);
        if (title === "") throw new SandboxError("The checkpoint name must not be empty.");
        const lines = [`## ${title} — ${status}`, `- Recorded: ${stamp()} by ${who}`, field("Notes", notes)];
        if (testing !== undefined && testing.trim() !== "") lines.push(field("Testing", testing));
        await editFile("checkpoints", (text) => setLastUpdated(text.replace(/\n+$/, "") + "\n\n" + lines.join("\n") + "\n", who));
        return ok(`Recorded checkpoint "${title}" (${status}) in workspace/${FILES.checkpoints.name}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 7. read_decisions
  server.registerTool(
    "read_decisions",
    {
      description: "Read workspace/DECISIONS.md: important technical decisions and the reasons for them, newest at the bottom.",
      inputSchema: z.strictObject({}),
      annotations: readOnly,
    },
    async () => {
      try {
        return ok(limitText(await readFileText("decisions"), "end"));
      } catch (err) {
        return fail(err);
      }
    }
  );

  // 8. record_decision
  server.registerTool(
    "record_decision",
    {
      description:
        "Add a decision to workspace/DECISIONS.md (entries are only ever added, never edited). It gets the next number (D-001, D-002, ...).",
      inputSchema: z.strictObject({
        title: z.string().min(1).max(100).describe("Short title of the decision."),
        decision: z.string().min(1).max(2000).describe("What was decided."),
        reason: z.string().min(1).max(2000).describe("Why it was decided."),
        agent: agentField,
      }),
    },
    async ({ title, decision, reason, agent }) => {
      try {
        const who = agentName(agent);
        const cleanTitle = oneLine(title, 100);
        if (cleanTitle === "") throw new SandboxError("The decision title must not be empty.");
        let id = "";
        await editFile("decisions", (text) => {
          const numbers = findSections(text.split("\n")).map((s) => /^D-(\d+)/.exec(s.name)?.[1]);
          const next = Math.max(0, ...numbers.map((n) => Number(n ?? 0))) + 1;
          id = `D-${String(next).padStart(3, "0")}`;
          const block = [`## ${id}: ${cleanTitle}`, `- Recorded: ${stamp()} by ${who}`, field("Decision", decision), field("Reason", reason)];
          return setLastUpdated(text.replace(/\n+$/, "") + "\n\n" + block.join("\n") + "\n", who);
        });
        return ok(`Recorded decision ${id} "${cleanTitle}" in workspace/${FILES.decisions.name}.`);
      } catch (err) {
        return fail(err);
      }
    }
  );
}