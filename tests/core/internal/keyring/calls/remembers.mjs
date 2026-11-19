// A keyring call that keeps values in a file named by KEYRING_CALL_FILE, answering as secret-service-call.mjs does.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const file = process.env.KEYRING_CALL_FILE ?? "";
let text = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) text += chunk;
const asked = JSON.parse(text);
const kept = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const key = `${asked.service}/${asked.account}`;
let answer = {};
if (asked.act === "read") answer = { value: kept[key] ?? null };
if (asked.act === "write") kept[key] = asked.value;
if (asked.act === "remove") delete kept[key];
writeFileSync(file, JSON.stringify(kept));
process.stdout.write(`${JSON.stringify(answer)}\n`);
