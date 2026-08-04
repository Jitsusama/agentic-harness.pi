/**
 * V2 and V3 of the validation plan: the same width rule, swept across every
 * gate that draws authored prose, not just the propose gate.
 *
 * The sweep exists because of how the last report arrived. The propose gate
 * was fixed and the person came back saying the PR gate was still broken,
 * which was true: `gh pr edit` is drawn by a different function in a
 * different module, titled "PR Edit", and only its sibling had been touched.
 * A rule held in one place and checked in one place is a rule that half the
 * surface does not follow.
 *
 * So every panel-drawing path a body can reach is measured here, and adding a
 * gate without adding it to this list is the omission worth catching.
 */

import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { gateLines } from "../../extensions/review-integration/render.js";
import {
	closePanel,
	editPanel,
	proposePanel,
} from "../../extensions/review-integration/tools/offer.js";
import { primaryPanelFor } from "../../extensions/review-integration/tools/publish-gate.js";
import {
	entityGateLines,
	type ReviewableEntity,
} from "../../lib/internal/guardian/review-entity.js";
import { fakeTheme } from "../lib/ui/fake-theme.js";

const WIDTHS = [60, 80, 120, 200];

/** A body long enough to wrap, with a construct that pads and one that does not. */
const BODY = [
	"### 🌐 Situation",
	"",
	"A rule held in one place is followed by one place. This body wraps at",
	"every width under test and carries `a code span` and a list.",
	"",
	"- One item",
	"- Another",
].join("\n");

/** A row as the terminal sees it, without the fake theme's markers. */
function asDrawn(row: string): string {
	return row.replace(/<\/?[a-z:]+>/g, "");
}

/** Every gate that draws prose somebody wrote, named as a person would name it. */
const GATES: Array<[string, () => Parameters<typeof gateLines>[0]]> = [
	[
		"propose",
		() => ({
			...proposePanel({
				head: "jitsusama/a-branch-with-a-realistic-name",
				base: "main",
				repo: "github:Jitsusama/agentic-harness.pi",
				title: "A Title In Title Case",
				body: BODY,
				draft: false,
			}),
		}),
	],
	[
		"edit",
		() =>
			editPanel({
				label: "shop/world#2000980 · meteorite",
				edits: {
					body: { action: "set", value: BODY },
					labels: { action: "add", value: ["risky", "needs-a-second-look"] },
				},
			}),
	],
	[
		"close",
		() =>
			closePanel({
				label: "shop/world#2000980 · meteorite",
				comment: BODY,
			}),
	],
	[
		"publish review",
		() =>
			primaryPanelFor(
				{
					kind: "review",
					body: BODY,
					verdict: "request-changes",
					comments: [],
					itemIds: [],
				},
				"shop/world#2000980 · meteorite",
			),
	],
];

/** The guardian's own gate, which is a different path drawing the same thing. */
const GUARDIAN_GATES: Array<[string, ReviewableEntity]> = [
	[
		"New PR",
		{
			action: "create",
			title:
				"A Title Of The Full Seventy Two Characters That The Convention Permits",
			body: BODY,
		},
	],
	["PR Edit", { action: "edit", title: "A Shorter Title", body: BODY }],
];

describe("the guardian's gate follows the same rule", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	for (const [name, entity] of GUARDIAN_GATES) {
		it(name, () => {
			for (const width of WIDTHS) {
				const overrunning = entityGateLines(entity, fakeTheme(), width)
					.map((row, at) => ({ at, width: visibleWidth(asDrawn(row)) }))
					.filter((row) => row.width > width)
					.map((row) => `${name} at ${width}: row ${row.at} is ${row.width}`);

				expect(overrunning).toEqual([]);
			}
		});
	}
});

describe("every gate that draws prose fits its panel", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	for (const [name, build] of GATES) {
		it(name, () => {
			for (const width of WIDTHS) {
				const overrunning = gateLines(build(), fakeTheme(), width)
					.map((row, at) => ({ at, width: visibleWidth(asDrawn(row)) }))
					.filter((row) => row.width > width)
					.map((row) => `${name} at ${width}: row ${row.at} is ${row.width}`);

				expect(overrunning).toEqual([]);
			}
		});
	}
});
