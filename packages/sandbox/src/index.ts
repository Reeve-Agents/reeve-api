import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Everything a job needs, as relative path → file content. */
export interface JobBundle {
  files: Record<string, string>;
  /** argv run from the bundle root, e.g. ["python3", "-m", "reeve_runtime.job", "job"] */
  command: string[];
  /** Relative path of the JSON result file the job writes. */
  resultPath: string;
}

export interface JobRun {
  backend: string;
  sandboxId?: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  result: string | null;
  durationMs: number;
  log: string[];
}

export interface Sandbox {
  readonly name: string;
  /** onLog streams glass-box lines as they happen (the full log is also returned). */
  runJob(bundle: JobBundle, onLog?: (line: string) => void): Promise<JobRun>;
}

/**
 * LOCAL DEV ONLY. Runs the job as a subprocess in a temp directory with a scrubbed environment.
 * It does NOT isolate the network or the filesystem; use CreateOSSandbox for anything real.
 */
export class LocalSandbox implements Sandbox {
  readonly name = "local (dev only, no isolation)";

  constructor(private readonly timeoutMs = 120_000) {}

  async runJob(bundle: JobBundle, onLog?: (line: string) => void): Promise<JobRun> {
    const log: string[] = [];
    const say = (line: string) => {
      log.push(line);
      onLog?.(line);
    };
    const root = mkdtempSync(join(tmpdir(), "reeve-job-"));
    const started = Date.now();
    try {
      for (const [rel, content] of Object.entries(bundle.files)) {
        const p = join(root, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, content);
      }
      say(`wrote ${Object.keys(bundle.files).length} files to ${root}`);
      const [cmd, ...args] = bundle.command;
      say(`exec ${bundle.command.join(" ")}`);
      const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
        // Scrubbed env: no API keys or tokens reach generated code.
        const child = spawn(cmd!, args, { cwd: root, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" } });
        let out = "";
        let err = "";
        const timer = setTimeout(() => child.kill("SIGKILL"), this.timeoutMs);
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("error", reject);
        child.on("close", (c) => {
          clearTimeout(timer);
          resolve({ code: c ?? -1, stdout: out, stderr: err });
        });
      });
      let result: string | null = null;
      try {
        result = readFileSync(join(root, bundle.resultPath), "utf8");
      } catch {
        result = null;
      }
      say(`exit ${code} in ${Date.now() - started} ms`);
      return { backend: this.name, exitCode: code, stdout, stderr, result, durationMs: Date.now() - started, log };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

interface JSend<T> {
  status: "success" | "fail" | "error";
  data?: T;
  message?: string;
}

/**
 * CreateOS Sandbox (Firecracker microVM) over the REST API.
 * Built from https://createos.sh/docs/Sandbox/REST-API/ (base https://api.sb.createos.sh, header X-Api-Key).
 * One sandbox per job, destroyed in `finally` (Free plan: 1 concurrent, 10 per day).
 * NOTE: not yet exercised against the live API in this repo; verify before relying on it.
 */
export class CreateOSSandbox implements Sandbox {
  readonly name = "createos";

  constructor(
    private readonly apiKey: string,
    private readonly opts: {
      baseUrl?: string;
      shape?: string;
      rootfs?: string;
      workdir?: string;
      /** Deny-by-default egress. Any non-empty list blocks everything not listed. */
      egress?: string[];
      readyTimeoutMs?: number;
    } = {},
  ) {}

  private get base() {
    return this.opts.baseUrl ?? "https://api.sb.createos.sh";
  }

  private async call<T>(method: string, path: string, body?: unknown, raw?: string): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        ...(raw !== undefined ? { "Content-Type": "application/octet-stream" } : body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (method === "GET" && path.includes("/files?")) {
      if (!res.ok) throw new Error(`CreateOS ${method} ${path}: HTTP ${res.status}`);
      return (await res.text()) as T;
    }
    const json = (await res.json().catch(() => ({}))) as JSend<T>;
    if (!res.ok || json.status !== "success") {
      throw new Error(`CreateOS ${method} ${path}: HTTP ${res.status} ${json.message ?? JSON.stringify(json.data ?? {})}`);
    }
    return json.data as T;
  }

  async runJob(bundle: JobBundle, onLog?: (line: string) => void): Promise<JobRun> {
    const log: string[] = [];
    const say = (line: string) => {
      log.push(line);
      onLog?.(line);
    };
    const started = Date.now();
    const workdir = this.opts.workdir ?? "/workspace";
    const created = await this.call<{ id: string; spawn_ms?: number }>("POST", "/v1/sandboxes", {
      shape: this.opts.shape ?? "s-1vcpu-1gb",
      rootfs: this.opts.rootfs ?? "devbox:1",
      name: `reeve-${Date.now().toString(36)}`, // API limit: max 22 characters
      egress: this.opts.egress ?? ["127.0.0.1:9"],
    });
    const id = created.id;
    say(`sandbox ${id} created (egress locked: ${(this.opts.egress ?? ["127.0.0.1:9"]).join(", ")})`);
    try {
      const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 60_000);
      for (;;) {
        const sb = await this.call<{ status: string }>("GET", `/v1/sandboxes/${id}`);
        if (sb.status === "running") break;
        if (sb.status === "error") throw new Error(`sandbox ${id} entered error state`);
        if (Date.now() > deadline) throw new Error(`sandbox ${id} not running after timeout`);
        await new Promise((r) => setTimeout(r, 500));
      }
      // Upload with bounded concurrency (sequential PUTs took ~10 s for 40 files).
      const entries = Object.entries(bundle.files);
      let next = 0;
      const worker = async () => {
        while (next < entries.length) {
          const [rel, content] = entries[next++]!;
          await this.call("PUT", `/v1/sandboxes/${id}/files?path=${encodeURIComponent(`${workdir}/${rel}`)}`, undefined, content);
        }
      };
      await Promise.all(Array.from({ length: Math.min(8, entries.length) }, worker));
      say(`uploaded ${Object.keys(bundle.files).length} files`);
      const quoted = bundle.command.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
      say(`exec ${bundle.command.join(" ")}`);
      const exec = await this.call<{ result: { stdout: string; stderr: string; exit_code: number }; exec_ms?: number }>(
        "POST",
        `/v1/sandboxes/${id}/exec`,
        { cmd: "/bin/bash", args: ["-lc", `cd ${workdir} && ${quoted}`] },
      );
      let result: string | null = null;
      try {
        result = await this.call<string>("GET", `/v1/sandboxes/${id}/files?path=${encodeURIComponent(`${workdir}/${bundle.resultPath}`)}`);
      } catch {
        result = null;
      }
      say(`exit ${exec.result.exit_code} (exec ${exec.exec_ms ?? "?"} ms)`);
      return {
        backend: this.name,
        sandboxId: id,
        exitCode: exec.result.exit_code,
        stdout: exec.result.stdout,
        stderr: exec.result.stderr,
        result,
        durationMs: Date.now() - started,
        log,
      };
    } finally {
      await this.call("DELETE", `/v1/sandboxes/${id}`).catch(() => undefined);
      say(`sandbox ${id} destroyed`);
    }
  }
}

export function sandboxFromEnv(env: NodeJS.ProcessEnv = process.env): Sandbox {
  const kind = env.REEVE_SANDBOX ?? "local";
  if (kind === "createos") {
    const key = env.CREATEOS_API_KEY ?? env.CREATEOS_PROJECT_API_KEY; // Stripe Projects naming
    if (!key) throw new Error("REEVE_SANDBOX=createos needs CREATEOS_API_KEY (or CREATEOS_PROJECT_API_KEY)");
    return new CreateOSSandbox(key, {
      egress: env.REEVE_CREATEOS_EGRESS ? env.REEVE_CREATEOS_EGRESS.split(",") : undefined,
    });
  }
  return new LocalSandbox();
}
