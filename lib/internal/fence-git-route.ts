/**
 * Why git refused a fenced command, and where to go instead. A
 * worktree's shared git folder stays read-only inside the agent fence,
 * since a watch over a writable one loses a race to git outside
 * (`fence-git-root.ts`). Objects, refs and logs stay writable, so
 * commits, branches, fetches and rebases work, but whatever rewrites
 * `packed-refs` fails: deleting a branch or tag, `git pack-refs`, and
 * a fetch pruning a packed ref. Git's own error doesn't say why, so
 * the output that holds it gains a line naming the route, and each is
 * counted, to see how often agents meet it (ISXEG8 [753f43b4]).
 */

/** The line a refused rewrite of `packed-refs` gains. */
export const PACKED_REFS_ROUTE =
	"pi: the agent fence keeps a repository's shared git folder read-only, so deleting a branch or tag, `git pack-refs` and pruning a packed ref fail inside it. Do them with the work tool, which runs git outside the fence, or leave them for the person.";

/** Git's words for a lock on `packed-refs` it couldn't take. */
const REFUSED = /packed-refs\.lock['"]?:? .*Read-only file system/;

/** One block of a tool's output, as pi hands it to `tool_result`. */
type Block = { readonly type: string; readonly text?: string };

/**
 * `content` with the route added after the block where git said it
 * couldn't rewrite `packed-refs`, `record` called once for it; or
 * undefined, when no block says so.
 */
export function routedPackedRefs<T extends Block>(
	content: readonly T[],
	record: () => void,
): T[] | undefined {
	const at = content.findIndex(
		(block) => block.type === "text" && REFUSED.test(block.text ?? ""),
	);
	if (at === -1) return undefined;
	record();
	return content.map((block, index) =>
		index === at
			? { ...block, text: `${block.text}\n\n${PACKED_REFS_ROUTE}` }
			: block,
	);
}
