// A keyring call that says it started in KEYRING_CALL_FILE's folder, with how many were running then, and answers only once a file named go, or go-<its act>, is there: with its account's name, or a refusal for an account named fails-*.
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
let text = "";
for await (const chunk of process.stdin) text += chunk;
const asked = JSON.parse(text);
const letGo = () =>
	existsSync(join(folder, "go")) || existsSync(join(folder, `go-${asked.act}`));

const mine = join(running, String(process.pid));
writeFileSync(mine, "");
appendFileSync(
	join(folder, "starts"),
	`${JSON.stringify({ account: asked.account, running: readdirSync(running).length })}\n`,
);

if (!letGo()) {
	await new Promise((answer) => {
		const watcher = watch(folder, () => {
			if (!letGo()) return;
			watcher.close();
			answer(undefined);
		});
		if (letGo()) {
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
