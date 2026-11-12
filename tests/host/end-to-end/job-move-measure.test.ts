/**
 * A measurement, not a check: what a move does today to a plain pi's
 * background job. Each case prints what it saw as `MEASURED {...}` and
 * fails only when the harness around it does. Not for merging.
 */

import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, it } from "vitest";
import { isRecord } from "../../../lib/internal/record.ts";
import { type HostProcess, startHost } from "./support/host-process.ts";
import {
	onHostPi,
	ROUND_TRIP_MS,
	repliesIn,
	textOf,
	turnEnded,
	untilAnswered,
} from "./support/hosted-case.ts";
import { CARRIED_END, CARRY, CARRYING } from "./support/scripted-model.ts";
import { type Seal, seal } from "./support/seal.ts";
import {
	SCRIPTED_PROVIDER,
	startTerminalPi,
	type TerminalPi,
} from "./support/terminal-pi.ts";

const PI_ENGINE = resolve(import.meta.dirname, "support/pi-engine.ts");

/** How long a case watches after it acts: past the job's own 45 s. */
const WATCH_MS = 75_000;

/** How often a case looks. */
const LOOK_MS = 500;

let sealed: Seal;
let host: HostProcess | undefined;
let plain: TerminalPi | undefined;
beforeEach(async () => {
	sealed = await seal();
	host = undefined;
	plain = undefined;
});
afterEach(async () => {
	await plain?.stop();
	await host?.kill();
	await sealed.dispose();
});

function said(): string {
	return [
		host ? `The host wrote:\n${host.errors()}` : "",
		plain ? `The plain pi wrote:\n${plain.errors()}` : "",
	].join("\n");
}

/** What /proc says of one process, or nothing once it has gone. */
function procOf(pid: number): Record<string, unknown> | undefined {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		return {
			pid,
			ppid: Number(fields[1]),
			pgid: Number(fields[2]),
			sid: Number(fields[3]),
			cmd: readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" "),
			cgroup: readFileSync(`/proc/${pid}/cgroup`, "utf8").trim(),
			fds: readdirSync(`/proc/${pid}/fd`).map(
				(fd) => `${fd}->${readlinkOf(`/proc/${pid}/fd/${fd}`)}`,
			),
		};
	} catch {
		// The process has gone, which is what is asked.
		return undefined;
	}
}

function readlinkOf(path: string): string {
	try {
		return readlinkSync(path);
	} catch {
		// Unreadable: a measurement only.
		return "?";
	}
}

/** The pid of the job's follow, found by its command and the seal's HOME. */
function followIn(home: string): number | undefined {
	for (const name of readdirSync("/proc")) {
		const pid = Number(name);
		if (!Number.isInteger(pid)) continue;
		try {
			const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8");
			if (cmd !== "tail\0-f\0/dev/null\0") continue;
			const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
			if (env.includes(`HOME=${home}`)) return pid;
		} catch {
			// Gone or not ours: passed over.
		}
	}
	return undefined;
}

/** The chain of parents from `pid` up to pid 1, as /proc says. */
function parentsOf(pid: number): Record<string, unknown>[] {
	const chain: Record<string, unknown>[] = [];
	let at: number | undefined = pid;
	while (at !== undefined && at > 1 && chain.length < 8) {
		const one = procOf(at);
		if (!one) break;
		chain.push(one);
		at = typeof one["ppid"] === "number" ? one["ppid"] : undefined;
	}
	return chain;
}

/** The custom entry types and message roles a log holds, in order. */
function entriesOf(file: string | undefined): string[] {
	return textOf(file)
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			try {
				const entry: unknown = JSON.parse(line);
				if (!isRecord(entry)) return "?";
				if (entry["type"] === "custom")
					return `custom:${String(entry["customType"])}`;
				if (entry["type"] === "custom_message")
					return `custom_message:${String(entry["customType"])}`;
				if (entry["type"] === "message" && isRecord(entry["message"]))
					return `message:${String(entry["message"]["role"])}`;
				return String(entry["type"]);
			} catch {
				return "unparsed";
			}
		});
}

