// Live check: generated code inside a CreateOS sandbox must not reach the internet.
import { CreateOSSandbox } from "@reeve/sandbox";

const key = process.env.CREATEOS_API_KEY ?? process.env.CREATEOS_PROJECT_API_KEY;
if (!key) throw new Error("needs CREATEOS_API_KEY or CREATEOS_PROJECT_API_KEY");

const probe = `
import json, urllib.request
out = {}
for url in ["https://example.com", "https://api.stripe.com/v1"]:
    try:
        urllib.request.urlopen(url, timeout=5)
        out[url] = "REACHABLE"
    except Exception as e:
        out[url] = "blocked: " + type(e).__name__
open("job/egress.json", "w").write(json.dumps(out))
print(json.dumps(out))
`;

const run = await new CreateOSSandbox(key).runJob({ files: { "job/probe.py": probe }, command: ["python3", "job/probe.py"], resultPath: "job/egress.json" });
for (const l of run.log) console.log("sandbox |", l);
console.log("result:", run.result ?? run.stderr.slice(-500));
