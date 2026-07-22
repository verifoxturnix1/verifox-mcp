#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// Base URL of the Verifox REST API. Defaults to production; override with
// VERIFOX_API_URL (e.g. http://localhost:8001) for local development.
const API_URL = (process.env.VERIFOX_API_URL ?? "https://api.verifox.ai").replace(/\/+$/, "");

// Per-user Verifox API key (foxkey_…). Authenticates every call and is the
// account whose Fox Credits are charged. Sent as the `x-api-key` header.
const API_KEY = process.env.VERIFOX_API_KEY ?? "";

// ── HTTP helper ──────────────────────────────────────────────────

async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (API_KEY) headers["x-api-key"] = API_KEY;

  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(120_000),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Cannot reach Verifox API at ${API_URL}: ${reason}`);
  }

  const raw = await res.text();
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = raw;
    }
  }

  if (!res.ok) {
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : typeof parsed === "string" && parsed
          ? parsed
          : res.statusText) || `HTTP ${res.status}`;
    const hint =
      res.status === 401
        ? " — set VERIFOX_API_KEY to a valid foxkey_ key"
        : res.status === 402
          ? " — the account is out of Fox Credits"
          : "";
    throw new Error(`API error ${res.status}: ${message}${hint}`);
  }

  return parsed as T;
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}
function json(data: unknown) {
  return text(JSON.stringify(data, null, 2));
}

/** Wrap a tool handler so thrown errors return a structured MCP error result. */
function tool<A>(handler: (args: A) => Promise<ReturnType<typeof json>>) {
  return async (args: A) => {
    try {
      return await handler(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: message }], isError: true };
    }
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Async-job polling ────────────────────────────────────────────
// Bulk verify, single find, and bulk find are all async jobs. The tools submit
// then poll here so the caller gets final results in one call; jobs that outrun
// `maxWaitMs` return their id + status so the model can finish via `get_job`.

type JobType = "verify_bulk" | "find_single" | "find_bulk";

const JOBS = {
  verify_bulk: {
    progress: (id: string) => `/v1/email-validation/bulk/${id}/progress`,
    results: (id: string, cursor: number) =>
      `/v1/email-validation/bulk/${id}/results?cursor=${cursor}&limit=1000`,
    terminal: new Set(["completed", "failed", "stopped"]),
  },
  find_bulk: {
    progress: (id: string) => `/v1/email-finder/bulk/${id}/progress`,
    results: (id: string, cursor: number) =>
      `/v1/email-finder/bulk/${id}/results?cursor=${cursor}&limit=200`,
    terminal: new Set(["completed", "failed", "stopped"]),
  },
} as const;

async function pollJob(type: JobType, jobId: string, maxWaitMs: number): Promise<any> {
  const deadline = Date.now() + maxWaitMs;

  // Single find has no separate results endpoint — the job GET carries the result.
  if (type === "find_single") {
    const terminal = new Set(["completed", "failed"]);
    for (;;) {
      const job = await api<any>(`/v1/email-finder/${jobId}`);
      if (terminal.has(job?.status)) return { jobId, done: true, ...job };
      if (Date.now() > deadline)
        return { jobId, done: false, status: job?.status ?? "pending" };
      await sleep(4000);
    }
  }

  const spec = JOBS[type];
  let progress: any;
  for (;;) {
    progress = await api<any>(spec.progress(jobId));
    if (spec.terminal.has(progress?.status)) break;
    if (Date.now() > deadline)
      return { jobId, done: false, status: progress?.status ?? "processing" };
    await sleep(4000);
  }
  if (progress?.status === "failed") return { jobId, done: true, status: "failed" };

  const results: any[] = [];
  let cursor = 0;
  for (;;) {
    const page = await api<any>(spec.results(jobId, cursor));
    const rows = Array.isArray(page?.results) ? page.results : [];
    results.push(...rows);
    const next = page?.next_cursor;
    if (next === null || next === undefined || rows.length === 0) break;
    cursor = next;
  }
  return {
    jobId,
    done: true,
    status: progress?.status ?? "completed",
    count: results.length,
    results,
  };
}

// Give a submitted job ~55s to finish inside the tool call (under typical MCP
// client timeouts); larger jobs fall back to `get_job`.
const WAIT_MS = 55_000;

// ── MCP Server ───────────────────────────────────────────────────

const server = new McpServer({ name: "verifox", version: "1.1.1" });

// ── Email verification ───────────────────────────────────────────

server.registerTool(
  "verify_email",
  {
    description:
      "Verify whether ONE email address is deliverable. Checks syntax, MX, SMTP, catch-all, disposable, free-provider and role detection, and returns a 0-100 quality score. Charges 1 Fox Credit per uncached email.",
    inputSchema: {
      email: z.string().email().describe("Email address to verify"),
      proxy: z.boolean().optional().describe("Use a SOCKS5 proxy for the SMTP check"),
    },
  },
  tool(async ({ email, proxy }: { email: string; proxy?: boolean }) => {
    const result = await api("/v1/email-validation", {
      method: "POST",
      body: { email, proxy: proxy ?? false },
    });
    return json(result);
  }),
);

server.registerTool(
  "verify_emails",
  {
    description:
      "Bulk-verify a LIST of email addresses. Submits the whole list, waits for completion, and returns one result per email (same fields as verify_email). Best for cleaning lead lists. Charges 1 Fox Credit per email. Large lists that don't finish quickly return a jobId to poll with get_job.",
    inputSchema: {
      emails: z
        .array(z.string().email())
        .min(1)
        .max(100000)
        .describe("Email addresses to verify"),
      wait: z
        .boolean()
        .optional()
        .describe(
          "Wait for results in this call (default true). Set false to just get a jobId.",
        ),
    },
  },
  tool(async ({ emails, wait }: { emails: string[]; wait?: boolean }) => {
    const submit = await api<any>("/v1/email-validation/bulk", {
      method: "POST",
      body: { input: emails },
    });
    const jobId = submit?.jobId ?? submit?.job_id;
    if (!jobId) return json(submit);
    if (wait === false) {
      return json({ jobId, submitted: emails.length, poll: "get_job(job_id, 'verify_bulk')" });
    }
    return json(await pollJob("verify_bulk", jobId, WAIT_MS));
  }),
);

// ── Email finder ─────────────────────────────────────────────────

server.registerTool(
  "find_email",
  {
    description:
      "Find ONE person's business email from their name and company domain. Generates ~50 permutations and SMTP-verifies each, waits for the result, and returns the best match (or not_found). Charges 10 Fox Credits per find.",
    inputSchema: {
      first_name: z.string().describe("Person's first name"),
      last_name: z.string().describe("Person's last name"),
      domain: z.string().describe("Company domain, e.g. stripe.com"),
      middle_name: z
        .string()
        .optional()
        .describe("Optional middle name for more permutations"),
    },
  },
  tool(
    async ({
      first_name,
      last_name,
      domain,
      middle_name,
    }: {
      first_name: string;
      last_name: string;
      domain: string;
      middle_name?: string;
    }) => {
      const submit = await api<any>("/v1/email-finder", {
        method: "POST",
        body: { firstName: first_name, lastName: last_name, domain, middleName: middle_name },
      });
      const jobId = submit?.jobId ?? submit?.job_id;
      if (!jobId) return json(submit);
      return json(await pollJob("find_single", jobId, WAIT_MS));
    },
  ),
);

server.registerTool(
  "find_emails",
  {
    description:
      "Bulk-find business emails for a LIST of contacts (name + company domain each). Submits the list, waits for completion, and returns the found email per contact. Up to 1000 contacts. Charges 10 Fox Credits per contact. Large lists that don't finish quickly return a jobId to poll with get_job.",
    inputSchema: {
      contacts: z
        .array(
          z.object({
            first_name: z.string().optional(),
            last_name: z.string().optional(),
            name: z
              .string()
              .optional()
              .describe("Full name (alternative to first_name/last_name)"),
            middle_name: z.string().optional(),
            domain: z.string().describe("Company domain"),
          }),
        )
        .min(1)
        .max(1000)
        .describe("Contacts to find emails for"),
      wait: z.boolean().optional().describe("Wait for results in this call (default true)"),
    },
  },
  tool(
    async ({
      contacts,
      wait,
    }: {
      contacts: Array<{
        first_name?: string;
        last_name?: string;
        name?: string;
        middle_name?: string;
        domain: string;
      }>;
      wait?: boolean;
    }) => {
      const input = contacts.map((c) => ({
        firstName: c.first_name,
        lastName: c.last_name,
        name: c.name,
        middleName: c.middle_name,
        domain: c.domain,
      }));
      const submit = await api<any>("/v1/email-finder/bulk", {
        method: "POST",
        body: { input },
      });
      const jobId = submit?.jobId ?? submit?.job_id;
      if (!jobId) return json(submit);
      if (wait === false) {
        return json({
          jobId,
          submitted: contacts.length,
          poll: "get_job(job_id, 'find_bulk')",
        });
      }
      return json(await pollJob("find_bulk", jobId, WAIT_MS));
    },
  ),
);

// ── Job polling (for jobs that outrun a single call) ─────────────

server.registerTool(
  "get_job",
  {
    description:
      "Check an async job started by verify_emails, find_email, or find_emails. Returns results if finished, otherwise the current status. Use the type shown in the submitting tool's response.",
    inputSchema: {
      job_id: z.string().describe("Job ID from verify_emails / find_email / find_emails"),
      type: z
        .enum(["verify_bulk", "find_single", "find_bulk"])
        .describe("Job type: verify_bulk, find_single, or find_bulk"),
    },
  },
  tool(async ({ job_id, type }: { job_id: string; type: JobType }) => {
    // Single quick check (no long wait) — poll again if still running.
    return json(await pollJob(type, job_id, 0));
  }),
);

// ── Account ──────────────────────────────────────────────────────

server.registerTool(
  "get_credits",
  {
    description:
      "Get the current Fox Credit balance for the Verifox account tied to the API key. Free — no credits charged. Use it to check remaining balance before a big verify/find run (verify = 1 credit/email, find = 10 credits/contact).",
    inputSchema: {},
  },
  tool(async () => {
    return json(await api("/v1/credits/balance"));
  }),
);

// ── Start ────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Verifox MCP server running on stdio");
  console.error(`API: ${API_URL}`);
  console.error(`API key: ${API_KEY ? "set" : "MISSING (set VERIFOX_API_KEY)"}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
