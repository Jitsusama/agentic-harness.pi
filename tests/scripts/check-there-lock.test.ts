/**
 * check-there.sh's turn-taking, as the host it runs on takes it: the
 * script's own `lock` and `take_turn`, read out of it and run by bash
 * against one lock file, once with util-linux's flock and once with only
 * perl on the PATH, as on a Mac. A check that holds the lock keeps every
 * other waiting until its shell closes the file, or until the wait's
 * limit passes, and a lock that can't be tried at all fails the check
 * rather than reading as a busy one.
 */

import { type ChildProcess, spawn } from "node:child_process";
import {
	accessSync,
	constants,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(
	import.meta.dirname,
	"..",
	"..",
	"scripts",
	"check-there.sh",
);
/** How long a check is given to start, take its turn or end. */
const SETTLES_IN_MS = 10_000;

/** The script's own `lock` and `take_turn`, as it defines them. */
function turnTaking(): string {
	const text = readFileSync(SCRIPT, "utf8");
	return ["lock", "take_turn"]
		.map((name) => {
			const found = new RegExp(
				`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`,
				"m",
			).exec(text);
			if (found === null) throw new Error(`check-there.sh defines no ${name}`);
			return found[0];
		})
		.join("\n");
}

/** Where `program` is on this machine's PATH. */
function onPath(program: string): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const path = join(dir, program);
		try {
			accessSync(path, constants.X_OK);
			return path;
		} catch {
			// Not in this folder: the next may have it.
		}
	}
	return undefined;
}

const made: string[] = [];
const started: ChildProcess[] = [];
afterEach(() => {
	for (const child of started.splice(0)) child.kill("SIGKILL");
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/** A folder of the programs a host offers, linked from this machine's. */
function hostWith(programs: readonly string[]): string {
	const root = mkdtempSync(join(tmpdir(), "check-there-lock-"));
	made.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	for (const program of programs) {
		const path = onPath(program);
		if (path === undefined) throw new Error(`no ${program} here`);
		symlinkSync(path, join(bin, program));
	}
	return root;
}

/** A check's shell: the turn-taking, then `body`, on the host's PATH. */
function check(host: string, body: string, fd9 = true): ChildProcess {
	const bash = onPath("bash");
	if (bash === undefined) throw new Error("no bash here");
	const turn = `turn="${join(host, "lock")}"\n`;
	// Without fd9 the descriptor is closed outright, whatever node left open.
	const opening = fd9 ? `${turn}exec 9> "$turn"\n` : `${turn}exec 9>&-\n`;
	const child = spawn(
		bash,
		["-c", `set -euo pipefail\n${turnTaking()}\n${opening}${body}`],
		{ env: { PATH: join(host, "bin") }, stdio: ["pipe", "pipe", "pipe"] },
	);
	started.push(child);
	return child;
}

/** What a check said on stdout and stderr, and how it ended. */
interface Ended {
	readonly code: number | null;
	readonly out: string;
	readonly err: string;
}

/** Wait for a check to end, within `SETTLES_IN_MS`. */
function ended(child: ChildProcess): Promise<Ended> {
	let out = "";
	let err = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		err += chunk.toString();
	});
	return new Promise((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`no end in ${SETTLES_IN_MS} ms: ${err}`)),
			SETTLES_IN_MS,
		);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, out, err });
		});
	});
}

/** Wait until a check prints `line` on stdout. */
function says(child: ChildProcess, line: string): Promise<void> {
	return new Promise((resolve, reject) => {
		let out = "";
		const timer = setTimeout(
			() => reject(new Error(`never said ${line}`)),
			SETTLES_IN_MS,
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			out += chunk.toString();
			if (out.split("\n").includes(line)) {
				clearTimeout(timer);
				resolve();
			}
		});
	});
}

/** Wait until a check says something matching `said` on stderr. */
function complains(child: ChildProcess, said: RegExp): Promise<string> {
	return new Promise((resolve, reject) => {
		let err = "";
		const timer = setTimeout(
			() => reject(new Error(`never said ${said} on stderr`)),
			SETTLES_IN_MS,
		);
		child.stderr?.on("data", (chunk: Buffer) => {
			err += chunk.toString();
			if (said.test(err)) {
				clearTimeout(timer);
				resolve(err);
			}
		});
	});
}

