/**
 * Putting a tree through its typecheck and the tests its changes reach
 * before a reload: reading what tsc and vitest say, stopping at the
 * first check that fails or once whoever asked stops, and running
 * stand-ins for both through the same pipes.
 */

import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkTree,
	commandRunner,
	describeTree,
	MOST_LINE_CHARS,
	MOST_NAMED,
	type Ran,
	type Runner,
	runCommand,
	TREE_STEP_TIMEOUT_MS,
	testReport,
	typeErrors,
} from "../../../../lib/internal/reload/tree-check.ts";

let tree: string;

beforeEach(() => {
	tree = mkdtempSync(join(tmpdir(), "tree-check-"));
});

afterEach(() => {
	rmSync(tree, { recursive: true, force: true });
});

/** Put a program in the tree's node_modules/.bin, saying `body` as sh. */
function install(name: string, body = "exit 0"): void {
	const bin = join(tree, "node_modules", ".bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
	chmodSync(join(bin, name), 0o755);
}

/** vitest's JSON report, holding the files given. */
function vitestJson(files: readonly object[], passed: number): string {
	return JSON.stringify({ numPassedTests: passed, testResults: files });
}

/** The file vitest writes its report to, from the arguments it was given. */
function outputFile(args: readonly string[]): string {
	const flag = args.find((arg) => arg.startsWith("--outputFile="));
	if (flag === undefined) throw new Error("vitest was given no output file");
	return flag.slice("--outputFile=".length);
}

/** One command a runner was asked to run. */
interface Asked {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly timeoutMs: number;
	readonly signal: AbortSignal | undefined;
}

/** How each stand-in program ends. */
interface Ends {
	readonly tsc?: Partial<Ran> & { during?: () => void };
	readonly vitest?: Partial<Ran> & { report?: string };
	readonly git?: Partial<Ran>;
}

/** A runner whose tsc, vitest and git end as told, recording what ran. */
function standIn(ends: Ends = {}): { run: Runner; asked: Asked[] } {
	const asked: Asked[] = [];
	const run: Runner = (command, args, cwd, env, timeoutMs, signal) => {
		asked.push({ command, args, cwd, env, timeoutMs, signal });
		const end = { code: 0, stdout: "", stderr: "", hung: false };
		if (command === "git") return Promise.resolve({ ...end, ...ends.git });
		if (command.endsWith("tsc")) {
			ends.tsc?.during?.();
			return Promise.resolve({ ...end, ...ends.tsc });
		}
		if (ends.vitest?.report !== undefined) {
			writeFileSync(outputFile(args), ends.vitest.report);
		}
		return Promise.resolve({ ...end, ...ends.vitest });
	};
	return { run, asked };
}

/** The programs each asked command ran, by name. */
function names(asked: readonly Asked[]): string[] {
	return asked.map(({ command }) => command.split("/").at(-1) ?? command);
}

describe("reading what the checks said", () => {
	it("names each type error by file, line and code", () => {
		expect(
			typeErrors(
				[
					"lib/a.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
					"  The expected type comes from property 'n'",
					"tests/b.test.ts(3,1): error TS2304: Cannot find name 'x'.",
				].join("\n"),
			),
		).toEqual([
			"lib/a.ts:12: TS2322 Type 'string' is not assignable to type 'number'.",
			"tests/b.test.ts:3: TS2304 Cannot find name 'x'.",
		]);
	});

	it("reads the line TypeScript 7's tsc prints into a pipe", () => {
		// What tsc 7.0.2 printed for `const a: number = "x"`, piped, on 25
		// November: the classic form, with no colour and no pretty frame.
		expect(
			typeErrors(
				"a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
			),
		).toEqual([
			"a.ts:1: TS2322 Type 'string' is not assignable to type 'number'.",
		]);
	});

	it("names each failing test with its first cause, and a file that failed with none", () => {
		const report = vitestJson(
			[
				{
					name: join(tree, "tests/a.test.ts"),
					status: "failed",
					message: "",
					assertionResults: [
						{ fullName: "a works", status: "passed", failureMessages: [] },
						{
							fullName: "a refuses b",
							status: "failed",
							failureMessages: [
								"\nAssertionError: expected 1 to be 2\n    at a.test.ts:9",
							],
						},
					],
				},
				{
					name: join(tree, "tests/c.test.ts"),
					status: "failed",
					message: "Cannot find module './gone.ts'\nRequire stack:",
					assertionResults: [],
				},
			],
			1,
		);
		expect(testReport(report, tree)).toEqual({
			failures: [
				"tests/a.test.ts > a refuses b: AssertionError: expected 1 to be 2",
				"tests/c.test.ts: Cannot find module './gone.ts'",
			],
			passed: 1,
		});
	});

	it("reads the report vitest writes when the change reaches no test", () => {
		// vitest 4.1.10's report for `run --changed` reaching nothing, as
		// written on 25 November, cut to the fields it is read by and beside.
		const empty = JSON.stringify({
			numTotalTestSuites: 0,
			numPassedTestSuites: 0,
			numFailedTestSuites: 0,
			numTotalTests: 0,
			numPassedTests: 0,
			numFailedTests: 0,
			testResults: [],
			success: true,
		});
		expect(testReport(empty, tree)).toEqual({ failures: [], passed: 0 });
	});

	it("reads nothing from a report cut short", () => {
		expect(testReport('{"numPassedTests":', tree)).toBeUndefined();
		expect(testReport("{}", tree)).toBeUndefined();
	});
});

describe("putting a tree through its checks", () => {
	it("passes a tree whose typecheck and changed tests pass, running them in order in the tree, apart from the session", async () => {
		install("tsc");
		install("vitest");
		const { run, asked } = standIn({ vitest: { report: vitestJson([], 7) } });
		const steps: [string, number][] = [];
		const report = await checkTree(tree, {
			run,
			onStep: (step, budgetMs) => steps.push([step, budgetMs]),
		});
		expect(report.ok).toBe(true);
		expect(steps).toEqual([
			["typecheck", TREE_STEP_TIMEOUT_MS.typecheck],
			["tests", TREE_STEP_TIMEOUT_MS.tests],
		]);
		expect(names(asked)).toEqual(["tsc", "git", "vitest"]);
		const [tsc, git, vitest] = asked;
		expect(tsc?.command).toBe(join(tree, "node_modules/.bin/tsc"));
		expect(tsc?.args).toEqual(["--noEmit"]);
		expect(tsc?.timeoutMs).toBe(TREE_STEP_TIMEOUT_MS.typecheck);
		expect(git?.args).toEqual([
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/main^{commit}",
		]);
		expect(vitest?.command).toBe(join(tree, "node_modules/.bin/vitest"));
		expect(vitest?.args.slice(0, 5)).toEqual([
			"run",
			"--changed",
			"origin/main",
			"--passWithNoTests",
			"--reporter=json",
		]);
		expect(outputFile(vitest?.args ?? [])).toMatch(/tests\.json$/);
		expect(vitest?.timeoutMs).toBe(TREE_STEP_TIMEOUT_MS.tests);
		for (const { cwd, env } of asked) {
			expect(cwd).toBe(tree);
			expect(env.PI_OFFLINE).toBe("1");
			expect(env.XDG_STATE_HOME).toMatch(/tree-check-sandbox-[^/]+\/state$/);
			expect(env.XDG_RUNTIME_DIR).toMatch(/tree-check-sandbox-[^/]+\/runtime$/);
		}
		expect(describeTree(report, "~/t")).toBe(
			"~/t passes its typecheck and the 7 tests its changes reach.",
		);
	});

	it("gives every step the one budget it is handed in place of its own", async () => {
		install("tsc");
		install("vitest");
		const { run, asked } = standIn({ vitest: { report: vitestJson([], 1) } });
		await checkTree(tree, { run, timeoutMs: 1234 });
		expect(asked.map(({ timeoutMs }) => timeoutMs)).toEqual([1234, 1234, 1234]);
	});

	it("stops at a failing typecheck, naming its errors, before any test runs", async () => {
		install("tsc");
		install("vitest");
		const { run, asked } = standIn({
			tsc: {
				code: 2,
				stdout: "lib/a.ts(1,1): error TS2304: Cannot find name 'x'.\n",
			},
		});
		const report = await checkTree(tree, { run });
		expect(report.ok).toBe(false);
		expect(names(asked)).toEqual(["tsc"]);
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. Its typecheck failed:\n- lib/a.ts:1: TS2304 Cannot find name 'x'.",
		);
	});

	it("says a typecheck cut off by its budget was, though it named errors first", async () => {
		install("tsc");
		const { run } = standIn({
			tsc: {
				code: null,
				hung: true,
				stdout: "lib/a.ts(1,1): error TS2304: Cannot find name 'x'.\n",
			},
		});
		expect(
			describeTree(await checkTree(tree, { run, timeoutMs: 2000 }), "~/t"),
		).toBe(
			"~/t fails a check. Its typecheck failed: it was still running after 2s.\n- lib/a.ts:1: TS2304 Cannot find name 'x'.",
		);
	});

	it("refuses a tree with no origin/main to measure its change against, running no test", async () => {
		install("tsc");
		install("vitest");
		const { run, asked } = standIn({ git: { code: 1 } });
		const report = await checkTree(tree, { run });
		expect(names(asked)).toEqual(["tsc", "git"]);
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed: it has no origin/main to measure its change against, so fetch origin in it.",
		);
	});

	it("says why git couldn't tell whether it has origin/main, rather than telling it to fetch", async () => {
		install("tsc");
		install("vitest");
		const endings: Partial<Ran>[] = [
			{ code: 128, stderr: "fatal: not a git repository\n" },
			{ code: null, hung: true },
			{ code: null, stopped: true },
			{ code: null, unstarted: "spawn git ENOENT" },
		];
		const said = await Promise.all(
			endings.map(async (git) => {
				const { run, asked } = standIn({ git });
				const report = await checkTree(tree, { run });
				expect(names(asked)).toEqual(["tsc", "git"]);
				return describeTree(report, "~/t");
			}),
		);
		const lead =
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed: git could not say whether it has origin/main: ";
		expect(said).toEqual([
			`${lead}it exited with 128: fatal: not a git repository.`,
			`${lead}it was still running after 60s.`,
			`${lead}it was stopped before it finished.`,
			`${lead}it could not start: spawn git ENOENT.`,
		]);
	});

	it("hands whoever asked's signal to every command it runs", async () => {
		install("tsc");
		install("vitest");
		const stop = new AbortController();
		const { run, asked } = standIn({
			vitest: { report: vitestJson([], 1) },
		});
		await checkTree(tree, { run, signal: stop.signal });
		expect(names(asked)).toEqual(["tsc", "git", "vitest"]);
		for (const { signal } of asked) expect(signal).toBe(stop.signal);
	});

	it("cuts a failure or problem past its length, since the tree's own words go to the model", async () => {
		install("tsc");
		const long = "x".repeat(MOST_LINE_CHARS + 50);
		const { run } = standIn({
			tsc: {
				code: 2,
				stdout: `lib/a.ts(1,1): error TS2304: ${long}\n`,
			},
		});
		const [, named] = describeTree(await checkTree(tree, { run }), "~/t").split(
			"\n",
		);
		expect(named).toBe(
			`- ${`lib/a.ts:1: TS2304 ${long}`.slice(0, MOST_LINE_CHARS)} [cut]`,
		);
		const { run: unstartable } = standIn({
			tsc: { code: null, unstarted: long },
		});
		expect(
			describeTree(await checkTree(tree, { run: unstartable }), "~/t"),
		).toBe(
			`~/t fails a check. Its typecheck failed: ${`it could not start: ${long}`.slice(0, MOST_LINE_CHARS)} [cut].`,
		);
	});

	it("refuses a tree whose changed tests fail, naming the first of them and counting the rest", async () => {
		install("tsc");
		install("vitest");
		const failing = Array.from({ length: MOST_NAMED + 2 }, (_, n) => ({
			fullName: `case ${n}`,
			status: "failed",
			failureMessages: ["Error: no"],
		}));
		const { run } = standIn({
			vitest: {
				code: 1,
				report: vitestJson(
					[
						{
							name: join(tree, "tests/x.test.ts"),
							status: "failed",
							assertionResults: failing,
						},
					],
					3,
				),
			},
		});
		const said = describeTree(await checkTree(tree, { run }), "~/t");
		expect(said.split("\n")).toEqual([
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed:",
			...failing
				.slice(0, MOST_NAMED)
				.map(({ fullName }) => `- tests/x.test.ts > ${fullName}: Error: no`),
			"- and 2 more",
		]);
	});

	it("can't pass a tree whose tests ended without a report, or failed with none named", async () => {
		install("tsc");
		install("vitest");
		const silent = standIn({
			vitest: { code: 1, stderr: "Loading config\nError: config broke\n" },
		});
		expect(describeTree(await checkTree(tree, silent), "~/t")).toBe(
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed: it exited with 1: Error: config broke.",
		);
		const unnamed = standIn({
			vitest: { code: 1, report: vitestJson([], 4) },
		});
		expect(describeTree(await checkTree(tree, unnamed), "~/t")).toBe(
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed: it exited with 1.",
		);
	});

	it("says a check that could not start, and why", async () => {
		install("tsc");
		const { run } = standIn({
			tsc: { code: null, unstarted: "spawn EACCES" },
		});
		expect(describeTree(await checkTree(tree, { run }), "~/t")).toBe(
			"~/t fails a check. Its typecheck failed: it could not start: spawn EACCES.",
		);
	});

	it("fails a tree whose check was stopped while it ran, saying it was stopped rather than blaming its code", async () => {
		install("tsc");
		const stop = new AbortController();
		const { run } = standIn({
			tsc: {
				code: null,
				stopped: true,
				stdout: "lib/a.ts(1,1): error TS2304: Cannot find name 'x'.\n",
				during: () => stop.abort(),
			},
		});
		const report = await checkTree(tree, { run, signal: stop.signal });
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. Its typecheck failed: it was stopped before it finished.\n- lib/a.ts:1: TS2304 Cannot find name 'x'.",
		);
	});

	it("starts no tests once stopped during a typecheck that passed", async () => {
		install("tsc");
		install("vitest");
		const stop = new AbortController();
		const steps: string[] = [];
		const { run, asked } = standIn({ tsc: { during: () => stop.abort() } });
		const report = await checkTree(tree, {
			run,
			signal: stop.signal,
			onStep: (step) => steps.push(step),
		});
		expect(report.ok).toBe(false);
		expect(names(asked)).toEqual(["tsc"]);
		expect(steps).toEqual(["typecheck"]);
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed: it was stopped before it started.",
		);
	});

	it("can't pass a tree with no programs to check it with", async () => {
		const report = await checkTree(tree, { run: standIn().run });
		expect(describeTree(report, "~/t")).toBe(
			"~/t fails a check. Its typecheck failed: it has no node_modules/.bin/tsc, so install or link its node_modules.",
		);
		install("tsc");
		expect(
			describeTree(await checkTree(tree, { run: standIn().run }), "~/t"),
		).toBe(
			"~/t fails a check. The tests its changes reach (vitest --changed origin/main) failed: it has no node_modules/.bin/vitest, so install or link its node_modules.",
		);
	});
});

