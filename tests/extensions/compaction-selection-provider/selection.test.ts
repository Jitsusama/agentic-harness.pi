import type {
	ClassifierContext,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	classifierStatus,
	resolveClassifier,
} from "../../../extensions/compaction-selection-provider/classifier.ts";
import {
	SELECTION_RECORD_ID,
	selectionContributor,
} from "../../../extensions/compaction-selection-provider/contribution.ts";
import {
	memoryStore,
	type SelectionStore,
	selectionStoreKind,
	sessionStore,
} from "../../../extensions/compaction-selection-provider/store.ts";
import { tagger } from "../../../extensions/compaction-selection-provider/tagger.ts";
import { newContributions } from "../../../lib/compaction/index.ts";
import { SELECTION_HOLDS_ENTRY } from "../../../lib/compaction/selection/holds.ts";
import { EXCERPTS_HEADING } from "../../../lib/compaction/selection/render.ts";
import { SELECTION_TAGS_ENTRY } from "../../../lib/compaction/selection/tags.ts";
import {
	paragraphRef,
	unitsOf,
} from "../../../lib/compaction/selection/units.ts";
import {
	assistant,
	compaction,
	judged,
	passages,
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
	const notices: string[] = [];
	const ctx = {
		hasUI: true,
		ui: { notify: (message: string) => notices.push(message) },
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
	const store = sessionStore((type, data) => {
		appended.push([type, data]);
		branch.push({
			type: "custom",
			id: `e${branch.length}`,
			parentId: null,
			timestamp: "",
			customType: type,
			data,
		} as SessionEntry);
	});
	return { ctx, store, sent, appended, notices };
}

/** The selection's record on a compaction's contributions. */
function recordOf(contributions: { records?: Record<string, unknown> }) {
	return contributions.records?.[SELECTION_RECORD_ID] as
		| Record<string, unknown>
		| undefined;
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
		expect(off).toMatchObject({ ok: false, off: true });

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

	it("tells the person once a session when there is none, and never when it is off", async () => {
		process.env.PI_COMPACTION_CLASSIFIER = "local/other";
		const { ctx, notices } = session([], answeringYesTo());
		const status = classifierStatus();
		await status.resolve(ctx);
		await status.resolve(ctx);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("no classifier local/other has credentials");
		expect(status.current()).toEqual({
			unavailable: "no classifier local/other has credentials",
		});

		status.reset();
		await status.resolve(ctx);
		expect(notices).toHaveLength(2);

		process.env.PI_COMPACTION_CLASSIFIER = "off";
		const quiet = classifierStatus();
		await quiet.resolve(ctx);
		expect(notices).toHaveLength(2);
	});
});

describe("tagging", () => {
	it("tags each untagged message once and records what it cost", async () => {
		const branch = [
			user("u1", "Always sign every commit."),
			assistant("a1", "Understood, signing them."),
		];
		const { ctx, store, sent, appended } = session(
			branch,
			answeringYesTo(".rule"),
		);
		const tags = tagger(store);

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
		const recorded = appended.map(([, data]) => data);
		expect(recorded).toContainEqual(
			expect.objectContaining({
				entryId: "u1",
				units: [expect.objectContaining({ kinds: ["rule"] })],
				model: "tagger",
				usage: USAGE,
				ms: expect.any(Number),
			}),
		);
	});

	it("tags the newest messages first", async () => {
		const branch = Array.from({ length: 6 }, (_, at) =>
			user(`u${at}`, `Message number ${at} of the session.`),
		);
		const { ctx, store, sent } = session(branch, answeringYesTo());
		const tags = tagger(store);
		tags.schedule(ctx);
		await tags.idle();
		expect(sent).toHaveLength(6);
		expect(passages(sent[0]?.context, "paragraphs")).toEqual([
			"Message number 5 of the session.",
		]);
		expect(passages(sent.at(-1)?.context, "paragraphs")).toEqual([
			"Message number 0 of the session.",
		]);
	});

	it("knows a paragraph by its text, so a rebuilt session is not tagged again", async () => {
		const before = user("u1", "Always sign every commit.");
		// The host rebuilt the session: same words, new id.
		const after = user("rebuilt-7", "Always sign every commit.");
		const branch = [tagged(before, ["rule"]), after, user("u2", "Go on.")];
		const { ctx, store, sent } = session(branch, answeringYesTo());
		const tags = tagger(store);
		tags.schedule(ctx);
		await tags.idle();
		expect(sent).toHaveLength(0);

		const contributions = newContributions({}, "u2");
		selectionContributor(() => ctx, { store }).listener(contributions);
		expect(contributions.appendix[0]).toContain("> Always sign every commit.");
	});

	it("does nothing when no classifier has credentials", async () => {
		delete process.env.PI_COMPACTION_CLASSIFIER;
		const { ctx, store, sent } = session(
			[user("u1", "Always sign every commit.")],
			answeringYesTo(".rule"),
			[{ provider: "local", id: "tagger" }],
		);
		const tags = tagger(store);
		tags.schedule(ctx);
		await tags.idle();
		expect(sent).toHaveLength(0);
	});

	it("records a failure that cost something, naming its paragraphs, rather than paying twice", async () => {
		const said = user("u1", "Always sign every commit.");
		const branch = [said];
		const { ctx, store, appended, sent } = session(branch, (context) => ({
			...answeringYesTo()(context),
			answers: {},
			stopReason: "error",
			errorMessage: "the context is too long",
		}));
		const tags = tagger(store);
		tags.schedule(ctx);
		await tags.idle();
		expect(appended[0]?.[1]).toMatchObject({
			entryId: "u1",
			units: [{ hash: unitsOf(said)[0]?.hash, kinds: [] }],
			model: "local/tagger",
			failed: "the context is too long",
			usage: USAGE,
		});

		tags.schedule(ctx);
		await tags.idle();
		expect(sent).toHaveLength(1);
	});
});