/** What every host offers a check beside its lock: the commands it says with. */
const SAYING = ["hostname", "cat", "date"] as const;

const HOSTS = {
	"with util-linux's flock": ["perl", "flock", ...SAYING],
	"with only perl, as a Mac": ["perl", ...SAYING],
} as const;

describe.each(Object.entries(HOSTS))("check-there's turns %s", (_, tools) => {
	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"keeps a second check out while the first holds the lock, then lets it in",
		async () => {
			const host = hostWith(tools);
			// The holder takes its turn, says so, and holds until its stdin closes.
			const holder = check(
				host,
				"branch=feature\ntake_turn\necho held\nread -r _ || true",
			);
			await says(holder, "held");

			const tried = await ended(check(host, "lock -n"));
			expect(tried.code, "a try while the lock is held").toBe(1);

			const waiter = check(host, "take_turn\necho took");
			const waited = ended(waiter);
			const said = await complains(waiter, /waiting its turn/);
			expect(said, "whose turn it is").toMatch(
				/\(feature, from \d\d:\d\d\); waiting its turn/,
			);
			expect(
				waiter.exitCode,
				"a second check, having said it waits, still runs",
			).toBeNull();

			holder.stdin?.end();
			await ended(holder);
			const turn = await waited;
			expect(turn).toMatchObject({ code: 0, out: "took\n" });
		},
	);

	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"gives up once its wait's limit passes, saying so",
		async () => {
			const host = hostWith(tools);
			const holder = check(host, "take_turn\necho held\nread -r _ || true");
			await says(holder, "held");

			const waiter = await ended(
				check(host, "turn_wait_s=1\ntake_turn\necho took"),
			);
			expect(waiter).toMatchObject({ code: 1, out: "" });
			expect(waiter.err).toMatch(/gave up after 1 s waiting/);
			expect(
				waiter.err,
				"a busy lock isn't one that can't be tried",
			).not.toMatch(/can't take/);
		},
	);

	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"fails a check whose lock can't be tried, rather than reading it as busy",
		async () => {
			const host = hostWith(tools);
			const tried = await ended(check(host, "take_turn\necho took", false));
			expect(tried.code, "a lock never tried").not.toBe(0);
			expect(tried.out).toBe("");
			expect(tried.err).not.toMatch(/waiting its turn/);
			expect(tried.err).toMatch(/can't take/);
		},
	);
});

describe("check-there on a host with neither flock nor perl", () => {
	it.runIf(SAYING.every((tool) => onPath(tool) !== undefined))(
		"fails the check rather than reading the lock as busy",
		async () => {
			const tried = await ended(
				check(hostWith(SAYING), "take_turn\necho took"),
			);
			expect(tried.code, "no lock to take").not.toBe(0);
			expect(tried.out).toBe("");
			expect(tried.err).not.toMatch(/waiting its turn/);
			expect(tried.err).toMatch(/can't take/);
		},
	);
});

// What runs on the host can't run here without its clone and its ssh, so
// its shape is read instead: the check's own work, from the fetch to the
// last test, sits in one group with fd 9 closed, so nothing it leaves
// running, such as git's fsmonitor daemon, holds the next check out.
describe("the check's work on its host", () => {
	it("runs without the lock's descriptor, from its turn to its end", () => {
		const text = readFileSync(SCRIPT, "utf8");
		const there = /<<'THERE'\n([\s\S]*?)\nTHERE\n/.exec(text)?.[1] ?? "";
		const lines = there.split("\n");
		const after = lines
			.slice(lines.indexOf("take_turn") + 1)
			.filter((line) => !line.startsWith("#"));
		expect(after[0], "the group opens as its turn is taken").toBe("{");
		expect(after.at(-1), "and closes fd 9 for all of it").toBe("} 9>&-");
		expect(
			after.filter((line) => line === "{" || line.startsWith("}")),
			"one group, not several",
		).toEqual(["{", "} 9>&-"]);
	});
});
