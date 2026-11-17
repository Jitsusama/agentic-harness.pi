/**
 * The machine's queue: heavy work takes turns by the room it needs.
 *
 * Every pi session on the machine shares one queue, kept as files in
 * the account's runtime directory (see folder.ts), with no daemon and
 * nobody in charge: whichever session looks next starts the next job.
 * An agent learns nothing new. Its bash call runs as it always did; the
 * harness reads what kind of work the command is from one map, so no
 * agent names its own place, and the command's shell waits for its
 * turn before it starts. pi itself never waits, only the shell does.
 *
 * What a turn is decided by:
 *
 * - **Memory**, the one hard limit: CPU is shared by weight, so an idle
 *   build only takes what nobody else wants, but memory past what the
 *   machine has is what systemd-oomd ends work for. A job starts when
 *   the memory left past the floors core.nix keeps for Joel's programs
 *   covers what its kind needs, and pressure is under a set point,
 *   which only quick work too small to feel waits past (see
 *   `LIGHT_GIB` in needs.ts).
 * - **Kinds held to a number at once**: VMs, whose tests time out when
 *   they share the CPU with too much else. The VMs running are counted
 *   on the machine as well as in the queue, since a command can pick
 *   its check from a variable the queue can't read, and a session on
 *   older code runs its VMs outside the queue. And walks of World's git
 *   objects, whose packs evict each other from the page cache that the
 *   memory available counts as free (see {@link WALKS_AT_ONCE}).
 * - **Order**: timed work before bulk, quick work before the rest of
 *   bulk, then work another session waits on (see awaited.ts), then the
 *   oldest first. A job its limit holds back lets the next one past; a
 *   job memory holds back holds everyone behind it but quick work, one
 *   quick job at a time, so a big job is never starved by small ones
 *   slipping in and a check of seconds never waits on it; once the
 *   memory it waits for is held by a long run, it holds only the work
 *   that would still run when that ends.
 * - **One at a time, a little apart**: memory is read a moment after
 *   it is taken, and everyone reacting at once to one reading is what
 *   makes a group overshoot and swing back, so turns are given out one
 *   at a time, a few seconds apart, with what was just started counted
 *   as taken until it has had time to grow.
 *
 * The room left over is said too ({@link roomLeft}): the queue only
 * fills the machine with work somebody starts, and most of the idle
 * minutes measured on 22 October (35 of 43 under half busy) had no VM
 * running at all, while agents ran their tests one after another.
 *
 * This file reads what kind of work a command is. The rest of the queue
 * lives beside it, each part in the file its reason to change names, and
 * every name other files take from the queue is still said from here.
 */

import { homedir } from "node:os";
import {
	CARGO,
	CHANGED_CHECKS,
	EVAL_TESTS,
	EVAL_TESTS_GIB,
	EVALUATES,
	EVERY_CHECK,
	type Kind,
	NIX_FAST_BUILD,
	needsGibOf,
	SYSTEM_EVALUATION,
	THERE_HERE,
} from "./needs.ts";
import { runSteps, stepsOf } from "./steps.ts";
import {
	GIT_WALK,
	searchesWorldWhole,
	type Where,
	worldWalks,
} from "./world-walk.ts";

export {
	CAPPED_NIX,
	CAPS_BUILDS_FROM_CPU_PRESSURE,
	FEWER_VMS,
	GREW_BYTES,
	MOST_CPU_PRESSURE_BESIDE_VMS,
	MOST_CPU_PRESSURE_FOR_BUILDS,
	MOST_FLOORS_CPU_PRESSURE,
	MOST_FLOORS_PRESSURE,
	MOST_IO_PRESSURE_FOR_BUILDS,
	MOST_MEMORY_PRESSURE,
	MOST_VMS,
	pressedPast,
	QUICK_NIX,
	QUICK_OUTRUN_MS,
	VM_SETTLE_MS,
	VM_SPREAD_MS,
	VM_STEADY_MS,
} from "./bounds.ts";
export {
	isVm,
	type Job,
	type Offload,
	type Pressed,
	type Room,
	type RoomLeft,
	RULES,
	type Rules,
	type WaitedOn,
	type WaitReason,
} from "./job.ts";
export {
	CHANGED_CHECKS_GIB,
	CHANGED_CHECKS_SENT_GIB,
	CLASS_OF,
	type Class,
	EVAL_TESTS_GIB,
	EVALUATION_GIB,
	EVERY_CHECK_GIB,
	type Kind,
	NEEDS_GIB,
	needsGibOf,
	PUSH_GIB,
	runsChangedChecks,
	WALKS_AT_ONCE,
} from "./needs.ts";
export {
	JOINS_FOR_MS,
	KEEPS_LINE_FOR_MS,
	LENDING_WAIT_MS,
	nextTurn,
	PASS_AFTER_MS,
	RAMP_MS,
	RULES_VERSION,
	roomLeft,
	roomSaid,
	SPREAD_MS,
	waitingInOrder,
	waitReasons,
	waitsWithRoom,
} from "./next-turn.ts";
export { stepsOf } from "./steps.ts";
export {
	skipsWorldPushHooks,
	type Where,
	walkOf,
} from "./world-walk.ts";

