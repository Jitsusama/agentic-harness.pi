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
 */

import { isRecord } from "../../lib/internal/record.ts";

/** How long a gate may take, in minutes, when it names no time of its own. */
export const DEFAULT_GATE_MINUTES = 5;

/** The longest a gate may name: past this, a merge is waiting on a stuck gate. */
export const MOST_GATE_MINUTES = 180;

/** Milliseconds in a minute. */
const MINUTE_MS = 60_000;

/** Exit code a shell gives a command it can't find. */
const NOT_FOUND = 127;

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
			problem:
				"review.merge.gates should be an object of repo keys to commands.",
		};
	}
	const named = isRecord(merge.gates) ? merge.gates[repo] : undefined;
	if (named === undefined) return { kind: "none" };
	const command = isRecord(named) ? named.command : named;
	if (typeof command !== "string" || command.trim() === "") {
		return {
			kind: "malformed",
			problem: `review.merge.gates["${repo}"] should be a command, or { "command": ..., "minutes": ... }.`,
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
			problem: `review.merge.gates["${repo}"].minutes should be a whole number from 1 to ${MOST_GATE_MINUTES}.`,
		};
	}
	return { kind: "gate", command: command.trim(), minutes };
}

/** How long a gate may run, in milliseconds. */
export function gateTimeoutMs(gate: Gate): number {
	return gate.minutes * MINUTE_MS;
}

/** What running a command answered. */
export interface GateRun {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly killed: boolean;
}

/** Runs a gate's shell line in a folder, killing it past `timeoutMs`. */
export type RunGate = (
	line: string,
	cwd: string,
	timeoutMs: number,
) => Promise<GateRun>;

/** A single-quoted word the shell reads as it is. */
function quoted(word: string): string {
	return `'${word.replaceAll("'", `'\\''`)}'`;
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
	let ran: GateRun;
	try {
		ran = await run(`${command} ${quoted(head)}`, cwd, gateTimeoutMs(gate));
	} catch (error) {
		return `The merge gate \`${command}\` couldn't run in ${cwd}: ${error instanceof Error ? error.message : String(error)}. Not merged.`;
	}
	if (ran.code === 0 && !ran.killed) return undefined;
	const said = (ran.stderr.trim() || ran.stdout.trim()).slice(-2_000);
	if (ran.killed) {
		return `The merge gate \`${command}\` ran past its ${gate.minutes} minutes at ${head.slice(0, 12)}, so it was not merged. A gate that needs longer names its time in review.merge.gates as { "command": ..., "minutes": ... }.${said ? `\n${said}` : ""}`;
	}
	if (ran.code === NOT_FOUND) {
		return `The merge gate \`${command}\` isn't on this machine (exit ${NOT_FOUND}), so nothing could say ${head.slice(0, 12)} may merge. Not merged.${said ? `\n${said}` : ""}`;
	}
	return [
		`The merge gate \`${command}\` refused ${head.slice(0, 12)} (exit ${ran.code}), so it was not merged.`,
		said || "It said nothing about why.",
	].join("\n");
}
