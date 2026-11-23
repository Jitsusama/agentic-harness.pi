/**
 * check-there.sh's tests, which its test files run: its turn-taking, as
 * the host it runs on takes it, the script's own `lock` and `take_turn`
 * read out of it and run by bash against one lock file, once a file with
 * util-linux's flock and once with only perl on the PATH, as on a Mac,
 * so the two hosts' turns run side by side; then its local half and the
 * shape of its work there. A check that holds the lock keeps every other
 * waiting until its shell closes the file, or until the wait's limit
 * passes, and a lock that can't be tried at all fails the check rather
 * than reading as a busy one. Long because each part is read through the
 * same pieces: the script read out of its file, the stand-in hosts with
 * only the tools they're given, and what each test leaves to be cleared.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

const SCRIPT = join(
	import.meta.dirname,
	"..",
	"..",
	"..",
	"scripts",
	"check-there.sh",
);
/** How long a check is given to start, take its turn or end. */
const SETTLES_IN_MS = 10_000;
/** How long a test is given: several of its checks settling in turn. */
const TEST_MS = 4 * SETTLES_IN_MS;
/** Milliseconds in a second, for a time a shell says in seconds. */
const MS_PER_S = 1_000;

/** What the script runs on its host, between its `THERE` lines. */
function there(): string {
	const text = readFileSync(SCRIPT, "utf8");
	return /<<'THERE'\n([\s\S]*?)\nTHERE\n/.exec(text)?.[1] ?? "";
}

/** The script's line clearing what its stops read, whatever the host exports. */
const CLEARED = "holder= node_link= ending= deadline= killed= stop_wait_s=";

/** The lines the script runs as they stand, which the checks here run too. */
const SETTINGS = [
	"set -m",
	CLEARED,
	"caller=$PPID",
	"note_caller",
	"trap let_go EXIT",
	"trap 'stop_all 143' TERM",
	"trap 'stop_all 130' INT",
	"trap 'stop_all 129' HUP",
	"trap caller_gone PIPE",
] as const;

/** The script's function `name`, as it defines it, or nothing when it doesn't. */
function defined(text: string, name: string): string | undefined {
	return new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(
		text,
	)?.[0];
}

