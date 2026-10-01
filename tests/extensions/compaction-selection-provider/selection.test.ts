import type {
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveClassifier } from "../../../extensions/compaction-selection-provider/classifier.ts";
import { selectionContributor } from "../../../extensions/compaction-selection-provider/contribution.ts";
import { tagger } from "../../../extensions/compaction-selection-provider/tagger.ts";
import { newContributions } from "../../../lib/compaction/index.ts";
import { SELECTION_HOLDS_ENTRY } from "../../../lib/compaction/selection/holds.ts";
import { EXCERPTS_HEADING } from "../../../lib/compaction/selection/render.ts";
import { SELECTION_TAGS_ENTRY } from "../../../lib/compaction/selection/tags.ts";
import { unitsOf } from "../../../lib/compaction/selection/units.ts";
import {
	assistant,
	judged,
	tagged,
	user,
} from "../../lib/compaction/selection/fixtures.ts";

const USAGE = {
	input: 10,
	output: 5,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 15,
	cost: {
		input: 0.001,
		output: 0.001,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0.002,
	},
};

type Answerer = (context: ClassifierContext) => ClassifierResult;

/** Answers yes to every question whose id ends in one of these. */
function answeringYesTo(...suffixes: string[]): Answerer {
	return (context) => ({
		api: "test-classifier",
		provider: "local",
		model: "tagger",
		answers: Object.fromEntries(
			Object.keys(context.questions).map((id) => [
				id,
				{
					type: "bool",
					probability: suffixes.some((s) => id.endsWith(s)) ? 0.9 : 0.05,
				},
			]),
		),
		usage: USAGE,
		stopReason: "stop",
		timestamp: 0,
	});
}

const CLASSIFIERS = [
	{ provider: "local", id: "tagger", type: "classifier" },
	{ provider: "typesafe", id: "jev-latest", type: "classifier" },
];

function session(
	branch: SessionEntry[],
	answer: Answerer,
	available: readonly { provider: string; id: string }[] = CLASSIFIERS,
) {
	const sent: Array<{ model: string; context: ClassifierContext }> = [];
	const ctx = {
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "s1",
		},
		modelRegistry: {
			getAvailableOfType: async (type: string) =>
				type === "classifier" ? available : [],
			classify: async (
				model: { provider: string; id: string },
				context: ClassifierContext,
			) => {
				sent.push({ model: `${model.provider}/${model.id}`, context });
				return answer(context);
			},
		},
	} as unknown as ExtensionContext;
	const appended: Array<[string, unknown]> = [];
	const pi = {
		appendEntry: (type: string, data: unknown) => {
			appended.push([type, data]);
			branch.push({
				type: "custom",
				id: `e${branch.length}`,
				parentId: null,
				timestamp: "",
				customType: type,
				data,
			} as SessionEntry);
		},
	};
	return { ctx, pi, sent, appended };
}

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.PI_COMPACTION_CLASSIFIER = "local/tagger";
	delete process.env.PI_COMPACTION_EXCERPT_TOKENS;
});
afterEach(() => {
	process.env = saved;
});

describe("the classifier", () => {
	it("is the one named, or Jev when none is, or none when it is off", async () => {
		const { ctx } = session([], answeringYesTo());
		const named = await resolveClassifier(ctx, {
			PI_COMPACTION_CLASSIFIER: "local/tagger",
		});
		expect(named.ok && named.label).toBe("local/tagger");

		const fallback = await resolveClassifier(ctx, {});
		expect(fallback.ok && fallback.label).toBe("typesafe/jev-latest");

		const off = await resolveClassifier(ctx, {
			PI_COMPACTION_CLASSIFIER: "off",
		});
		expect(off.ok).toBe(false);

		const missing = await resolveClassifier(ctx, {
			PI_COMPACTION_CLASSIFIER: "local/other",
		});
		expect(missing).toEqual({
			ok: false,
			reason: "no classifier local/other has credentials",
		});
	});

	it("is none on a pi without classifier models", async () => {
		const ctx = { modelRegistry: {} } as unknown as ExtensionContext;
		expect(await resolveClassifier(ctx, {})).toEqual({
			ok: false,
			reason: "this pi has no classifier models",
		});
	});
});

