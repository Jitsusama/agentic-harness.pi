/**
 * Calls that would wait on a person who is not there.
 *
 * The gates are not the only things that open a panel. Signing in to
 * Slack or Google asks too, and overnight that panel would sit open as
 * surely as an approval does. The sign-in libraries already refuse to
 * prompt when there is no UI, so while the person is away they are
 * handed a context that says so, and the sign-in that could not be
 * offered is held for the person's return like any other call.
 */

import { hold, isAway } from "./state.ts";

/**
 * The context to hand anything that might prompt: the one given, or
 * while the person is away, one that says nobody can be asked.
 *
 * A proxy rather than a copy, because pi's context reads through
 * getters, and a spread would take a snapshot of them.
 */
export function unattended<T extends { readonly hasUI: boolean }>(ctx: T): T {
	if (!isAway()) return ctx;
	return new Proxy(ctx, {
		get: (target, key) =>
			key === "hasUI" ? false : Reflect.get(target, key, target),
	});
}

/**
 * The error to throw for a sign-in that failed while the person is
 * away, after holding it for their return. Present, the cause is
 * returned as it was.
 */
export function signInFailure(
	service: string,
	guard: string,
	cause: unknown,
): unknown {
	if (!isAway()) return cause;
	const why = cause instanceof Error ? cause.message : String(cause);
	// Held by name alone: the reason varies from call to call, and one
	// sign-in waiting is one item however many calls found it missing.
	const held = hold({ guard, title: `Sign in to ${service}` });
	return new Error(
		`${service} could not be signed in to (${why}). The user is away, so signing in was not offered; it is held as #${held.id} for their return. Carry on with work that does not need ${service}.`,
	);
}
