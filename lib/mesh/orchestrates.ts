/**
 * Telling the node which quests a session orchestrates.
 *
 * The node routes a message for an orchestrator by the claims it holds,
 * and refuses a quest another session already claims, so two sessions
 * that each load the same orchestrating quest can't both play it. It
 * takes who claims from the asking process: in a pi host every
 * session shares one process, so the node tells them apart only by the
 * asking process's own `PI_SESSION_ID`. That is no proof: any process
 * of the same account can set it, so a claim is only as trustworthy as
 * every process the account runs, its agents' shells among them. A
 * claim is therefore asked
 * through `mycelium orchestrates`, run as a child whose environment
 * names the session, rather than over the socket from the host's own
 * process, which names none.
 */

import { isRecord } from "../internal/record.ts";
import { NOTHING_SHOWN, shownLines } from "./shown-line.ts";
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

/** Where a claim is asked from: the session's environment. */
export interface ClaimPlace {
	/** The session's environment, this process's unless given. */
	readonly env?: NodeJS.ProcessEnv;
}

/**
 * The folder `mycelium orchestrates` runs in. A claim names its realm
 * and session and reads nothing of its folder, so it runs from one that
 * is always there, never the session's: that may be a quest's tree a
 * sweep has taken, which would leave a claim no forget could reach, and
 * a relative entry on the session's PATH would find a `mycelium` its
 * agent wrote there.
 */
const ASKED_FROM = "/";

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
 * orchestrates nothing, run from {@link ASKED_FROM} with the place's
 * environment naming the session. Never throws: a node that can't be asked, or
 * refuses, is said in what it answers, on one line.
 */
export async function tellOrchestrates(
	claim: OrchestrationClaim | "forget",
	session: string,
	realm: string,
	place: ClaimPlace,
	run: RunProgram = runProgram,
): Promise<ClaimTold> {
	const ran = await run("mycelium", claimArguments(claim, realm), {
		cwd: ASKED_FROM,
		timeoutMs: CLAIM_PATIENCE_MS,
		env: { ...(place.env ?? process.env), PI_SESSION_ID: session },
	});
	return toldBy(ran);
}

/** What a run of `mycelium orchestrates` came to. */
function toldBy(ran: Ran): ClaimTold {
	if (ran.missing) return unasked("mycelium isn't installed here");
	if (ran.noFolder) return unasked(`mycelium's folder, ${ASKED_FROM}, is gone`);
	if (ran.neverRan) return unasked(`mycelium couldn't start (${ran.neverRan})`);
	if (ran.timedOut)
		return sentUnanswered(
			`mycelium answered nothing in ${CLAIM_PATIENCE_MS / 1000} s`,
		);
	const reply = lastJson(ran.stdout);
	if (isRecord(reply) && typeof reply.Err === "string") {
		const why =
			oneLine(reply.Err) || `the node refused and said ${hiddenOr(reply.Err)}`;
		return { kind: "refused", why };
	}
	if (ran.code === 0 && isRecord(reply) && "Ok" in reply)
		return { kind: "recorded" };
	const said = oneLine(ran.stderr);
	// Killed before it ended, its ask may already be with the node; and one
	// that ended well with words it can't read most likely was recorded,
	// which costs no more than a forget to treat as maybe.
	// Words that hide alone are said to be there, so they never read as none.
	const quiet = ran.stderr.trim() ? ` and said ${NOTHING_SHOWN}` : "";
	if (ran.code === null)
		return sentUnanswered(
			said || `mycelium was stopped before it answered${quiet}`,
		);
	if (ran.code === 0)
		return sentUnanswered(
			said || `mycelium ended well with no reply it reads${quiet}`,
		);
	return unasked(said || `mycelium ended with ${ran.code}${quiet}`);
}

/** "nothing that shows" where `said` holds words that all hide, else "nothing". */
function hiddenOr(said: string): string {
	return said.trim() ? NOTHING_SHOWN : "nothing";
}

/**
 * What mycelium or the node said, as it shows (shownLines), cut short
 * and folded onto one line, so it is one journal entry, the same trouble
 * reads the same each time, and no escape a peer relayed is journalled.
 */
function oneLine(said: string): string {
	return shownLines(said, MOST_SAID);
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
