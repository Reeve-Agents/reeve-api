/**
 * Send one test message through the connector registry, exactly as the broker would.
 *   npm run connectors:send -- --tool=GMAIL_SEND_EMAIL --to=you@example.com
 */
import { connectorsFromEnv } from "@reeve/connectors";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const tool = arg("tool") ?? "GMAIL_SEND_EMAIL";
const to = arg("to");
if (!to) throw new Error("--to is required");
const args: Record<string, unknown> =
  tool === "GMAIL_SEND_EMAIL"
    ? { recipient_email: to, subject: "Reeve test: Composio Gmail", body: "Tes dari Reeve broker lewat Composio Connect. Abaikan email ini." }
    : { chat_id: to, text: "Tes dari Reeve broker lewat Composio Connect. Abaikan pesan ini." };
const r = await connectorsFromEnv().execute(tool.startsWith("GMAIL") ? "gmail" : "telegram", tool, args);
console.log(JSON.stringify({ ok: r.ok, connector: r.connector, error: r.error ?? null }));
const sent = r.data as Record<string, unknown> | undefined;
if (sent) console.log("provider response keys:", Object.keys(sent).join(", "), "| id:", String(sent.id ?? sent.response_data ?? "").slice(0, 40));