/** The functions `text` defines, by name. */
function functionsIn(text: string): string[] {
	return [...text.matchAll(/^(\w+)\(\) \{$/gm)].flatMap(
		(found) => found[1] ?? [],
	);
}

/** The functions `name`'s code in `text` calls, and those they call in turn. */
function reachedFrom(text: string, name: string): Set<string> {
	const functions = functionsIn(text);
	const seen = new Set([name]);
	for (const each of seen) {
		const body = (defined(text, each) ?? "")
			.split("\n")
			.filter((line) => !line.trimStart().startsWith("#"))
			.join("\n");
		for (const called of functions)
			if (new RegExp(`(^|[^\\w-])${called}($|[^\\w-])`, "m").test(body))
				seen.add(called);
	}
	return seen;
}

/** The functions a stop runs: every one a trap's handler reaches. */
function stoppingIn(text: string): string[] {
	const handlers = SETTINGS.flatMap(
		(line) => /^trap '?(\w+)/.exec(line)?.[1] ?? [],
	);
	return [...new Set(handlers.flatMap((name) => [...reachedFrom(text, name)]))];
}

/**
 * The script's own turn-taking, as it defines it: every function it
 * defines there, then those of its job control and traps it runs, so a
 * check here ends and stops as one there does. One it lacks is left out
 * here rather than refused, so its checks still run against it; the
 * work's own test names each it lacks.
 */
function turnTaking(): string {
	const text = there();
	const functions = text.match(/^\w+\(\) \{\n[\s\S]*?\n\}$/gm) ?? [];
	if (functions.length === 0) throw new Error("check-there.sh defines nothing");
	const lines = text.split("\n");
	// In the script's own order, so a check here sets them as one there does.
	const settings = SETTINGS.filter((line) => lines.includes(line)).sort(
		(a, b) => lines.indexOf(a) - lines.indexOf(b),
	);
	return [...functions, ...settings].join("\n");
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
/** Stop every check a test started and clear its folders, after each. */
function clearsAfterEach(): void {
	afterEach(clearAway);
}
function clearAway(): void {
	for (const child of started.splice(0)) {
		try {
			// Each check leads a group of its own, as one under ssh does.
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
		} catch {
			// Its group has ended already: nothing left to stop.
		}
	}
	for (const dir of made.splice(0))
		rmSync(dir, { recursive: true, force: true });
}

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

/**
 * A check's shell: the turn-taking, then `body`, on the host's PATH with
 * the host's folder as its home. It leads a process group of its own, as
 * a shell ssh starts does, so a stop it sends its group reaches only it.
 */
function check(
	host: string,
	body: string,
	fd9 = true,
	exported: Readonly<Record<string, string>> = {},
): ChildProcess {
	const child = spawn(bashHere(), ["-c", shellOf(host, body, fd9)], {
		env: { ...exported, PATH: join(host, "bin"), HOME: host },
		stdio: ["pipe", "pipe", "pipe"],
		detached: true,
	});
	started.push(child);
	return child;
}

/**
 * A check's shell started under a caller of its own, as sshd starts the
 * shell there, so a test can take the caller away and leave the shell
 * running. What it returns is the caller; the shell says its own pid
 * first, on stdout.
 */
function checkUnderCaller(host: string, body: string): ChildProcess {
	const bash = bashHere();
	const caller = spawn(
		bash,
		["-c", '"$0" -c "$1" & wait', bash, shellOf(host, `echo "$$"\n${body}`)],
		{
			env: { PATH: join(host, "bin"), HOME: host },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		},
	);
	started.push(caller);
	return caller;
}

/** This machine's bash. */
function bashHere(): string {
	const bash = onPath("bash");
	if (bash === undefined) throw new Error("no bash here");
	return bash;
}

/** What a check's shell runs: the turn-taking, then `body`. */
function shellOf(host: string, body: string, fd9 = true): string {
	const turn = `turn="${join(host, "lock")}"\n`;
	// Without fd9 the descriptor is closed outright, whatever node left open.
	const opening = fd9 ? `${turn}exec 9> "$turn"\n` : `${turn}exec 9>&-\n`;
	return `set -euo pipefail\n${turnTaking()}\n${opening}${body}`;
}

/** The pids a check has said on stdout, one a line, once it has said `count`. */
async function saidPids(child: ChildProcess, count: number): Promise<number[]> {
	const sofar = heard(child);
	let pids: number[] = [];
	await vi.waitFor(
		() => {
			pids = sofar()
				.split("\n")
				.filter((line) => /^\d+$/.test(line))
				.map(Number);
			expect(pids.length, `${count} pids said`).toBeGreaterThanOrEqual(count);
		},
		{ timeout: SETTLES_IN_MS, interval: 50 },
	);
	for (const pid of pids) onTestFinished(() => killIfThere(pid));
	return pids.slice(0, count);
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

/** What every host offers a check beside its lock. */
const EVERY_HOST = ["hostname", "cat", "date", "rm", "sleep"] as const;

/** The hosts a check's turns are taken on, by the lock tool each offers. */
const HOSTS = {
	"with util-linux's flock": ["flock", ...EVERY_HOST],
	"with only perl, as a Mac": ["perl", ...EVERY_HOST],
} as const;

/** What a check has said on stdout so far, read as it goes. */
function heard(child: ChildProcess): () => string {
	let out = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		out += chunk.toString();
	});
	return () => out;
}

/** A check's turns, taken on the host `named`. */
export function describeTurns(named: keyof typeof HOSTS): void {
	const tools: readonly string[] = HOSTS[named];
	describe(`check-there's turns ${named}`, () => {
		clearsAfterEach();
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
				const sofar = heard(waiter);
				const waited = ended(waiter);
				const said = await complains(waiter, /waiting its turn/);
				expect(said, "whose turn it is").toMatch(
					/\(feature, pid \d+, from \d{4}-\d\d-\d\d \d\d:\d\d\); waiting its turn/,
				);
				// A wait that let the waiter in at once would print within this
				// pause; nothing signals a wait still waiting, so time must pass.
				await new Promise((resolve) => setTimeout(resolve, 1_500));
				expect(sofar(), "no turn while the holder holds it").toBe("");
				expect(waiter.exitCode, "and the waiter still waits").toBeNull();

				holder.stdin?.end();
				await ended(holder);
				const turn = await waited;
				expect(turn).toMatchObject({ code: 0, out: "took\n" });
				expect(
					existsSync(join(host, "lock.holder")),
					"each check takes its holder's line with it",
				).toBe(false);
			},
			TEST_MS,
		);

		// The holder's line is that check's to write, its branch's code
		// among what can, and every waiter says it, so it is said only in
		// the shape take_turn writes it.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined)).each([
			[
				"escapes and a line of the script's own",
				`\x1b[2J\x1b]0;titled\x07said\ncheck-there: run this ${"x".repeat(200)}\n`,
			],
			[
				"a mark reordering what follows, in a line otherwise its shape",
				"feature\u202e, pid 12, from 2026-11-22 00:00\n",
			],
			[
				"a branch past 160 characters",
				`${"b".repeat(161)}, pid 12, from 2026-11-22 00:00\n`,
			],
		])(
			"says no holder's line holding %s",
			async (_, written) => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				writeFileSync(join(host, "lock.holder"), written);
				const waiter = await ended(
					check(host, "turn_wait_s=1\ntake_turn\necho took"),
				);
				holder.stdin?.end();
				await ended(holder);
				expect(waiter.code, waiter.err).toBe(75);
				expect(
					waiter.err.split("\n").filter((line) => line !== ""),
					"the script's own lines alone, the holder's said as not its shape",
				).toEqual([
					`check-there: another check runs on ${hostname()} (a line not in its shape); waiting its turn`,
					expect.stringMatching(
						/^check-there: gave up after 1 s .*, held by \(a line not in its shape\)$/,
					),
				]);
			},
			TEST_MS,
		);

		// A FIFO's read waits for a writer, and an endless device's never
		// ends, so a waiter reading either would hold past its limit; a
		// link, even to a line in its shape, is read as no line at all.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined)).each([
			[
				"a link to an endless device",
				(path: string) => symlinkSync("/dev/zero", path),
			],
			[
				"a link to a line in its shape",
				(path: string) => {
					writeFileSync(
						`${path}.real`,
						"later, pid 1, from 2026-11-22 00:00\n",
					);
					symlinkSync(`${path}.real`, path);
				},
			],
			[
				"a FIFO",
				(path: string) => {
					spawnSync("mkfifo", [path]);
					if (!lstatSync(path).isFIFO()) throw new Error("no FIFO made");
				},
			],
		])(
			"gives up on time, its holder's line unsaid, when the line is %s",
			async (_, make) => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				const line = join(host, "lock.holder");
				rmSync(line);
				make(line);
				const asked = Date.now();
				const waiter = await ended(
					check(host, "turn_wait_s=1\ntake_turn\necho took"),
				);
				const waitedFor = Date.now() - asked;
				holder.stdin?.end();
				await ended(holder);
				expect(waiter.code, waiter.err).toBe(75);
				// Its limit and the second more it promises, with room for a
				// busy machine's slow start, and far short of a held read.
				expect(waitedFor, "gave up on time").toBeLessThan(6_000);
				expect(waiter.err, "the line, unsaid").toMatch(
					/\(unsaid\); waiting its turn[\s\S]*held by \(unsaid\)/,
				);
			},
			TEST_MS,
		);

		// The look and the read are two lookups of one name, so a holder
		// can swap a FIFO in between them: here, as the waiter looks.
		it.runIf([...tools, "mkfifo"].every((tool) => onPath(tool) !== undefined))(
			"gives up on time when a FIFO is swapped in after its look",
			async () => {
				const host = hostWith([...tools, "mkfifo"]);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				const swap = [
					"[() {",
					'  if builtin [ "$1" = "!" ] && builtin [ "$2" = -L ] && builtin [ -f "$3" ]; then',
					'    rm -f "$3"; mkfifo "$3"',
					"  fi",
					'  builtin [ "$@"',
					"}",
				].join("\n");
				const asked = Date.now();
				const waiter = await ended(
					check(host, `${swap}\nturn_wait_s=1\ntake_turn\necho took`),
				);
				const waitedFor = Date.now() - asked;
				// Read before the holder ends, which takes its line with it.
				const swapped = lstatSync(join(host, "lock.holder")).isFIFO();
				holder.stdin?.end();
				await ended(holder);
				expect(waiter.code, waiter.err).toBe(75);
				expect(swapped, "the swap was made").toBe(true);
				// Its limit, the second more it promises and a second's read,
				// with room for a slow start, and far short of a held open.
				expect(waitedFor, "gave up on time").toBeLessThan(7_000);
				expect(waiter.err, "the line, unsaid").toMatch(
					/\(unsaid\); waiting its turn[\s\S]*held by \(unsaid\)/,
				);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"gives up once its wait's limit passes, saying so",
			async () => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");

				const asked = Date.now();
				const waiting = check(host, "turn_wait_s=2\ntake_turn\necho took");
				const waited = ended(waiting);
				await complains(waiting, /waiting its turn/);
				// The turn changes hands while it waits, as over 90 minutes it may.
				writeFileSync(
					join(host, "lock.holder"),
					"later, pid 1, from 2026-11-22 00:00\n",
				);
				const waiter = await waited;
				const waitedFor = Date.now() - asked;
				expect(
					waitedFor,
					"it waited its limit before giving up",
				).toBeGreaterThanOrEqual(1_900);
				// Asked each second, it gives up within a second or so of its limit.
				expect(waitedFor, "and gave up soon after").toBeLessThan(6_000);
				expect(waiter).toMatchObject({ code: 75, out: "" });
				expect(waiter.err, "naming who holds the turn as it gives up").toMatch(
					/gave up after 2 s waiting for .*'s check lock, held by \(later, pid 1, from 2026-11-22 00:00\)/,
				);
				expect(
					waiter.err,
					"a busy lock isn't one that can't be tried",
				).not.toMatch(/can't take/);
				expect(
					existsSync(join(host, "lock.holder")),
					"a check that gave up leaves its holder's line",
				).toBe(true);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"lets the next check in once the first ends, whatever it left running outside its work",
			async () => {
				const host = hostWith(tools);
				// As git's fsmonitor outlives the check that started it, in a
				// group of its own that the work's end doesn't reach.
				const leaving = [
					"escape() {",
					"  ( set -m; sleep 30 >/dev/null 2>&1 <&- & echo $! )",
					"}",
				].join("\n");
				for (const [shape, code] of [
					["alone escape", 0],
					["escape", 1],
				] as const) {
					const first = await ended(
						check(host, `${leaving}\ntake_turn\n${shape}`),
					);
					const pid = Number(first.out.trim());
					onTestFinished(() => killIfThere(pid));
					// Still running, so the turn passing says what it holds, not
					// that the work's end took it along.
					expect(
						() => process.kill(pid, 0),
						`it ran on outside the work's group, after ${shape}`,
					).not.toThrow();
					const next = await ended(check(host, "lock -n"));
					expect(next.code, `a try after ${shape}`).toBe(code);
					process.kill(pid, "SIGKILL");
				}
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops the whole check when its holder's pid is sent a TERM, then lets the next in",
			async () => {
				const host = hostWith(tools);
				// The check's work runs as the script runs it, alone, and tidies up
				// for a while once told to stop, as a test runner may.
				const holder = check(
					host,
					[
						"work() {",
						`  trap 'sleep 1; : > "$HOME/tidied"; exit 0' TERM`,
						"  sleep 30 >/dev/null 2>&1 <&- &",
						"  echo $!",
						// Until the check's shell goes, which afterEach sees to.
						"  while kill -0 $$ 2>/dev/null; do sleep 0.1; done",
						"}",
						"take_turn",
						"alone work",
					].join("\n"),
				);
				const stopped = ended(holder);
				const work = Number(
					await new Promise<string>((resolve) => {
						holder.stdout?.once("data", (chunk: Buffer) =>
							resolve(chunk.toString().trim()),
						);
					}),
				);
				onTestFinished(() => killIfThere(work));
				const during = await ended(check(host, "lock -n"));
				expect(during.code, "no turn while its work runs").toBe(1);
				const line = readFileSync(join(host, "lock.holder"), "utf8");
				expect(line, "the line names the pid to stop").toContain(
					`pid ${holder.pid}`,
				);

				// Read as its shell ends, which `close` would wait past for the
				// work, since the work holds the shell's output too.
				const tidiedAtExit = new Promise<boolean>((resolve) =>
					holder.once("exit", () => resolve(existsSync(join(host, "tidied")))),
				);
				holder.kill("SIGTERM");
				// A second stop, landing as the first waits for the work, says nothing more.
				await complains(holder, /stopped by TERM/);
				holder.kill("SIGTERM");
				const stop = await stopped;
				expect(stop.code, "it ends as signalled").toBe(143);
				expect(
					stop.err.match(/check-there: stopped by .*/g),
					"saying so once",
				).toEqual([
					"check-there: stopped by TERM; ending what it runs, then passing its turn",
				]);
				expect(stop.err, "its work stopped in time").not.toMatch(/outlived/);
				expect(
					await tidiedAtExit,
					"its work had tidied up before its shell, and its turn, ended",
				).toBe(true);
				expect(await goneWithin(work), "its work stopped with it").toBe(true);
				const after = await ended(check(host, "lock -n"));
				expect(after.code, "the next check gets its turn").toBe(0);
				expect(
					existsSync(join(host, "lock.holder")),
					"and the stopped check took its line with it",
				).toBe(false);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"kills the work that ignores a stop once its wait for it passes, then lets the next in",
			async () => {
				const host = hostWith(tools);
				// Ignoring the TERM, as what it starts then does too.
				const holder = check(
					host,
					[
						"work() {",
						"  trap '' TERM",
						"  sleep 30 >/dev/null 2>&1 <&- &",
						"  echo $!",
						"  while kill -0 $$ 2>/dev/null; do sleep 0.1; done",
						"}",
						"stop_wait_s=1",
						"take_turn",
						"alone work",
					].join("\n"),
				);
				const stopped = ended(holder);
				const work = Number(
					await new Promise<string>((resolve) => {
						holder.stdout?.once("data", (chunk: Buffer) =>
							resolve(chunk.toString().trim()),
						);
					}),
				);
				onTestFinished(() => killIfThere(work));

				const asked = Date.now();
				holder.kill("SIGTERM");
				const stop = await stopped;
				expect(stop.code, "it ends as signalled").toBe(143);
				expect(
					Date.now() - asked,
					"having waited its limit for the work",
				).toBeGreaterThanOrEqual(900);
				expect(
					stop.err.match(/check-there: stopped by .*/g),
					"saying once that it was stopped",
				).toEqual([
					"check-there: stopped by TERM; ending what it runs, then passing its turn",
				]);
				expect(
					stop.err.match(/what it ran outlived 1 s, so it was killed/g),
					"saying, once, that it killed it",
				).toHaveLength(1);
				expect(await goneWithin(work), "its work killed with it").toBe(true);
				const after = await ended(check(host, "lock -n"));
				expect(after.code, "the next check gets its turn").toBe(0);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"ends what its work left in the work's group as the work ends, with the work's status",
			async () => {
				const host = hostWith(tools);
				const first = await ended(
					check(
						host,
						[
							"work() {",
							"  sleep 30 >/dev/null 2>&1 <&- &",
							"  echo $!",
							"  return 3",
							"}",
							"take_turn",
							"alone work",
						].join("\n"),
					),
				);
				expect(first.code, "it ends as its work did").toBe(3);
				expect(first.err, "neither stopped nor killed").not.toMatch(
					/stopped by|outlived/,
				);
				const left = Number(first.out.trim());
				onTestFinished(() => killIfThere(left));
				expect(
					await goneWithin(left),
					"what its work left, ended with it",
				).toBe(true);
				const next = await ended(check(host, "lock -n"));
				expect(next.code, "the next check gets its turn").toBe(0);
			},
			TEST_MS,
		);

		// The work's job is gone from the shell's table by then, so only the
		// group alone is ending says what a stop must wait for.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops whole when the stop lands as it ends what its work left",
			async () => {
				const host = hostWith(tools);
				const holder = check(
					host,
					[
						"work() {",
						"  ( trap '' TERM; sleep 30 ) >/dev/null 2>&1 <&- &",
						"  echo $!",
						// Says once alone's TERM reaches what the work left, which then
						// has its six seconds to go.
						`  ( trap ': > "$HOME/termed"; exit' TERM; while kill -0 $$ 2>/dev/null; do sleep 0.1; done ) >/dev/null 2>&1 <&- &`,
						"}",
						"stop_wait_s=6",
						"take_turn",
						"alone work",
					].join("\n"),
				);
				const stopped = ended(holder);
				const left = Number(
					await new Promise<string>((resolve) => {
						holder.stdout?.once("data", (chunk: Buffer) =>
							resolve(chunk.toString().trim()),
						);
					}),
				);
				onTestFinished(() => killIfThere(left));
				await vi.waitFor(
					() =>
						expect(
							existsSync(join(host, "termed")),
							"alone ending what the work left",
						).toBe(true),
					{ timeout: SETTLES_IN_MS, interval: 50 },
				);
				// The stop lands two and a half seconds into the six alone gave
				// what the work left. A wait ends by the clock, in whole seconds,
				// so never sooner than its length nor a second past it: what was
				// left ends 3.5 to 4.5 s after the stop, where six of its own
				// would end 6 s or more after it, and a kill at once at none.
				await new Promise((resolve) => setTimeout(resolve, 2_500));
				const stopAt = Date.now();
				holder.kill("SIGTERM");
				const stop = await stopped;
				expect(stop.code, "it ends as signalled").toBe(143);
				const tookMs = Date.now() - stopAt;
				expect(
					tookMs,
					"killing it with what was left of alone's six seconds, not six more",
				).toBeLessThan(5_900);
				// A busy machine only makes the stop land later and this shorter,
				// so the floor sits well under 3.5 s, over a kill at once.
				expect(tookMs, "and not before it ran out").toBeGreaterThanOrEqual(
					1_500,
				);
				expect(
					await goneWithin(left),
					"what its work left, ended before its turn passed",
				).toBe(true);
				expect(stop.err, "saying it was stopped").toMatch(
					/check-there: stopped by TERM; ending what it runs/,
				);
				expect(
					stop.err.match(/what it ran outlived 6 s, so it was killed/g),
					"and, once, what outlived its wait",
				).toHaveLength(1);
			},
			TEST_MS,
		);

		// A stop landing once alone has said it killed, its KILL not yet
		// sent, would otherwise send a TERM again and wait out the six
		// seconds alone gave the KILL. The window is too short to land a
		// signal in, so the stop's own ending is run from the state alone
		// leaves there.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"goes on with its KILL when a stop lands once alone has killed",
			async () => {
				const host = hostWith(tools);
				const stopping = check(
					host,
					[
						`( trap '' TERM; : > "$HOME/deaf"; sleep 30 ) >/dev/null 2>&1 <&- &`,
						"group=$!",
						// A TERM before its trap is set would end it, as a KILL would.
						'until [ -e "$HOME/deaf" ]; do sleep 0.05; done',
						'echo "$group"',
						"stop_wait_s=10 killed=1 deadline=$(( SECONDS + 6 ))",
						'end_groups "$group"',
						"echo ended",
					].join("\n"),
				);
				const [group = 0] = await saidPids(stopping, 1);
				const asked = Date.now();
				const stop = await ended(stopping);
				expect(stop.code, stop.err).toBe(0);
				expect(Date.now() - asked, "killed at once").toBeLessThan(3_000);
				expect(stop.err, "saying nothing more of the kill").not.toMatch(
					/outlived/,
				);
				expect(await goneWithin(group), "what was left, killed").toBe(true);
			},
			TEST_MS,
		);

		// Without a group of the work's own, a stop would signal nothing and
		// read the work as gone while it ran on in the shared worktree.
		it.runIf([...tools, "touch"].every((tool) => onPath(tool) !== undefined))(
			"refuses to run work no stop could reach, ending it",
			async () => {
				// touch, so the quick job would leave its mark if it ran.
				const host = hostWith([...tools, "touch"]);
				// Refused before it runs, the sleep never holds the shell's output,
				// so the check ends at once.
				const refused = await ended(
					check(host, "set +m\ntake_turn\nalone sleep 30\necho ran"),
				);
				expect(refused.code, "the check fails").toBe(1);
				expect(refused.out, "going no further").toBe("");
				expect(refused.err, "saying why").toMatch(
					/no process group of its own/,
				);
				// The work is named, not what runs it.
				const wrapped = await ended(
					check(host, "set +m\ntake_turn\nalone with_errexit sleep 30"),
				);
				expect(wrapped.err, "naming the work").toMatch(
					/^check-there: sleep got no process group/m,
				);
				// A job that ends at once is refused as surely, before it runs.
				const quick = await ended(
					check(host, 'set +m\ntake_turn\nalone touch "$HOME/ran"'),
				);
				expect(quick.code, "a quick one fails too").toBe(1);
				expect(existsSync(join(host, "ran")), "having run nothing").toBe(false);
				// A subshell runs with job control off, whatever its `$-` says.
				const inner = await ended(
					check(host, 'take_turn\n( alone touch "$HOME/ran" )\necho ran'),
				);
				expect(inner.code, "one asked from a subshell fails too").toBe(1);
				expect(inner.err, "saying why").toMatch(/no process group of its own/);
				expect(existsSync(join(host, "ran")), "having run nothing").toBe(false);
				// A command substitution is a subshell too.
				const substituted = await ended(
					check(host, 'take_turn\nsaid=$(alone touch "$HOME/ran")\necho ran'),
				);
				expect(substituted.code, "one asked from $( ) fails too").toBe(1);
				expect(existsSync(join(host, "ran")), "having run nothing").toBe(false);
				const next = await ended(check(host, "lock -n"));
				expect(next.code, "the next check gets its turn").toBe(0);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops a check still waiting its turn at once, as each signal says",
			async () => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				for (const [signal, code] of [
					["SIGTERM", 143],
					["SIGINT", 130],
					["SIGHUP", 129],
				] as const) {
					const waiting = check(host, "turn_wait_s=30\ntake_turn\necho took");
					const waited = ended(waiting);
					await complains(waiting, /waiting its turn/);
					const asked = Date.now();
					waiting.kill(signal);
					const stopped = await waited;
					expect(stopped.code, `ended by ${signal}`).toBe(code);
					expect(stopped.out, "taking no turn").toBe("");
					expect(
						stopped.err.match(/check-there: stopped by .*/g),
						`saying once that ${signal} stopped it, before its turn`,
					).toEqual([
						`check-there: stopped by ${signal.slice(3)} before it took its turn; ending what it runs`,
					]);
					expect(stopped.err, "with nothing to kill").not.toMatch(/outlived/);
					expect(
						Date.now() - asked,
						`stopped by ${signal} well before its wait ran out`,
					).toBeLessThan(SETTLES_IN_MS / 2);
				}
				expect(
					existsSync(join(host, "lock.holder")),
					"the holder's line stays its own",
				).toBe(true);
				holder.stdin?.end();
				await ended(holder);
			},
			TEST_MS,
		);

		// Without a pty sshd signals nothing as it goes, so a check whose
		// ssh was killed, or whose connection dropped, must notice itself.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops the whole check when its caller goes, then lets the next in",
			async () => {
				const host = hostWith(tools);
				const caller = checkUnderCaller(
					host,
					[
						"work() {",
						"  sleep 30 >/dev/null 2>&1 <&- &",
						"  echo $!",
						"  while kill -0 $$ 2>/dev/null; do sleep 0.1; done",
						"}",
						"take_turn",
						"alone work",
					].join("\n"),
				);
				let err = "";
				caller.stderr?.on("data", (chunk: Buffer) => {
					err += chunk.toString();
				});
				const [shell = 0, work = 0] = await saidPids(caller, 2);
				const during = await ended(check(host, "lock -n"));
				expect(during.code, "no turn while its work runs").toBe(1);

				process.kill(caller.pid ?? 0, "SIGKILL");
				expect(await goneWithin(shell), "its shell stopped").toBe(true);
				expect(await goneWithin(work), "and its work with it").toBe(true);
				expect(err, "saying why").toMatch(
					/check-there: stopped by its caller going; ending what it runs, then passing its turn/,
				);
				const after = await ended(check(host, "lock -n"));
				expect(after.code, "the next check gets its turn").toBe(0);
				expect(
					existsSync(join(host, "lock.holder")),
					"and the stopped check took its line with it",
				).toBe(false);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops a check still waiting its turn once its caller goes",
			async () => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				const caller = checkUnderCaller(
					host,
					"turn_wait_s=30\ntake_turn\necho took",
				);
				const sofar = heard(caller);
				const waiting = complains(caller, /waiting its turn/);
				const [shell = 0] = await saidPids(caller, 1);
				await waiting;

				const asked = Date.now();
				process.kill(caller.pid ?? 0, "SIGKILL");
				expect(await goneWithin(shell), "its shell stopped").toBe(true);
				expect(Date.now() - asked, "well before its wait ran out").toBeLessThan(
					SETTLES_IN_MS / 2,
				);
				expect(sofar(), "taking no turn").not.toContain("took");
				expect(
					readFileSync(join(host, "lock.holder"), "utf8"),
					"the holder's line stays its own",
				).toContain(`pid ${holder.pid}`);
				holder.stdin?.end();
				await ended(holder);
			},
			TEST_MS,
		);

		// Its caller gone, a check's writes fail; one in its stop, killing its
		// shell before the stop reached its work, would pass the turn anyway.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops whole when a stop lands after its output lost its reader",
			async () => {
				const host = hostWith(tools);
				const holder = check(
					host,
					[
						"work() {",
						"  sleep 30 >/dev/null 2>&1 <&- &",
						"  echo $!",
						"  while kill -0 $$ 2>/dev/null; do sleep 0.1; done",
						"}",
						"take_turn",
						"alone work",
					].join("\n"),
				);
				const [work = 0] = await saidPids(holder, 1);
				const stopped = new Promise<{
					code: number | null;
					signal: NodeJS.Signals | null;
				}>((resolve) =>
					holder.once("exit", (code, signal) => resolve({ code, signal })),
				);
				holder.stdout?.destroy();
				holder.stderr?.destroy();
				holder.kill("SIGTERM");
				expect(await stopped, "it ends as signalled").toEqual({
					code: 143,
					signal: null,
				});
				expect(await goneWithin(work), "its work stopped with it").toBe(true);
				const after = await ended(check(host, "lock -n"));
				expect(after.code, "the next check gets its turn").toBe(0);
			},
			TEST_MS,
		);

		// A write of its own finding no reader, with no stop under way, would
		// end its shell by SIGPIPE with its work running on.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"stops as a hang-up when a write of its own finds its reader gone",
			async () => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				const waiter = check(
					host,
					"read -r _ || true\nturn_wait_s=30\ntake_turn\necho took",
				);
				const sofar = heard(waiter);
				const stopped = new Promise<{
					code: number | null;
					signal: NodeJS.Signals | null;
				}>((resolve) =>
					waiter.once("exit", (code, signal) => resolve({ code, signal })),
				);
				// Its stderr's reader goes before it says it is waiting its turn.
				waiter.stderr?.destroy();
				waiter.stdin?.end("go\n");
				expect(await stopped, "it ends as a hang-up, not by SIGPIPE").toEqual({
					code: 129,
					signal: null,
				});
				expect(sofar(), "taking no turn").not.toContain("took");
				expect(
					readFileSync(join(host, "lock.holder"), "utf8"),
					"the holder's line stays its own",
				).toContain(`pid ${holder.pid}`);
				holder.stdin?.end();
				await ended(holder);
			},
			TEST_MS,
		);

		// ssh may hand the login shell what the caller exports; a check that
		// acted on those names would remove the holder's line or a file it
		// never made as it gave up.
		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"acts on none of what its stops read when the host exports those names",
			async () => {
				const host = hostWith(tools);
				const holder = check(host, "take_turn\necho held\nread -r _ || true");
				await says(holder, "held");
				const kept = join(host, "kept");
				writeFileSync(kept, "");
				const gaveUp = await ended(
					check(host, "turn_wait_s=1\ntake_turn\necho took", true, {
						holder: join(host, "lock.holder"),
						node_link: kept,
					}),
				);
				expect(gaveUp.code, "it gave up its wait").toBe(75);
				expect(
					readFileSync(join(host, "lock.holder"), "utf8"),
					"the holder's line, left",
				).toContain(`pid ${holder.pid}`);
				expect(existsSync(kept), "a file it never made, left").toBe(true);
				holder.stdin?.end();
				await ended(holder);
			},
			TEST_MS,
		);

		it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
			"fails a check whose lock can't be tried, rather than reading it as busy",
			async () => {
				const host = hostWith(tools);
				const tried = await ended(check(host, "take_turn\necho took", false));
				expect(tried.code, "a lock never tried, said as its own").toBe(3);
				expect(tried.out).toBe("");
				expect(tried.err).not.toMatch(/waiting its turn/);
				expect(tried.err, "why it couldn't").toMatch(/Bad file descriptor/);
				expect(tried.err).toMatch(/can't take/);
			},
			TEST_MS,
		);
	});
}

