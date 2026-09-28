import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the two web tools answer when the person stops them.
 *
 * Pi marks a tool result as an error only when execute throws, which is
 * what its own tools do on abort. A tool that turns an abort into an
 * ordinary answer tells the model it has a result when it has none.
 */

const reads = vi.hoisted(() => ({
	readPage: vi.fn(),
	webSearch: vi.fn(),
}));

vi.mock("@jitsusama/agentic-harness.core/web/reader", () => ({
	AuthSetupNeeded: class AuthSetupNeeded extends Error {},
	cleanupSessionBundles: vi.fn(),
	readPage: reads.readPage,
	reapAbandonedBundles: vi.fn(),
}));
vi.mock("@jitsusama/agentic-harness.core/web/search", () => ({
	webSearch: reads.webSearch,
}));
vi.mock("@jitsusama/agentic-harness.core/web/browser", () => ({
	closeBrowser: vi.fn(),
	killBrowserSync: vi.fn(),
}));
vi.mock("@jitsusama/agentic-harness.core/web/cookies", () => ({
	isSetUp: () => false,
	StaleKeyError: class StaleKeyError extends Error {},
	setupChromeKey: vi.fn(),
}));

const { default: webSearchIntegration } = await import(
	"../../../extensions/web-search-integration/index.ts"
);

interface Tool {
	name: string;
	renderResult(
		result: { content: { type: string; text: string }[]; details: unknown },
		options: { expanded: boolean },
		palette: typeof theme,
		context: { isError: boolean; lastComponent: undefined },
	): { render(width: number): string[] };
	execute(
		id: string,
		params: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ content: { type: string; text: string }[] }>;
}

/** The two tools, as the extension registered them. */
function tools(): Map<string, Tool> {
	const found = new Map<string, Tool>();
	const pi = {
		registerTool(definition: Tool) {
			found.set(definition.name, definition);
		},
		registerCommand() {},
		on() {},
	};
	webSearchIntegration(pi as never);
	return found;
}

/** A theme that says which colour each piece was given. */
const theme = {
	fg: (colour: string, text: string) => `<${colour}>${text}`,
	bold: (text: string) => text,
};

/** Work that rejects the way core does once its signal fires. */
function abortable(signal?: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		signal?.addEventListener("abort", () =>
			reject(new DOMException("This operation was aborted", "AbortError")),
		);
	});
}

const CALLS = [
	["web_read", { url: "https://example.com" }],
	["web_search", { query: "anything" }],
] as const;

describe("the web tools when stopped", () => {
	beforeEach(() => {
		reads.readPage.mockImplementation((_url, signal) => abortable(signal));
		reads.webSearch.mockImplementation((_q, _n, signal) => abortable(signal));
	});

	for (const [name, params] of CALLS) {
		it(`${name} fails rather than answering when its signal fires`, async () => {
			const tool = tools().get(name);
			const stop = new AbortController();
			const running = tool?.execute("call", params, stop.signal);

			stop.abort();

			await expect(running).rejects.toThrow(/abort/i);
		});
	}

	for (const [name] of CALLS) {
		it(`${name} draws the stop as an error, not a result`, () => {
			// What pi hands the renderer once execute has thrown.
			const failed = {
				content: [{ type: "text", text: "Operation aborted" }],
				details: {},
			};
			const drawn = tools()
				.get(name)
				?.renderResult(failed, { expanded: false }, theme, {
					isError: true,
					lastComponent: undefined,
				})
				.render(80)
				.join("\n");

			expect(drawn).toContain("<error>Operation aborted");
			expect(drawn).not.toContain("✓");
		});
	}

	for (const [name, params] of CALLS) {
		it(`${name} still explains a failure nobody asked for`, async () => {
			const unreachable = new Error("net::ERR_NAME_NOT_RESOLVED");
			reads.readPage.mockRejectedValue(unreachable);
			reads.webSearch.mockRejectedValue(unreachable);
			const tool = tools().get(name);

			const answer = await tool?.execute(
				"call",
				params,
				new AbortController().signal,
			);

			expect(answer?.content[0]?.text).toContain("ERR_NAME_NOT_RESOLVED");
		});
	}
});
