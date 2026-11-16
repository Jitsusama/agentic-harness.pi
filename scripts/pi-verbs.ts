/**
 * The verbs server the launcher keeps a connection to, and a thin client
 * of it for agents and tests:
 *
 *   node scripts/pi-verbs.ts serve
 *   node scripts/pi-verbs.ts list
 *   node scripts/pi-verbs.ts ask VERB [NAME=WORDS ...] < selection
 *   node scripts/pi-verbs.ts told USE accepted|undone|dismissed
 *
 * `serve` listens on the socket systemd holds for it, or its own in the
 * login's runtime folder, and serves until a stop signal or, handed its
 * socket, until five minutes pass with no connection open: systemd holds
 * the socket meanwhile and starts it again on the next ask, so a node
 * process isn't kept all day for a menu used now and then. The others ask
 * it one line and print the answer as JSON. `--help` says how to ask it,
 * on stdout. It exits 64 when asked wrongly, naming the nearest command,
 * 78 when there is no runtime folder to find the socket in, and 1 when an
 * ask is refused.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, stateDir } from "../lib/internal/paths.ts";
import { VERBS_HELP, verbsAsked } from "../lib/internal/verbs/asked.ts";
import { askVerbs } from "../lib/internal/verbs/client.ts";
import {
	listenForVerbs,
	verbServer,
	verbsSocket,
} from "../lib/internal/verbs/serve.ts";

/** The status a wrong asking exits with, as sysexits' EX_USAGE. */
const EXIT_USAGE = 64;

/** The status a unit reads as a configuration no restart would change. */
const EXIT_MISCONFIGURED = 78;

/** How long a handed server serves with no connection open. */
const REST_AFTER_MS = 5 * 60 * 1000;

const asked = verbsAsked(process.argv.slice(2));
if ("help" in asked) {
	process.stdout.write(VERBS_HELP);
	process.exit(0);
}
if ("wrong" in asked) {
	process.stderr.write(`${asked.wrong}\nTry pi-verbs --help.\n`);
	process.exit(EXIT_USAGE);
}
const socket = verbsSocket();
if (!socket) {
	process.stderr.write(
		"pi-verbs: there is no runtime folder to find the socket in\n",
	);
	process.exit(EXIT_MISCONFIGURED);
}

if ("serve" in asked) {
	// Node names its main thread MainThread, which is all `ps -e` and
	// systemctl showed of it; a daemon is shown by its own name.
	process.title = "pi-verbs";
	// systemd says it handed the socket over, and to which process. Only a
	// handed server rests, since one listening on its own socket would
	// leave nothing to answer the next ask.
	const handed =
		process.env.LISTEN_FDS === "1" &&
		process.env.LISTEN_PID === String(process.pid);
	const end = (): void => {
		server.stop().then(() => process.exit(0));
	};
	const server = verbServer({
		folders: [join(import.meta.dirname, "..", "verbs"), configDir("verbs")],
		uses: join(stateDir("verbs"), "uses.jsonl"),
		...(handed ? { restAfterMs: REST_AFTER_MS, onRest: end } : {}),
	});
	await listenForVerbs(server.server, socket, handed);
	for (const signal of ["SIGTERM", "SIGINT"] as const) {
		process.once(signal, end);
	}
} else {
	const line = asked.selection
		? { ...asked.line, selection: readFileSync(0, "utf8") }
		: asked.line;
	const answer = await askVerbs(socket, line);
	process.stdout.write(`${JSON.stringify(answer, null, "\t")}\n`);
	if (answer.ok === false) process.exit(1);
}