/** What a check does beside its turns: its lock's absence, its node, its two halves. */
export function describeTheRest(): void {
	clockWait();
	callerNamed();
	noLock();
	nodeLink();
	localHalf();
	lookups();
	itsEnd();
	workThere();
}

/** Make `path`, with the folders it sits in, as an empty program. */
function madeAt(path: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "");
	return path;
}

function lookups(): void {
	describe("what the check finds on its host", () => {
		clearsAfterEach();
		// Under errexit and pipefail, a lookup that ended the shell on a
		// match of none would end the check before it said what was missing.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"finds the pnpm a store holds for the version named, and says none where it holds none",
			async () => {
				const host = hostWith(EVERY_HOST);
				const store = join(host, "store");
				// The version named sorts second, so taking the first would show.
				mkdirSync(join(store, "a1-pnpm-10.2.1", "bin"), { recursive: true });
				mkdirSync(join(store, "b2-pnpm-10.2.0", "bin"), { recursive: true });
				const found = await ended(
					check(
						host,
						`pnpm_in "${store}" 10.2.0\nnone=$(pnpm_in "${store}" 9.9.9)\necho "none:$none"`,
					),
				);
				expect(found.code, found.err).toBe(0);
				expect(found.out, "the version named, then none").toBe(
					`${join(store, "b2-pnpm-10.2.0", "bin")}\nnone:\n`,
				);
			},
			TEST_MS,
		);

		// glibc's -bin output holds a loader too, a stub that runs nothing.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"finds glibc's own loader in a store, never its -bin output's, and says none where there is none",
			async () => {
				const host = hostWith(EVERY_HOST);
				const store = join(host, "store");
				const loader = "lib/ld-linux-x86-64.so.2";
				// A -bin stub on either side, so neither the first match nor the
				// last is glibc's own by luck.
				madeAt(join(store, "a0-glibc-2.40-66-bin", loader));
				const own = madeAt(join(store, "b1-glibc-2.40-66", loader));
				madeAt(join(store, "c2-glibc-2.40-66-bin", loader));
				const found = await ended(
					check(
						host,
						`loader_in "${store}"\nnone=$(loader_in "${join(host, "empty")}")\necho "none:$none"`,
					),
				);
				expect(found.code, found.err).toBe(0);
				expect(found.out, "glibc's own, then none").toBe(`${own}\nnone:\n`);
			},
			TEST_MS,
		);

		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"finds the biome a tree's install holds, and says none where it holds none",
			async () => {
				const host = hostWith(EVERY_HOST);
				const tree = join(host, "tree");
				const biome = madeAt(
					join(
						tree,
						"node_modules/.pnpm/@biomejs+cli-linux-x64@2.5.3/node_modules/@biomejs/cli-linux-x64/biome",
					),
				);
				const found = await ended(
					check(
						host,
						`biome_in "${tree}"\nnone=$(biome_in "${join(host, "empty")}")\necho "none:$none"`,
					),
				);
				expect(found.code, found.err).toBe(0);
				expect(found.out, "the tree's biome, then none").toBe(
					`${biome}\nnone:\n`,
				);
			},
			TEST_MS,
		);

		// The lookups' tests hold only what the check itself calls, and the
		// wrapper runs biome by the whole path its lookup gives, quoted.
		it("finds its pnpm, loader and biome by those lookups", () => {
			const work = (defined(there(), "run_check") ?? "")
				.split("\n")
				.map((line) => line.trim());
			for (const line of [
				'bin=$(pnpm_in /nix/store "$want")',
				"ld=$(loader_in /nix/store)",
				'real=$(biome_in "$PWD")',
				`printf '#!/bin/sh\\nexec %q %q "$@"\\n' "$ld" "$real" > ~/.cache/harness-check-bin/biome`,
			])
				expect(work, `${line}, in the check`).toContain(line);
		});
	});
}

