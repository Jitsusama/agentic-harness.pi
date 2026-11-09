import { afterEach, describe, expect, it, vi } from "vitest";
import {
	cleanupSessionResults,
	createResultStore,
	sessionResultDir,
} from "../../../lib/core/result/index.ts";
import { resultSession } from "../../support/result-session.ts";

/**
 * What the google tool does when Google will not answer.
 *
 * Every request already ends at core's request clock. A read is also
 * safe to walk away from, so it answers its caller's stop at once and
 * holds to a clock of the tool's own across however many requests it
 * makes. A write is not: a stop cannot say whether the write landed, so
 * it runs to Google's answer, which the request clock still bounds.
 */

vi.mock("../../../lib/google/auth/ensure-auth.ts", () => ({
	ensureAuthenticated: async () => ({}),
}));
vi.mock("../../../lib/google/index.ts", async (original) => ({
	...(await original<object>()),
	searchEmails: () => new Promise(() => {}),
	archiveEmail: () => new Promise(() => {}),
	listFiles: async () => ({
		files: Array.from({ length: 2_000 }, (_, i) => ({
			id: `file-${i}`,
			name: `Document number ${i} with a long descriptive name`,
			mimeType: "application/pdf",
			modifiedTime: "2026-01-01T00:00:00Z",
		})),
	}),
}));

const { default: googleWorkspace } = await import(
	"../../../extensions/google-workspace-integration/index.ts"
);
const { GOOGLE_READ_WALL_MS } = await import(
	"../../../extensions/google-workspace-integration/limits.ts"
);

interface Tool {
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	): Promise<{ content: { type: string; text: string }[] }>;
}

/** Longer than a call given up on should take to end. */
const STILL_RUNNING_MS = 2000;

/** The call's outcome, or a note that it was still waiting. */
async function outcome(call: Promise<unknown>): Promise<string> {
	const running = new Promise<string>((resolve) =>
		setTimeout(() => resolve("still running"), STILL_RUNNING_MS),
	);
	return Promise.race([
		call.then(
			(result) => {
				const text = (result as { content: { text: string }[] }).content[0]
					?.text;
				return `answered: ${text}`;
			},
			(error: unknown) =>
				error instanceof Error ? `failed: ${error.name}` : "failed",
		),
		running,
	]);
}

/** The google tool, as the extension registered it. */
function googleTool(): Tool {
	let found: Tool | undefined;
	const pi = {
		registerTool(definition: Tool) {
			found = definition;
		},
		registerCommand() {},
		on() {},
		events: { on() {}, emit() {} },
	};
	googleWorkspace(pi as never);
	if (!found) throw new Error("the google tool was not registered");
	return found;
}

const ctx = { ...resultSession(), hasUI: false };

describe("a google call Google never answers", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stores a large Drive listing only in its caller's session", async () => {
		const caller = { ...resultSession(), hasUI: false };
		const other = resultSession();
		try {
			const result = await googleTool().execute(
				"call",
				{ action: "list_files" },
				undefined,
				undefined,
				caller,
			);
			const handle = /handle (result-[0-9a-f]{16})/.exec(
				result.content[0].text,
			)?.[1];
			expect(handle).toBeDefined();
			expect(
				JSON.parse(
					createResultStore({ dir: sessionResultDir(caller) }).read(
						handle as string,
					),
				),
			).toHaveLength(2_000);
			expect(() =>
				createResultStore({ dir: sessionResultDir(other) }).read(
					handle as string,
				),
			).toThrow();
		} finally {
			cleanupSessionResults(caller);
			cleanupSessionResults(other);
		}
	});

	it("ends a read the moment its caller stops", async () => {
		const controller = new AbortController();
		const call = googleTool().execute(
			"call",
			{ action: "search_emails", query: "from:someone" },
			controller.signal,
			undefined,
			ctx,
		);
		setTimeout(() => controller.abort(), 50);
		expect(await outcome(call)).toBe("failed: AbortError");
	});

	it("gives up on a read at its clock and says so", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const call = googleTool().execute(
			"call",
			{ action: "search_emails", query: "from:someone" },
			undefined,
			undefined,
			ctx,
		);
		// Handled now, so a rejection while the clock is wound on is not
		// reported as unhandled before outcome listens.
		const watched = call.then((result) => result);
		watched.catch(() => {});
		await vi.advanceTimersByTimeAsync(GOOGLE_READ_WALL_MS);
		vi.useRealTimers();
		expect(await outcome(watched)).toMatch(/^answered: .*given up on/);
	});

	it("lets a write run to Google's answer rather than guess it failed", async () => {
		const controller = new AbortController();
		const call = googleTool().execute(
			"call",
			{ action: "archive_email", id: "m1" },
			controller.signal,
			undefined,
			ctx,
		);
		call.catch(() => {});
		setTimeout(() => controller.abort(), 50);
		expect(await outcome(call)).toBe("still running");
	});
});