describe("running a check's command", () => {
	/**
	 * The real runner, but for git: the stand-in tree is no repository,
	 * and the base check is read through the stand-in runner above.
	 */
	const runReal: Runner = (command, args, cwd, env, timeoutMs, signal) =>
		command === "git"
			? Promise.resolve({ code: 0, stdout: "", stderr: "", hung: false })
			: runCommand(command, args, cwd, env, timeoutMs, signal);

	/**
	 * Waiting a minute for output held open past an exit, so a case's
	 * bound is kept only by killing the whole group, never by the close
	 * grace letting go of a sleeper the kill missed.
	 */
	const holdsOn = commandRunner({ closeGraceMs: 60_000 });

	it("reads stand-in programs' output, exits and report file through the same pipes", async () => {
		install(
			"tsc",
			"echo \"lib/a.ts(2,3): error TS1005: ';' expected.\"\nexit 2",
		);
		const failed = await checkTree(tree, { run: runReal });
		expect(failed.steps[0]?.failures).toEqual([
			"lib/a.ts:2: TS1005 ';' expected.",
		]);

		install("tsc");
		install(
			"vitest",
			[
				'for arg; do case $arg in --outputFile=*) out=$(echo "$arg" | cut -d= -f2-);; esac; done',
				`printf '%s' '${vitestJson([], 2)}' > "$out"`,
			].join("\n"),
		);
		expect(await checkTree(tree, { run: runReal })).toMatchObject({
			ok: true,
		});
	});

	it("kills the whole of a command past its budget, not just its first process", async () => {
		// Two sleepers outlasting the half-second budget, the first in the
		// background holding the pipes: killing only sh would leave it, and
		// the run would wait out its 30 s, past this case's own budget.
		install("tsc", "sleep 30 &\nsleep 30");
		const began = Date.now();
		const hung = await checkTree(tree, {
			run: (command, args, cwd, env, timeoutMs, signal) =>
				command === "git"
					? runReal(command, args, cwd, env, timeoutMs, signal)
					: holdsOn(command, args, cwd, env, timeoutMs, signal),
			timeoutMs: 500,
		});
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(describeTree(hung, "~/t")).toBe(
			"~/t fails a check. Its typecheck failed: it was still running after 1s.",
		);
	}, 15_000);

	it("kills the whole of a command once whoever asked for it stops", async () => {
		const sh = join(tree, "both");
		// As above: a background sleeper keeps the pipes for 30 s unless the
		// whole group goes.
		writeFileSync(sh, "#!/bin/sh\nsleep 30 &\nsleep 30\n");
		chmodSync(sh, 0o755);
		const stop = new AbortController();
		const began = Date.now();
		const path = { PATH: process.env.PATH ?? "" };
		const running = holdsOn(sh, [], tree, path, 60_000, stop.signal);
		// Long enough for sh to have started both sleepers before the stop.
		setTimeout(() => stop.abort(), 300);
		const ran = await running;
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(ran).toMatchObject({ stopped: true, hung: false });
	}, 15_000);

	/** Write `body` as an sh script in the tree, returning its path. */
	function script(body: string): string {
		const path = join(tree, "script");
		writeFileSync(path, `#!/bin/sh\n${body}\n`);
		chmodSync(path, 0o755);
		return path;
	}

	const path = { PATH: process.env.PATH ?? "" };

	it("asks a command to end before killing it, so its own teardown runs", async () => {
		// The trap is what vitest's teardown stands for: it runs only if TERM
		// comes before the kill. `wait` is what the trap interrupts.
		const sh = script(
			`trap 'echo ended > "${tree}/ended"; exit 0' TERM\nsleep 30 &\nwait`,
		);
		const run = commandRunner({ stopGraceMs: 10_000 });
		const ran = await run(sh, [], tree, path, 500);
		expect(ran).toMatchObject({ hung: true, code: 0 });
		expect(readFileSync(join(tree, "ended"), "utf8")).toBe("ended\n");
	}, 15_000);

	it("kills a command that won't end on being asked once its grace has passed", async () => {
		// An ignored TERM is inherited by the sleeper, so only the kill ends either.
		const sh = script("trap '' TERM\nsleep 30 &\nwait");
		const began = Date.now();
		const ran = await commandRunner({ stopGraceMs: 300 })(
			sh,
			[],
			tree,
			path,
			300,
		);
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(ran).toMatchObject({ hung: true, code: null });
	}, 15_000);

	it("ends with a command that exits, killing what it left running in its group", async () => {
		// The sleeper holds the pipes for 30 s unless it goes with the exit;
		// the long close grace leaves only that kill to end the run.
		const sh = script("sleep 30 &\necho done");
		const began = Date.now();
		const ran = await commandRunner({ closeGraceMs: 60_000 })(
			sh,
			[],
			tree,
			path,
			60_000,
		);
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(ran).toMatchObject({ code: 0, stdout: "done\n", hung: false });
	}, 15_000);

	// setsid is util-linux's, and macOS has none: there the script would
	// wait for a pid file nothing writes until the test's timeout.
	it.skipIf(process.platform !== "linux")(
		"lets go of output held open from outside its group once the command has exited",
		async () => {
			// setsid puts the sleeper in a session of its own, out of the group's
			// kill, still holding the pipes; the test ends it by its pid. The
			// script waits for it to have left, or the kill at its exit would
			// catch it first.
			const sh = script(
				[
					`setsid sh -c 'echo $$ > "${tree}/escaped"; exec sleep 30' &`,
					`until [ -s "${tree}/escaped" ]; do sleep 0.05; done`,
					"echo done",
				].join("\n"),
			);
			const began = Date.now();
			try {
				const ran = await commandRunner({ closeGraceMs: 300 })(
					sh,
					[],
					tree,
					path,
					60_000,
				);
				expect(Date.now() - began).toBeLessThan(10_000);
				expect(ran).toMatchObject({ code: 0, stdout: "done\n", hung: false });
			} finally {
				const escaped = Number(readFileSync(join(tree, "escaped"), "utf8"));
				process.kill(escaped, "SIGKILL");
			}
		},
		15_000,
	);

	it.skipIf(process.platform !== "linux")(
		"doesn't call a command that exited in time cut off, though its budget passes while its output is held",
		async () => {
			// The grace outlasts the budget, so the budget passes while the
			// escaped sleeper still holds the pipes after the command exited.
			const sh = script(
				[
					`setsid sh -c 'echo $$ > "${tree}/escaped"; exec sleep 30' &`,
					`until [ -s "${tree}/escaped" ]; do sleep 0.05; done`,
					"echo done",
				].join("\n"),
			);
			try {
				const ran = await commandRunner({ closeGraceMs: 3000 })(
					sh,
					[],
					tree,
					path,
					1500,
				);
				expect(ran).toMatchObject({ code: 0, stdout: "done\n", hung: false });
			} finally {
				const escaped = Number(readFileSync(join(tree, "escaped"), "utf8"));
				process.kill(escaped, "SIGKILL");
			}
		},
		15_000,
	);

	it("stops a command that says more than it holds, and says why", async () => {
		const sh = script("head -c 5000 /dev/zero | tr '\\0' x\nsleep 30");
		const began = Date.now();
		const ran = await commandRunner({ mostHeldChars: 1000 })(
			sh,
			[],
			tree,
			path,
			60_000,
		);
		expect(Date.now() - began).toBeLessThan(10_000);
		expect(ran.stdout).toBe("x".repeat(1000));
		expect(ran.stderr).toBe(
			`\n${sh} was stopped: it said more than 1000 characters`,
		);
	}, 15_000);

	it("runs nothing once already stopped, and says a program that isn't there could not start", async () => {
		const stop = new AbortController();
		stop.abort();
		expect(
			await runCommand("sh", ["-c", "exit 0"], tree, {}, 1000, stop.signal),
		).toMatchObject({ code: null, stopped: true });
		const gone = await runCommand(join(tree, "gone"), [], tree, {}, 1000);
		expect(gone.unstarted).toMatch(/ENOENT/);
	});
});