/** What the script runs once its work is defined: the work, and its end. */
function afterTheWork(): string {
	const text = there();
	const work = defined(text, "run_check");
	if (work === undefined)
		throw new Error("check-there.sh defines no run_check");
	return text.slice(text.indexOf(work) + work.length);
}

function itsEnd(): void {
	describe("how the check there ends", () => {
		clearsAfterEach();
		// A caller acts on 3 and 75 as this script's own, so the branch's
		// code, which can exit with either, can't say them.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined)).each([
			[75, 1],
			[3, 1],
			[2, 2],
			[0, 0],
		])(
			"ends %i's work there with %i",
			async (work, code) => {
				const host = hostWith(EVERY_HOST);
				const run = await ended(
					check(host, `run_check() { return ${work}; }${afterTheWork()}`),
				);
				expect(run.code, run.err).toBe(code);
				if (code === work)
					expect(run.err, "nothing said of its code").not.toMatch(/exited/);
				else
					expect(run.err, "said why").toMatch(
						new RegExp(
							`^the check on .* exited ${work}, a code check-there keeps for its own, so it ends 1$`,
							"m",
						),
					);
			},
			TEST_MS,
		);

		// Its code is read with errexit off, which the work's own shell
		// would otherwise keep, running on past a failed step.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"stops its work at the first step that fails",
			async () => {
				const host = hostWith(EVERY_HOST);
				const run = await ended(
					check(host, `run_check() {\nfalse\necho past\n}${afterTheWork()}`),
				);
				expect(run.code, run.err).toBe(1);
				expect(run.out, "nothing past the failed step").not.toMatch(/past/);
			},
			TEST_MS,
		);

		// The turn's own 75 and 3 end the script under errexit, so errexit
		// is off only once the turn is taken, and the work never runs.
		it
			.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))
			.each([75, 3])(
			"ends with the turn's own %i, running no work",
			async (code) => {
				const host = hostWith(EVERY_HOST);
				const text = there();
				const work = defined(text, "run_check") ?? "";
				const fromTurn = text
					.slice(text.lastIndexOf("\ntake_turn\n"))
					.replace(work, "run_check() { echo ran; }");
				const run = await ended(
					check(host, `take_turn() { return ${code}; }${fromTurn}`),
				);
				expect(run.code, run.err).toBe(code);
				expect(run.out, "no work run").not.toMatch(/ran/);
				expect(run.err, "nothing said of the work's code").not.toMatch(
					/exited/,
				);
			},
			TEST_MS,
		);
	});
}

