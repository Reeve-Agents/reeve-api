/**
 * Read rows from any connected app, as the broker does for a dataset (prints field names and types only):
 *   npm run connectors:read -- --tool=GOOGLESHEETS_VALUES_GET --args='{"spreadsheet_id":"…","range":"Sheet1!A1:Z500"}'
 */
import { connectorsFromEnv, inferFields } from "@reeve/connectors";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const tool = arg("tool");
if (!tool) throw new Error("--tool is required");
const records = await connectorsFromEnv().readRecords("", tool, JSON.parse(arg("args") ?? "{}") as Record<string, unknown>);
console.log(`${records.length} rows from ${tool}`);
for (const f of inferFields(records)) console.log(`  ${f.name.padEnd(20)} ${f.type}${f.values ? ` (${f.values.join("/")})` : ""}`);