describe("keeping tags in the process", () => {
	it("is chosen by PI_COMPACTION_SELECTION_STORE=memory", () => {
		expect(selectionStoreKind({})).toBe("session");
		expect(
			selectionStoreKind({ PI_COMPACTION_SELECTION_STORE: "memory" }),
		).toBe("memory");
	});

	it("tags, quotes and reports what it spent without writing to the session", async () => {
		const rule = user("u1", "Always sign every commit.");
		const branch: SessionEntry[] = [rule, user("u2", "Now write the tests.")];
		const { ctx, appended } = session(branch, answeringYesTo(".rule"));
		const store: SelectionStore = memoryStore();
		const tags = tagger(store);
		tags.schedule(ctx);
		await tags.idle();

		const contributions = newContributions({}, "u2");
		selectionContributor(() => ctx, { store }).listener(contributions);

		expect(appended).toEqual([]);
		expect(contributions.appendix[0]).toContain("> Always sign every commit.");
		expect(recordOf(contributions)).toMatchObject({
			store: "memory",
			spend: 2 * USAGE.cost.total,
		});

		store.compacted();
		expect(store.spend(branch)).toBe(0);
		expect(store.tags(branch).kinds.size).toBeGreaterThan(0);
	});
});

describe("how long the classifier took", () => {
	const taking = (ms: number) => ({ entryId: "u1", units: [], ms });

	it("sums tagging and checking since the last compaction on the session", () => {
		const branch: SessionEntry[] = [];
		const { store } = session(branch, answeringYesTo());
		store.recordTags(taking(1_200));
		branch.push(compaction("c1"));
		store.recordTags(taking(300));
		store.recordTags(taking(200));
		store.recordHolds({ holds: {}, ms: 50 });
		store.recordHolds({ holds: {} });

		expect(store.elapsed(branch)).toEqual({ taggingMs: 500, judgingMs: 50 });
	});

	it("sums them in the process and starts over at a compaction", () => {
		const store = memoryStore();
		store.recordTags(taking(300));
		store.recordHolds({ holds: {}, ms: 50 });
		expect(store.elapsed([])).toEqual({ taggingMs: 300, judgingMs: 50 });

		store.compacted();
		expect(store.elapsed([])).toEqual({ taggingMs: 0, judgingMs: 0 });
	});
});

