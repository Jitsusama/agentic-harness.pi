/**
 * The kinds of paragraph worth quoting past a compaction, and the
 * questions that find them.
 *
 * A summary paraphrases, and what a paraphrase loses first is the
 * exact wording of a standing instruction or a correction. These kinds
 * name the paragraphs whose wording matters later: what the user
 * asked for and ruled out, what was settled, what is still open and
 * what was learned. Each has a question for tagging a paragraph and a
 * question for asking, later, whether it still holds.
 */

/** A kind of paragraph worth keeping in its own words. */
export type SelectionKind =
	| "rule"
	| "correction"
	| "goal"
	| "decision"
	| "open"
	| "failure"
	| "finding"
	| "change"
	| "done";

/** A yes-or-no question as the classifier is asked it. */
export interface KindQuestion {
	readonly ask: string;
	readonly yes: string;
	readonly no: string;
}

/** Everything the selection knows about one kind. */
export interface KindDefinition {
	/** How the kind is headed where its excerpts are quoted. */
	readonly heading: string;
	/** Only the user can say this kind of thing. */
	readonly userOnly: boolean;
	readonly tag: KindQuestion;
	/** Whether a paragraph of this kind still holds by the end. */
	readonly holds: KindQuestion;
}

/**
 * Every kind, most durable first. The order decides which kind a
 * paragraph with several is quoted under, and the order kinds take
 * turns in once the budget is shared.
 */
export const SELECTION_KINDS: readonly SelectionKind[] = [
	"rule",
	"correction",
	"goal",
	"decision",
	"open",
	"failure",
	"finding",
	"change",
	"done",
];

/** The kinds quoted before any other, since losing one repeats a mistake. */
export const FIRST_KINDS: ReadonlySet<SelectionKind> = new Set([
	"rule",
	"correction",
]);

export const KIND_DEFINITIONS: Readonly<Record<SelectionKind, KindDefinition>> =
	{
		rule: {
			heading: "Standing instructions",
			userOnly: false,
			tag: {
				ask: "Does this paragraph set a standing instruction, preference or constraint for how the work should be done?",
				yes: "It says what to always do, never do, or prefer, beyond the current step.",
				no: "It is about this step only, or it sets nothing.",
			},
			holds: {
				ask: "Is this instruction still in force at the end of the conversation?",
				yes: "Nothing later withdraws or replaces it.",
				no: "A later message withdraws, reverses or replaces it.",
			},
		},
		correction: {
			heading: "Corrections",
			userOnly: false,
			tag: {
				ask: "Does this paragraph correct a mistake, a wrong assumption or a misunderstanding?",
				yes: "It says something done or believed was wrong and what is right instead.",
				no: "It corrects nothing.",
			},
			holds: {
				ask: "Does this correction still hold at the end of the conversation?",
				yes: "Nothing later undoes it.",
				no: "A later message undoes it or shows it was itself wrong.",
			},
		},
		goal: {
			heading: "Goals",
			userOnly: true,
			tag: {
				ask: "Does this paragraph state what the work is for or what should come out of it?",
				yes: "It names an aim, an outcome or a requirement of the work.",
				no: "It states no aim.",
			},
			holds: {
				ask: "Is this goal still wanted at the end of the conversation?",
				yes: "It is still being worked towards, or it frames the work.",
				no: "It was dropped, replaced, or fully met and closed.",
			},
		},
		decision: {
			heading: "Decisions",
			userOnly: false,
			tag: {
				ask: "Does this paragraph settle a choice between options?",
				yes: "It says which way the work goes, and usually why.",
				no: "It settles nothing, or only weighs options.",
			},
			holds: {
				ask: "Does this decision still stand at the end of the conversation?",
				yes: "Nothing later reverses it.",
				no: "A later message reverses or replaces it.",
			},
		},
		open: {
			heading: "Still open",
			userOnly: false,
			tag: {
				ask: "Does this paragraph leave something to be done, answered or decided later?",
				yes: "It names a next step, an open question, a promise or something blocked.",
				no: "It leaves nothing outstanding.",
			},
			holds: {
				ask: "Is this still outstanding at the end of the conversation?",
				yes: "Nothing later shows it done, answered or dropped.",
				no: "A later message shows it done, answered or dropped.",
			},
		},
		failure: {
			heading: "What failed",
			userOnly: false,
			tag: {
				ask: "Does this paragraph report that an approach, a command or a test failed, and how?",
				yes: "It says what went wrong in a way worth not repeating.",
				no: "It reports no failure.",
			},
			holds: {
				ask: "Is this failure still worth knowing at the end of the conversation?",
				yes: "The approach could still be tried again by mistake, or the failure still stands.",
				no: "It was fixed and nothing about it matters any more.",
			},
		},
		finding: {
			heading: "Findings",
			userOnly: false,
			tag: {
				ask: "Does this paragraph establish a fact about the system, the code or the data that later work relies on?",
				yes: "It says how something is, found by reading, running or measuring.",
				no: "It establishes no fact, or only a guess.",
			},
			holds: {
				ask: "Is this finding still true at the end of the conversation?",
				yes: "Nothing later contradicts it or changes what it describes.",
				no: "A later message contradicts it, or a later change made it untrue.",
			},
		},
		change: {
			heading: "Changes made",
			userOnly: false,
			tag: {
				ask: "Does this paragraph say what was changed, where?",
				yes: "It names files, settings or systems that were changed and how.",
				no: "It describes no change that was made.",
			},
			holds: {
				ask: "Is this change still in place at the end of the conversation?",
				yes: "Nothing later reverts or replaces it.",
				no: "A later message reverts or replaces it.",
			},
		},
		done: {
			heading: "Done",
			userOnly: false,
			tag: {
				ask: "Does this paragraph say a piece of the work is finished?",
				yes: "It reports something complete, merged, shipped or passing.",
				no: "It reports nothing finished.",
			},
			holds: {
				ask: "Is this still finished at the end of the conversation?",
				yes: "Nothing later reopens it.",
				no: "A later message reopens or undoes it.",
			},
		},
	};

/** The kinds a paragraph from this speaker can be tagged with. */
export function kindsFor(speaker: "user" | "assistant"): SelectionKind[] {
	return SELECTION_KINDS.filter(
		(kind) => speaker === "user" || !KIND_DEFINITIONS[kind].userOnly,
	);
}

/** Whether a value names a selection kind. */
export function isSelectionKind(value: unknown): value is SelectionKind {
	return (
		typeof value === "string" &&
		(SELECTION_KINDS as readonly string[]).includes(value)
	);
}
