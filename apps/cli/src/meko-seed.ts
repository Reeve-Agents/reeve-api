// One command to load the Kos Melati demo into Meko Cloud once MEKO_API_KEY exists:
//
//   npm run meko:seed                          # Meko Cloud (needs MEKO_API_KEY), ledger file under .reeve
//   npm run meko:seed -- --ledger=pg           # ledger in Postgres (DATABASE_URL): what the deployed API reads
//   npm run meko:seed -- --local --fresh       # rehearsal on local Meko (`meko start`), demo datapack reset
//   npm run meko:seed -- --llm                 # Worker drafts on Claude Haiku 5.5 (costs a few cents)
//
// It checks the endpoint and its tools first, then runs `crew:demo` with the same flags and prints
// what to set on CreateOS (key names only). Secret values are never printed.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { connectMeko, mekoEndpointFromEnv } from "@reeve/meko";
import { repoRoot } from "@reeve/pipeline";

const args = process.argv.slice(2);
const local = args.includes("--local");
const say = (s: string) => console.log(s);

if (!local && !process.env.MEKO_API_KEY) {
  say("MEKO_API_KEY is not set. Add it to .env (key from your Meko Cloud account), or rehearse with --local.");
  process.exit(1);
}
const env = { ...process.env };
if (local) {
  delete env.MEKO_API_KEY;
  delete env.MEKO_MCP_URL;
}
if (args.includes("--ledger=pg") && !env.DATABASE_URL) {
  say("--ledger=pg needs DATABASE_URL. That is the production database: run it only when you mean to.");
  process.exit(1);
}

const endpoint = mekoEndpointFromEnv(env);
say(`target: Meko ${endpoint.cloud ? "Cloud" : "local"} (${endpoint.url}), workspace ${env.REEVE_MEKO_WORKSPACE ?? "kos-melati"}, ledger ${args.includes("--ledger=pg") ? "Postgres (DATABASE_URL)" : "file under .reeve"}`);
const meko = await connectMeko(endpoint);
const tools = new Set(await meko.tools());
await meko.close();
const need = ["conversation_create", "conversation_add_message", "conversation_get", "context_search", "memory_add", "memory_promote", "artifact_put", "datapack_create", "datapack_list"];
const missing = need.filter((t) => !tools.has(t));
if (missing.length) {
  say(`Meko is missing tools this demo needs: ${missing.join(", ")}`);
  process.exit(1);
}
say(`Meko answers with ${tools.size} tools; track_token_usage ${tools.has("track_token_usage") ? "available" : "not available (local Meko)"}`);

const run = spawnSync("npx", ["tsx", join(repoRoot, "apps/cli/src/crew-demo.ts"), ...args.filter((a) => a !== "--local")], { stdio: "inherit", env, cwd: repoRoot });
if (run.status !== 0) process.exit(run.status ?? 1);

say(`
Done. For the deployed API (CreateOS reeve-api, branch main), set these environment variables by name:
  MEKO_API_KEY            Meko Cloud key (the API then uses https://mcp.mekodata.ai/mcp)
  MEKO_DATAPACK_ID        datapack UUID, only if Cloud refuses to create one itself (MEKO_DATAPACK_ID_<WORKSPACE> per workspace)
  REEVE_MEKO_WORKSPACE    only if not "kos-melati"
  TELEGRAM_BOT_USERNAME   bot name for the tenant link (t.me/<name>?start=<code>)
  REEVE_MEKO_PUBLIC_ASK   "on" only if the public Tanya usaha box should accept questions
The API must read the same ledger: seed with --ledger=pg for the deployment.`);
