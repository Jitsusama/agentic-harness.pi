/**
 * How a driver tells which of its recorded surfaces still exist.
 *
 * A handle names its surface by a scope (the socket or session that
 * reaches it) and a value inside that scope. Only a scope on this host
 * can be asked, and a scope that was not asked, or would not answer,
 * says nothing about its surfaces: unknown, never a false absent.
 */

import { hostname } from "node:os";
import {
	type TerminalProbe,
	type TerminalSessionHandle,
	terminalHandleKey,
} from "../../../../terminal/types.ts";

/** The scopes on this host that the handles name, each once. */
export function localScopes(
	handles: readonly TerminalSessionHandle[],
): Set<string> {
	const scopes = new Set<string>();
	for (const handle of handles) {
		if (handle.scope && handle.hostId === hostname()) scopes.add(handle.scope);
	}
	return scopes;
}

/**
 * Each handle's probe, from what its scope lists: present when listed,
 * absent when the scope answered without it, unknown when the scope is
 * another host's, was not asked because the probe was stopped, or
 * would not answer. Every local scope is asked at once.
 */
export async function probeByListing(
	handles: readonly TerminalSessionHandle[],
	signal: AbortSignal | undefined,
	list: (scope: string) => Promise<Iterable<string>>,
): Promise<Map<string, TerminalProbe>> {
	const live = new Map<string, Set<string> | undefined>();
	await Promise.all(
		[...localScopes(handles)].map(async (scope) => {
			if (signal?.aborted) {
				live.set(scope, undefined);
				return;
			}
			try {
				live.set(scope, new Set(await list(scope)));
			} catch {
				// A server or session that has gone, or will not answer, says
				// nothing about its surfaces; a zellij session may even be
				// resurrected. Unknown, never a false absent.
				live.set(scope, undefined);
			}
		}),
	);
	const out = new Map<string, TerminalProbe>();
	for (const handle of handles) {
		const listed =
			handle.scope && handle.hostId === hostname()
				? live.get(handle.scope)
				: undefined;
		out.set(
			terminalHandleKey(handle),
			listed === undefined
				? "unknown"
				: listed.has(handle.value)
					? "present"
					: "absent",
		);
	}
	return out;
}
