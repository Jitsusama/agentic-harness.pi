/**
 * What a failure to read a file or folder says of it: nothing there, a
 * fault that may pass, or something wrong with that one path.
 *
 * Readers that keep what they read decide by it whether to keep their
 * last answer or move on. Read a passing fault as "nothing there" and a
 * listing loses a tree; read a lasting one as passing and a listing
 * never moves again, so readers of one folder share one definition.
 */

/**
 * The faults of the moment rather than of the path: the process out of
 * descriptors or memory, the kernel asking to try again, or a call cut
 * short by a signal. Each says nothing of the file, and the next try
 * may well read it.
 */
const PASSING = new Set([
	"EMFILE",
	"ENFILE",
	"EAGAIN",
	"EBUSY",
	"EINTR",
	"ENOMEM",
]);

/** The errno a failure carries, when it carries one. */
export function errnoOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) {
		return undefined;
	}
	return typeof error.code === "string" ? error.code : undefined;
}

/** Whether a failure says nothing is at the path, nor along it. */
export function isGone(error: unknown): boolean {
	const code = errnoOf(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Whether a failure is a fault of the moment that says nothing of the
 * path, so a reader should keep what it had and try again.
 */
export function isPassingFault(error: unknown): boolean {
	const code = errnoOf(error);
	return code !== undefined && PASSING.has(code);
}
