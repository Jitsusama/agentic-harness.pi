/**
 * Whether anything in this process can follow a handle.
 *
 * Every citation ends by telling the reader how to query the
 * handle. That capability comes from one consumer of this library,
 * and the consumers that mint handles are others, each loadable on
 * their own. Load a browser tool without a query tool and every
 * citation names a tool that is not there, which is worse than a
 * long answer: the reader is told the rest of the data is one call
 * away and the call does not exist.
 *
 * Kept on globalThis rather than in a module variable, because a
 * module variable is not process-global when a host loads each
 * consumer as its own module instance (pi loads each extension
 * separately, for one). The symbol-keyed slot is the same
 * mechanism the other registries in this package use for the same
 * reason, and it also survives a module reimport.
 */

/** Where the offer lives, shared by every copy of this module. */
const SLOT = Symbol.for("pi:agentic-harness:result-query-tool");

type Host = Record<symbol, string | undefined>;

/**
 * Declare that a tool in this process can follow handles.
 *
 * Called by whichever consumer registers the query tool, on
 * activation. Idempotent.
 */
export function offerQueryTool(name: string): void {
	(globalThis as Host)[SLOT] = name;
}

/** Withdraw the offer, when the consumer goes away or a test ends. */
export function withdrawQueryTool(): void {
	(globalThis as Host)[SLOT] = undefined;
}

/** The tool a citation should name, or undefined when there is none. */
export function queryTool(): string | undefined {
	return (globalThis as Host)[SLOT];
}
