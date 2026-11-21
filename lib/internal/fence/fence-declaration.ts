/**
 * The fence a spawned session says it may run in, which the node judges
 * where it may go by. A session reading a stranger's text, or holding
 * optimus's own credentials, is strict; one that does neither may say
 * fence, and the node may then start it on another machine under a
 * strict parent (ISXEG8 [8c12af57], [28705b1b]). Nothing is inferred:
 * the spawn's word wins, then its quest's. Nothing can be declared
 * looser than the fence.
 *
 * A spawn nobody declared a fence for tells the node what it truly
 * runs, from "default", which the node never trusts to lower anything
 * (ISXEG8 [8d401568]): strict under a strict parent, which its child
 * keeps; the fence where the fence's first stage takes it; otherwise
 * none. Taking every spawn's credentials is the staged rollout's, not
 * this.
 */

/** The fences a spawn may declare. */
export const DECLARED_FENCES = ["fence", "strict"] as const;

/** A fence a spawn may declare. */
export type DeclaredFence = (typeof DECLARED_FENCES)[number];

/** Who declared it: the spawn's call, its quest's README, or nobody. */
export type FenceSource = "spawn" | "quest" | "default";

/** What a session's commands run in, as the node's Kind names it. */
export type FenceKind = "none" | DeclaredFence;

/** The fence a spawn tells the node it runs in, and who said so. */
export interface FenceDeclaration {
	readonly kind: FenceKind;
	readonly from: FenceSource;
}

/** Where a spawn nobody declared a fence for starts, and under whom. */
export interface UndeclaredStart {
	/** The environment of the session spawning it. */
	readonly parent: Readonly<Record<string, string | undefined>>;
	/** Whether the fence's first stage takes it, here. */
	readonly staged: boolean;
}

/**
 * What a spawn nobody declared a fence for runs: strict when the session
 * spawning it runs strict, since its child keeps that, the fence when the
 * first stage takes it, and none otherwise.
 */
export function undeclaredRuns(start: UndeclaredStart): FenceKind {
	if (start.parent.PI_SANDBOX?.trim() === "strict") return "strict";
	return start.staged ? "fence" : "none";
}

/**
 * ISXEG8's two tests, word for word, which a spawn passes before it may
 * declare fence; a refusal to declare one repeats them.
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
 * quest's README gives, else what it `runs` undeclared. A word that
 * names no fence a spawn may declare is refused, never read as one,
 * since a typo read as fence would let a strict session out and one
 * read as strict would hide the mistake.
 */
export function fenceDeclared(
	fenceWord: string | undefined,
	questWord: unknown,
	runs: FenceKind,
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
	if (questWord === undefined) {
		return { ok: true, declaration: { kind: runs, from: "default" } };
	}
	return isDeclaredFence(questWord)
		? { ok: true, declaration: { kind: questWord, from: "quest" } }
		: {
				ok: false,
				refusal: `The quest's README says fence: ${JSON.stringify(questWord)}, which is neither fence nor strict; set it with need-add and fence, or name fence on the spawn.`,
			};
}

/**
 * The `PI_SANDBOX` a fresh child is given for `declaration`: the kind
 * declared, and strict for an undeclared child of a strict parent, which
 * no spawn's environment would otherwise hand on. Any other undeclared
 * child gets none, so its commands run as the fence's stage says rather
 * than every spawn losing its credentials at once.
 */
export function sandboxFor(
	declaration: FenceDeclaration,
): DeclaredFence | undefined {
	if (declaration.from !== "default") {
		return isDeclaredFence(declaration.kind) ? declaration.kind : undefined;
	}
	return declaration.kind === "strict" ? "strict" : undefined;
}

/**
 * `declaration` once it is known where the spawn starts and whether the
 * first stage took it: an undeclared fence the stage didn't take, or one
 * started on another machine, which no listing here reaches, runs none.
 */
export function declarationSettled(
	declaration: FenceDeclaration,
	settled: { readonly staged: boolean; readonly here: boolean },
): FenceDeclaration {
	const unstaged = !settled.staged || !settled.here;
	return declaration.from === "default" &&
		declaration.kind === "fence" &&
		unstaged
		? { kind: "none", from: "default" }
		: declaration;
}

/** The declaration said in a sentence, for a spawn's answer. */
export function declarationSaid(declaration: FenceDeclaration): string {
	const by =
		declaration.from === "spawn"
			? "as the spawn declared"
			: declaration.from === "quest"
				? "as its quest declares"
				: "since nothing declared a fence";
	const runs = declaration.kind === "none" ? "unfenced" : declaration.kind;
	return `It tells the node it runs ${runs}, ${by}.`;
}
