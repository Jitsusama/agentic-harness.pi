/**
 * Whether a change could land, and what is in the way.
 *
 * Every backend surveyed answers this, and every one of them answers it with more than a
 * boolean: a word for the state plus flags for the things holding it up. Reducing that to
 * `mergeable: false` throws away the only part anybody can act on, and worse, it reads the
 * same whether the fix is a review, a rebase or a green build.
 *
 * So the flags are separate and all optional, because absent means unreported. A backend
 * with no view on whether a required check is failing must not be read as saying none is.
 */

/** Where a change stands with landing, as the backend describes it. */
export interface Landability {
	/**
	 * The backend's own word, passed through.
	 *
	 * Kept because a backend can know a reason this model has no flag for, and losing
	 * it would turn a specific answer into an unexplained silence.
	 */
	reason?: string;
	/** At least one approving review. */
	approved?: boolean;
	/** A review asked for changes. */
	changesRequested?: boolean;
	/** A check the base branch requires is failing. */
	failingRequiredCheck?: boolean;
	/** The branch no longer merges cleanly into its base. */
	conflicted?: boolean;
}

/** Blockers in the order somebody has to deal with them. */
const BLOCKERS: readonly {
	readonly of: keyof Landability;
	readonly said: string;
	/** Backend words this phrasing already covers, so they are not said twice. */
	readonly covers: readonly string[];
}[] = [
	{
		of: "conflicted",
		said: "it conflicts with its base",
		covers: ["conflicting", "dirty", "conflict"],
	},
	{
		of: "changesRequested",
		said: "changes were requested",
		covers: ["changes_requested"],
	},
	{
		of: "failingRequiredCheck",
		said: "a required check is failing",
		covers: ["failing_required_check", "blocked", "unstable"],
	},
];

/**
 * Say where a change stands with landing, in one line, or nothing at all.
 *
 * Every blocker is named rather than only the first, because a change with changes
 * requested and a failing check needs two fixes and being told about one of them sends
 * somebody back a second time.
 */
export function standsAt(landing: Landability | undefined): string {
	if (landing === undefined) return "";

	const stopping = BLOCKERS.filter((blocker) => landing[blocker.of] === true);
	const word = landing.reason?.trim().toLowerCase();
	const spoken = stopping.some((blocker) =>
		blocker.covers.includes(word ?? ""),
	);
	// The backend's word only when the flags did not already say it, or the line
	// reads as the same sentence twice in two vocabularies.
	const aside = word === undefined || word === "" || spoken ? "" : ` (${word})`;

	// Approval is said only when it is true. `approved: false` does not mean a
	// review is required, since plenty of repos ask for none, so reporting the
	// negative would invent a blocker the backend never claimed. Said even
	// alongside blockers, because "approved, but a check is failing" is a
	// different situation from "nobody has looked and a check is failing".
	const reviewed = landing.approved === true ? ", approved" : "";

	if (stopping.length > 0) {
		return `cannot land: ${stopping.map((blocker) => blocker.said).join(", and ")}${aside}${reviewed}`;
	}
	// Only the backend can say a change is clear. Nothing in the way is not the
	// same fact, since this model has no flag for every reason a backend has.
	if (word !== undefined && word !== "") {
		return CLEAR.includes(word)
			? `can land${aside}${reviewed}`
			: `cannot land${aside}${reviewed}`;
	}
	// Approval on its own is worth saying even when the backend named no state,
	// since somebody asking whether a change is ready wants to know a human has
	// looked at it.
	return reviewed === "" ? "" : "approved";
}

/** Backend words that mean nothing is holding the change up. */
const CLEAR: readonly string[] = ["mergeable", "clean", "ready", "has_hooks"];
