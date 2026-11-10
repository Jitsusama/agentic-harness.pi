/**
 * Whether anything in this conversation can follow a handle.
 *
 * Every citation ends by telling the reader how to query the
 * handle. That capability comes from one consumer of this library,
 * and the consumers that mint handles are others, each loadable on
 * their own. Load a browser tool without a query tool and every
 * citation names a tool that is not there, which is worse than a
 * long answer: the reader is told the rest of the data is one call
 * away and the call does not exist.
 *
 * Kept in a session cell rather than a module variable, because a
 * module variable is not shared when a host loads each consumer as
 * its own module instance (pi loads each extension separately, for
 * one). On plain pi the cell is the process's own symbol-keyed
 * slot, as it always was, so it also survives a module reimport. In
 * a host each conversation loads its own project's extensions, so
 * one conversation's query tool says nothing of another's: each
 * offers its own, at activation, inside that conversation.
 */

import { sessionCell } from "../session/index.ts";

/** Where the offer lives, shared by every copy of this module. */
const NAME = "pi:agentic-harness:result-query-tool";

/**
 * Declare that a tool in this conversation can follow handles.
 *
 * Called by whichever consumer registers the query tool, on
 * activation. Idempotent.
 */
export function offerQueryTool(name: string): void {
	sessionCell<string>(NAME).set(name);
}

/** Withdraw the offer, when the consumer goes away or a test ends. */
export function withdrawQueryTool(): void {
	sessionCell<string>(NAME).clear();
}

/** The tool a citation should name, or undefined when there is none. */
export function queryTool(): string | undefined {
	return sessionCell<string>(NAME).get();
}
