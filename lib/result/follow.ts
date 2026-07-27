/**
 * Whether anything in this process can follow a handle.
 *
 * Every citation ends by telling the reader to query the handle
 * with result_query. That tool comes from one extension, and the
 * extensions that mint handles come from several others, each
 * loadable on its own. Load the browser tools without the store
 * tools and every citation names a tool that is not there, which
 * is worse than a long answer: the reader is told the rest of the
 * data is one call away and the call does not exist.
 *
 * Kept on globalThis rather than in a module variable, because a
 * module variable is not process-global here. Pi loads each
 * extension separately, so two extensions importing this file get
 * two copies of it, and the copy the store extension wrote to was
 * not the copy the browser extension read from. Driving a real
 * page is what showed it: every citation said no tool could
 * follow the handle, in a session where result_query read them
 * all perfectly well. The symbol-keyed slot is the same mechanism
 * lib/internal/registry uses for the same reason, and it also
 * survives a module reimport.
 */

/** Where the offer lives, shared by every copy of this module. */
const SLOT = Symbol.for("pi:agentic-harness:result-query-tool");

type Host = Record<symbol, string | undefined>;

/**
 * Declare that a tool in this process can follow handles.
 *
 * Called by whichever extension registers the query tool, on
 * activation. Idempotent.
 */
export function offerQueryTool(name: string): void {
	(globalThis as Host)[SLOT] = name;
}

/** Withdraw the offer, when the extension goes away or a test ends. */
export function withdrawQueryTool(): void {
	(globalThis as Host)[SLOT] = undefined;
}

/** The tool a citation should name, or undefined when there is none. */
export function queryTool(): string | undefined {
	return (globalThis as Host)[SLOT];
}