/**
 * The least a command is held to whatever its earlier runs held: a zone's
 * evaluation tests' {@link EVAL_TESTS_GIB} when a step of it runs them,
 * else nothing. A chain that runs them last may have stopped before them
 * every time it ran, so what it held then says nothing of them.
 */
export function leastGibOfCommand(command: string): number {
	return runSteps(command).some((step) => EVAL_TESTS.test(step))
		? EVAL_TESTS_GIB
		: 0;
}

/**
 * A type check: tsc by its name or its path, vue-tsc and tsgo, over a
 * project or files, each holding a gigabyte and a core for minutes. Two
 * took no turn on equilibrius at load 155 to 264 on 16 November
 * (VRZKID). Left out are the runs that compile nothing, asking its
 * version or help or writing a config, and a watch, which never ends
 * and would hold a turn for good.
 */
const TYPE_CHECK =
	/(?:(?<![\w.-])(?:\S*\/)?(?:vue-)?tsc|(?<![\w./-])tsgo)(?![\w./-])(?![^\n]*\s(?:-v|--version|-h|--help|--all|--init|--showConfig|--clean|-w|--watch)(?![\w-]))/;

/**
 * A package script named typecheck, or typecheck:<anything>, run by pnpm,
 * yarn or bun, or npm's run, with any flags before it, as `pnpm -C dir`,
 * `pnpm --filter x` and `pnpm -r` are.
 */
const TYPE_CHECK_SCRIPT =
	/\b(?:(?:pnpm|yarn|bun)(?:\s+--?[\w-]+(?:[=\s][^\s-]\S*)?)*\s+(?:run\s+)?|npm(?:\s+--?[\w-]+(?:[=\s][^\s-]\S*)?)*\s+run(?:-script)?\s+)typecheck(?::[\w-]+)?(?![\w:-])/;

/**
 * The one map from a command to its kind, first match winning. A VM
 * test is a VM or a test driver run here; building a test's driver is a
 * build; a VM check is a Nix build or check of something named for a
 * VM test, which the daemon runs.
 */