function clockWait(): void {
	describe("check-there's wait for its turn", () => {
		clearsAfterEach();
		// Tries that come back quickly, as on a host whose lock answers
		// fast, would end a wait counted in tries long before its limit.
		// Each sleeps a little, so the wait doesn't spin a core meanwhile.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"times its wait by the clock, however quickly each try comes back",
			async () => {
				const host = hostWith(EVERY_HOST);
				// The first try says when it came to the microsecond, by bash's
				// own clock where it has one, 5.0's EPOCHREALTIME, and by node
				// under bash 3.2, whose start costs a moment before the deadline
				// is set just after it. Bash's clock moves a second at a time,
				// but 5.3's not on the wall's seconds, so the wait is held to
				// what it promises on any of them: two seconds, never fewer,
				// which it keeps only by its second more, as a wait without it
				// ends short of two seconds in nearly every run.
				const node = JSON.stringify(process.execPath);
				const stub = `lock() { if [ "$1" = -n ]; then echo "first try \${EPOCHREALTIME:-$(${node} -p 'Date.now() / 1000')}" >&2; return 1; fi; sleep 0.02; return 1; }`;
				const waiter = await ended(
					check(host, `${stub}\nturn_wait_s=2\ntake_turn\necho took`),
				);
				const endedAt = Date.now();
				// In seconds, its point a comma in some locales.
				const said = /first try ([\d.,]+)/.exec(waiter.err)?.[1];
				const first =
					said === undefined
						? Number.NaN
						: Number(said.replace(",", ".")) * MS_PER_S;
				expect(first, `when its first try came: ${waiter.err}`).not.toBeNaN();
				// A wait counted in tries would end in a twentieth of a second.
				expect(
					endedAt - first,
					"it waited by the clock, never less than it says",
				).toBeGreaterThanOrEqual(2_000);
				// Its second more ends at most 3 s past its deadline, and its
				// last try takes a fiftieth of one; more would overrun it.
				expect(
					endedAt - first,
					"it gave up once its limit passed, not seconds after",
				).toBeLessThan(4_500);
				expect(waiter).toMatchObject({ code: 75, out: "" });
				expect(waiter.err, "giving up as its limit passed").toMatch(
					/gave up after 2 s waiting/,
				);
			},
			TEST_MS,
		);

		// A wait sent with a leading zero would be read as octal, where 8
		// is no digit at all.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"reads its wait in tens, whatever it opens with",
			async () => {
				const host = hostWith(EVERY_HOST);
				// Each try moves the shell's clock on a second, so the wait's
				// eight seconds pass at once; the test above times it for real.
				const waiter = await ended(
					check(
						host,
						"lock() { SECONDS=$(( SECONDS + 1 )); return 1; }\nturn_wait_s=08\ntake_turn\necho took",
					),
				);
				expect(waiter).toMatchObject({ code: 75, out: "" });
				expect(waiter.err, "its wait read as eight seconds").toMatch(
					/gave up after 8 s waiting/,
				);
			},
			TEST_MS,
		);
	});
}

