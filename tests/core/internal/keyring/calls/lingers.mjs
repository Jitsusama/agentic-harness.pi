// A keyring call that answers and then stays running, as one whose D-Bus connection keeps it alive would, leaving its pid beside KEYRING_CALL_FILE.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const folder = dirname(process.env.KEYRING_CALL_FILE ?? "");
for await (const _ of process.stdin);
writeFileSync(join(folder, "lingers.pid"), String(process.pid));
process.stdout.write(`${JSON.stringify({ value: "value" })}\n`);
setInterval(() => undefined, 60_000);
