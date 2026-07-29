/**
 * Publishing a composed review through a persisted draft.
 *
 * The point of the draft is what happens when publishing only
 * partly works. Posting in one shot means a rejected half is
 * simply gone, and the person who wrote it finds out by noticing
 * their remarks are missing. A draft keeps whatever did not land.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	forgetSubstrate,
	publishDraftThroughSubstrate,
	setSubstrateApi,
} from "../../../extensions/pr-workflow/substrate.js";
import type {
	BoundTarget,
	Capabilities,
	DraftState,
	ReviewDraft,
	ReviewEngine,
	ReviewSubstrateApi,
} from "../../../lib/review/index.js";
import {
	addFinding,
	emptyDraft,
	setVerdict,
} from "../../../lib/review/index.js";

const reference = { owner: "o", repo: "r", number: 7 };

const target = {
	kind: "proposal",
	change: {
		provider: "github",
		repo: { key: "github:o/r" },
		id: "7",
		label: "o/r#7",
	},
} as const;

/** A draft carrying one anchored remark and a verdict. */
function composed(): DraftState {
	const draft = addFinding(emptyDraft("d-1", target), {
		anchor: { subject: "line", path: "lib/x.ts", blob: "new", line: 11 },
		body: "this leaks",
	});
	return setVerdict(draft, "comment");
}

/** Capabilities of a backend that takes anchored comments. */
const capable = {
	conversation: { anchoredComments: true, verdicts: true },
} as unknown as Capabilities;

/**
 * A substrate whose engine opens the draft given, and records
 * what was published through it.
 */
function substrate(outcome: { ok: boolean }): {
	api: ReviewSubstrateApi;
	opened: unknown[];
	published: DraftState[];
} {
	const opened: unknown[] = [];
	const published: DraftState[] = [];

	const engine = {
		async resolve() {
			return {
				target,
				capabilities: capable,
				provider: { id: "github" },
				diffModel: async () => ({ files: [] }),
				conversation: {},
			} as unknown as BoundTarget;
		},
		async openDraft(forTarget: unknown) {
			opened.push(forTarget);
			let state = emptyDraft("d-1", target);
			const draft = {
				get id() {
					return state.id;
				},
				get state() {
					return state;
				},
				async addFinding(finding: { anchor: unknown; body: string }) {
					state = addFinding(
						state,
						finding as Parameters<typeof addFinding>[1],
					);
					return state.items[state.items.length - 1].id;
				},
				async setVerdict(verdict: "comment") {
					state = setVerdict(state, verdict);
				},
				plan: () => ({ target, ops: [], degraded: [], refused: [] }),
				async publish() {
					published.push(state);
					return { ok: outcome.ok, outcomes: [] };
				},
			} as unknown as ReviewDraft;
			return draft;
		},
	} as unknown as ReviewEngine;

	const api = {
		registerProvider() {},
		listProviders: () => ["github"],
		engine: async () => engine,
	} satisfies ReviewSubstrateApi;
	return { api, opened, published };
}

afterEach(() => forgetSubstrate());

describe("publishDraftThroughSubstrate", () => {
	it("publishes the composed remarks and says it landed", async () => {
		const { api, published } = substrate({ ok: true });
		setSubstrateApi(api);

		const result = await publishDraftThroughSubstrate({
			ref: reference,
			draft: composed(),
		});

		expect(result.ok).toBe(true);
		expect(published).toHaveLength(1);
		expect(published[0].items).toHaveLength(1);
		expect(published[0].verdict).toBe("comment");
	});

	it("opens the draft about the change being reviewed", async () => {
		// A draft filed against the wrong target is a draft nobody
		// will find again.
		const { api, opened } = substrate({ ok: true });
		setSubstrateApi(api);

		await publishDraftThroughSubstrate({ ref: reference, draft: composed() });

		expect(opened).toEqual([target]);
	});

	it("reports a publish that did not fully land", async () => {
		const { api } = substrate({ ok: false });
		setSubstrateApi(api);

		const result = await publishDraftThroughSubstrate({
			ref: reference,
			draft: composed(),
		});

		expect(result.ok).toBe(false);
	});

	it("refuses when no substrate is hosting", async () => {
		// A review that silently went nowhere is worse than an error.
		await expect(
			publishDraftThroughSubstrate({ ref: reference, draft: composed() }),
		).rejects.toThrow();
	});
});