const KINDS: readonly (readonly [RegExp, Kind])[] = [
	[
		// Each as a program, not a store path or folder named after one, as
		// `/nix/store/<hash>-nixos-test-driver-1.1/lib` is: a grep there
		// waited for a turn as a VM test.
		/\bqemu-system-[\w-]+(?![\w.*/-])|\bqemu-kvm(?![\w.*/-])|\bnixos-test-driver(?![\w.*/-])|\/bin\/run-[\w-]+-vm\b|(?<![\w./-])run-subtests(?![\w.-])(?!\s+--there\b)/,
		"vm-test",
	],
	[/\bnix\s+build\b[^\n]*\.driver\b/, "build"],
	// A dry run only evaluates: one naming a VM check waited 16th in line
	// for a VM slot on 29 October.
	[/\bnix\s+build\b[^\n]*\s--dry-run\b/, "build"],
	[
		/\bnix(?:\s+--?\S+)*\s+(?:build|flake\s+check)\b[^\n]*(?:\bvm-|\.vm\b|nixosTests|vmTest)/,
		"vm-check",
	],
	[
		new RegExp(`${THERE_HERE}[^\\n]*(?:\\bvm-|\\.vm\\b|nixosTests|vmTest)`),
		"vm-check",
	],
	[
		new RegExp(
			`${CHANGED_CHECKS.source}(?=[^\\n]*\\s--build\\b)(?![^\\n]*\\s--no-vm\\b)`,
		),
		"vm-check",
	],
	[new RegExp(`${CARGO}bench\\b|\\bhyperfine\\b`), "benchmark"],
	[
		new RegExp(
			[
				// nix-build as a program, not a build's cgroup or a glob over them,
				// as in `$D/nix-build-*`, which held a read-only loop 315 s.
				/\bnix\s+flake\s+check\b|\bnix\s+build\b|\bnix-build(?![\w.*-])|\bnixos-rebuild\b/,
				// An image for containers, which compiles what it holds.
				/\b(?:podman|docker)\s+(?:buildx\s+|compose\s+)?build\b|\bbuildah\s+(?:build|bud)\b/,
				/\b(?:darwin-rebuild\s+(?:switch|build|check|test)|home-manager\s+(?:switch|build))\b/,
				NIX_FAST_BUILD,
				EVAL_TESTS,
				new RegExp(
					`${CARGO}(?:build|b|check|c|clippy|test|t|nextest|run|r|install|doc|llvm-cov|miri|insta)\\b`,
				),
				/\bmake\b[^\n]*\s-j\s*\d*|\bcmake\s+--build\b|\bgo\s+(?:build|test|install|vet)\b/,
				// A test suite's workers fill the cores as a build does: vitest as
				// a program, not a file named for it, and the package scripts
				// that run it. Several ran at once at 21:09 on 7 November. npm's
				// test is left alone: Acceluary's deploy waits on its, which is
				// timed work rather than bulk (N3Q98W).
				/(?<![\w./-])vitest(?![\w.-])|\bpnpm\s+(?:run\s+)?(?:check|test(?::[\w-]+)?)(?![\w:-])/,
				TYPE_CHECK,
				TYPE_CHECK_SCRIPT,
			]
				.map((pattern) => pattern.source)
				.join("|"),
		),
		"build",
	],
	[CHANGED_CHECKS, "build"],
	[new RegExp(THERE_HERE), "build"],
	[EVERY_CHECK, "build"],
];

/**
 * The kind of heavy work a command runs, read only where the shell runs
 * it: text in quotes or a heredoc names work rather than running it.
 * A quoted single word is an argument, as a quoted flake reference
 * such as `"path:$W#checks.x86_64-linux.vm-desktop-works"` is, so it
 * is read; quoted words with spaces between them are prose. A step that
 * only looks, as `pgrep -x qemu-system-x86` does, names work without
 * running it: read as a VM, it waited 30 seconds for a turn and timed
 * out. Nothing for a command that runs none.
 */
export function kindOf(
	command: string,
	where: Where = { home: homedir() },
): Kind | undefined {
	const steps = runSteps(command).filter((step) => !testsOneFile(step));
	const runs = steps.join("\n");
	// Before a stamp: what a timed run times may be the stamp's own suite.
	if (timesARun(runs, where)) return "timed-run";
	if (stamps(runs, where)) return "stamp";
	if (searchesWorldWhole(command, where)) return "build";
	// An evaluation's expression is quoted, which reading the steps blanks
	// as prose, so what it evaluates is read from the command as written.
	if (EVALUATES.test(runs) && SYSTEM_EVALUATION.test(command)) return "build";
	const kind = KINDS.find(([pattern]) => pattern.test(runs))?.[1];
	if (kind !== undefined) return kind;
	return worldWalks(steps, where).length > 0 ? "world-walk" : undefined;
}

/**
 * Whether a step is vitest run over one test file alone: one worker for
 * seconds, the focused run P9R1KI left the machine itself when every
 * other suite went to a builder (8 November). Held as a build, one
 * waited minutes behind a cargo build short of memory, for a turn it
 * barely needed.
 */
function testsOneFile(step: string): boolean {
	const words = step.trim().split(/\s+/);
	const at = words.indexOf("vitest");
	if (at < 0 || words[at + 1] !== "run") return false;
	const files: string[] = [];
	for (const word of words.slice(at + 2)) {
		// A redirection ends its arguments; what follows is a file it writes.
		if (/^(?:\d|&)?>/.test(word) || /^[|;&]/.test(word)) break;
		if (!word.startsWith("-")) files.push(word);
	}
	return files.length === 1 && /\.test\.[cm]?tsx?$/.test(files[0] ?? "");
}

/** The suite a deploy of Acceluary's or Estuary's runs as its stamp. */
const STAMP_SUITE =
	/(?<![\w.-])node\s+(?:\S*\/)?(?:deploy|estero)\/suite\.mjs(?![\w.-])/;

/** npm's test, which in Acceluary's checkout runs the deploy's suite. */
const NPM_TEST = /(?<![\w.-])npm\s+(?:run\s+)?test(?![\w:-])/;

