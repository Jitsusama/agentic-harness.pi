/**
 * What each kind of heavy work is held to need: its class, the memory it
 * books, and the reading of a Nix evaluation or check that decides how
 * much of the machine one command takes.
 */

import type { Job } from "./job.ts";

/** What a command does, as the harness reads it. */
export type Kind =
	| "vm-test"
	| "vm-check"
	| "benchmark"
	| "build"
	| "world-walk"
	| "stamp"
	| "timed-run";

/**
 * What a walk of World's objects does, as world-walk.ts's `walkOf` reads
 * it.
 */
export type Walk = "push" | "main-fetch" | "branch" | "other";

/**
 * How a kind is run: timed work's result depends on its timing, so it
 * runs at a weight of its own; bulk takes whatever is left.
 */
export type Class = "timed" | "bulk";

export const CLASS_OF: Readonly<Record<Kind, Class>> = {
	// A VM test run from its driver, in the session's own cgroups.
	"vm-test": "timed",
	// A VM test run by the Nix daemon, as `nix build` of a check does: it
	// runs in build.slice whatever the queue says, so it is bulk here,
	// but it is a VM all the same and counts against the VMs at once.
	"vm-check": "bulk",
	benchmark: "timed",
	build: "bulk",
	"world-walk": "bulk",
	// A deploy's whole suite, headless Chrome and all, which every
	// production deploy of Acceluary and Estuary waits on: beside ten
	// builds at 74% pressure, train 8's took 13 minutes on 7 November
	// against 3 to 5 at 10 to 40%, and load flakes its Chrome tests
	// (N3Q98W). Its owner ruled it goes first (E2ZIAQ, 22:57).
	stamp: "timed",
	// One of Acceluary's paired timings, through its tools/timed.mjs: given
	// back while builds held the load at 25 to 55 (E2ZIAQ, 8 November).
	"timed-run": "timed",
};

/**
 * The memory each kind is held to need, in GiB. 2HN63P's VM tests take
 * 2 to 6 GiB each, so a VM is given the top of that. A build's and a
 * benchmark's are starting values, not yet measured. A walk of World's
 * objects maps its packs: the gits the kernel killed on 4 November held
 * 4.7 to 5.6 GB each as file pages (5FWIUS).
 */
export const NEEDS_GIB: Readonly<Record<Kind, number>> = {
	"vm-test": 6,
	"vm-check": 6,
	benchmark: 2,
	build: 4,
	"world-walk": 6,
	stamp: 4,
	"timed-run": 4,
};

/**
 * The memory a push of World is held to need, in GiB, when it leaves out
 * its LFS scan (pushes.ts) and has never been seen to run. With the scan
 * left out a push sends a few commits rather than walking the packs: on
 * 10 November four peaked at 2.9 to 3.2 MB and ran 3 to 14 s, yet each
 * waited 481 to 618 s booked as a 6 GiB walk (WJATIN). The hooks decide
 * at push time, so a push that does add an LFS file runs its scan under
 * this booking too.
 */
export const PUSH_GIB = 0.25;

/**
 * The most memory quick work other than a build may be held to need, in
 * GiB, and still start while the machine is short of memory: what the
 * queue's smallest seen peak rounds up to (outcome.ts's `peakGibAfter`).
 * Such work adds nothing a pressed machine would feel, so holding it
 * frees nothing. A build is never let through, since the Nix builds it
 * asks for are the daemon's, outside what it was seen to hold.
 */
export const LIGHT_GIB = 1;

/**
 * How many walks of World's git objects run at once while memory
 * pressure stays under {@link ONE_WALK_FROM_PRESSURE}, past which one
 * does ({@link walksAtOnce}). From 08:04 to 08:22 on 4 November the kernel killed six times
 * while 3 to 5 ran at once from different sessions' World trees, each
 * mapping 3 to 6 GB of packs: each evicted the others', 60.9M file pages
 * refaulted in 38 minutes, and at the 08:14:56 kill reclaim found
 * nothing in 18.9 GB of inactive file pages (5FWIUS). The memory the
 * queue reads counts that page cache as free, so only a count holds
 * them.
 */
export const WALKS_AT_ONCE = 2;

/**
 * The memory pressure, the share of the last minute every task stalled
 * (`full avg60`), in percent, from which walks of World's objects go one
 * at a time. At 06:08 on 21 November it read 13.6 to 17.8 while two
 * World rebases of 3.8 and 3.9 GB, a push's LFS scan of 2.3 GB and a
 * `git log -S` of 1.3 GB ran side by side, and core.nix's own small git
 * calls took 9 to 70 s each (80ECO2). Beside one another, each walk
 * evicts the packs the next one maps.
 */
