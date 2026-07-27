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
 * Process-global because it describes a process-global fact, the
 * same way lib/internal/git holds the bypass state: which tools a
 * session has loaded is not a property of any one store, any one
 * citation, or any one caller, and threading it through twenty
 * call sites would only make each of them repeat the answer.
 */

/** The tool that can read a handle, when one is loaded. */
let follower: string | undefined;

/**
 * Declare that a tool in this process can follow handles.
 *
 * Called by whichever extension registers the query tool, on
 * activation. Idempotent.
 */
export function offerQueryTool(name: string): void {
	follower = name;
}

/** Withdraw the offer, when the extension goes away or a test ends. */
export function withdrawQueryTool(): void {
	follower = undefined;
}

/** The tool a citation should name, or undefined when there is none. */
export function queryTool(): string | undefined {
	return follower;
}