/**
 * A host offering `ps` that names `name` the process that starts a
 * check, this one, as `ps -o comm= -p PID` asks, and no other.
 */
function hostNaming(name: string): string {
	const host = hostWith(EVERY_HOST);
	const ps = join(host, "bin", "ps");
	writeFileSync(
		ps,
		`#!${bashHere()}\n[ "$4" = "${process.pid}" ] && echo ${name}\nexit 0\n`,
	);
	chmodSync(ps, 0o755);
	return host;
}

function callerNamed(): void {
	describe("the caller a check runs under", () => {
		clearsAfterEach();
		// A login shell that stays between sshd and the check never goes
		// with its caller, so the check can't see a dropped link.
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"says once when it isn't sshd, so a dropped link goes unseen",
			async () => {
				const done = await ended(check(hostNaming("zsh"), "echo took"));
				expect(done).toMatchObject({ code: 0, out: "took\n" });
				expect(
					done.err.match(/started under zsh, not sshd/g),
					"said once",
				).toHaveLength(1);
			},
			TEST_MS,
		);

		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"says nothing under sshd, nor where ps can't tell",
			async () => {
				for (const host of [hostNaming("sshd-session"), hostWith(EVERY_HOST)]) {
					const done = await ended(check(host, "echo took"));
					expect(done).toMatchObject({ code: 0, out: "took\n" });
					expect(done.err, "no word of its caller").not.toMatch(
						/started under/,
					);
				}
			},
			TEST_MS,
		);
	});
}

function noLock(): void {
	describe("check-there on a host with neither flock nor perl", () => {
		clearsAfterEach();
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"fails the check rather than reading the lock as busy",
			async () => {
				const tried = await ended(
					check(hostWith(EVERY_HOST), "take_turn\necho took"),
				);
				expect(tried.code, "no lock to take, said as its own").toBe(3);
				expect(tried.out).toBe("");
				expect(tried.err).not.toMatch(/waiting its turn/);
				expect(tried.err, "what the host lacks, then what follows").toMatch(
					/has neither flock nor perl to lock with\n.*can't take .*'s check lock/,
				);
			},
			TEST_MS,
		);
	});
}

function nodeLink(): void {
	describe("the node link a check keeps", () => {
		clearsAfterEach();
		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"goes as the check ends",
			async () => {
				const host = hostWith(EVERY_HOST);
				mkdirSync(join(host, ".cache"));
				const link = join(host, ".cache", "harness-check-node.mine");
				symlinkSync(join(host, "nothing"), link);
				const done = await ended(check(host, `node_link="${link}"\necho took`));
				expect(done).toMatchObject({ code: 0, out: "took\n" });
				expect(lstatOrNull(link), "its link went with it").toBeNull();
			},
			TEST_MS,
		);

		it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
			"is taken away by the next check once its own is no longer running",
			async () => {
				const host = hostWith(EVERY_HOST);
				mkdirSync(join(host, ".cache"));
				const gone = spawnSync("true").pid;
				const dead = join(host, ".cache", `harness-check-node.${gone}`);
				const live = join(host, ".cache", `harness-check-node.${process.pid}`);
				symlinkSync(join(host, "nothing"), dead);
				symlinkSync(join(host, "nothing"), live);
				const swept = await ended(check(host, "let_go_of_dead\necho swept"));
				expect(swept).toMatchObject({ code: 0, out: "swept\n" });
				expect(lstatOrNull(dead), "a stopped check's link").toBeNull();
				expect(lstatOrNull(live), "a running check's link").not.toBeNull();
			},
			TEST_MS,
		);
	});
}

/**
 * Whether `pid` is gone within `SETTLES_IN_MS`. A process killed with
 * its parent lingers until whoever adopts it reaps it, and nothing says
 * when that is, so it is asked again every 50 ms.
 */
async function goneWithin(pid: number): Promise<boolean> {
	const until = Date.now() + SETTLES_IN_MS;
	while (Date.now() < until) {
		try {
			process.kill(pid, 0);
		} catch {
			// No such process: it is gone.
			return true;
		}
		// Nothing says when its reaper reaps it, so the poll waits a while.
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return false;
}

/** Kill `pid` if it is still there, as a test that failed may leave it. */
function killIfThere(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone: nothing left to stop.
	}
}

