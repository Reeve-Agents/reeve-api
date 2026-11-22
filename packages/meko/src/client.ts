// Meko MCP transport. Local Meko by default (token from `meko token`), Meko Cloud when
// MEKO_MCP_URL and MEKO_API_KEY are set. The token is read at call time and never logged.
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/** The one seam the rest of the module talks to, so tests can swap in an in-memory Meko. */
export interface MekoTransport {
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  /** Tool names the server offers (e.g. `track_token_usage` exists only on Meko Cloud). */
  tools(): Promise<string[]>;
  close(): Promise<void>;
}

export const LOCAL_MEKO_URL = "http://127.0.0.1:7777/mcp";
export const CLOUD_MEKO_URL = "https://mcp.mekodata.ai/mcp";

export interface MekoEndpoint {
  url: string;
  cloud: boolean;
  token: () => string;
}

export function mekoEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): MekoEndpoint {
  const url = env.MEKO_MCP_URL ?? (env.MEKO_API_KEY ? CLOUD_MEKO_URL : LOCAL_MEKO_URL);
  const cloud = !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost");
  return {
    url,
    cloud,
    token: () => {
      const key = env.MEKO_API_KEY ?? env.MEKO_TOKEN;
      if (key) return key;
      if (cloud) throw new Error("MEKO_API_KEY is not set for Meko Cloud");
      const bin = env.MEKO_BIN ?? `${env.HOME}/.local/bin/meko`;
      return execFileSync(bin, ["token"], { encoding: "utf8" }).trim().split(/\s+/).pop() ?? "";
    },
  };
}

export class MekoError extends Error {
  constructor(
    readonly tool: string,
    readonly detail: string,
  ) {
    super(`meko ${tool} failed: ${detail.slice(0, 300)}`);
  }
}

export async function connectMeko(endpoint: MekoEndpoint = mekoEndpointFromEnv()): Promise<MekoTransport> {
  const headers: Record<string, string> = { Authorization: `Bearer ${endpoint.token()}`, "User-Agent": "reeve-meko/0.1" };
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), { requestInit: { headers } });
  const client = new Client({ name: "reeve", version: "0.1.0" });
  await client.connect(transport);
  let names: string[] | undefined;
  return {
    async call(tool, args) {
      // Meko Cloud is eventually consistent: a conversation made a moment ago can still be "not found". Retry that
      // (nothing was stored when it fails) a few times before giving up.
      for (let attempt = 0; ; attempt++) {
        const res = await client.callTool({ name: tool, arguments: endpoint.cloud ? cloudArgs(args) : args });
        const text = (res.content as { type: string; text?: string }[])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n");
        if (res.isError) throw new MekoError(tool, text);
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return text;
        }
        if (endpoint.cloud && attempt < 6 && retryable(parsed)) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        return endpoint.cloud ? cloudResult(parsed) : parsed;
      }
    },
    async tools() {
      names ??= (await client.listTools()).tools.map((t) => t.name);
      return names;
    },
    close: () => client.close(),
  };
}

/** Meko Cloud declares `metadata` as a JSON string (local Meko takes an object), so send it as one. */
export function cloudArgs(args: Record<string, unknown>): Record<string, unknown> {
  const m = args.metadata;
  return m && typeof m === "object" ? { ...args, metadata: JSON.stringify(m) } : args;
}

/** ...and it may hand `metadata` back as a JSON string: parse it so callers see the same shape as on local Meko. */
export function cloudResult(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cloudResult);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "metadata" && typeof x === "string" && x.startsWith("{")) {
      try {
        out[k] = JSON.parse(x);
        continue;
      } catch {
        /* keep the string */
      }
    }
    // Cloud stores a message's plan (a list) as a JSON string; hand it back as the list Reeve sent.
    if (k === "plan" && typeof x === "string" && x.startsWith("[")) {
      try {
        out[k] = JSON.parse(x);
        continue;
      } catch {
        /* keep the string */
      }
    }
    // Cloud may return a message's JSON text fields already parsed; local Meko keeps the exact string Reeve sent.
    out[k] = (k === "output" || k === "input" || k === "reasoning") && x && typeof x === "object" ? JSON.stringify(x) : cloudResult(x);
  }
  return out;
}

/** Cloud answers a too-early read with {"error":"not_found"}; only that is worth another try. */
export function retryable(v: unknown): boolean {
  return !!v && typeof v === "object" && (v as { error?: unknown }).error === "not_found";
}
