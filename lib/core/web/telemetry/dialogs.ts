/**
 * The dialogs a page put up, and what was said back.
 *
 * A dialog is not a passive event. Until something answers it,
 * the page is stopped: no script runs, no action lands, and
 * anything waiting on the page waits forever. So a session
 * always has an answer ready, and records what it gave.
 */

/** What the page asked for. */
export type DialogKind = "alert" | "confirm" | "prompt" | "beforeunload";

/** How dialogs get answered while nobody is watching. */
export interface DialogPolicy {
	/** Accept, or dismiss. Dismissing is the cautious default. */
	readonly accept: boolean;
	/** What to type into a prompt when accepting one. */
	readonly promptText?: string;
}

/** One dialog, and the answer it was given. */
export interface DialogEvent {
	readonly kind: DialogKind;
	readonly message: string;
	readonly defaultPrompt?: string;
	readonly accepted: boolean;
	readonly reply?: string;
	readonly url?: string;
}

/**
 * Dismiss unless told otherwise.
 *
 * Dismissing is the answer that changes least: a confirm that
 * guards a deletion gets a no, and a prompt gets nothing rather
 * than a value nobody chose. Accepting can be asked for.
 */
export const DEFAULT_DIALOG_POLICY: DialogPolicy = { accept: false };

/** What the page asked, and what it was told. */
export function renderDialogs(dialogs: readonly DialogEvent[]): string {
	if (dialogs.length === 0) return "The page has not opened a dialog.";

	return dialogs
		.map((dialog) => {
			const answered = dialog.accepted ? "accepted" : "dismissed";
			const typed =
				dialog.reply === undefined || dialog.reply === ""
					? ""
					: ` with "${dialog.reply}"`;
			return `${dialog.kind}: ${dialog.message}\n  ${answered}${typed}`;
		})
		.join("\n");
}

/** How a dialog of this kind would be answered under this policy. */
export function answerFor(
	kind: DialogKind,
	policy: DialogPolicy,
): { accept: boolean; promptText?: string } {
	// Only a prompt has anywhere to put text, and sending it to
	// the others would be meaningless rather than harmless.
	return kind === "prompt" && policy.accept && policy.promptText !== undefined
		? { accept: policy.accept, promptText: policy.promptText }
		: { accept: policy.accept };
}