describe("contributing excerpts", () => {
	const rule = user("u1", "Always sign every commit.");
	const kept = user("u2", "Now write the tests.");

	it("appends the tagged paragraphs a compaction drops", () => {
		const branch = [rule, tagged(rule, ["rule"]), kept];
		const { ctx, store } = session(branch, answeringYesTo());
		const contributor = selectionContributor(() => ctx, { store });
		const contributions = newContributions({ firstKeptEntryId: "u2" });

		contributor.listener(contributions);

		expect(contributions.appendix).toHaveLength(1);
		expect(contributions.appendix[0]).toContain(EXCERPTS_HEADING);
		expect(contributions.appendix[0]).toContain("> Always sign every commit.");
		expect(contributions.appendix[0]).not.toContain("p:");
	});

	it("quotes from where the host says the verbatim tail starts, over pi's cut", () => {
		const finding = assistant("a1", "The cache lives for an hour.");
		const branch = [
			rule,
			tagged(rule, ["rule"]),
			finding,
			tagged(finding, ["finding"]),
			kept,
		];
		const { ctx, store } = session(branch, answeringYesTo());
		// pi cut at u2, but a summary written ahead keeps from a1.
		const contributions = newContributions({ firstKeptEntryId: "u2" }, "a1");
		selectionContributor(() => ctx, { store }).listener(contributions);
		expect(contributions.appendix[0]).toContain("Always sign");
		expect(contributions.appendix[0]).not.toContain("cache lives");
	});

	it("names each quote's paragraph when the recall tool is there to read it", () => {
		const branch = [rule, tagged(rule, ["rule"]), kept];
		const { ctx, store } = session(branch, answeringYesTo());
		const contributions = newContributions({}, "u2");
		selectionContributor(() => ctx, { store, refs: () => true }).listener(
			contributions,
		);
		const ref = paragraphRef(unitsOf(rule)[0]?.hash ?? "");
		expect(contributions.appendix[0]).toContain(`User (${ref}):`);
		expect(contributions.appendix[0]).toContain("session_recall");
		expect(recordOf(contributions)).toMatchObject({ refs: true });
	});

	it("says what it did with the compaction, quotes or none", () => {
		const untaggedMessage = user("u0", "Something nobody tagged yet.");
		const branch = [untaggedMessage, rule, tagged(rule, ["rule"]), kept];
		const { ctx, store } = session(branch, answeringYesTo());
		const contributions = newContributions({}, "u2");
		selectionContributor(() => ctx, { store }).listener(contributions);
		expect(recordOf(contributions)).toEqual({
			unresolved: true,
			store: "session",
			budget: 3000,
			candidates: 1,
			chosen: 1,
			excerptTokens: 7,
			notHolding: 0,
			unchecked: 1,
			untagged: 1,
			refs: false,
			spend: 0,
			taggingMs: 0,
			judgingMs: 0,
		});
	});

	it("says why it quoted nothing", () => {
		const reason = (branch: SessionEntry[], firstKeptEntryId: string) => {
			const { ctx, store } = session(branch, answeringYesTo());
			const contributions = newContributions({ firstKeptEntryId });
			selectionContributor(() => ctx, { store }).listener(contributions);
			return recordOf(contributions)?.nothingQuoted;
		};

		expect(reason([rule, tagged(rule, ["rule"]), kept], "u1")).toBe(
			"nothing-dropped",
		);
		expect(reason([rule, kept], "u2")).toBe("untagged");
		expect(reason([rule, tagged(rule, []), kept], "u2")).toBe("no-candidates");
		process.env.PI_COMPACTION_EXCERPT_TOKENS = "1";
		expect(reason([rule, tagged(rule, ["rule"]), kept], "u2")).toBe(
			"over-budget",
		);
	});

	it("leaves out one judged no longer to hold, and contributes nothing at a budget of 0", () => {
		const [unit] = unitsOf(rule);
		const branch = [
			rule,
			tagged(rule, ["rule"]),
			kept,
			judged("j1", { [unit?.hash ?? ""]: 0.1 }),
		];
		const { ctx, store } = session(branch, answeringYesTo());
		const contributor = selectionContributor(() => ctx, { store });

		const judgedOut = newContributions({ firstKeptEntryId: "u2" });
		contributor.listener(judgedOut);
		expect(judgedOut.appendix).toEqual([]);
		expect(recordOf(judgedOut)).toMatchObject({
			chosen: 0,
			notHolding: 1,
			nothingQuoted: "none-holding",
		});

		process.env.PI_COMPACTION_EXCERPT_TOKENS = "0";
		const off = newContributions({ firstKeptEntryId: "u2" });
		selectionContributor(() => ctx, { store }).listener(off);
		expect(off.appendix).toEqual([]);
		expect(recordOf(off)).toEqual({ budget: 0, nothingQuoted: "off" });
	});

	it("checks ahead whether what it would quote still holds, and records it", async () => {
		// Long enough that pi would keep it and what follows verbatim.
		const long = assistant("a1", "y".repeat(100_000));
		const branch = [rule, tagged(rule, ["rule"]), long, kept];
		const { ctx, store, appended, sent } = session(
			branch,
			answeringYesTo(".holds"),
		);
		const contributor = selectionContributor(() => ctx, { store });

		contributor.listener(newContributions({}));
		await contributor.idle();

		expect(sent).toHaveLength(1);
		expect(appended).toHaveLength(1);
		const [type, data] = appended[0] ?? [];
		expect(type).toBe(SELECTION_HOLDS_ENTRY);
		expect(data).toMatchObject({ ms: expect.any(Number) });
		expect(
			Object.values((data as { holds: Record<string, number> }).holds),
		).toEqual([0.9]);
	});

	it("lets the tagger catch up before it checks, so a backlog can be quoted", async () => {
		const long = assistant("a1", "y".repeat(100_000));
		const branch: SessionEntry[] = [rule, long, kept];
		const { ctx, store, appended } = session(
			branch,
			answeringYesTo(".rule", ".holds"),
		);
		const tags = tagger(store);
		const contributor = selectionContributor(() => ctx, {
			store,
			caughtUp: (c) => {
				tags.schedule(c);
				return tags.idle();
			},
		});

		contributor.listener(newContributions({}));
		await contributor.idle();

		expect(appended.map(([type]) => type)).toContain(SELECTION_HOLDS_ENTRY);
	});
});
