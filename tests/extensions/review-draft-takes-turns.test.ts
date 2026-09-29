/**
 * Calls on one draft take turns.
 *
 * Every review_draft call loads the draft, changes it and saves it.
 * An agent issues tool calls in parallel, and two findings noted in
 * one turn then each loaded the draft before the other saved, so the
 * second save wrote the first finding out of it without a word.
 */

import { describe, expect, it } from "vitest";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.ts";

/** One open change, so the draft has a hosted target to belong to. */
const CHANGE = {
	"Shopify/world/pulls/7": {
		stdout: JSON.stringify({
			number: 7,
			title: "Teach the widget to fly",
			body: "",
			state: "open",
			draft: false,
			merged_at: null,
			user: { login: "someone" },
			base: { ref: "main" },
			head: { ref: "topic", sha: "abc1234" },
			html_url: "https://github.com/Shopify/world/pull/7",
			created_at: "2026-08-01T00:00:00Z",
			updated_at: "2026-08-02T00:00:00Z",
		}),
	},
};

/** The item count a show reports, read out of the answer's details. */
function itemsIn(answer: unknown): number | undefined {
	const details = (answer as { details?: { items?: number } }).details;
	return details?.items;
}

describe("calls on one draft at once", () => {
	it("keep every finding noted in parallel", async () => {
		const stub = activate(CHANGE);
		const draft = toolNamed(stub, "review_draft");
		const change = "https://github.com/Shopify/world/pull/7";
		const noted = (body: string) =>
			draft.execute(
				body,
				{ action: "finding", change, path: "a.ts", body },
				undefined,
				undefined,
				HEADLESS,
			);

		const show = () =>
			draft.execute(
				"show",
				{ action: "show", change },
				undefined,
				undefined,
				HEADLESS,
			);
		const before = itemsIn(await show()) ?? 0;

		await Promise.all(["one", "two", "three", "four"].map(noted));

		expect(itemsIn(await show())).toBe(before + 4);
	});

	it("let a call stopped while it waits leave without running", async () => {
		const stub = activate(CHANGE);
		const draft = toolNamed(stub, "review_draft");
		const change = "https://github.com/Shopify/world/pull/7";
		const show = () =>
			draft.execute(
				"show",
				{ action: "show", change },
				undefined,
				undefined,
				HEADLESS,
			);
		// The draft outlives a test, as it outlives a session.
		const before = itemsIn(await show());
		// A plan holds its turn while it fetches the diff, which is held
		// here until the test lets it go.
		let letGo: () => void = () => {};
		const answered = stub.exec.getMockImplementation();
		stub.exec.mockImplementation(async (file: string, args: string[] = []) => {
			if (args.includes("diff")) {
				await new Promise<void>((resolve) => {
					letGo = resolve;
				});
			}
			return answered
				? answered(file, args)
				: { code: 0, stdout: "", stderr: "", killed: false };
		});
		const planning = draft.execute(
			"plan",
			{ action: "plan", change },
			undefined,
			undefined,
			HEADLESS,
		);
		const stop = new AbortController();
		const noting = draft.execute(
			"finding",
			{ action: "finding", change, path: "a.ts", body: "late" },
			stop.signal,
			undefined,
			HEADLESS,
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		stop.abort();

		const settled = await Promise.race([
			noting.then(() => "left"),
			new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200)),
		]);
		letGo();
		await planning;
		expect(settled).toBe("left");
		expect(itemsIn(await show())).toBe(before);
	});
});
