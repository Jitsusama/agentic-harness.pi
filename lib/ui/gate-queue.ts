/**
 * One screen, one gate on it at a time.
 *
 * Pi's `ctx.ui.custom` supports one active component at a time. When an
 * agent fires several write calls in one turn their handlers run
 * concurrently and each tries to mount its own gate: the first wins the
 * UI and the rest either hang or silently bypass review, which is the bad
 * one, since a gate nobody saw still counts as approval.
 *
 * Slack worked this out first and kept the queue private, which held
 * while it was the only extension asking. It is not: a review tool call
 * can land while a Slack gate is already open.
 *
 * The queue lives here rather than in any one integration because what it
 * protects, the screen, belongs to none of them.
 */

/**
 * The tail of the chain, replaced by each caller.
 *
 * Holding the caught form means a rejected gate does not poison the queue
 * for whoever is next, and that the chain does not grow a handler per gate
 * for a session's whole life.
 */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Run a gate prompt with exclusive access to the UI.
 *
 * Callers wait for the gate in flight to settle, resolve or reject, before
 * their own prompt mounts. Order is the order they asked in.
 */
export async function runGate<T>(fn: () => Promise<T>): Promise<T> {
	const previous = queue;
	const next = previous.then(fn, fn);
	queue = next.catch(() => undefined);
	return await next;
}
