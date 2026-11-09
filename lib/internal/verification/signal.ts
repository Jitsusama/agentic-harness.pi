/**
 * Conversation-owned verification check, process-global on plain pi.
 *
 * The verification workflow offers a check here so another extension
 * can ask whether the code is failing without a shared import graph.
 * The commit guardian asks it when a commit arrives, to refuse one
 * while the tree it lands from has errors.
 *
 * It is a question rather than a stored answer on purpose. A stored
 * "failing" said what was true when it was written, and the commit
 * guardian kept refusing on it after the errors were fixed, and after
 * a check that ran in another directory entirely. Asking at commit
 * time means the answer describes the code as it stands.
 *
 * Shared across independently loaded extensions through session slots
 * in a host, and the original global symbol on plain pi.
 * When nothing offers a check the answer is that nothing is failing.
 */

import {
	hosted,
	type SessionRef,
	sessionSlot,
} from "../../core/session/index.ts";

/** Where a commit lands, and the run that asks on its behalf. */
export interface VerificationScope {
	/** The directory the commit runs in; omitted when it cannot be told. */
	readonly dir?: string;
	/** Stops the check when the run that asked is stopped. */
	readonly signal?: AbortSignal;
}

/** What verification found failing, confirmed when it was asked. */
export interface VerificationFailure {
	/** One line per problem: a file position and its message, or a check. */
	readonly problems: readonly string[];
}

/** Answers whether anything in a scope is failing right now. */
export type VerificationCheck = (
	scope: VerificationScope,
) => Promise<VerificationFailure | undefined>;

const CHECK_KEY = Symbol.for("pi:verification-check:v1");

type GlobalCheck = Record<symbol, VerificationCheck | undefined>;

function hostedCheck(ref?: SessionRef): { check?: VerificationCheck } {
	return sessionSlot<{ check?: VerificationCheck }>(
		"pi:verification-check:v1",
		ref,
		() => ({}),
	);
}

/** Offer this conversation's check, or withdraw only its check with undefined. */
export function provideVerificationCheck(
	check: VerificationCheck | undefined,
	ref?: SessionRef,
): void {
	if (hosted()) {
		hostedCheck(ref).check = check;
	} else {
		(globalThis as GlobalCheck)[CHECK_KEY] = check;
	}
}

/** What is failing in the scope right now, or undefined when nothing is. */
export async function currentVerificationFailure(
	scope: VerificationScope,
	ref?: SessionRef,
): Promise<VerificationFailure | undefined> {
	const check = hosted()
		? hostedCheck(ref).check
		: (globalThis as GlobalCheck)[CHECK_KEY];
	if (!check) return undefined;
	return check(scope);
}