async function openPlain(pi: string, name: string): Promise<TerminalPi> {
	host = await startHost({
		seal: sealed,
		engine: PI_ENGINE,
		kind: "background",
		env: { PI_HOST_PACKAGE_DIR: pi },
	});
	const settings = join(sealed.home, ".pi", "agent", "settings.json");
	const written: unknown = JSON.parse(await readFile(settings, "utf8"));
	await writeFile(
		settings,
		JSON.stringify({
			...(isRecord(written) ? written : {}),
			extensions: [SCRIPTED_PROVIDER],
		}),
	);
	const cwd = join(sealed.home, "w");
	await mkdir(cwd, { recursive: true });
	await mkdir(join(sealed.home, ".pi", "agent"), { recursive: true });
	await writeFile(
		join(sealed.home, ".pi", "agent", "trust.json"),
		JSON.stringify({ [await realpath(sealed.home)]: true }),
	);
	const hold = join(sealed.root, "hold");
	await mkdir(hold, { recursive: true });
	const started = await startTerminalPi({
		seal: sealed,
		packageDir: pi,
		cwd,
		env: {
			MYCELIUM_WAKE: join(hold, `${name}.wake`),
			MYCELIUM_AGAIN: join(hold, `${name}.again`),
		},
		bare: true,
	});
	await writeFile(
		join(hold, `${name}.json`),
		JSON.stringify({ pid: started.pid }),
	);
	await started.prompt(CARRY);
	await untilAnswered(
		"the turn that started the job to end",
		async () =>
			textOf(started.file()).includes(CARRYING) && turnEnded(started.file()),
		ROUND_TRIP_MS,
	);
	return started;
}

/** Watch for WATCH_MS, noting when each thing first happened, in ms from `from`. */
async function watch(
	from: number,
	follow: number,
	file: () => string | undefined,
	sessionId: string,
): Promise<Record<string, number | undefined>> {
	const at: Record<string, number | undefined> = {
		piEnded: undefined,
		followGone: undefined,
		resultInLog: undefined,
		hostLists: undefined,
	};
	while (Date.now() - from < WATCH_MS) {
		const now = Date.now() - from;
		if (at["piEnded"] === undefined && plain?.ended()) at["piEnded"] = now;
		if (at["followGone"] === undefined && procOf(follow) === undefined)
			at["followGone"] = now;
		if (
			at["resultInLog"] === undefined &&
			textOf(file()).split(CARRIED_END).length > 2
		)
			at["resultInLog"] = now;
		if (
			at["hostLists"] === undefined &&
			((await host?.list()) ?? []).some((one) => one.sessionId === sessionId)
		)
			at["hostLists"] = now;
		// A poll: the pi, the host and the job are other processes.
		await new Promise((done) => setTimeout(done, LOOK_MS));
	}
	return at;
}

it(
	"measures /host on a plain pi with a background job running",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			plain = await openPlain(pi, "m1");
			const follow = followIn(sealed.home);
			const before = {
				follow: follow === undefined ? undefined : procOf(follow),
				parents: follow === undefined ? [] : parentsOf(follow),
				piPid: plain.pid,
			};
			const file = plain.file();
			const asked = Date.now();
			plain.type("/host");
			const at = await watch(asked, follow ?? -1, () => file, plain.sessionId);
			const listed = (await host?.list()) ?? [];
			console.log(
				`MEASURED ${JSON.stringify({
					case: "host-with-job",
					before,
					at,
					listed,
					repliesAfter: repliesIn(file),
					entries: entriesOf(file),
					screen: plain.ended() ? "ended" : plain.errors().slice(-1500),
				})}`,
			);
		});
	},
	ROUND_TRIP_MS * 2 + WATCH_MS * 2,
);

it(
	"measures what a move's ending does to a running job, as Close does",
	async ({ skip }) => {
		await onHostPi(skip, said, async (pi) => {
			plain = await openPlain(pi, "m2");
			const follow = followIn(sealed.home);
			const file = plain.file();
			const asked = Date.now();
			// A move ends the session as Close does: pi's shutdown, reason quit.
			plain.type("/quit");
			const at = await watch(asked, follow ?? -1, () => file, plain.sessionId);
			console.log(
				`MEASURED ${JSON.stringify({
					case: "ended-with-job",
					follow,
					at,
					entries: entriesOf(file),
					tail: textOf(file).slice(-1500),
				})}`,
			);
		});
	},
	ROUND_TRIP_MS * 2 + WATCH_MS * 2,
);
