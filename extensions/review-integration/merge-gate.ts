/**
 * A repo's own say before a change of it merges.
 *
 * On the morning of 8 November four checks went red on core.nix's main,
 * though changed-checks had named each one: the branches that broke them
 * had built before rebasing, or built a subset. Nothing at merge time
 * asked whether the head being merged was the one that passed. So a repo
 * can name a gate in `review.merge.gates`, keyed by its repo key, and
 * review_offer merge runs it with the head's full sha before it merges:
 *
 *   "review": { "merge": { "gates": {
 *     "github:Jitsusama/core.nix": "merge-net ready"
 *   } } }
 *
 * The command runs through the shell, with the sha as its last word, in
 * a local checkout of the repo. Exit 0 lets the merge go on; any other
 * exit refuses it, with what the gate said as the reason. A gate that
 * can't run, or runs past its time, refuses too, since a gate that is
 * skipped whenever it breaks guards nothing.
 *
 * A gate is given five minutes unless it names its own time, as
 * `{ "command": "merge-net ready", "minutes": 30 }`. core.nix's gate
 * builds the merge's net, about 13 minutes on 21 November, so the
 * default refused every core.nix merge as late (1JQPPC, CUITX1). The
 * time stays the repo's to say rather than a longer default for all,
 * since a quick gate that hangs should still be told apart from a
 * slow one doing its work.
 *
 * A gate reads the head onto the base as it was, so where the base is
 * on origin is read before and after (`baseTip`), and offer-merge.ts
 * refuses when it moved: core.nix's main has no branch protection to
 * refuse two gated merges overlapping, and the longer a gate the wider
 * that window.
 *
 * A forge that lands a change through a queue puts it onto its main's
 * newest tip itself, and runs its own checks there, so comparing the
 * base guards nothing; and on World, whose main moved 40 times in 140
 * seconds on 23 November while each read took 3 to 5, it would refuse
 * nearly every gated merge. Such a gate says `"base": "queued"`, and
 * its base is neither read nor compared; the head is read again as
 * ever. A forge that merges when asked can't say it, since there the
 * base its gate read is the one the change lands on.
 *
 * `review.ready.gates` names a gate the same way for review_offer ready,
 * run with the head's full sha before a draft is marked ready: a change
 * readied before its checks ran at that head asked people to read code
 * nothing had checked (1JQPPC, 27 November). A ready gate takes no
 * `base`, since nothing lands; the head is all it judges.
 */

import { stat } from "node:fs/promises";
import {
	callSignal,
	EXIT_ABORTED,
	spawnExec,
} from "../../lib/core/exec/index.ts";
import { isRecord } from "../../lib/internal/record.ts";

/** How long a gate may take, in minutes, when it names no time of its own. */
export const DEFAULT_GATE_MINUTES = 5;

/** The longest a gate may name: past this, a merge is waiting on a stuck gate. */
export const MOST_GATE_MINUTES = 180;

/** Milliseconds in a minute. */
const MINUTE_MS = 60_000;

/**
 * How long reading where the base is on origin may take: a network round
 * trip, not a build, so a minute past this is a remote that isn't answering.
 */
const BASE_READ_MS = 2 * MINUTE_MS;

/** Exit code a shell gives a command it can't find. */
const NOT_FOUND = 127;

/** The keys a gate's object form may hold, at each stage. */
const GATE_KEYS: Readonly<Record<Stage, ReadonlySet<string>>> = {
	merge: new Set(["command", "minutes", "base"]),
	ready: new Set(["command", "minutes"]),
};

/** Which act a gate stands before: a merge, or marking a draft ready. */
export type Stage = "merge" | "ready";

/** How each stage's gate is named, and what a refusal leaves. */
const STAGE_WORDS: Readonly<
	Record<
		Stage,
		{ readonly gate: string; readonly act: string; readonly left: string }
	>