describe("tagging", () => {
	it("tags each untagged message once and records what it cost", async () => {
		const branch = [
			user("u1", "Always sign every commit."),
			assistant("a1", "Understood, signing them."),
		];
		const { ctx, pi, sent, appended } = session(
			branch,
			answeringYesTo(".rule"),
		);
		const tags = tagger(pi);

		tags.schedule(ctx);
		tags.schedule(ctx);
		await tags.idle();
		tags.schedule(ctx);
		await tags.idle();

		expect(sent).toHaveLength(2);
		expect(sent[0]?.model).toBe("local/tagger");
		expect(appended.map(([type]) => type)).toEqual([
			SELECTION_TAGS_ENTRY,
			SELECTION_TAGS_ENTRY,
		]);
		expect(appended[0]?.[1]).toMatchObject({
			entryId: "u1",
			units: [{ kinds: ["rule"] }],
			model: "tagger",
			usage: USAGE,
		});
	});

	it("does nothing when no classifier has credentials", async () => {
		delete process.env.PI_COMPACTION_CLASSIFIER;
		const { ctx, pi, sent } = session(
			[user("u1", "Always sign every commit.")],
			answeringYesTo(".rule"),
			[{ provider: "local", id: "tagger" }],
		);
		const tags = tagger(pi);
		tags.schedule(ctx);
		await tags.idle();
		expect(sent).toHaveLength(0);
	});

	it("records a failure that cost something rather than paying twice", async () => {
		const { ctx, pi, appended } = session(
			[user("u1", "Always sign every commit.")],
			(context) => ({
				...answeringYesTo()(context),
				answers: {},
				stopReason: "error",
				errorMessage: "the context is too long",
			}),
		);
		const tags = tagger(pi);
		tags.schedule(ctx);
		await tags.idle();
		expect(appended[0]?.[1]).toMatchObject({
			entryId: "u1",
			units: [],
			model: "local/tagger",
			failed: "the context is too long",
			usage: USAGE,
		});
	});
});

describe("contributing excerpts", () => {
	const rule = user("u1", "Always sign every commit.");
	const kept = user("u2", "Now write the tests.");

	it("appends the tagged paragraphs a compaction drops", () => {
		const branch = [rule, tagged(rule, ["rule"]), kept];
		const { ctx, pi } = session(branch, answeringYesTo());
		const contributor = selectionContributor(pi, () => ctx);
		const contributions = newContributions({ firstKeptEntryId: "u2" });

		contributor.listener(contributions);

		expect(contributions.appendix).toHaveLength(1);
		expect(contributions.appendix[0]).toContain(EXCERPTS_HEADING);
		expect(contributions.appendix[0]).toContain("> Always sign every commit.");
	});

	it("leaves out one judged no longer to hold, and contributes nothing at a budget of 0", () => {
		const [unit] = unitsOf(rule);
		const branch = [
			rule,
			tagged(rule, ["rule"]),
			kept,
			judged("j1", { [unit?.hash ?? ""]: 0.1 }),
		];
		const { ctx, pi } = session(branch, answeringYesTo());
		const contributor = selectionContributor(pi, () => ctx);

		const judgedOut = newContributions({ firstKeptEntryId: "u2" });
		contributor.listener(judgedOut);
		expect(judgedOut.appendix).toEqual([]);

		process.env.PI_COMPACTION_EXCERPT_TOKENS = "0";
		const off = newContributions({ firstKeptEntryId: "u2" });
		selectionContributor(pi, () => ctx).listener(off);
		expect(off.appendix).toEqual([]);
	});

	it("checks ahead whether what it would quote still holds, and records it", async () => {
		// Long enough that pi would keep it and what follows verbatim.
		const long = assistant("a1", "y".repeat(100_000));
		const branch = [rule, tagged(rule, ["rule"]), long, kept];
		const { ctx, pi, appended, sent } = session(
			branch,
			answeringYesTo(".holds"),
		);
		const contributor = selectionContributor(pi, () => ctx);

		contributor.listener(newContributions({}));
		await contributor.idle();

		expect(sent).toHaveLength(1);
		expect(appended).toHaveLength(1);
		const [type, data] = appended[0] ?? [];
		expect(type).toBe(SELECTION_HOLDS_ENTRY);
		expect(
			Object.values((data as { holds: Record<string, number> }).holds),
		).toEqual([0.9]);
	});
});