export const ONE_WALK_FROM_PRESSURE = 5;

/**
 * How many walks of World's objects may run at once while `fullMinute`
 * is the memory pressure read, or nothing where none is read: one from
 * {@link ONE_WALK_FROM_PRESSURE}, else {@link WALKS_AT_ONCE}.
 */
export function walksAtOnce(fullMinute: number | undefined): number {
	return (fullMinute ?? 0) >= ONE_WALK_FROM_PRESSURE ? 1 : WALKS_AT_ONCE;
}

/**
 * What a whole flake's check holds, in GiB, whatever its kind: `nix flake
 * check` evaluates every output before it builds one, and keeps that heap
 * until the last build ends. A core.nix check's evaluator held 17.1 GiB
 * (P9R1KI's measurement) and 17.8 to 20.2 GiB in four that ran at once on
 * 23 October, against the 4 a build is held to: the queue let in about
 * 80 GiB it counted as 16, and the rest went to swap.
 */
export const EVALUATION_GIB = 20;

/**
 * What a zone's evaluation tests hold at least, in GiB. On 6 November
 * nix-unit, running aquifer converge's `evalTests` at the end of a chain
 * the queue held to a cargo build's 4, held 8.5 GiB of anonymous memory
 * when the kernel killed it with the machine out of room. It hadn't
 * finished, so its peak lies past that.
 */
export const EVAL_TESTS_GIB = 12;

/**
 * A zone's evaluation tests: nix-unit, or `tec run` of an `evalTests`
 * target, which runs it. As programs, not a path or a name holding the
 * words.
 */
export const EVAL_TESTS =
	/\bnix-unit(?![\w.*/-])|\btec\s+run\s+\S*:evalTests\b/;

/**
 * core.nix's changed-checks, run as a command rather than named as a
 * file: it evaluates every check twice, at the base and in the tree,
 * then builds what moved, VM tests too unless told `--no-vm`. Run from
 * a `bin` folder too, as `$out/bin/changed-checks` runs a build of it,
 * but never a file or folder named after it, such as its crate's.
 */
export const CHANGED_CHECKS =
	/(?:(?<![\w./-])|(?<=\/bin\/))changed-checks(?![\w./-])/;

/** Whether a command runs core.nix's changed-checks. */
export function runsChangedChecks(command: string): boolean {
	return CHANGED_CHECKS.test(command);
}

/** A shell variable set for one command, as `NAME=value`, and its name. */
const ASSIGNS = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/**
 * Variables a step may not change for itself and still be sent: with no
 * `PI_QUEST` elsewhere runs the job here, and another `PATH` may find
 * another elsewhere than the one asked where it places a kind.
 */
const KEEPS = new Set(["PI_QUEST", "PATH"]);

