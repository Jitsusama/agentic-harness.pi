/**
 * check-there.sh's turn-taking, as the host it runs on takes it: the
 * script's own `lock` and `take_turn`, read out of it and run by bash
 * against one lock file, once with util-linux's flock and once with only
 * perl on the PATH, as on a Mac. A check that holds the lock keeps every
 * other waiting until its shell closes the file, or until the wait's
 * limit passes, and a lock that can't be tried at all fails the check
 * rather than reading as a busy one.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, onTestFinished } from "vitest";

const SCRIPT = join(
	import.meta.dirname,
	"..",
	"..",
	"scripts",
	"check-there.sh",
);
/** How long a check is given to start, take its turn or end. */
const SETTLES_IN_MS = 10_000;
/** How long a test is given: several of its checks settling in turn. */
const TEST_MS = 4 * SETTLES_IN_MS;

/** What the script runs on its host, between its `THERE` lines. */
function there(): string {
	const text = readFileSync(SCRIPT, "utf8");
	return /<<'THERE'\n([\s\S]*?)\nTHERE\n/.exec(text)?.[1] ?? "";
}

/** The lines the script runs as they stand, which the checks here run too. */
const SETTINGS = [
	"set -m",
	"trap let_go EXIT",
	"trap 'stop_all 143' TERM",
	"trap 'stop_all 130' INT",
	"trap 'stop_all 129' HUP",
] as const;

/**
 * The script's own turn-taking, as it defines it: its functions, then
 * its job control and the traps it sets, so a check here ends and stops
 * as one there does.
 */