/** A link's own status, or null when there is none to read. */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
	try {
		return lstatSync(path);
	} catch {
		// Nothing at that path: that is the answer.
		return null;
	}
}

/**
 * The local half as it runs, through an ssh that only writes down what
 * it was given: one word a line, in `ssh.args` beside the stand-in.
 */
function sendFrom(
	args: readonly string[],
	wait?: string,
	session?: string,
): {
	readonly code: number | null;
	readonly err: string;
	readonly sent: readonly string[] | null;
	readonly root: string;
} {
	const bash = onPath("bash");
	if (bash === undefined) throw new Error("no bash here");
	const root = mkdtempSync(join(tmpdir(), "check-there-send-"));
	made.push(root);
	const bin = join(root, "bin");
	mkdirSync(bin);
	const record = join(root, "ssh.args");
	writeFileSync(
		join(bin, "ssh"),
		`#!${bash}\nprintf '%s\\n' "$@" > "${record}"\n`,
		{ mode: 0o755 },
	);
	const ran = spawnSync(bash, [SCRIPT, ...args], {
		cwd: root,
		env: {
			PATH: bin,
			HOME: root,
			...(wait === undefined ? {} : { CHECK_THERE_WAIT_S: wait }),
			...(session === undefined ? {} : { PI_SESSION_ID: session }),
		},
		encoding: "utf8",
		timeout: SETTLES_IN_MS,
	});
	const sent = existsSync(record)
		? readFileSync(record, "utf8").replace(/\n$/, "").split("\n")
		: null;
	return { code: ran.status, err: ran.stderr, sent, root };
}

function localHalf(): void {
	describe("the check's local half", () => {
		clearsAfterEach();
		// Penelope logs in to bash and the Mac to zsh, and each reads the line.
		for (const shell of ["bash", "zsh"] as const) {
			it.runIf(onPath(shell) !== undefined)(
				`sends a branch that ${shell}, as the host's shell, reads back as one word, with the wait last`,
				() => {
					const branch = "jitsusama/fix-1.2_b+c@d";
					const sent = sendFrom([branch, "there"], "60");
					expect(sent.code, sent.err).toBe(0);
					// A connection of its own: a shared master's sshd would outlive
					// its ssh, and the check would never see its caller go.
					expect(sent.sent?.slice(0, -1)).toEqual([
						"-o",
						"BatchMode=yes",
						"-o",
						"ControlMaster=no",
						"-o",
						"ControlPath=none",
						// A host asleep, or a link silent mid-check, ends it after
						// five minutes rather than when TCP gives up.
						"-o",
						"ConnectTimeout=30",
						"-o",
						"ServerAliveInterval=15",
						"-o",
						"ServerAliveCountMax=20",
						"there",
					]);
					const line = sent.sent?.at(-1) ?? "";
					expect(line, "the host's command").toMatch(/^bash -s -- .* 60$/);
					// The host's shell reads the line again: its words, one a line.
					const words = spawnSync(
						onPath(shell) ?? shell,
						[
							...(shell === "zsh" ? ["-f"] : []),
							"-c",
							line.replace(/^bash -s -- /, "printf '%s\\n' "),
						],
						{ cwd: sent.root, encoding: "utf8" },
					);
					expect(words.stdout, words.stderr).toBe(`${branch}\n60\n`);
				},
			);
		}

		// git lets a branch hold `;` and `$(`, which the host's login shell,
		// bash or zsh, would read again; a check's branch never needs them.
		it.each(["a;touch x$(id)", "a b", "-oops", "a`id`", "a\\b"])(
			"refuses a branch the host's shell would read as more than a name, %s, reaching no host",
			(branch) => {
				const sent = sendFrom([branch, "there"]);
				expect(sent.code).toBe(2);
				expect(sent.err).toMatch(/names no branch a check can take/);
				expect(sent.sent, "no ssh").toBeNull();
			},
		);

		// Past 160 characters its holder's line would read to every waiter
		// as not in its shape, so the branch is refused before any host.
		it("refuses a branch past 160 characters, reaching no host", () => {
			const fits = sendFrom(["b".repeat(160), "there"]);
			expect(fits.code, fits.err).toBe(0);
			const sent = sendFrom(["b".repeat(161), "there"]);
			expect(sent.code).toBe(2);
			expect(sent.err).toMatch(/^check-there: .* is past 160 characters/m);
			expect(sent.sent, "no ssh").toBeNull();
		});

		// An empty setting reads as none, as `:-` reads it.
		it("waits its default when the wait is set empty", () => {
			const sent = sendFrom(["feature", "there"], "");
			expect(sent.code, sent.err).toBe(0);
			expect(sent.sent?.at(-1), "ninety minutes").toMatch(/ 5400$/);
		});

		// A host but penelope runs the check as an account holding Joel's
		// credentials, outside any agent fence, so a check run under pi goes
		// to penelope alone until one runs it fenced or under an account of
		// its own (ISXEG8). A name holding penelope's is another host.
		it.each([
			"equilibrius",
			"joel@there",
			"192.168.4.49",
			"penelope.local",
			"notpenelope",
		])(
			"sends a check run under pi to no host but penelope, %s, naming penelope",
			(host) => {
				const sent = sendFrom(["feature", host], undefined, "a-session");
				expect(sent.code, "refused").toBe(2);
				expect(sent.err, "saying where it may go").toMatch(
					/a check run under pi \(PI_SESSION_ID is set\) goes only to the host named penelope/,
				);
				expect(sent.err, "and what it would do instead").toContain(
					"pnpm check:there feature penelope",
				);
				expect(sent.sent, "no ssh").toBeNull();
			},
		);

		it.each([[["feature"]], [["feature", "penelope"]]])(
			"sends a check run under pi to penelope, named or not, %j",
			(args) => {
				const sent = sendFrom(args, undefined, "a-session");
				expect(sent.code, sent.err).toBe(0);
				expect(sent.sent?.at(-2), "to penelope").toBe("penelope");
			},
		);

		// A wait is at most seven digits, over a hundred days, so no wait is
		// mistyped into one that never ends.
		// A leading zero would be read there as octal: 0100 as 64 s, 0900 as
		// no number at all.
		it.each(["abc", "12345678", "0900", "08"])(
			"refuses a wait that isn't a number of seconds under ten million, '%s', reaching no host",
			(wait) => {
				const sent = sendFrom(["feature", "there"], wait);
				expect(sent.code).toBe(2);
				expect(sent.err).toContain(`CHECK_THERE_WAIT_S is '${wait}'`);
				expect(sent.sent, "no ssh").toBeNull();
			},
		);

		// A dash opens one of ssh's options; older ssh puts the name into a
		// ProxyCommand's shell line as it stands.
		it.each([
			"-oProxyCommand=touch pwned",
			"x@-esh",
			"there;touch x",
			"there$(id)",
		])(
			"refuses a host ssh would read as more than a name, %s, reaching none",
			(host) => {
				const sent = sendFrom(["feature", host]);
				expect(sent.code).toBe(2);
				expect(sent.err).toMatch(/names no host/);
				expect(sent.sent, "no ssh").toBeNull();
			},
		);

		it.each(["joel@there", "there.local", "192.168.4.49", "my-host"])(
			"sends to a host named in plain words, %s",
			(host) => {
				const sent = sendFrom(["feature", host], "9999999");
				expect(sent.code, sent.err).toBe(0);
				expect(sent.sent?.at(-2), "the host, as named").toBe(host);
				expect(sent.sent?.at(-1), "with the longest wait there is").toMatch(
					/ 9999999$/,
				);
			},
		);

		it("sends a wait of none, a zero alone", () => {
			const sent = sendFrom(["feature", "there"], "0");
			expect(sent.code, sent.err).toBe(0);
			expect(sent.sent?.at(-1), "with no wait").toMatch(/ 0$/);
		});
	});
}