/** A word that runs a command here as the shell expands it. */
const SUBSTITUTES = /\$\(|`|<\(|>\(/;

/**
 * A word as the shell reads it once its quotes and backslashes are gone,
 * so `-""-here`, `\-\-here` and `PI_""QUEST` read as what they are.
 */
function unquoted(word: string): string {
	return word.replace(/["'\\]/g, "");
}

/**
 * Anything in a command that can change which elsewhere runs or where it
 * places a run: `PI_QUEST` or `PATH` named anywhere, whether set, unset
 * or exported by an earlier step, or `elsewhere` defined as a function
 * or an alias. Read over the whole command, not one step, since an
 * earlier step changes what a later one inherits.
 */
const REROUTES =
	/\bPI_QUEST\b|(?<!\w)PATH\b|\belsewhere\s*\(|\bfunction\s+elsewhere\b|\balias\s+elsewhere\b/;

/** Whether anything in a command can change where its elsewhere runs go. */
export function reroutesElsewhere(command: string): boolean {
	return REROUTES.test(command);
}

/** Whether a word sets a variable for one command, and not one it keeps. */
function setsOwn(word: string): boolean {
	const name = ASSIGNS.exec(word)?.[1];
	return name !== undefined && !KEEPS.has(name);
}

/**
 * Where `env` stops reading and its program starts, or nothing when it
 * clears or changes what a sent run needs, or takes an option read no
 * further than `-u NAME`.
 */
function envTakes(words: readonly string[], at: number): number | undefined {
	let next = at;
	for (;;) {
		const word = words[next] ?? "";
		if (unquoted(word) === "-u") {
			if (KEEPS.has(unquoted(words[next + 1] ?? ""))) return undefined;
			next += 2;
		} else if (word.startsWith("-")) return undefined;
		else if (ASSIGNS.test(word)) {
			if (!setsOwn(word)) return undefined;
			next += 1;
		} else return next;
	}
}

/** What `timeout` reads before the program it runs: options, then a duration. */
function timeoutTakes(words: readonly string[], at: number): number {
	let next = at;
	while ((words[next] ?? "").startsWith("-")) {
		const word = words[next] ?? "";
		next += word === "-s" || word === "-k" ? 2 : 1;
	}
	return next + 1;
}

/**
 * Whether a word names elsewhere as PATH finds it, the one asked where it
 * places a kind. A path, even an absolute one, may name a script of the
 * agent's own, so it never counts.
 */
function isElsewhere(word: string): boolean {
	return word === "elsewhere";
}

/**
 * The kind of job a step sends with `elsewhere run KIND [OPTIONS] -- ...`, which
 * carries its tracked files to the machine mycelium places it on
 * (core.nix's elsewhere), or nothing when the step runs something else,
 * or asks with `--here` to run on this machine. Read from the step's
 * words, past one-command settings, `env`, `timeout` and `command`, so
 * the words inside a quoted argument or a test's name never count.
 * Nothing, too, for a step that runs something here as the shell expands
 * it (`$(...)`, backticks, `<(...)`), or that changes `PI_QUEST` or
 * `PATH` for itself, since either keeps work on this machine.
 */
export function elsewhereKindOf(words: readonly string[]): string | undefined {
	const expands = (word: string) =>
		SUBSTITUTES.test(word) && !/^'[^']*'$/.test(word);
	if (words.some(expands)) return undefined;
	let at: number | undefined = 0;
	for (;;) {
		const word: string = words[at] ?? "";
		if (ASSIGNS.test(word)) {
			if (!setsOwn(word)) return undefined;
			at += 1;
		} else if (word === "env") {
			at = envTakes(words, at + 1);
			if (at === undefined) return undefined;
		} else if (word === "timeout") at = timeoutTakes(words, at + 1);
		else if (word === "command" || word === "exec") at += 1;
		else break;
	}
	if (!isElsewhere(unquoted(words[at] ?? ""))) return undefined;
	const kind = unquoted(words[at + 2] ?? "");
	if (unquoted(words[at + 1] ?? "") !== "run" || !/^\w[\w.-]*$/.test(kind)) {
		return undefined;
	}
	// elsewhere takes the job only after `--`, and refuses a run without
	// one (exit 64, 22 November), so such a step sends nothing.
	const end = words.indexOf("--", at + 3);
	if (end === -1) return undefined;
	const options = words.slice(at + 3, end);
	const staysHere = (option: string) =>
		option.includes("$") || unquoted(option) === "--here";
	return options.some(staysHere) ? undefined : kind;
}

/**
 * `nix-offload there --here`, which builds on this machine when no
 * builder takes the build (core #1394), so it waits its turn here like
 * the `nix build` it stands for; without `--here` it builds nothing here.
 */
export const THERE_HERE = String.raw`\bnix-offload\s+there\b(?=[^\n]*\s--here\b)`;

/**
 * What evaluating every check's derivation at once holds, in GiB: it
 * reached 24 GB on optimus inside changed-checks (2HN63P's run, 7SU7HB's
 * measurement), and a bare `nix eval` of every check about the same
 * (Y9XISP's), and 2HN63P's evaluation of a commit's checks held 22 GiB on
 * 24 October. Two ran with no turn that day at about 20 each, beside a
 * flake check given one, which filled swap.
 */
export const EVERY_CHECK_GIB = 24;

/**
 * What changed-checks holds, in GiB: since core #465 it evaluates checks
 * 40 at a time, so its peak is one chunk's, not every check's. Its own
 * scope peaked at 11.7 and 12.5 GiB in the two runs recorded on 24
 * October, and a chunk of 40 VM tests, the heaviest chunk it can meet,
 * held 13.8 GiB evaluated alone (40 other checks held 4.9). The last tree
 * still running the tool from before #465 was pruned that day.
 */
export const CHANGED_CHECKS_GIB = 16;

/**
 * What a changed-checks run that sends itself to the builder and has
 * never been seen to run is held to here, in GiB; once seen it is held
 * to what it held (outcome.ts's `peakGibAfter`) up to this, since a run
 * the builder turned away ran here whole. Of the 546 changed-checks
 * runs recorded with a peak from 8 to 10 November, 523 were held to
 * this, and the 289 whose peak was not a shared cgroup's held 0.17 GiB at
 * the median and 0.37 at the 90th percentile; 80ECO2 counted 91 sent runs
 * at 0.16 and 0.21 at the 75th. Of the 149 runs given no flags in the 29 hours to midnight on
 * 5 November, 141 peaked at 5.8 GiB or under and 8 at 8.9 to 16.2, while
 * each waited for 16 free: changed-checks runs waited 4.1 hours on
 * memory in that time.
 * One the builder turns away at that moment runs here, past this, and
 * the room the queue reads shows it once it does.
 */
export const CHANGED_CHECKS_SENT_GIB = 6;

/**
 * cargo up to its subcommand, past a `+toolchain` and flags such as
 * `--locked`: `cargo +nightly build` and `cargo --locked build` ran with
 * no turn, as did the short aliases, `cargo b`, `cargo t` and `cargo c`.
 */
export const CARGO = String.raw`\bcargo(?:\s+\+\S+)?(?:\s+--?[\w-]+(?:=\S+)?)*\s+`;

/** nix-fast-build, which evaluates every check, then builds them. */
export const NIX_FAST_BUILD = /(?<![\w./-])nix-fast-build(?![\w.-])/;

/** An evaluation of a flake's every check, for one system or all. */
export const EVERY_CHECK =
	/\bnix(?:\s+--?\S+)*\s+eval\b[^\n]*#checks(?:\.[\w-]+)?(?![\w.-])/;

/**
 * An evaluation of a whole machine, a home or a flake's machines, by
 * `nix eval` or `nix-instantiate`: at 01:15 on 8 November one of a
 * nixosSystem through `--expr` ran at 9% beside two evaluations of
 * checks at 108% and 83%, with the machine at load 223 an hour before
 * and a deploy's tests failing under it (P9R1KI). One attribute's
 * evaluation, as a check's drvPath, still isn't heavy work. This is
 * what such an evaluation names, as a word; {@link EVALUATES} is the
 * step that runs it.
 */
export const SYSTEM_EVALUATION =
	/\b(?:nixosSystem|darwinSystem|nixosConfigurations|darwinConfigurations|homeConfigurations|homeManagerConfiguration|system\.build|toplevel)\b/;

/** A step that evaluates Nix: `nix eval` or `nix-instantiate`. */
export const EVALUATES =
	/\bnix(?:\s+--?\S+)*\s+eval\b|(?<![\w.-])nix-instantiate(?![\w.-])/;

/**
 * The argument a `nix eval` applies to what it evaluates, unquoted as
 * the shell would: `'c: builtins.attrNames c'` or `builtins.attrNames`.
 */
const APPLIED = /\s--apply\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'"|;&]+))/;

/**
 * The builtins that read a set's names, or the names and strings they
 * give, without forcing a value in the set.
 */
const NAME_BUILTINS: ReadonlySet<string> = new Set([
	"attrNames",
	"filter",
	"match",
	"map",
	"mapAttrs",
	"length",
	"elem",
	"sort",
	"lessThan",
	"head",
	"tail",
	"any",
	"all",
	"concatLists",
	"concatMap",
	"concatStringsSep",
	"stringLength",
	"substring",
	"replaceStrings",
]);

/** The words of a Nix expression that name no value. */
const NIX_WORDS: ReadonlySet<string> = new Set([
	"null",
	"true",
	"false",
	"if",
	"then",
	"else",
	"with",
	"builtins",
]);

/** A Nix string: double-quoted with its escapes, or `''` to `''`. */
const NIX_STRING = /"(?:[^"\\]|\\.)*"|''[\s\S]*?''/g;

/** A name or a path of names, such as `builtins.attrNames` or `c.foo`. */
const NIX_NAME = /[A-Za-z_][\w'-]*(?:\.[A-Za-z_][\w'-]*)*/g;

/** A lambda's parameter, as `n` in `n: ...`, never a URL's scheme. */
const NIX_PARAMETER = /([A-Za-z_][\w'-]*)\s*:(?!\/)/g;

/** The parameter of the lambda a whole expression is, as `c` in `c: ...`. */
const OUTER_PARAMETER = /^\s*([A-Za-z_][\w'-]*)\s*:(?!\/)/;

/** The value a `mapAttrs` gives its function, as `c` in `mapAttrs (s: c: ...)`. */
const MAPPED_VALUE =
	/\bmapAttrs\s*\(\s*[A-Za-z_][\w'-]*\s*:\s*([A-Za-z_][\w'-]*)\s*:(?!\/)/g;

/** What `attrNames` is given by name, as `c` in `attrNames c`. */
const NAMES_OF = /\battrNames\s+([A-Za-z_][\w'-]*)/g;

/**
 * The parameters bound to a set of checks, or of systems' checks: the
 * one the whole expression takes, the value a `mapAttrs` maps, and what
 * `attrNames` is given.
 */
function setParameters(
	bare: string,
	parameters: ReadonlySet<string>,
): Set<string> {
	const sets = new Set<string>();
	const outer = OUTER_PARAMETER.exec(bare)?.[1];
	if (outer !== undefined) sets.add(outer);
	for (const match of bare.matchAll(MAPPED_VALUE)) {
		const value = match[1];
		if (value !== undefined) sets.add(value);
	}
	for (const match of bare.matchAll(NAMES_OF)) {
		const set = match[1];
		if (set !== undefined && parameters.has(set)) sets.add(set);
	}
	return sets;
}

/**
 * Whether a set parameter's use at `at` reads only its names: where it
 * is bound, given to `attrNames`, or the set the whole expression's
 * `mapAttrs` maps last, as `c` in `c: builtins.mapAttrs (...) c`.
 */
function usesOnlyNames(bare: string, name: string, at: number): boolean {
	const before = bare.slice(0, at);
	const after = bare.slice(at + name.length);
	if (/^\s*:(?!\/)/.test(after)) return true;
	if (/\battrNames\s+$/.test(before)) return true;
	const outer = OUTER_PARAMETER.exec(bare);
	return (
		outer?.[1] === name &&
		after.trim() === "" &&
		/^\s*[A-Za-z_][\w'-]*\s*:\s*(?:builtins\.)?mapAttrs\b/.test(before)
	);
}

/**
 * Whether a `nix eval` of every check applies only what reads their
 * names, as `--apply builtins.attrNames` or a `builtins.filter` with
 * `builtins.match` over them does, so no check is evaluated: 16V6F4
 * measured core's 678 check names listed in 1.1 s at 169 MB, while the
 * queue held such an evaluation (mw13l2lv) to 24 GiB for 4,473 s on 3
 * November. Read from the words alone, so a step naming anything else,
 * a check's attribute, a `let` or a string with `${` in it, still counts
 * as evaluating every check, as does one using a set of checks other
 * than through its names, as `c: [ (builtins.attrNames c) c ]` does,
 * since `--json` forces every check in a set it returns.
 */
function appliesNamesOnly(step: string): boolean {
	const applied = APPLIED.exec(step);
	if (applied === null) return false;
	const expression =
		applied[1] ?? applied[2]?.replace(/\\(.)/g, "$1") ?? applied[3] ?? "";
	if (expression.includes("${")) return false;
	const bare = expression.replace(NIX_STRING, '""');
	const parameters = new Set(
		[...bare.matchAll(NIX_PARAMETER)].flatMap((match) => match[1] ?? []),
	);
	const names = bare.match(NIX_NAME) ?? [];
	const sets = setParameters(bare, parameters);
	for (const use of bare.matchAll(NIX_NAME)) {
		if (sets.has(use[0]) && !usesOnlyNames(bare, use[0], use.index)) {
			return false;
		}
	}
	const builtin = (name: string) => name.replace(/^builtins\./, "");
	const readsNames = (name: string) =>
		NAME_BUILTINS.has(builtin(name)) ||
		NIX_WORDS.has(name) ||
		parameters.has(name);
	return (
		names.some((name) => builtin(name) === "attrNames") &&
		names.every(readsNames)
	);
}

/**
 * A command that evaluates a whole flake's checks: `nix flake check`,
 * changed-checks, and an evaluation of every check.
 */
const WHOLE_FLAKE = new RegExp(
	[
		/\bnix(?:\s+--?\S+)*\s+flake\s+check\b/,
		CHANGED_CHECKS,
		EVERY_CHECK,
		NIX_FAST_BUILD,
	]
		.map((pattern) => pattern.source)
		.join("|"),
);

/**
 * The memory one job is held to need, in GiB: what it was judged to need
 * when it asked, from its whole step, or else from what it does, which a
 * job an older harness asked for carries alone.
 */
export function needsGibOf(
	job: Pick<Job, "kind" | "what"> & Pick<Partial<Job>, "needsGib">,
): number {
	if (job.needsGib !== undefined) return job.needsGib;
	const kind = NEEDS_GIB[job.kind];
	if (CHANGED_CHECKS.test(job.what)) return Math.max(kind, CHANGED_CHECKS_GIB);
	if (EVERY_CHECK.test(job.what)) {
		return appliesNamesOnly(job.what) ? kind : Math.max(kind, EVERY_CHECK_GIB);
	}
	if (EVAL_TESTS.test(job.what)) return Math.max(kind, EVAL_TESTS_GIB);
	return WHOLE_FLAKE.test(job.what) ? Math.max(kind, EVALUATION_GIB) : kind;
}
