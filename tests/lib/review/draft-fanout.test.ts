import { describe, expect, it } from "vitest";
import {
	addFinding,
	type ChangeRef,
	type ConversationCapabilities,
	type ConversationFacet,
	compilePlan,
	emptyDraft,
	type LineAnchor,
	publishAcross,
	type ReviewProvider,
	type StackPublishEntry,
	setVerdict,
} from "../../../lib/review";
import { stubProvider } from "./support/stub-provider.js";

const anchor: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 3,
};

const capabilities: ConversationCapabilities = {
	anchoredBatchReview: true,
	fileLevelComments: "batch",
	multiLineRanges: true,
	suggestions: false,
	unresolve: true,
	reactions: ["rocket"],
	topLevelThreading: false,
	pendingReviews: false,
	staleness: "pinned",
};

const changeOf = (id: string): ChangeRef => ({
	provider: "forge",
	repo: { key: "forge:o/r" },
	id,
	label: `o/r#${id}`,
});

/** One change's entry, carrying one finding. */
function entry(ref: string, id: string, body = "leaks"): StackPublishEntry {
	const change = changeOf(id);
	let state = emptyDraft(`d${id}`, { kind: "proposal", change });
	state = addFinding(state, { anchor, body });
	state = setVerdict(state, "comment", "a look");
	return {
		ref,
		change,
		plan: compilePlan(state, { capabilities: { conversation: capabilities } }),
	};
}

/** Records which changes it was asked about, failing the named ones. */
function recordingProvider(failFor: string[] = []): {
	provider: ReviewProvider;
	posted: string[];
} {
	const posted: string[] = [];
	const conversation: ConversationFacet = {
		reviews: async () => [],
		threads: async () => [],
		messages: async () => [],
		postReview: async (change) => {
			if (failFor.includes(change.id)) {
				throw new Error(`forge refused ${change.label}`);
			}
			posted.push(change.id);
			return { id: `r${change.id}` };
		},
		reply: async () => ({ id: "c" }),
		resolve: async () => {},
		comment: async () => ({ id: "m" }),
	};
	return {
		provider: stubProvider({
			id: "forge",
			priority: 100,
			capabilities: { conversation: capabilities },
			facets: { conversation },
		}),
		posted,
	};
}

describe("publishing across a stack", () => {
	it("publishes nothing for no entries", async () => {
		const { provider, posted } = recordingProvider();

		const outcome = await publishAcross([], provider);

		expect(posted).toEqual([]);
		expect(outcome.ok).toBe(true);
		expect(outcome.changes).toEqual([]);
	});

	it("publishes to every change in the order given", async () => {
		const { provider, posted } = recordingProvider();

		const outcome = await publishAcross(
			[entry("refs/heads/base", "1"), entry("refs/heads/tip", "2")],
			provider,
		);

		expect(posted).toEqual(["1", "2"]);
		expect(outcome.ok).toBe(true);
		expect(outcome.changes.map((c) => c.ref)).toEqual([
			"refs/heads/base",
			"refs/heads/tip",
		]);
	});

	it("keeps going after a change fails", async () => {
		// The same argument as within one plan: stopping would leave a
		// partly published review with no record of which part.
		const { provider, posted } = recordingProvider(["1"]);

		const outcome = await publishAcross(
			[entry("refs/heads/base", "1"), entry("refs/heads/tip", "2")],
			provider,
		);

		expect(posted).toEqual(["2"]);
		expect(outcome.changes[0]?.outcome.ok).toBe(false);
		expect(outcome.changes[1]?.outcome.ok).toBe(true);
	});

	it("is not ok when any change failed", async () => {
		const { provider } = recordingProvider(["2"]);

		const outcome = await publishAcross(
			[entry("refs/heads/base", "1"), entry("refs/heads/tip", "2")],
			provider,
		);

		expect(outcome.ok).toBe(false);
	});

	it("says which changes landed and which are left", async () => {
		// So a retry sends only the remainder. Without this the caller
		// either posts everything twice or gives up on the lot.
		const { provider } = recordingProvider(["2"]);

		const outcome = await publishAcross(
			[
				entry("refs/heads/base", "1"),
				entry("refs/heads/middle", "2"),
				entry("refs/heads/tip", "3"),
			],
			provider,
		);

		expect(outcome.landed).toEqual(["refs/heads/base", "refs/heads/tip"]);
		expect(outcome.remaining).toEqual(["refs/heads/middle"]);
	});

	it("carries the provider's own words about a failure", async () => {
		const { provider } = recordingProvider(["1"]);

		const outcome = await publishAcross(
			[entry("refs/heads/base", "1")],
			provider,
		);

		expect(outcome.changes[0]?.outcome.outcomes[0]?.error).toContain(
			"forge refused o/r#1",
		);
	});

	it("counts a change with nothing to say as landed", async () => {
		// An empty plan is not a failure, and calling it remaining would
		// keep a retry alive forever over a change nobody had a remark
		// about.
		const change = changeOf("9");
		const empty: StackPublishEntry = {
			ref: "refs/heads/quiet",
			change,
			plan: compilePlan(emptyDraft("d9", { kind: "proposal", change }), {
				capabilities: { conversation: capabilities },
			}),
		};
		const { provider, posted } = recordingProvider();

		const outcome = await publishAcross([empty], provider);

		expect(posted).toEqual([]);
		expect(outcome.ok).toBe(true);
		expect(outcome.landed).toEqual(["refs/heads/quiet"]);
	});
});