// What runs on the host can't run here without its clone and its ssh, so
// its shape is read instead: the check's own work, from the fetch to the
// last test, is one function run `alone`, which the turns above show
// runs without fd 9 and stops whole.
/**
 * The script's lines as its shell runs them at the top, by their place,
 * with those inside a function's body, or opening or closing one, left
 * undefined: those run only once called.
 */
function topLevel(lines: readonly string[]): (string | undefined)[] {
	let inside = false;
	return lines.map((line) => {
		if (/^\w+\(\) \{$/.test(line)) inside = true;
		const top = inside ? undefined : line;
		if (line === "}") inside = false;
		return top;
	});
}

function workThere(): void {
	describe("the check's work on its host", () => {
		const lines = there().split("\n");

		// The checks here bring their own order and stdin, so the script's own
		// are read: job control and the stops set before its first job, and
		// every job launched with neither fd 9 nor the script's stdin.
		it("sets its job control and its stops before its first job, launched bare", () => {
			const top = topLevel(lines);
			const firstJob = top.findIndex(
				(line) =>
					line !== undefined &&
					!line.trimStart().startsWith("#") &&
					(/(^|[\s!])alone\s/.test(line) || /&\s*$/.test(line)),
			);
			expect(firstJob, "a first job").toBeGreaterThan(-1);
			for (const line of SETTINGS) {
				const at = top.indexOf(line);
				expect(at, `${line}, run`).toBeGreaterThan(-1);
				expect(at, `${line}, before its first job`).toBeLessThan(firstJob);
			}
			expect(
				lines.filter(
					(line) => line.includes('"$@"') && line.trim().endsWith("&"),
				),
				"alone's one launch",
			).toEqual(['  "$@" 9>&- </dev/null &']);
		});

		// The checks here define every function before any setting, so the
		// script's own order is read where it matters: a function a setting
		// calls or a trap names, and every one that one calls in turn, is
		// defined first, or a signal meanwhile runs nothing; the caller is
		// known before it is asked after; and what a stop reads is cleared
		// before a trap can run one. What it was sent, read before its
		// turn, is held the same way.
		it("defines what each setting calls first, knows its caller and clears what its stops read before they can run, and reads what it was sent before its turn", () => {
			const top = topLevel(lines);
			const at = (line: string): number => top.indexOf(line);
			const traps = SETTINGS.filter((line) => line.startsWith("trap "));
			const text = there();
			const functions = functionsIn(text);
			const reached = (name: string): Set<string> => reachedFrom(text, name);
			expect(reached("stop_all"), "what a stop calls, followed").toContain(
				"end_groups",
			);
			for (const line of SETTINGS) {
				const name = line.startsWith("trap ")
					? (/^trap '?(\w+)/.exec(line)?.[1] ?? "")
					: (line.split(" ")[0] ?? "");
				if (!functions.includes(name)) continue;
				for (const called of reached(name))
					expect(
						lines.indexOf(`${called}() {`),
						`${called}, defined before ${line}`,
					).toBeLessThan(at(line));
			}
			expect(traps.length, "traps named").toBeGreaterThan(0);
			for (const line of ["note_caller", "trap caller_gone PIPE"])
				expect(
					at("caller=$PPID"),
					`its caller, known before ${line}`,
				).toBeLessThan(at(line));
			for (const line of traps)
				expect(
					at(CLEARED),
					`what its stops read, cleared before ${line}`,
				).toBeLessThan(at(line));
			const turn = top.indexOf("take_turn");
			expect(turn, "its turn, taken").toBeGreaterThan(-1);
			for (const sent of [
				'branch="$1"',
				'turn_wait_s="$2"',
				"turn=~/.cache/harness-check.lock",
				'exec 9> "$turn"',
			]) {
				const read = top.indexOf(sent);
				expect(read, `${sent}, read`).toBeGreaterThan(-1);
				expect(read, `${sent}, before its turn`).toBeLessThan(turn);
			}
		});

		// A name a stop reads, left out of that line, would be read as
		// whatever the host's shell exports; only its own locals and what
		// bash sets itself are its own.
		it("clears every name its stops read before it sets them", () => {
			const text = there();
			const cleared = CLEARED.split(" ").map((word) =>
				word.replace(/[=]$/, ""),
			);
			const stopping = stoppingIn(text);
			expect(stopping, "what its traps run, followed").toEqual(
				expect.arrayContaining([
					"let_go",
					"caller_gone",
					"stop_all",
					"end_groups",
					"gone_within",
				]),
			);
			const read = stopping.flatMap((name) => {
				const body = defined(text, name);
				expect(body, `check-there.sh defines ${name}`).toBeDefined();
				const locals = [...(body ?? "").matchAll(/^\s*local ([^\n]*)$/gm)]
					.flatMap((found) => (found[1] ?? "").split(/\s+/))
					.map((word) => word.replace(/[=].*$/, ""));
				return [...(body ?? "").matchAll(/\$\{?([A-Za-z_]\w*)/g)]
					.map((found) => found[1] ?? "")
					.filter((read) => read !== "SECONDS" && !locals.includes(read));
			});
			expect(read.length, "names its stops read").toBeGreaterThan(0);
			expect(
				[...new Set(read)].filter((name) => !cleared.includes(name ?? "")),
				"read by a stop, never cleared",
			).toEqual([]);
		});

		// A Mac sleeps on no one's touch, however hard it works, and its
		// sshd holds it awake for none of it.
		it("holds a Mac awake from before its turn for as long as it lives", () => {
			const top = topLevel(lines);
			const awake = top.findIndex((line) =>
				/^ {2}caffeinate -i -w "\$\$" .*&$/.test(line ?? ""),
			);
			expect(awake, "held awake while this shell lives").toBeGreaterThan(-1);
			expect(top[awake - 1], "where a host has it to hold").toBe(
				"if command -v caffeinate >/dev/null 2>&1; then",
			);
			expect(awake, "before its turn, waited for or not").toBeLessThan(
				top.indexOf("take_turn"),
			);
			const build = top.findIndex((line) => line?.includes("nix build"));
			expect(build, "the node build it holds awake").toBeGreaterThan(-1);
			expect(
				awake,
				"before node is built, which can take minutes",
			).toBeLessThan(build);
		});

		// Under errexit and pipefail, an ls matching nothing ends the check
		// at its own line, before the one saying what was missing.
		it("finds what it runs by globs, never by an ls in a pipe", () => {
			expect(
				lines.filter((line) => /\$\(ls\b[^)]*\|/.test(line)),
				"an ls piped on, whose match of none would end it unsaid",
			).toEqual([]);
		});

		it("runs alone, from its turn to its end", () => {
			const after = lines
				.slice(lines.indexOf("take_turn") + 1)
				.filter((line) => line.trim() !== "" && !line.startsWith("#"));
			expect(after[0], "the work opens as its turn is taken").toBe(
				"run_check() {",
			);
			expect(
				after.filter((line) => /(^|\s)alone\s/.test(line)),
				"run once its function closes, as the stops above stop it",
			).toEqual(["alone with_errexit run_check"]);
			expect(
				after.indexOf("alone with_errexit run_check"),
				"after its function",
			).toBeGreaterThan(after.indexOf("}"));
			expect(
				after.filter((line) => line.startsWith("}") || line.endsWith("{")),
				"one function, holding all of it",
			).toEqual(["run_check() {", "}"]);
		});

		// A stop during the build would otherwise wait for nix to finish.
		it("builds its node as a job a stop reaches", () => {
			const build = lines.filter((line) => line.includes("nix build"));
			expect(build, "one build of node").toHaveLength(1);
			expect(build[0], "run alone, with no substitution around it").toMatch(
				/^\s*if ! alone nix build /,
			);
		});

		it("sweeps dead checks' node links before finding its own", () => {
			const sweep = lines.indexOf("let_go_of_dead");
			expect(sweep, "the sweep is run").toBeGreaterThan(-1);
			expect(sweep, "before its node is looked for").toBeLessThan(
				lines.indexOf("if ! command -v node >/dev/null 2>&1; then"),
			);
		});
	});
}
