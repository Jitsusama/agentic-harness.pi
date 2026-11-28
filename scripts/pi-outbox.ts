/**
 * pi-outbox: takes what a strict session left in its outbox out of it,
 * for a node handing that session's work back
 * (lib/internal/sandbox/outbox.ts says how, and why each check):
 *
 *   node scripts/pi-outbox.ts --outbox DIR --into DIR [--most BYTES] [--seconds N]
 *
 * It copies each plain file of the outbox into the folder named, as a
 * new file, and says each entry on stdout as a line of JSON: its name,
 * and its bytes and sha-256 when taken, or why not. It exits 0 when it
 * took every entry, 1 when it refused one, 126 when it read none, saying
 * why on stderr, and 2 when it was asked wrongly. Run it as the
 * session's account, never as root. It reads only node's own modules,
 * so it runs where the package's are not installed.
 */

import { takeOutbox } from "../lib/internal/sandbox/outbox.ts";

/** The status when no entry was read. */
const REFUSED = 126;

/** The status a wrong asking exits with. */
const ASKED_WRONGLY = 2;

/** The most one file may hold unless asked: 64 MiB. */
const MOST_BYTES = 64 * 1024 * 1024;

/** How long a taking may take unless asked. */
const SECONDS = 60;

/** A thousand milliseconds. */
const SECOND_MS = 1000;

const HELP =
	"usage: node scripts/pi-outbox.ts --outbox DIR --into DIR [--most BYTES] [--seconds N]\n";

/** The value after each `--name`, or why the asking is wrong. */
function asked(words: readonly string[]): Map<string, string> | string {
	const named = new Map<string, string>();
	for (let at = 0; at < words.length; at += 2) {
		const name = words[at] ?? "";
		const value = words[at + 1];
		if (!["--outbox", "--into", "--most", "--seconds"].includes(name)) {
			return `it takes no ${JSON.stringify(name)}`;
		}
		if (value === undefined) return `${name} wants a value`;
		named.set(name, value);
	}
	if (!(named.has("--outbox") && named.has("--into"))) {
		return "it wants both --outbox and --into";
	}
	return named;
}

/** `value` as a whole number above 0, or none. */
function whole(
	value: string | undefined,
	otherwise: number,
): number | undefined {
	if (value === undefined) return otherwise;
	const number = Number(value);
	return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const words = process.argv.slice(2);
if (words.includes("--help")) {
	process.stdout.write(HELP);
	process.exit(0);
}
const named = asked(words);
const most =
	typeof named === "string"
		? undefined
		: whole(named.get("--most"), MOST_BYTES);
const seconds =
	typeof named === "string"
		? undefined
		: whole(named.get("--seconds"), SECONDS);
if (typeof named === "string" || most === undefined || seconds === undefined) {
	const why =
		typeof named === "string"
			? named
			: "--most and --seconds want whole numbers above 0";
	process.stderr.write(`pi-outbox: ${why}\n${HELP}`);
	process.exit(ASKED_WRONGLY);
}
const taking = takeOutbox(
	named.get("--outbox") ?? "",
	named.get("--into") ?? "",
	{
		most,
		deadline: Date.now() + seconds * SECOND_MS,
	},
);
if ("refused" in taking) {
	process.stderr.write(`pi-outbox: ${taking.refused}\n`);
	process.exit(REFUSED);
}
for (const entry of taking.entries) {
	process.stdout.write(`${JSON.stringify(entry)}\n`);
}
process.exit(taking.entries.every((entry) => entry.taken) ? 0 : 1);
