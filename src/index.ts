#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";

// Base URL of the Verifox REST API. Override with VERIFOX_API_URL for local dev.
const API_URL = (process.env.VERIFOX_API_URL ?? "https://api.verifox.ai").replace(/\/+$/, "");

// The Verifox API key (foxkey_…). stdio: from VERIFOX_API_KEY. HTTP (multi-tenant):
// per request from the Authorization header, carried via AsyncLocalStorage so the
// shared api() helper picks up the right caller's key without threading it around.
const keyStore = new AsyncLocalStorage<string>();
function currentKey(): string {
  return keyStore.getStore() ?? process.env.VERIFOX_API_KEY ?? "";
}

// ── HTTP helper ──────────────────────────────────────────────────

async function api<T = any>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const key = currentKey();
  if (key) headers["x-api-key"] = key;

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
        ? " — provide a valid Verifox API key (foxkey_)"
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

// Give a submitted job ~55s to finish inside the tool call; larger jobs fall
// back to get_job.
const WAIT_MS = 55_000;

// ── Server factory (fresh instance per HTTP request; single for stdio) ───────

function buildServer(): McpServer {
  const server = new McpServer({ name: "verifox", version: "1.2.0" });

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
      return json(
        await api("/v1/email-validation", {
          method: "POST",
          body: { email, proxy: proxy ?? false },
        }),
      );
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
      if (wait === false)
        return json({
          jobId,
          submitted: emails.length,
          poll: "get_job(job_id, 'verify_bulk')",
        });
      return json(await pollJob("verify_bulk", jobId, WAIT_MS));
    }),
  );

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
          body: {
            firstName: first_name,
            lastName: last_name,
            domain,
            middleName: middle_name,
          },
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
        if (wait === false)
          return json({
            jobId,
            submitted: contacts.length,
            poll: "get_job(job_id, 'find_bulk')",
          });
        return json(await pollJob("find_bulk", jobId, WAIT_MS));
      },
    ),
  );

  server.registerTool(
    "get_credits",
    {
      description:
        "Get the current Fox Credit balance for the Verifox account tied to the API key. Free — no credits charged. Use it to check remaining balance before a big verify/find run (verify = 1 credit/email, find = 10 credits/contact).",
      inputSchema: {},
    },
    tool(async () => json(await api("/v1/credits/balance"))),
  );

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
      return json(await pollJob(type, job_id, 0));
    }),
  );

  return server;
}

// ── Auth extraction (HTTP) ───────────────────────────────────────
// Accepts the Verifox key from Authorization: Bearer <key>, x-api-key, or a
// ?api_key= query param (covers Smithery config passing + manual clients).
function extractKey(req: http.IncomingMessage): string {
  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1].trim();
  }
  const xk = req.headers["x-api-key"];
  if (typeof xk === "string" && xk) return xk;
  try {
    const url = new URL(req.url ?? "", "http://x");
    const q = url.searchParams.get("api_key") ?? url.searchParams.get("apiKey");
    if (q) return q;
  } catch {
    /* ignore */
  }
  return "";
}

function setCors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, mcp-session-id",
  );
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// ── Transports ───────────────────────────────────────────────────

async function runStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Verifox MCP server running on stdio");
  console.error(`API: ${API_URL}`);
  console.error(`API key: ${currentKey() ? "set" : "MISSING (set VERIFOX_API_KEY)"}`);
}

async function runHttp(port: number) {
  const httpServer = http.createServer(async (req, res) => {
    setCors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    // Simple health check for uptime monitors.
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "ok", server: "verifox-mcp", transport: "http" }));
      return;
    }

    const apiKey = extractKey(req);
    const body = req.method === "POST" ? await readBody(req) : undefined;

    // Stateless: a fresh server + transport per request, scoped to the caller's key.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await keyStore.run(apiKey, async () => {
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    } catch (err) {
      console.error("http request error:", err);
      if (!res.headersSent) {
        res
          .writeHead(500, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
    }
  });

  httpServer.listen(port, () => {
    console.error(`Verifox MCP server running on http :${port} (POST /mcp)`);
    console.error(`API: ${API_URL}`);
  });
}

async function main() {
  const port = Number(process.env.PORT);
  const useHttp = process.env.MCP_TRANSPORT === "http" || Number.isFinite(port);
  if (useHttp) await runHttp(Number.isFinite(port) ? port : 8080);
  else await runStdio();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
