/**
 * The merge gate's fail-to-pass step: refuse a head whose own tests
 * still pass with its source undone, the rule SWE-bench grades a fix by
 * (FAIL_TO_PASS). It runs the tests the change adds or changes twice,
 * on the head's tree and on that tree with the change's source put back
 * as the merge-base had it, and holds when some case passes the first
 * time and fails the second. `lib/internal/verification/fail-to-pass.ts`
 * judges; this runs git and vitest for it.
 *
 * Stock tools were checked first. Stryker's mutation testing has a
 * vitest runner, but it judges every line of a file and takes minutes a
 * file, too slow for a gate; vitest's `--changed` picks tests but has no
 * run with the source undone; FAIL_TO_PASS is a method, not a tool.
 *
 * Run it from a checkout with its dependencies installed, as the merge
 * gate does:
 *
 *   node scripts/fail-to-pass.ts BASE HEAD
 *
 * It passes, exiting 0, when the change touches no source, when its
 * head commit carries a `Fail-To-Pass: none, <reason>` trailer, when it
 * changes no test (another rule's business), when a case held, and when
 * the tests can't be judged (every one failed to load undone, or none
 * ran). It exits 1 when no case failed undone, and 2 when git or vitest
 * couldn't run, saying what they said. The scratch copy goes on every
 * exit.
 */

import {
	existsSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	type Exec,
	type ExecResult,
	spawnExec,
} from "../lib/core/exec/index.ts";
import { stoppedBySignals } from "../lib/core/exec/stopped-by-signals.ts";
import {
	type CaseResults,
	type ChangedPath,
	exemptionOf,
	type FailToPass,
	judgeFailToPass,
	parseNameStatus,
	parseVitestReport,
	splitChange,
} from "../lib/internal/verification/fail-to-pass.ts";
import { count } from "../lib/ui/count.ts";

/** What each line this step prints opens with. */
const SAYS = "fail-to-pass:";

/** The exit for a head whose tests pass with its source undone. */
const EXIT_NOT_HELD = 1;

/** The exit for a step that couldn't run git or vitest. */
const EXIT_COULD_NOT_RUN = 2;

/**
 * How long one vitest run of the changed tests may take: past the
 * longest a whole unit run takes on a busy machine, so only a hung
 * run is stopped.
 */
const VITEST_MS = 10 * 60 * 1000;

/** Why the step stopped short of a verdict, and with which exit. */
class CouldNotRun extends Error {}

/** The same exec, its failure thrown with what the command said. */
async function ran(
	exec: Exec,
	command: string,
	args: string[],
): Promise<string> {
	const result = await exec(command, args);
	if (result.code !== 0) {
		throw new CouldNotRun(
			`${command} ${args.join(" ")} exited ${result.code}: ${said(result)}`,
		);
	}
	return result.stdout;
}

/** Both of a command's streams, as far as they say anything. */
function said(result: ExecResult): string {
	return [result.stderr.trim(), result.stdout.trim()]
		.filter((stream) => stream !== "")
		.join("\n");
}

/** Where one judging happens, and the commands it runs. */
interface Judging {
	readonly checkout: string;
	readonly scratch: string;
	readonly tree: string;
	readonly exec: Exec;
	readonly signal: AbortSignal;
}

/** git in the checkout, with `env` laid over this process's. */
function git(
	judging: Judging,
	args: string[],
	env?: Record<string, string>,
): Promise<string> {
	const exec =
		env === undefined
			? judging.exec
			: spawnExec({ signal: judging.signal, env });
	return ran(exec, "git", ["-C", judging.checkout, ...args]);
}

/**
 * The trailers of `head`'s message, read by git's own parser from a
 * file, since exec gives no stdin.
 */
async function trailersOf(judging: Judging, head: string): Promise<string> {
	const message = await git(judging, ["log", "-1", "--format=%B", head]);
	const file = join(judging.scratch, "message");
	writeFileSync(file, message);
	return git(judging, ["interpret-trailers", "--parse", file]);
}

/**
 * Write `commit`'s tree into the scratch tree through an index of the
 * step's own, so the checkout's index and worktree are never touched,
 * and nothing `export-ignore` marks is left out as `git archive` would.
 */
async function writeTree(judging: Judging, commit: string): Promise<void> {
	const env = { GIT_INDEX_FILE: join(judging.scratch, "head-index") };
	await git(judging, ["read-tree", commit], env);
	await git(
		judging,
		["checkout-index", "-a", `--prefix=${judging.tree}/`],
		env,
	);
}

/**
 * Put the change's source back as `base` had it: an added file taken
 * away, a changed or deleted one written from `base`, and a rename
 * taken back to its old path.
 */
