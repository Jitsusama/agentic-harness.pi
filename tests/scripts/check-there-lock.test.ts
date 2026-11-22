/**
 * check-there.sh's turn-taking, as the host it runs on takes it: the
 * script's own `lock` and `take_turn`, read out of it and run by bash
 * against one lock file, once with util-linux's flock and once with only
 * perl on the PATH, as on a Mac. A check that holds the lock keeps every
 * other waiting until its shell closes the file, and a lock that can't
 * be tried at all fails the check rather than reading as a busy one.
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
/** How long a waiting check is watched to see that it does wait. */
const WAITS_FOR_MS = 500;
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
	const opening = fd9 ? `exec 9> "${join(host, "lock")}"\n` : "";
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

/** Whether a check is still running after `ms`. */
function stillRunsAfter(child: ChildProcess, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(true), ms);
		child.on("close", () => {
			clearTimeout(timer);
			resolve(false);
		});
	});
}

const HOSTS = {
	"with util-linux's flock": ["perl", "hostname", "flock"],
	"with only perl, as a Mac": ["perl", "hostname"],
} as const;

describe.each(Object.entries(HOSTS))("check-there's turns %s", (_, tools) => {
	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"keeps a second check out while the first holds the lock, then lets it in",
		async () => {
			const host = hostWith(tools);
			// The holder takes its turn, says so, and holds until its stdin closes.
			const holder = check(host, "take_turn\necho held\nread -r _ || true");
			await says(holder, "held");

			const tried = await ended(check(host, "lock -n"));
			expect(tried.code).toBe(1);

			const waiter = check(host, "take_turn\necho took");
			const waited = ended(waiter);
			expect(await stillRunsAfter(waiter, WAITS_FOR_MS)).toBe(true);

			holder.stdin?.end();
			await ended(holder);
			const turn = await waited;
			expect(turn).toMatchObject({ code: 0, out: "took\n" });
			expect(turn.err).toMatch(/waiting its turn/);
		},
	);

	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"fails a check whose lock can't be tried, rather than reading it as busy",
		async () => {
			const host = hostWith(tools);
			const tried = await ended(check(host, "take_turn\necho took", false));
			expect(tried.code).not.toBe(0);
			expect(tried.out).toBe("");
			expect(tried.err).not.toMatch(/waiting its turn/);
			expect(tried.err).toMatch(/can't take/);
		},
	);
});