/** A folder of Acceluary's: its checkout, or a tree or snapshot of it. */
const ACCELUARY = /(?:^|\/)[^/\s]*acceluary[^/\s]*(?:\/|$)/;

/**
 * Whether a command runs a deploy's stamp: the suite by its file, or
 * `npm test` from Acceluary's own folder, named by where the command
 * runs or the `cd` it makes. Elsewhere `npm test` is somebody's tests.
 */
function stamps(runs: string, where: Where): boolean {
	if (STAMP_SUITE.test(runs)) return true;
	return NPM_TEST.test(runs) && runsInAcceluary(runs, where);
}

/** Acceluary's wrapper every timed run goes through, by its file. */
const TIMED_RUN = /(?<![\w.-])node\s+(?:\S*\/)?tools\/timed\.mjs(?![\w.-])/;

/**
 * Whether a command runs one of Acceluary's timed runs: its wrapper,
 * from Acceluary's own folder. Elsewhere a `tools/timed.mjs` is
 * somebody else's.
 */
function timesARun(runs: string, where: Where): boolean {
	return TIMED_RUN.test(runs) && runsInAcceluary(runs, where);
}

/**
 * Whether a command runs in Acceluary's folder, named by where it runs,
 * the `cd` it makes, or the path it gives its wrapper.
 */
function runsInAcceluary(runs: string, where: Where): boolean {
	const inAcceluary = (path: string | undefined) =>
		path !== undefined && ACCELUARY.test(path);
	const cds = [...runs.matchAll(/(?:^|\n)\s*cd\s+(\S+)/g)].map((m) => m[1]);
	const wrapper = runs.match(/(\S*)\/tools\/timed\.mjs/)?.[1];
	return (
		inAcceluary(where.cwd) || cds.some(inAcceluary) || inAcceluary(wrapper)
	);
}

/** Each kind as a sentence names one, so every surface says it alike. */
export const KIND_SAID: Readonly<Record<Kind, string>> = {
	"vm-test": "a VM test",
	"vm-check": "a VM check",
	benchmark: "a benchmark",
	build: "a build",
	"world-walk": "a walk of World's git objects",
	stamp: "a deploy stamp",
	"timed-run": "a timed run",
};

/**
 * The step of a command that does its heavy work, whole, never a line of
 * a heredoc: a commit message naming changed-checks was once the step
 * named, and the build beside it was held to that tool's memory. A
 * zone's evaluation tests name it wherever they come in a chain, since
 * they hold the most: named by the cargo build before them, a chain's
 * peak would be charged to every plain run of that build.
 */
export function stepOf(command: string): string {
	const steps = stepsOf(command);
	return (
		steps.find((one) => EVAL_TESTS.test(one) && kindOf(one) !== undefined) ??
		steps.find((one) => kindOf(one) !== undefined) ??
		// A walk alone says nothing of the folder a `cd` before it gave it.
		steps.find((one) => GIT_WALK.test(one)) ??
		steps[0] ??
		""
	);
}

/**
 * Each step of a command that runs heavy work, in order, as written,
 * with its kind. The queue gives the whole command one turn, as the
 * heaviest of these, so a VM step beside a build makes the build hold a
 * VM slot (shell/shell-habits.ts refuses that).
 */
export function heavySteps(
	command: string,
): { readonly step: string; readonly kind: Kind }[] {
	return stepsOf(command).flatMap((step) => {
		const kind = kindOf(step);
		return kind === undefined ? [] : [{ step, kind }];
	});
}

/**
 * The memory a command of `kind` is held to need, in GiB: its heaviest
 * step's, not its first's. Y9XISP's on 24 October built changed-checks
 * and then ran it, and was held to the build's 4 GiB while the tool
 * used 11.8.
 */
export function needsGibOfCommand(kind: Kind, command: string): number {
	return Math.max(
		needsGibOf({ kind, what: stepOf(command) }),
		...stepsOf(command)
			.filter((step) => kindOf(step) !== undefined)
			.map((step) => needsGibOf({ kind, what: step })),
	);
}

/** How long a job's `what` may be before it is cut. */
const MOST_WHAT = 120;

/** The step of a command that does its heavy work, as one short line. */
export function whatOf(command: string): string {
	const step = stepOf(command);
	return step.length > MOST_WHAT ? `${step.slice(0, MOST_WHAT - 3)}...` : step;
}
