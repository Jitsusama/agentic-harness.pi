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
 *
 * A tree's own git folder is written only for the trees the session
 * holds; git in another fails with the same bare words, so it gains the
 * way to hold it (ISXEG8 [0804813d]).
 *
 * The signing agent stays outside, so a signed commit, tag or rebase
 * made with git inside fails, naming only the key it couldn't use; it
 * gains the work tool's route, which signs outside (ISXEG8 [2fc080c2]).
 */

/** The line a refused rewrite of `packed-refs` gains. */
export const PACKED_REFS_ROUTE =
	"pi: the agent fence keeps a repository's shared git folder read-only, so deleting a branch or tag, `git pack-refs` and pruning a packed ref fail inside it. Do them with the work tool, which runs git outside the fence, or leave them for the person.";

/** The line git refused in a tree's own git folder gains. */
export const UNHELD_TREE_ROUTE =
	"pi: the agent fence lets git write only in the trees this session holds, so this tree's own git folder is read-only inside. Cut or take the tree with the work tool (`work tree`), then work in it, or ask the session that holds it.";

/** The line a commit git couldn't sign gains. */
export const SIGNING_ROUTE =
	"pi: the agent fence keeps the signing agent outside, so a signed commit, tag or rebase made with git inside fails. Commit with the work tool (`work record`) and rebase with `work rebase`, which sign outside the fence.";

/** Git's words for a signature it couldn't make. */
const UNSIGNED =
	/gpg failed to sign the data|No private key found for public key/;

/** Git's words for a lock on `packed-refs` it couldn't take. */
const REFUSED = /packed-refs\.lock['"]?:? .*Read-only file system/;

/** Git's words for a file in a git folder, but `packed-refs`, it couldn't write. */
const UNHELD =
	/'[^']*\/(\.git|git\/worktrees)\/(?![^']*packed-refs)[^']*': Read-only file system/;

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
	return routed(content, REFUSED, PACKED_REFS_ROUTE, record);
}

/**
 * `content` with the route added after the block where git said it
 * couldn't write a tree's own git folder, `record` called once for it;
 * or undefined, when no block says so.
 */
export function routedUnheldTree<T extends Block>(
	content: readonly T[],
	record: () => void,
): T[] | undefined {
	return routed(content, UNHELD, UNHELD_TREE_ROUTE, record);
}

/**
 * `content` with the route added after the block where git said it
 * couldn't sign, `record` called once for it; or undefined, when no
 * block says so.
 */
export function routedSigning<T extends Block>(
	content: readonly T[],
	record: () => void,
): T[] | undefined {
	return routed(content, UNSIGNED, SIGNING_ROUTE, record);
}

/** `content` with `route` after the first block `said` matches, or undefined. */
function routed<T extends Block>(
	content: readonly T[],
	said: RegExp,
	route: string,
	record: () => void,
): T[] | undefined {
	const at = content.findIndex(
		(block) => block.type === "text" && said.test(block.text ?? ""),
	);
	if (at === -1) return undefined;
	record();
	return content.map((block, index) =>
		index === at ? { ...block, text: `${block.text}\n\n${route}` } : block,
	);
}
