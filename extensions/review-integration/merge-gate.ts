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

/** The keys a gate's object form may hold. */
const GATE_KEYS = new Set(["command", "minutes"]);

/** How a gate is named, for a message saying it was named wrongly. */
const GATE_FORMS = `a command, or { "command": ..., "minutes": ... } with minutes a whole number from 1 to ${MOST_GATE_MINUTES}`;

/** The gate a repo names, or why the config can't be read for one. */
export type GateFor =
	| { readonly kind: "none" }
	| ({ readonly kind: "gate" } & Gate)
	| { readonly kind: "malformed"; readonly problem: string };

/** A gate's command and how long it may run. */
export interface Gate {
	readonly command: string;
	readonly minutes: number;
}

/** The gate `review` names for one repo key. */
export function gateFor(review: unknown, repo: string): GateFor {
	if (!isRecord(review) || review.merge === undefined) return { kind: "none" };
	const merge = review.merge;
	if (
		!isRecord(merge) ||
		(merge.gates !== undefined && !isRecord(merge.gates))
	) {
		return {
			kind: "malformed",
			problem: `review.merge.gates should be an object of repo keys, each naming ${GATE_FORMS}.`,
		};
	}
	const named = isRecord(merge.gates) ? merge.gates[repo] : undefined;
	if (named === undefined) return { kind: "none" };
	const stray = isRecord(named)
		? Object.keys(named).filter((key) => !GATE_KEYS.has(key))
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
			problem: `review.merge.gates["${repo}"] should be ${GATE_FORMS}.${unknown}`,
		};
	}
	const minutes = isRecord(named) ? named.minutes : undefined;
	if (minutes === undefined) {
		return {
			kind: "gate",
			command: command.trim(),
			minutes: DEFAULT_GATE_MINUTES,
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
			problem: `review.merge.gates["${repo}"].minutes should be a whole number from 1 to ${MOST_GATE_MINUTES}, not ${JSON.stringify(minutes) ?? String(minutes)}.`,
		};
	}
	return { kind: "gate", command: command.trim(), minutes };
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
			// spawnExec's own last line, "bash aborted", names neither the
			// gate nor why; the refusal says both.
			const stderr = ran.stderr.replace(/(^|\n)bash aborted$/, "");
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
): Promise<string | undefined> {
	if (await isFolder(cwd)) return undefined;
	return `The merge gate \`${gate.command}\` couldn't run in ${cwd}: there is no such folder. Not merged; name a checkout of the repo with \`repo\`.`;
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
 * Why a gate refuses this head, or nothing when it lets it merge.
 */
export async function gateRefusal(
	gate: Gate,
	head: string,
	cwd: string,
	run: RunGate,
): Promise<string | undefined> {
	const { command } = gate;
	const missing = await missingCheckout(gate, cwd);
	if (missing !== undefined) return missing;
	let ran: GateRun;
	try {
		ran = await run(`${command} ${quoted(head)}`, cwd, gateTimeoutMs(gate));
	} catch (error) {
		return `The merge gate \`${command}\` couldn't run in ${cwd}: ${error instanceof Error ? error.message : String(error)}. Not merged.`;
	}
	if (ran.code === 0 && !ran.killed && ran.aborted !== true) return undefined;
	const said = (ran.stderr.trim() || ran.stdout.trim()).slice(-2_000);
	const tail = said ? `\n${said}` : "";
	if (ran.killed) {
		const stopped = `The merge gate \`${command}\` was still running after its ${gate.minutes} minutes at ${head.slice(0, 12)}, so it was stopped and nothing was merged.`;
		if (gate.minutes >= MOST_GATE_MINUTES) {
			return `${stopped} ${MOST_GATE_MINUTES} minutes is the most a gate may name, so the gate itself needs looking at.${tail}`;
		}
		return `${stopped} If it needs longer, give it more time in review.merge.gates, as { "command": ${JSON.stringify(command)}, "minutes": ${Math.min(gate.minutes * 2, MOST_GATE_MINUTES)} }.${tail}`;
	}
	if (ran.aborted === true) {
		return `The merge was stopped before its gate \`${command}\` answered at ${head.slice(0, 12)}. Not merged.${tail}`;
	}
	if (ran.code === NOT_FOUND) {
		return `The merge gate \`${command}\` isn't on this machine (exit ${NOT_FOUND}), so nothing could say ${head.slice(0, 12)} may merge. Not merged.${said ? `\n${said}` : ""}`;
	}
	return [
		`The merge gate \`${command}\` refused ${head.slice(0, 12)} (exit ${ran.code}), so it was not merged.`,
		said || "It said nothing about why.",
	].join("\n");
}