async function undo(
	judging: Judging,
	base: string,
	sources: readonly ChangedPath[],
): Promise<void> {
	const restored: string[] = [];
	for (const source of sources) {
		if (source.status === "A" || source.status === "R") {
			rmSync(join(judging.tree, source.path), { force: true });
		}
		if (source.status === "M" || source.status === "D") {
			restored.push(source.path);
		}
		if (source.status === "R" && source.from !== undefined) {
			restored.push(source.from);
		}
	}
	if (restored.length === 0) return;
	const env = { GIT_INDEX_FILE: join(judging.scratch, "base-index") };
	await git(judging, ["read-tree", base], env);
	await git(
		judging,
		["checkout-index", "-f", `--prefix=${judging.tree}/`, "--", ...restored],
		env,
	);
}

/**
 * Run vitest on `tests` in the scratch tree, its report written to the
 * scratch folder as `report`, and read back case by case. vitest exits
 * 1 when a case fails, which is an answer here; only a report it
 * never wrote, or one not in its shape, means it couldn't run.
 */
async function runTests(
	judging: Judging,
	vitest: string,
	tests: readonly string[],
	report: string,
): Promise<CaseResults> {
	const file = join(judging.scratch, report);
	const exec = spawnExec({
		signal: judging.signal,
		cwd: judging.tree,
		timeoutMs: VITEST_MS,
	});
	const result = await exec(process.execPath, [
		vitest,
		"run",
		"--root",
		judging.tree,
		"--color=false",
		"--reporter=json",
		`--outputFile=${file}`,
		...tests,
	]);
	if (!existsSync(file)) {
		throw new CouldNotRun(
			`vitest wrote no report (exit ${result.code}): ${said(result)}`,
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new CouldNotRun(`vitest's report isn't JSON: ${String(error)}`);
	}
	const results = parseVitestReport(parsed, (name) =>
		relative(judging.tree, name),
	);
	if (results === undefined) {
		throw new CouldNotRun(
			`vitest's report holds no test results (exit ${result.code}): ${said(result)}`,
		);
	}
	return results;
}

/** What the verdict prints, and the exit it takes. */
function verdict(judged: FailToPass): number {
	if (judged.held === true) {
		console.log(
			`${SAYS} held, failing with the source undone: ${count(judged.cases.length, "case")}`,
		);
		for (const name of judged.cases) console.log(`  ${name}`);
		return 0;
	}
	if (judged.held === "unjudged") {
		console.log(`${SAYS} unjudged, passing: ${judged.why}`);
		return 0;
	}
	console.log(`${SAYS} refused: ${judged.why}`);
	return EXIT_NOT_HELD;
}

/** Judge BASE..HEAD from the checkout this runs in; answers the exit. */
async function judge(
	judging: Judging,
	base: string,
	head: string,
): Promise<number> {
	const changed = splitChange(
		parseNameStatus(
			await git(judging, [
				"diff",
				"--name-status",
				"-z",
				"--find-renames",
				`${base}...${head}`,
			]),
		),
	);
	if (changed.sources.length === 0) {
		console.log(`${SAYS} no source changed at ${head}`);
		return 0;
	}
	const exemption = exemptionOf(await trailersOf(judging, head));
	if (exemption !== undefined) {
		console.log(`${SAYS} nothing to test at ${head}: ${exemption}`);
		return 0;
	}
	if (changed.tests.length === 0) {
		console.log(
			`${SAYS} ${head} changes ${count(changed.sources.length, "source file")} and no test, which another rule judges`,
		);
		return 0;
	}
	const vitest = join(judging.checkout, "node_modules", "vitest", "vitest.mjs");
	if (!existsSync(vitest)) {
		throw new CouldNotRun(
			`${judging.checkout} has no vitest installed; run pnpm install --frozen-lockfile there`,
		);
	}
	const forkPoint = (await git(judging, ["merge-base", base, head])).trim();
	await writeTree(judging, head);
	symlinkSync(
		join(judging.checkout, "node_modules"),
		join(judging.tree, "node_modules"),
	);
	const atHead = await runTests(judging, vitest, changed.tests, "head.json");
	await undo(judging, forkPoint, changed.sources);
	const undone = await runTests(judging, vitest, changed.tests, "undone.json");
	return verdict(judgeFailToPass(atHead, undone));
}

/** Run the step on this process's arguments; answers the exit. */
async function main(): Promise<number> {
	const [base, head] = process.argv.slice(2);
	if (base === undefined || head === undefined) {
		console.error("Name the commits: node scripts/fail-to-pass.ts BASE HEAD");
		return EXIT_COULD_NOT_RUN;
	}
	const signal = stoppedBySignals();
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "fail-to-pass-")));
	try {
		return await judge(
			{
				checkout: process.cwd(),
				scratch,
				tree: join(scratch, "tree"),
				exec: spawnExec({ signal }),
				signal,
			},
			base,
			head,
		);
	} catch (error) {
		if (!(error instanceof CouldNotRun)) throw error;
		console.error(`${SAYS} couldn't judge ${head}: ${error.message}`);
		return EXIT_COULD_NOT_RUN;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

if (import.meta.main) process.exitCode = await main();
