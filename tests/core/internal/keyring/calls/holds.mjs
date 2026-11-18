// A keyring call that says it started in KEYRING_CALL_FILE's folder, with how many were running then, and answers only once a file named go is there: with its account's name, or a refusal for an account named fails-*.
import {
	appendFileSync,
	existsSync,
	readdirSync,
	rmSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const folder = dirname(process.env.KEYRING_CALL_FILE ?? "");
const running = join(folder, "running");
const go = join(folder, "go");
let text = "";
for await (const chunk of process.stdin) text += chunk;
const asked = JSON.parse(text);

const mine = join(running, String(process.pid));
writeFileSync(mine, "");
appendFileSync(
	join(folder, "starts"),
	`${JSON.stringify({ account: asked.account, running: readdirSync(running).length })}\n`,
);

if (!existsSync(go)) {
	await new Promise((answer) => {
		const watcher = watch(folder, () => {
			if (!existsSync(go)) return;
			watcher.close();
			answer(undefined);
		});
		if (existsSync(go)) {
			watcher.close();
			answer(undefined);
		}
	});
}

rmSync(mine, { force: true });
const answer = asked.account.startsWith("fails-")
	? { error: `refused ${asked.account}` }
	: { value: asked.account };
process.stdout.write(`${JSON.stringify(answer)}\n`);