> = {
	merge: { gate: "merge gate", act: "The merge", left: "Not merged" },
	ready: {
		gate: "ready gate",
		act: "Marking it ready",
		left: "Left as a draft",
	},
};

/**
 * The forges whose merges go through a queue onto main's newest tip, by
 * the repo key's part before its colon: Delta, whose Merge Garden lands
 * World's changes.
 */
const QUEUED_FORGES = new Set(["delta"]);

/** How a gate is named at each stage, for a message saying it was named wrongly. */
const GATE_FORMS: Readonly<Record<Stage, string>> = {
	merge: `a command, or { "command": ..., "minutes": ..., "base": "queued" } with minutes a whole number from 1 to ${MOST_GATE_MINUTES} and base queued only on ${[...QUEUED_FORGES].join(", ")}`,
	ready: `a command, or { "command": ..., "minutes": ... } with minutes a whole number from 1 to ${MOST_GATE_MINUTES}`,
};

/** The gate a repo names, or why the config can't be read for one. */
export type GateFor =
	| { readonly kind: "none" }
	| ({ readonly kind: "gate" } & Gate)
	| { readonly kind: "malformed"; readonly problem: string };

/** A gate's command and how long it may run. */
export interface Gate {
	readonly command: string;
	readonly minutes: number;
	/** Set when a queue lands the change, so its base isn't read or compared. */
	readonly queued?: true;
}

/** The gate `review` names for one repo key, before a merge unless `stage` says. */
export function gateFor(
	review: unknown,
	repo: string,
	stage: Stage = "merge",
): GateFor {
	if (!isRecord(review) || review[stage] === undefined) return { kind: "none" };
	const section = review[stage];
	const forms = GATE_FORMS[stage];
	if (
		!isRecord(section) ||
		(section.gates !== undefined && !isRecord(section.gates))
	) {
		return {
			kind: "malformed",
			problem: `review.${stage}.gates should be an object of repo keys, each naming ${forms}.`,
		};
	}
	const named = isRecord(section.gates) ? section.gates[repo] : undefined;
	if (named === undefined) return { kind: "none" };
	const stray = isRecord(named)
		? Object.keys(named).filter((key) => !GATE_KEYS[stage].has(key))
		: [];
	const command = isRecord(named) ? named.command : named;
	if (
		typeof command !== "string" ||
		command.trim() === "" ||
		stray.length > 0
	) {
		const unknown =
			stray.length > 0
				? ` It holds ${stray.map((key) => `"${key}"`).join(", ")}, which a gate doesn't read, so a misspelt time isn't taken as the default.`
				: "";
		return {
			kind: "malformed",
			problem: `review.${stage}.gates["${repo}"] should be ${forms}.${unknown}`,
		};
	}
	const queued = queuedOf(isRecord(named) ? named.base : undefined, repo);
	if (typeof queued === "string") return { kind: "malformed", problem: queued };
	const minutes = isRecord(named) ? named.minutes : undefined;
	if (minutes === undefined) {
		return {
			kind: "gate",
			command: command.trim(),
			minutes: DEFAULT_GATE_MINUTES,
			...queued,
		};
	}
	if (
		typeof minutes !== "number" ||
		!Number.isInteger(minutes) ||
		minutes < 1 ||
		minutes > MOST_GATE_MINUTES
	) {
		return {
			kind: "malformed",
			problem: `review.${stage}.gates["${repo}"].minutes should be a whole number from 1 to ${MOST_GATE_MINUTES}, not ${JSON.stringify(minutes) ?? String(minutes)}.`,
		};
	}
	return { kind: "gate", command: command.trim(), minutes, ...queued };
}

/**
 * What a gate's `base` says: nothing when it names none, `queued` on a
 * forge that merges through a queue, and otherwise why it is refused.
 */
