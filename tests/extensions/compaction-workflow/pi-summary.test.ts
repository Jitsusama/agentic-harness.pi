/**
 * pi's summariser as a provider: on the spot only, priced uncached,
 * handed the combined focus and no file lists, since the host appends
 * those itself.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompactionRequest } from "../../../lib/compaction/index.ts";

const compact = vi.fn();
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	compact,
}));

const { piSummaryProvider } = await import(
	"../../../extensions/compaction-workflow/pi-summary.ts"
);

const pi = { getThinkingLevel: () => "high" } as unknown as ExtensionAPI;

const model = {
	id: "m",
	cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
};

function request(
	overrides: Partial<CompactionRequest> = {},
): CompactionRequest {
	const ctx = {
		model,
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				ok: true,
				apiKey: "k",
				headers: { kept: "yes", dropped: null },
			}),
		},
		sessionManager: { getSessionId: () => "s1" },
	} as unknown as ExtensionContext;
	return {
		timing: "on the spot",
		reason: "threshold",
		ctx,
		branch: [],
		coveredLeafId: "a1",
		preparation: {
			firstKeptEntryId: "u1",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 300_000,
			fileOps: {
				read: new Set(["a.ts"]),
				edited: new Set(),
				written: new Set(),
			},
			settings: {
				enabled: true,
				reserveTokens: 64_000,
				keepRecentTokens: 20_000,
			},
		},
		hasPreviousSummary: false,
		focus: { requested: "the layer", contributed: ["the tree"] },
		contextTokens: 300_000,
		expectedOutputTokens: 10_000,
		maxSummaryTokens: 51_200,
		...overrides,
	};
}

describe("pi's summariser as a provider", () => {
	// Braced: a function handed back from beforeEach runs as teardown.
	beforeEach(() => {
		compact.mockReset();
	});

	it("declines to write ahead, since it needs the compaction's preparation", () => {
		expect(
			piSummaryProvider(pi).assess(request({ timing: "ahead" })),
		).toMatchObject({
			ok: false,
		});
	});

	it("prices reading the whole context uncached, and the output", () => {
		expect(piSummaryProvider(pi).assess(request())).toEqual({
			ok: true,
			dollars: 1.4,
		});
	});

	it("writes with the combined focus and no file lists of its own", async () => {
		compact.mockResolvedValue({ summary: "## Goal", usage: { output: 900 } });
		const written = await piSummaryProvider(pi).write(
			request(),
			new AbortController().signal,
		);

		expect(written).toEqual({
			ok: true,
			text: "## Goal",
			usage: { output: 900 },
		});
		const [preparation, , apiKey, headers, focus, , thinking] =
			compact.mock.calls[0] ?? [];
		expect(preparation.fileOps.read.size).toBe(0);
		expect(preparation.firstKeptEntryId).toBe("u1");
		expect(apiKey).toBe("k");
		expect(headers).toEqual({ kept: "yes" });
		expect(focus).toBe("the layer\n\nthe tree");
		expect(thinking).toBe("high");
	});

	it("answers a failure rather than rejecting when pi's summariser throws", async () => {
		compact.mockRejectedValue(new Error("summarization failed"));
		expect(
			await piSummaryProvider(pi).write(
				request(),
				new AbortController().signal,
			),
		).toEqual({ ok: false, reason: "summarization failed" });
	});
});
