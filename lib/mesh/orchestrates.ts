/**
 * Telling the node which quests a session orchestrates.
 *
 * The node routes a message for an orchestrator by the claims it holds,
 * and refuses a quest another session already claims, so two sessions
 * that each load the same orchestrating quest can't both play it. It
 * proves who claims from the asking process: in a pi host every
 * session shares one process, so the node tells them apart only by the
 * asking process's own `PI_SESSION_ID`. A claim is therefore asked
 * through `mycelium orchestrates`, run as a child whose environment
 * names the session, rather than over the socket from the host's own
 * process, which names none.
 */

import { isRecord } from "../internal/record.ts";
import { type Ran, type RunProgram, runProgram } from "./sprout.ts";

/** What a session orchestrates: the quest it heads and those below it. */
export interface OrchestrationClaim {
	/** The orchestrating quest the session has loaded. */
	readonly heads: string;
	/** The open quests whose nearest orchestrator it is. */
	readonly quests: readonly string[];
}

/**
 * What the node said to a claim, or why it never answered. An unasked
 * claim that `mayLand` was sent and never answered, as when mycelium
 * timed out or was killed, so the node may have recorded it all the same.
 */
export type ClaimTold =
	| { readonly kind: "recorded" }
	| { readonly kind: "refused"; readonly why: string }
	| {
			readonly kind: "unasked";
			readonly why: string;
			readonly mayLand?: true;
	  };

/** Where a claim is asked from: the session's folder and environment. */
export interface ClaimPlace {
	readonly cwd: string;
	/** The session's environment, this process's unless given. */
	readonly env?: NodeJS.ProcessEnv;
}

/** How long `mycelium orchestrates` has to answer. */
export const CLAIM_PATIENCE_MS = 20_000;

/** The most of mycelium's own words a failure says. */
const MOST_SAID = 300;

/**
 * The arguments `mycelium orchestrates` is run with: the claim, or
 * `--forget` for none. Each quest is joined to its flag by `=`, and the
 * quests follow `--`, so no id read from a README starts an option.
 */
export function claimArguments(
	claim: OrchestrationClaim | "forget",
	realm: string,
): string[] {
	const head = ["orchestrates", `--realm=${realm}`];
	if (claim === "forget") return [...head, "--forget"];
	return [...head, `--heads=${claim.heads}`, "--", ...claim.quests];
}

/**
 * Tell the node in `realm` what `session` orchestrates, or that it
 * orchestrates nothing, run from the place's folder with its environment
 * naming the session. Never throws: a node that can't be asked, or
 * refuses, is said in what it answers.
 */
export async function tellOrchestrates(
	claim: OrchestrationClaim | "forget",
	session: string,
	realm: string,
	place: ClaimPlace,
	run: RunProgram = runProgram,
): Promise<ClaimTold> {
	const ran = await run("mycelium", claimArguments(claim, realm), {
		cwd: place.cwd,
		timeoutMs: CLAIM_PATIENCE_MS,
		env: { ...(place.env ?? process.env), PI_SESSION_ID: session },
	});
	return toldBy(ran);
}

/** What a run of `mycelium orchestrates` came to. */
function toldBy(ran: Ran): ClaimTold {
	if (ran.missing) return unasked("mycelium isn't installed here");
	if (ran.noFolder) return unasked("the session's folder is gone");
	if (ran.neverRan) return unasked(`mycelium couldn't start (${ran.neverRan})`);
	if (ran.timedOut)
		return sentUnanswered(
			`mycelium answered nothing in ${CLAIM_PATIENCE_MS / 1000} s`,
		);
	const reply = lastJson(ran.stdout);
	if (isRecord(reply) && typeof reply.Err === "string")
		return { kind: "refused", why: reply.Err.slice(0, MOST_SAID) };
	if (ran.code === 0 && isRecord(reply) && "Ok" in reply)
		return { kind: "recorded" };
	const said = ran.stderr.trim().slice(0, MOST_SAID);
	// Killed before it ended, its ask may already be with the node.
	if (ran.code === null)
		return sentUnanswered(said || "mycelium was stopped before it answered");
	return unasked(said || `mycelium ended with ${ran.code}`);
}

/** A claim the node never had, and why. */
function unasked(why: string): ClaimTold {
	return { kind: "unasked", why };
}

/** A claim sent that the node never answered, so it may have landed. */
function sentUnanswered(why: string): ClaimTold {
	return { kind: "unasked", why, mayLand: true };
}

/** The last line of `stdout` read as JSON, or nothing. */
function lastJson(stdout: string): unknown {
	const line = stdout.trim().split("\n").at(-1);
	if (!line) return undefined;
	try {
		return JSON.parse(line);
	} catch {
		// Not the node's reply, which toldBy reads as no answer.
		return undefined;
	}
}