function queuedOf(
	base: unknown,
	repo: string,
): { readonly queued?: true } | string {
	if (base === undefined) return {};
	const at = `review.merge.gates["${repo}"].base`;
	if (base !== "queued") {
		return `${at} may only be "queued", not ${JSON.stringify(base) ?? String(base)}.`;
	}
	const forge = repo.split(":")[0] ?? "";
	if (QUEUED_FORGES.has(forge)) return { queued: true };
	return `${at} is "queued", but ${forge || repo} isn't known here to land every change through a queue onto its base's newest tip, so the base its gate read must be read; only ${[...QUEUED_FORGES].join(", ")} is.`;
}

/** How long a gate may run, in milliseconds. */
export function gateTimeoutMs(gate: Gate): number {
	return gate.minutes * MINUTE_MS;
}

/**
 * What running a command answered. `killed` and `aborted` say the runner
 * itself stopped it, by its clock or because the call was stopped: a gate
 * that exits 124 or 130 of its own accord is neither, and is a refusal
 * like any other exit.
 */
export interface GateRun {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly killed: boolean;
	readonly aborted?: boolean;
}

/**
 * `stderr` without the note spawnExec puts last on a run it stopped,
 * which names neither the gate nor its clock, as the refusal does:
 * "bash aborted: " and the signal's reason, which may run over lines,
 * or "bash aborted before it started". What the gate said before it,
 * even a line reading the same, stays.
 */
function withoutExecNote(stderr: string): string {
	const at = stderr.lastIndexOf("bash aborted");
	if (at === -1 || (at > 0 && stderr[at - 1] !== "\n")) return stderr;
	const note = stderr.slice(at);
	if (
		note !== "bash aborted before it started" &&
		!note.startsWith("bash aborted: ")
	)
		return stderr;
	return stderr.slice(0, Math.max(0, at - 1));
}

/** Runs a gate's shell line in a folder, killing it past `timeoutMs`. */
export type RunGate = (
	line: string,
	cwd: string,
	timeoutMs: number,
) => Promise<GateRun>;

/**
 * Runs a gate through bash in its own process group, so the clock or
 * the call being stopped (Escape) ends the gate and everything it
 * started, not only the shell.
 */
