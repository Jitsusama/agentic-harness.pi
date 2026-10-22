/**
 * Applying the policy at the moment a guard fires.
 *
 * A redirect knows what it would refuse and why; whether it does is
 * the policy's call. This keeps that decision in one place so every
 * guard says the same thing in each mode.
 */

import { createHash } from "node:crypto";
import { hold, isAway } from "../internal/away/state.ts";
import { guardMode } from "./policy.ts";
import { reportGuard } from "./report.ts";
import type { GuardianResult } from "./types.ts";

/** What a redirected refusal adds, so the agent knows its way past. */
const OVERRIDE_HINT =
	"If this is right as it is, make the same call again, unchanged, and it will go through as a recorded override.";

/**
 * How many refusals are remembered for an override. An override is
 * nearly always the very next call, so a handful would do; the bound is
 * there so a long session cannot grow the set without end.
 */
const REMEMBERED = 64;

const REDIRECTS_KEY = Symbol.for("pi:guard-redirects");

type GlobalRedirects = Record<symbol, Set<string> | undefined>;

/** The refusals said under redirect and not yet overridden. */
function redirects(): Set<string> {
	const global = globalThis as GlobalRedirects;
	let said = global[REDIRECTS_KEY];
	if (!said) {
		said = new Set();
		global[REDIRECTS_KEY] = said;
	}
	return said;
}

/** Forget every refusal waiting for an override, as a new session does. */
export function forgetRedirects(): void {
	redirects().clear();
}

/**
 * One refusal, as the call that drew it. A digest, so a long PR body
 * costs the set forty characters rather than its own length.
 */
function signature(guard: string, reason: string, subject = ""): string {
	const digest = createHash("sha1")
		.update(reason)
		.update("\0")
		.update(subject)
		.digest("hex");
	return `${guard}\0${digest}`;
}

/**
 * A gate's verdict under the named guard's mode.
 *
 * - block: the refusal is returned as it is, every time.
 * - redirect: the refusal is returned with a line saying how to go
 *   ahead anyway. When the same refusal comes back for the same call, the
 *   call goes through and the person is shown the override. It is spent
 *   then, so the same mistake made later is said again.
 * - off: the refusal is reported to the person and the call goes ahead.
 *
 * Anything that is not a refusal passes through untouched. The title
 * names what was refused in the report. The subject is the call itself,
 * such as the command, so that a changed call is a new one even when
 * the guard would say the same thing about it; without one the reason
 * stands for the call.
 */
export function refusalUnder<R extends GuardianResult>(
	guard: string,
	verdict: R,
	title: string,
	subject?: string,
): R | undefined {
	if (!verdict || !("block" in verdict)) return verdict;
	const mode = guardMode(guard);
	if (mode === "block") return verdict;
	if (mode === "off") {
		reportGuard({ guard, kind: "waved", title, body: verdict.reason });
		return undefined;
	}
	const said = redirects();
	const key = signature(guard, verdict.reason, subject);
	if (said.delete(key)) {
		reportGuard({ guard, kind: "overridden", title, body: verdict.reason });
		return undefined;
	}
	said.add(key);
	if (said.size > REMEMBERED) {
		const oldest = said.values().next().value;
		if (oldest !== undefined) said.delete(oldest);
	}
	return { ...verdict, reason: `${verdict.reason}\n\n${OVERRIDE_HINT}` };
}

/**
 * Whether an approval should ask a person. A blocking guard asks. Any
 * other puts what it would have shown in the transcript and lets the
 * action go: the agent wrote what the panel shows, so there is nothing
 * in it for the agent to learn, and the content gates that could refuse
 * it have their own guards. The body is a thunk so a guard that will
 * ask never pays to render it twice.
 */
export function asksUnder(
	guard: string,
	title: string,
	body?: () => string,
): boolean {
	if (guardMode(guard) === "block") return true;
	const markdown = body?.();
	reportGuard({
		guard,
		kind: "shown",
		title,
		...(markdown ? { body: markdown } : {}),
	});
	return false;
}

/**
 * What an approval gate should do.
 *
 * - ask: show the panel, as a blocking gate always did.
 * - go: approve without asking.
 * - held: the person is away, so refuse with the reason, which says
 *   the call is held for their return and what happens then.
 */
export type Approval =
	| { readonly kind: "ask" }
	| { readonly kind: "go" }
	| { readonly kind: "held"; readonly reason: string };

const ASK: Approval = { kind: "ask" };
const GO: Approval = { kind: "go" };

/**
 * What an approval gate should do under its guard's mode and the
 * person's presence. Off and redirect behave as `asksUnder` does. A
 * blocking guard asks when the person is here; while they are away it
 * holds the call instead, so nothing waits on them. Nothing is ever
 * approved on the strength of a hold: once the person is back, a call
 * made again asks like any other.
 *
 * The body is a thunk for the same reason as in `asksUnder`.
 */
export function approvalUnder(
	guard: string,
	title: string,
	body?: () => string,
): Approval {
	if (!asksUnder(guard, title, body)) return GO;
	if (!isAway()) return ASK;

	const markdown = body?.();
	const held = hold({
		guard,
		title,
		...(markdown !== undefined ? { body: markdown } : {}),
	});
	reportGuard({
		guard,
		kind: "held",
		title: `#${held.id} ${title}`,
		...(markdown ? { body: markdown } : {}),
	});
	return { kind: "held", reason: heldReason(held.id, guard, title) };
}

/** What the model is told when its call is held. */
function heldReason(id: number, guard: string, title: string): string {
	return [
		`Held as #${id} (${title}): the user is away, and the ${guard} guard needs them to approve this. Nothing was sent.`,
		"Carry on with work that does not depend on it, and do not try another way round the gate.",
		"When they are back they will see it listed; if it is still wanted then, make the call again and they will be asked.",
	].join(" ");
}

/** Plain text fenced as markdown, so a report shows it verbatim. */
export function fenced(text: string): string {
	return `\`\`\`text\n${text.trimEnd()}\n\`\`\``;
}