function turnTaking(): string {
	const text = there();
	const functions = [
		"let_go",
		"gone_within",
		"end_groups",
		"stop_all",
		"alone",
		"let_go_of_dead",
		"lock",
		"take_turn",
	].map((name) => {
		const found = new RegExp(
			`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`,
			"m",
		).exec(text);
		if (found === null) throw new Error(`check-there.sh defines no ${name}`);
		return found[0];
	});
	const settings = SETTINGS.map((line) => {
		if (!text.split("\n").includes(line))
			throw new Error(`check-there.sh never runs ${line}`);
		return line;
	});
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
afterEach(() => {
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

/**
 * A check's shell: the turn-taking, then `body`, on the host's PATH with
 * the host's folder as its home. It leads a process group of its own, as
 * a shell ssh starts does, so a stop it sends its group reaches only it.
 */
function check(host: string, body: string, fd9 = true): ChildProcess {
	const bash = onPath("bash");
	if (bash === undefined) throw new Error("no bash here");
	const turn = `turn="${join(host, "lock")}"\n`;
	// Without fd9 the descriptor is closed outright, whatever node left open.
	const opening = fd9 ? `${turn}exec 9> "$turn"\n` : `${turn}exec 9>&-\n`;
	const child = spawn(
		bash,
		["-c", `set -euo pipefail\n${turnTaking()}\n${opening}${body}`],
		{
			env: { PATH: join(host, "bin"), HOME: host },
			stdio: ["pipe", "pipe", "pipe"],
			detached: true,
		},
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

/** What every host offers a check beside its lock. */
const EVERY_HOST = ["hostname", "cat", "date", "rm", "sleep"] as const;

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
			const sofar = heard(waiter);
			const waited = ended(waiter);
			const said = await complains(waiter, /waiting its turn/);
			expect(said, "whose turn it is").toMatch(
				/\(feature, pid \d+, from \w{3} \d\d:\d\d\); waiting its turn/,
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
				"later, pid 1, from Sun 00:00\n",
			);
			const waiter = await waited;
			expect(
				Date.now() - asked,
				"it waited its limit before giving up",
			).toBeGreaterThanOrEqual(1_900);
			expect(waiter).toMatchObject({ code: 75, out: "" });
			expect(waiter.err, "naming who holds the turn as it gives up").toMatch(
				/gave up after 2 s waiting for .*'s check lock, held by \(later, pid 1, from Sun 00:00\)/,
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
				onTestFinished(() => {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already gone: nothing left to stop.
					}
				});
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
			expect((await stopped).code, "it ends as signalled").toBe(143);
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
			expect((await stopped).code, "it ends as signalled").toBe(143);
			expect(
				Date.now() - asked,
				"having waited its limit for the work",
			).toBeGreaterThanOrEqual(900);
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
			const left = Number(first.out.trim());
			onTestFinished(() => killIfThere(left));
			expect(await goneWithin(left), "what its work left, ended with it").toBe(
				true,
			);
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
					"}",
					"stop_wait_s=3",
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
			// alone asks after its job each second, then gives what it left
			// three seconds: 1.5 s lands the stop inside that wait.
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			holder.kill("SIGTERM");
			expect((await stopped).code, "it ends as signalled").toBe(143);
			expect(
				await goneWithin(left),
				"what its work left, ended before its turn passed",
			).toBe(true);
		},
		TEST_MS,
	);

	// Without a group of the work's own, a stop would signal nothing and
	// read the work as gone while it ran on in the shared worktree.
	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"refuses to run work no stop could reach, ending it",
		async () => {
			const host = hostWith(tools);
			// The sleep keeps the shell's output: an end waits for it unless
			// it is ended too.
			const refused = await ended(
				check(host, "set +m\ntake_turn\nalone sleep 30\necho ran"),
			);
			expect(refused.code, "the check fails").toBe(1);
			expect(refused.out, "going no further").toBe("");
			expect(refused.err, "saying why").toMatch(/no process group of its own/);
			// A job that ends at once is refused as surely, before it runs.
			const quick = await ended(
				check(host, 'set +m\ntake_turn\nalone touch "$HOME/ran"'),
			);
			expect(quick.code, "a quick one fails too").toBe(1);
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

	it.runIf(tools.every((tool) => onPath(tool) !== undefined))(
		"fails a check whose lock can't be tried, rather than reading it as busy",
		async () => {
			const host = hostWith(tools);
			const tried = await ended(check(host, "take_turn\necho took", false));
			expect(tried.code, "a lock never tried").not.toBe(0);
			expect(tried.out).toBe("");
			expect(tried.err).not.toMatch(/waiting its turn/);
			expect(tried.err, "why it couldn't").toMatch(/Bad file descriptor/);
			expect(tried.err).toMatch(/can't take/);
		},
		TEST_MS,
	);
});

describe("check-there on a host with neither flock nor perl", () => {
	it.runIf(EVERY_HOST.every((tool) => onPath(tool) !== undefined))(
		"fails the check rather than reading the lock as busy",
		async () => {
			const tried = await ended(
				check(hostWith(EVERY_HOST), "take_turn\necho took"),
			);
			expect(tried.code, "no lock to take").not.toBe(0);
			expect(tried.out).toBe("");
			expect(tried.err).not.toMatch(/waiting its turn/);
			expect(tried.err).toMatch(/can't take/);
		},
		TEST_MS,
	);
});

describe("the node link a check keeps", () => {
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
		},
		encoding: "utf8",
		timeout: SETTLES_IN_MS,
	});
	const sent = existsSync(record)
		? readFileSync(record, "utf8").replace(/\n$/, "").split("\n")
		: null;
	return { code: ran.status, err: ran.stderr, sent, root };
}

describe("the check's local half", () => {
	it("sends a branch the host's shell reads back as one word, with the wait last", () => {
		const branch = "jitsusama/fix-1.2_b+c@d";
		const sent = sendFrom([branch, "there"], "60");
		expect(sent.code, sent.err).toBe(0);
		expect(sent.sent?.slice(0, 3)).toEqual(["-o", "BatchMode=yes", "there"]);
		const line = sent.sent?.[3] ?? "";
		expect(line, "the host's command").toMatch(/^bash -s -- .* 60$/);
		// The host's shell reads the line again: its words, printed one a line.
		const bash = onPath("bash") ?? "bash";
		const words = spawnSync(
			bash,
			["-c", line.replace(/^bash -s -- /, "printf '%s\\n' ")],
			{ cwd: sent.root, encoding: "utf8" },
		);
		expect(words.stdout).toBe(`${branch}\n60\n`);
	});

	// git lets a branch hold `;` and `$(`, which the host's login shell,
	// bash or zsh, would read again; a check's branch never needs them.
	it.each(["a;touch x$(id)", "a b", "-oops", "a`id`", "a\\b"])(
		"refuses a branch the host's shell would read as more than a name, %s, reaching no host",
		(branch) => {
			const sent = sendFrom([branch, "there"]);
			expect(sent.code).toBe(2);
			expect(sent.err).toMatch(/names no branch a check can take/);
			expect(sent.sent, "no ssh").toBeNull();
			expect(
				readdirSync(sent.root).filter((name) => name.startsWith("x")),
				"nothing in the branch ran",
			).toEqual([]);
		},
	);

	// A wait is at most seven digits, over a hundred days, so no wait is
	// mistyped into one that never ends.
	it.each(["abc", "12345678"])(
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
			expect(sent.sent?.[2], "the host, as named").toBe(host);
			expect(sent.sent?.[3], "with the longest wait there is").toMatch(
				/ 9999999$/,
			);
		},
	);
});

// What runs on the host can't run here without its clone and its ssh, so
// its shape is read instead: the check's own work, from the fetch to the
// last test, is one function run `alone`, which the turns above show
// runs without fd 9 and stops whole.
describe("the check's work on its host", () => {
	const lines = there().split("\n");

	it("runs alone, from its turn to its end", () => {
		const after = lines
			.slice(lines.indexOf("take_turn") + 1)
			.filter((line) => line.trim() !== "" && !line.startsWith("#"));
		expect(after[0], "the work opens as its turn is taken").toBe(
			"run_check() {",
		);
		expect(after.at(-2), "and closes once").toBe("}");
		expect(after.at(-1), "run as the stops above stop it").toBe(
			"alone run_check",
		);
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
