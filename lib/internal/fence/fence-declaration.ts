/**
 * The fence a spawned session says it may run in, which the node judges
 * where it may go by. A session reading a stranger's text, or holding
 * optimus's own credentials, is strict; one that does neither may say
 * fence, and the node may then start it on another machine under a
 * strict parent (ISXEG8 [8c12af57], [28705b1b]). Nothing is inferred:
 * the spawn's word wins, then its quest's, then strict, since a doubt
 * only ever makes a run stricter. Nothing can be declared looser than
 * the fence.
 */

/** The fences a spawn may declare. */
export const DECLARED_FENCES = ["fence", "strict"] as const;

/** A fence a spawn may declare. */
export type DeclaredFence = (typeof DECLARED_FENCES)[number];

/** Who declared it: the spawn's call, its quest's README, or nobody. */
export type FenceSource = "spawn" | "quest" | "default";

/** The fence a spawn tells the node it runs in, and who said so. */
export interface FenceDeclaration {
	readonly kind: DeclaredFence;
	readonly from: FenceSource;
}

/** The fence nobody declared. */
export const UNDECLARED: FenceDeclaration = { kind: "strict", from: "default" };

/**
 * ISXEG8's two tests, word for word, which a spawn passes before it may
 * declare fence; the tool's help and refusals repeat them.
 */
export const FENCE_TESTS =
	"Declare fence only when both hold: (1) it needs none of optimus's own credentials: its TPM keys, the agents' proxy, or Joel's gcloud or World push; (2) its work reads no stranger's text: other people's PRs and issues, Slack, email, or web pages beyond docs. Strict when unsure.";

/** Whether `word` names a fence a spawn may declare. */
export function isDeclaredFence(word: unknown): word is DeclaredFence {
	return DECLARED_FENCES.some((fence) => fence === word);
}

/** What declaring `fenceWord` and `questWord` comes to, or why not. */
export type DeclarationRead =
	| { readonly ok: true; readonly declaration: FenceDeclaration }
	| { readonly ok: false; readonly refusal: string };

/**
 * The fence a spawn declares: the word its call gives, else the word its
 * quest's README gives, else strict. A word that names no fence a spawn
 * may declare is refused, never read as one, since a typo read as fence
 * would let a strict session out and one read as strict would hide the
 * mistake.
 */
export function fenceDeclared(
	fenceWord: string | undefined,
	questWord: unknown,
): DeclarationRead {
	const spawn = fenceWord?.trim();
	if (spawn) {
		return isDeclaredFence(spawn)
			? { ok: true, declaration: { kind: spawn, from: "spawn" } }
			: {
					ok: false,
					refusal: `fence is fence or strict, not "${spawn}". ${FENCE_TESTS}`,
				};
	}
	if (questWord === undefined) return { ok: true, declaration: UNDECLARED };
	return isDeclaredFence(questWord)
		? { ok: true, declaration: { kind: questWord, from: "quest" } }
		: {
				ok: false,
				refusal: `The quest's README says fence: ${JSON.stringify(questWord)}, which is neither fence nor strict; set it with need-add and fence, or name fence on the spawn.`,
			};
}

/**
 * The `PI_SANDBOX` a spawned child is given for `declaration`: the kind
 * declared, or nothing when nobody declared one, so an undeclared child
 * runs its commands as the fence's stage says rather than every spawn
 * losing its credentials at once.
 */
export function sandboxFor(
	declaration: FenceDeclaration,
): DeclaredFence | undefined {
	return declaration.from === "default" ? undefined : declaration.kind;
}

/** The declaration said in a sentence, for a spawn's answer. */
export function declarationSaid(declaration: FenceDeclaration): string {
	const by =
		declaration.from === "spawn"
			? "as the spawn declared"
			: declaration.from === "quest"
				? "as its quest declares"
				: "since nothing declared a fence";
	return `It tells the node it runs ${declaration.kind}, ${by}.`;
}
