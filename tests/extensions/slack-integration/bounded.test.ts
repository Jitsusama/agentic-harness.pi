import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedAnswer } from "../../../extensions/slack-integration/bounded.ts";
import {
	cleanupSessionResults,
	createResultStore,
	recordsIn,
	sessionResultDir,
} from "../../../lib/core/result/index.ts";
import { resultSession } from "../../support/result-session.ts";

vi.mock("../../../lib/slack/index.ts", async (original) => ({
	...(await original<object>()),
	resolveTarget: async () => ({
		conversation: { id: "C1", kind: "channel", name: "general" },
		ts: "1700000.000100",
	}),
	getThread: async () =>
		longHistory(2_000).messages.map((message) => ({
			...message,
			files: [{ id: "F1" }],
		})),
	resolveMessages: async () => undefined,
	downloadFiles: async () => [
		{ kind: "image", data: "image-data", mimeType: "image/png" },
		{ kind: "text", text: "complete attachment" },
	],
}));

const { routeAction } = await import(
	"../../../extensions/slack-integration/router.ts"
);

/** A rendered message list long enough to need bounding. */
function longHistory(count: number): {
	view: string;
	messages: { user: string; text: string; ts: string }[];
} {
	const messages = Array.from({ length: count }, (_, i) => ({
		user: i % 2 === 0 ? "U_ALICE" : "U_BOB",
		text: `message number ${i} with enough words to take up a line`,
		ts: `1700000${String(i).padStart(3, "0")}.000100`,
	}));
	const view = messages
		.map((m) => `[${m.ts}] @${m.user}: ${m.text}`)
		.join("\n");
	return { view, messages };
}

describe("recordsIn", () => {
	it("finds the one collection a list answer carries", () => {
		const found = recordsIn({ messages: [{ text: "hi" }] });

		expect(found?.unit).toBe("messages");
		expect(found?.items).toHaveLength(1);
	});

	it("leaves an answer with no collection alone", () => {
		// A channel or a user is one object, and a handle pointing at it
		// would be machinery for its own sake.
		expect(
			recordsIn({ channel: { id: "C1", name: "general" } }),
		).toBeUndefined();
		expect(recordsIn(undefined)).toBeUndefined();
		expect(recordsIn("not an object")).toBeUndefined();
	});

	it("refuses to guess between two collections", () => {
		// Citing the wrong one points a query at a shape that is not
		// there, which is worse than not citing.
		expect(
			recordsIn({ messages: [{ text: "hi" }], files: [{ name: "a.png" }] }),
		).toBeUndefined();
	});

	it("treats an empty collection as nothing to cite", () => {
		expect(recordsIn({ messages: [] })).toBeUndefined();
	});
});

describe("boundedAnswer", () => {
	const ctx = resultSession();
	afterEach(() => {
		cleanupSessionResults(ctx);
	});

	it("returns a short history untouched", () => {
		const { view, messages } = longHistory(3);

		expect(boundedAnswer(view, { messages }, ctx)).toBe(view);
	});

	it("bounds a long history and keeps every message queryable", () => {
		// The case the guidance in this extension asks for by name:
		// limit 0 over a date range, meaning every message in the window.
		const { view, messages } = longHistory(2_000);

		const answer = boundedAnswer(view, { messages }, ctx);

		expect(Buffer.byteLength(answer, "utf-8")).toBeLessThan(
			Buffer.byteLength(view, "utf-8") / 5,
		);
		const handle = /handle (result-[0-9a-f]{16})/.exec(answer)?.[1];
		expect(handle).toBeDefined();
		const stored = createResultStore({ dir: sessionResultDir(ctx) });
		expect(JSON.parse(stored.read(handle as string))).toHaveLength(2_000);
		// And it names what the payload holds, so the first expression
		// is written against messages rather than lines, without
		// claiming the lines themselves were stored.
		expect(answer).toContain("All 2,000 messages are stored under handle");
		expect(answer).toMatch(/renders \d+ of 2,000 lines/);
		expect(answer).not.toContain("2,000 lines are stored");
	});

	it("bounds a thread at the caller exit and leaves attachments unchanged", async () => {
		const other = resultSession();
		try {
			const result = await routeAction(
				"get_thread",
				{} as never,
				{ target: "thread" },
				{ ...ctx, hasUI: false } as never,
				{} as never,
			);
			const first = result.content[0];
			if (first.type !== "text") throw new Error("missing rendered thread");
			const handle = /handle (result-[0-9a-f]{16})/.exec(first.text)?.[1];
			expect(handle).toBeDefined();
			expect(
				JSON.parse(
					createResultStore({ dir: sessionResultDir(ctx) }).read(
						handle as string,
					),
				),
			).toHaveLength(2_000);
			expect(() =>
				createResultStore({ dir: sessionResultDir(other) }).read(
					handle as string,
				),
			).toThrow();
			expect(result.content.slice(1)).toEqual([
				{ type: "image", data: "image-data", mimeType: "image/png" },
				{ type: "text", text: "\ncomplete attachment" },
			]);
		} finally {
			cleanupSessionResults(other);
		}
	});

	it("suggests narrowing in Slack's own vocabulary", () => {
		const { view, messages } = longHistory(2_000);

		const answer = boundedAnswer(view, { messages }, ctx);

		expect(answer).toContain("'limit'");
		expect(answer).toContain("'oldest'");
	});
});
