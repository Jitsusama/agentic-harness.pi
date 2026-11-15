/**
 * `review_offer edit`: changing a change's title, body, base, labels or
 * assignees, each said as which way it is going, behind the gate.
 *
 * Apart from `offer.ts` because it changes with what an edit can carry
 * and how adding, replacing and clearing a set are told apart.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	BoundTarget,
	FieldEdit,
	SetEdit,
} from "../../../lib/core/review/index.ts";
import { GLYPH, proposalLine } from "../render.ts";
import { confirmWrite, editPanel } from "./offer-gates.ts";
import type { OfferParams } from "./offer-request.ts";
import {
	type Answer,
	declined,
	type hostedChange,
	refuse,
	say,
} from "./shared.ts";

/**
 * How a set of labels or assignees is changing, or nothing.
 *
 * Adding is the default and replacing has to be asked for, because a
 * caller naming one label almost always means "also this" rather than
 * "only this", and guessing wrong silently removes work somebody else
 * did. Clearing is separate again, through `clear`, so emptying a set is
 * always deliberate.
 *
 * Removal wins when both are named for the same field, since asking to
 * add and remove the same label at once is a contradiction and taking it
 * off is the safer reading of it.
 */
function setEditFor(
	add: string[] | undefined,
	remove: string[] | undefined,
	cleared: boolean,
	mode: "add" | "set" | undefined,
): SetEdit<string> | undefined {
	if (cleared) return { action: "clear" };
	if (remove?.length) return { action: "remove", value: remove };
	if (!add?.length) return undefined;
	return { action: mode === "set" ? "set" : "add", value: add };
}

/** Change a title, a body, a base, labels or assignees. */
export async function edit(
	ctx: Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[4],
	change: NonNullable<ReturnType<typeof hostedChange>>,
	authoring: NonNullable<BoundTarget["provider"]["authoring"]>,
	params: OfferParams,
	caution?: string,
): Promise<Answer> {
	const clearing = new Set(params.clear ?? []);
	const set = <T>(
		value: T | undefined,
		field: string,
	): FieldEdit<T> | undefined => {
		if (clearing.has(field)) return { action: "clear" };
		return value === undefined ? undefined : { action: "set", value };
	};

	const labels = setEditFor(
		params.labels,
		params.unlabels,
		clearing.has("labels"),
		params.labelMode,
	);
	const assignees = setEditFor(
		params.assignees,
		params.unassignees,
		clearing.has("assignees"),
		params.labelMode,
	);

	const edits = {
		...(set(params.title, "title")
			? { title: set(params.title, "title") }
			: {}),
		...(set(params.body, "body") ? { body: set(params.body, "body") } : {}),
		...(set(params.base, "base") ? { base: set(params.base, "base") } : {}),
		...(labels ? { labels } : {}),
		...(assignees ? { assignees } : {}),
	};
	if (Object.keys(edits).length === 0) {
		return refuse(
			"Editing needs something to change: a title, a body, a base, labels, assignees, or a field to clear.",
		);
	}

	const decision = await confirmWrite(
		ctx,
		`Edit ${change.label}`,
		editPanel({
			label: change.label,
			edits,
			...(caution ? { caution } : {}),
		}),
	);
	if (!decision.approved) return declined(decision, "Left as it was.");

	const after = await authoring.edit(change, edits);
	// Named in the past tense, because the proposal line alone does not show
	// most of what an edit can change: labels and assignees are not on it, so
	// an edit that set a label answered with exactly what an edit that did
	// nothing would answer. It was landing correctly and reporting nothing,
	// which is only one step better than the reverse and just as hard to
	// notice, since the gate said what was coming and nothing said what came.
	const changed = Object.entries(edits).map(([field, edit]) =>
		edit?.action === "clear" ? `${field} cleared` : field,
	);
	return say(
		`${GLYPH.lands} ${proposalLine(after)}\n   ${changed.join(", ")} updated`,
	);
}
