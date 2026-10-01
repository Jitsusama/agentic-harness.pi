import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectionContributor } from "../../../extensions/compaction-selection-provider/contribution.ts";
import { tagger } from "../../../extensions/compaction-selection-provider/tagger.ts";
import {
	ANSWER_TOOL_NAME,
	requestFromContext,
} from "../../../lib/classifier/index.ts";
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

/** Answers yes to every question whose id ends in one of these. */
function answeringYesTo(...suffixes: string[]) {
	return (context: Context): AssistantMessage => {
		const request = requestFromContext(context);
		const answers = Object.fromEntries(
			Object.keys(request?.questions ?? {}).map((id) => [
				id,
				suffixes.some((s) => id.endsWith(s)) ? 0.9 : 0.05,
			]),
		);
		return {
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "t",
					name: ANSWER_TOOL_NAME,
					arguments: { answers },
				},
			],
			api: "openai-completions",
			provider: "local",
			model: "tagger",
			usage: USAGE,
			stopReason: "toolUse",
			timestamp: 0,
		};
	};
}

function session(
	branch: SessionEntry[],
	answer: (context: Context) => AssistantMessage,
) {
	const sent: Context[] = [];
	const ctx = {
		sessionManager: {
			getBranch: () => branch,
			getSessionId: () => "s1",
		},
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "local" && id === "tagger"
					? { maxTokens: 4096 }
					: undefined,
			hasConfiguredAuth: () => true,
			streamSimple: (_model: unknown, context: Context) => {
				sent.push(context);
				return { result: async () => answer(context) };
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

	it("does nothing without a classifier configured", async () => {
		delete process.env.PI_COMPACTION_CLASSIFIER;
		const { ctx, pi, sent } = session(
			[user("u1", "Always sign every commit.")],
			answeringYesTo(".rule"),
		);
		const tags = tagger(pi);
		tags.schedule(ctx);
		await tags.idle();
		expect(sent).toHaveLength(0);
	});

	it("records a failure that cost something rather than paying twice", async () => {
		const { ctx, pi, appended } = session(
			[user("u1", "Always sign every commit.")],
			() => ({
				...answeringYesTo()({ messages: [] }),
				content: [{ type: "text", text: "I think it is a rule." }],
				stopReason: "stop",
			}),
		);
		const tags = tagger(pi);
		tags.schedule(ctx);
		await tags.idle();
		expect(appended[0]?.[1]).toMatchObject({
			entryId: "u1",
			units: [],
			failed: "the reply did not call the answer tool",
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
