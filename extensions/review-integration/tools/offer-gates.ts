/**
 * The gates `review_offer` asks through, and what each draws: the
 * propose, edit and close panels, a caution set above a gate's detail,
 * and what to say when a provider promised a method it lacks.
 *
 * Apart from the actions because a gate changes with how a write is
 * shown to the person approving it, and the panels are pure so the
 * width tests can draw them without a terminal.
 */

import type {
	FieldEdit,
	SetEdit,
} from "../../../lib/core/review/index.ts";
import { GUARDS } from "../../../lib/internal/guardian/guards.ts";
import { confirmWrite as confirmUnder } from "../gate.ts";
import { type GatePanel, GLYPH } from "../render.ts";

/** Every write this tool makes is the review-offer guard's to ask about. */
export function confirmWrite(
	ctx: Parameters<typeof confirmUnder>[0],
	title: string,
	body: string | GatePanel,
) {
	return confirmUnder(ctx, title, body, GUARDS.reviewOffer.name);
}

/**
 * What to say when a capability promised a method the provider does not have.
 *
 * Every write in this tool announces itself in the past tense on the line
 * after the call, so an optional call that resolves to undefined because
 * the method is absent tells somebody their change moved when it did not.
 * Nothing logs it, nothing retries, and the backend is untouched while the
 * session's account of it is wrong: recovery needs a person to go and look.
 *
 * The capability gate refuses first for every provider that ships
 * today, so this is what happens when one declares a capability without the
 * method behind it. That case is exactly the one a build-time check cannot
 * reach, since a provider arrives over the bus from a package that may
 * never have copied the check.
 */
export function missingMethod(providerId: string, what: string): string {
	return `The ${providerId} provider declares it can ${what} but exposes no way to do it, so nothing happened. This is a bug in the provider rather than something you did.`;
}

/**
 * A gate's detail, with a warning above it when there is one.
 *
 * The caution goes first and is marked, because a person skimming an
 * approval reads the top line and the question. Putting it under the
 * detail is the same as not saying it.
 */
export function cautioned(detail: string, caution: string | undefined): string {
	return caution ? `${GLYPH.refused} ${caution}\n\n${detail}` : detail;
}

/**
 * One field an edit changes, as the gate needs to describe it.
 *
 * The union of what a proposal edit can carry, rather than a shape of
 * this file's own: a gate that models fewer actions than the contract
 * allows draws some edits as `undefined`.
 */
export type GateEdit = FieldEdit<string> | SetEdit<string>;

/**
 * Draw the close gate.
 *
 * The comment is the payload because it is authored prose that lands on
 * the change, and it is the only part a reader cannot reconstruct.
 */
export function closePanel(gate: {
	label: string;
	comment?: string;
}): GatePanel {
	return {
		destination: gate.label,
		...(gate.comment ? { payload: { body: gate.comment } } : {}),
		// Said rather than left absent: nothing on a closed change reads as
		// abandonment to whoever finds it later.
		...(gate.comment
			? {}
			: {
					consequence: [
						"No reason will be left on it, which reads as abandonment.",
					],
				}),
	};
}

/**
 * Draw the edit gate.
 *
 * A new body is the payload, so it renders and is never clipped. It used
 * to be sliced at 200 characters, which is mid-sentence for the shortest
 * body this package will write, and the slice was invisible: what the
 * gate showed and what would land stopped being the same text.
 *
 * Every other field stays a one-line summary, since a label or a base is
 * fully described by naming it.
 */
export function editPanel(gate: {
	label: string;
	edits: Record<string, GateEdit | undefined>;
	caution?: string;
}): GatePanel {
	const body = gate.edits.body;
	const newBody =
		body?.action === "set" && typeof body.value === "string"
			? body.value
			: undefined;
	return {
		destination: gate.label,
		...(newBody === undefined ? {} : { payload: { body: newBody } }),
		consequence: [
			...(gate.caution ? [`${GLYPH.refused} ${gate.caution}`] : []),
			...Object.entries(gate.edits)
				// The body is above, drawn whole. Naming it here as well would
				// say the same edit twice.
				.filter(([field]) => !(field === "body" && newBody !== undefined))
				.map(([field, edit]) => `${field}: ${describeEdit(edit)}`),
		],
	};
}

/**
 * One edit in a phrase.
 *
 * A set edit says which way it is going, since "labels: risky" reads as a
 * replacement and usually is not one.
 */
function describeEdit(edit: GateEdit | undefined): string {
	if (edit === undefined) return "unchanged";
	if (edit.action === "clear") return "cleared";
	const value = Array.isArray(edit.value)
		? edit.value.join(", ")
		: String(edit.value);
	return edit.action === "set" ? value : `${edit.action} ${value}`;
}

/** What the propose gate needs to draw itself. */
export interface ProposalGate {
	head: string;
	base: string;
	/** The repo key, named because the checkout cannot tell you it. */
	repo: string;
	title: string;
	body: string;
	draft: boolean;
	reviewers?: string[];
	/** Fields taken from the checkout rather than given. */
	guessed?: string[];
	warnings?: string[];
	/** Something permitted that the approver still needs to know. */
	caution?: string;
}

/**
 * Draw the propose gate.
 *
 * A panel rather than a joined string, so the body reaches
 * `renderMarkdown` and the inset the way every other gate's does. A PR
 * body is the most markdown-heavy text this package produces, and raw
 * wrapping showed its section headings as literal `###`.
 *
 * Pure, which is what makes it testable: the terminal stays in the thin
 * call that shows the result.
 */
export function proposePanel(gate: ProposalGate): GatePanel {
	return {
		// The repo is named because it is the one thing here not taken from
		// the checkout, so it is the one thing a reader cannot verify by
		// knowing where they are standing.
		destination: `${gate.head} → ${gate.base} on ${gate.repo}`,
		where: `${gate.title}${gate.draft ? " · draft" : ""}`,
		...(gate.body ? { payload: { body: gate.body } } : {}),
		consequence: [
			...(gate.reviewers?.length
				? [`Asking: ${gate.reviewers.join(", ")}`]
				: []),
			// Named rather than merely used, so a wrong guess is caught here by
			// the one person who can tell.
			...(gate.guessed?.length
				? [`Taken from the checkout: ${gate.guessed.join(", ")}.`]
				: []),
			...(gate.caution ? [`${GLYPH.refused} ${gate.caution}`] : []),
			...(gate.warnings ?? []).map((warning) => `${GLYPH.refused} ${warning}`),
		],
	};
}
