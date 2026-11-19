// A keyring call that answers and then stays running, as one whose D-Bus connection keeps it alive would, leaving its pid beside KEYRING_CALL_FILE; it ends itself after two minutes, so a test run that dies before ending it leaves nothing running for long.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const folder = dirname(process.env.KEYRING_CALL_FILE ?? "");
for await (const _ of process.stdin);
writeFileSync(join(folder, "lingers.pid"), String(process.pid));
process.stdout.write(`${JSON.stringify({ value: "value" })}\n`);
setTimeout(() => process.exit(0), 120_000);
