/**
 * Fields two GitHub readers both need.
 *
 * There are two places that turn a REST pull request into a
 * {@link Proposal}: the proposals facet, which reads changes, and the
 * authoring facet, which reads back the change it just wrote. They are
 * near-duplicates and predate this file, and merging them is a real
 * refactor rather than a detail of adding a field.
 *
 * What this file refuses to do is make the duplication worse. A reader
 * added to one and forgotten in the other means a label that appears
 * when you fetch a change and vanishes when you edit it, which reads as
 * the edit having removed it.
 */

import type { Actor } from "../../change.js";

/** Every string in an array of records under one key. */
function names(value: unknown, key: string): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const found: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null) continue;
		const held = (entry as Record<string, unknown>)[key];
		if (typeof held === "string" && held !== "") found.push(held);
	}
	return found;
}

/**
 * Labels and assignees, when GitHub reported them.
 *
 * Both are carried on the pull request representation itself, so reading
 * them costs nothing extra even though writing them takes a separate
 * call to the issue routes.
 *
 * Each field is present only when GitHub sent the array. An empty array
 * and an absent field are different facts: the first says this change
 * has no labels, the second says nobody looked.
 */
export function labelsAndAssignees(raw: Record<string, unknown>): {
	labels?: string[];
	assignees?: Actor[];
} {
	const labels = names(raw.labels, "name");
	const logins = names(raw.assignees, "login");
	return {
		...(labels ? { labels } : {}),
		...(logins ? { assignees: logins.map((id): Actor => ({ id })) } : {}),
	};
}