export function gateRunner(): RunGate {
	return async (line, cwd, timeoutMs) => {
		// The clock is the runner's own signal rather than spawnExec's
		// timeout, so whether it fired is known rather than guessed from an
		// exit code the gate could give itself, as `timeout(1)` gives 124.
		// The call is read when the gate starts, as spawnExec reads it.
		const call = callSignal();
		const clock = new AbortController();
		const timer = setTimeout(() => clock.abort(), timeoutMs);
		try {
			const ran = await spawnExec({ cwd, signal: clock.signal })("bash", [
				"-c",
				line,
			]);
			const stoppedHere =
				ran.code === EXIT_ABORTED &&
				(clock.signal.aborted || call?.aborted === true);
			if (!stoppedHere) return { ...ran, killed: false };
			const stderr = withoutExecNote(ran.stderr);
			const killed = clock.signal.aborted && call?.aborted !== true;
			return { ...ran, stderr, killed, aborted: !killed };
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Whether `path` is a folder a gate can run in. */
async function isFolder(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		// Missing or unreadable reads the same: the gate can't start there,
		// which the caller says.
		return false;
	}
}

/** A single-quoted word the shell reads as it is. */
function quoted(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Why a gate can't run in `cwd`, or nothing when the folder is there. The
 * real runner never throws: a folder it can't start in comes back as exit
 * 1, which would read as the gate judging the head.
 */
export async function missingCheckout(
	gate: Gate,
	cwd: string,
	stage: Stage = "merge",
): Promise<string | undefined> {
	if (await isFolder(cwd)) return undefined;
	const { gate: named, left } = STAGE_WORDS[stage];
	return `The ${named} \`${gate.command}\` couldn't run in ${cwd}: there is no such folder. ${left}; name a checkout of the repo with \`repo\`.`;
}

/**
 * The commit `base` is at on the checkout's origin, or why that couldn't
 * be read and what would mend it: naming a checkout mends a folder git
 * can't read origin in, not a stopped call or a change with no base. A gate reads the head merged onto the base as it was, so a base
 * that moves while the gate runs merges a pair nothing built: two gated
 * merges overlapping is how that happens, and the longer a gate runs the
 * likelier it is.
 */
export async function baseTip(
	base: string,
	cwd: string,
	run: RunGate,
): Promise<{ at: string } | { unread: string; fix: string }> {
	if (base === "") {
		return {
			unread: "the change names no base",
			fix: "a gated merge needs the base it lands on",
		};
	}
	const ran = await run(
		`git ls-remote --exit-code origin ${quoted(`refs/heads/${base}`)}`,
		cwd,
		BASE_READ_MS,
	);
	const at = ran.stdout.trim().split(/\s/)[0] ?? "";
	if (ran.code === 0 && !ran.killed && /^[0-9a-f]{40,64}$/.test(at)) {
		return { at };
	}
	if (ran.killed) {
		return {
			unread: "origin didn't answer in 2 minutes",
			fix: "merge again once origin answers",
		};
	}
	if (ran.aborted === true) {
		return { unread: "the call was stopped", fix: "merge again when ready" };
	}
	const said = (ran.stderr.trim() || ran.stdout.trim()).split("\n").at(-1);
	return {
		unread: `git ls-remote origin refs/heads/${base} gave exit ${ran.code}${said ? `: ${said}` : ""}`,
		fix: "name a checkout of the repo with `repo`",
	};
}

/**
 * Why a gate refuses this head, or nothing when it lets it through to
 * its `stage`: a merge, unless it says.
 */
export async function gateRefusal(
	gate: Gate,
	head: string,
	cwd: string,
	run: RunGate,
	stage: Stage = "merge",
): Promise<string | undefined> {
	const { command } = gate;
	const { gate: named, act, left } = STAGE_WORDS[stage];
	const missing = await missingCheckout(gate, cwd, stage);
	if (missing !== undefined) return missing;
	let ran: GateRun;
	try {
		ran = await run(`${command} ${quoted(head)}`, cwd, gateTimeoutMs(gate));
	} catch (error) {
		return `The ${named} \`${command}\` couldn't run in ${cwd}: ${error instanceof Error ? error.message : String(error)}. ${left}.`;
	}
	if (ran.code === 0 && !ran.killed && ran.aborted !== true) return undefined;
	const said = (ran.stderr.trim() || ran.stdout.trim()).slice(-2_000);
	const tail = said ? `\n${said}` : "";
	const at = head.slice(0, 12);
	if (ran.killed) {
		const stopped = `The ${named} \`${command}\` was still running after its ${gate.minutes} minutes at ${at}, so it was stopped. ${left}.`;
		if (gate.minutes >= MOST_GATE_MINUTES) {
			return `${stopped} ${MOST_GATE_MINUTES} minutes is the most a gate may name, so the gate itself needs looking at.${tail}`;
		}
		const queued = gate.queued ? `, "base": "queued"` : "";
		return `${stopped} If it needs longer, give it more time in review.${stage}.gates, as { "command": ${JSON.stringify(command)}, "minutes": ${Math.min(gate.minutes * 2, MOST_GATE_MINUTES)}${queued} }.${tail}`;
	}
	if (ran.aborted === true) {
		return `${act} was stopped before its gate \`${command}\` answered at ${at}. ${left}.${tail}`;
	}
	if (ran.code === NOT_FOUND) {
		return `The ${named} \`${command}\` isn't on this machine (exit ${NOT_FOUND}), so nothing could say ${at} may go on. ${left}.${tail}`;
	}
	return [
		`The ${named} \`${command}\` refused ${at} (exit ${ran.code}). ${left}.`,
		said || "It said nothing about why.",
	].join("\n");
}
