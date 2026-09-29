/**
 * A publish stops where it was stopped.
 *
 * Publishing sends a review's operations one after another. Stopped
 * halfway, it used to send the rest anyway, since nothing handed the
 * call's signal to the publish. Now it stops between operations, and
 * what it did not send stays in the draft for the next publish.
 */

import { describe, expect, it } from "vitest";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.ts";

/** One open change, numbered apart from the other suites' changes. */
const CHANGE = {
	"Shopify/world/pulls/8": {
		stdout: JSON.stringify({
			number: 8,
			title: "Teach the widget to fly",
			body: "",
			state: "open",
			draft: false,
			merged_at: null,
			user: { login: "someone" },
			base: { ref: "main" },
			head: { ref: "topic", sha: "abc1234" },
			html_url: "https://github.com/Shopify/world/pull/8",
			created_at: "2026-08-01T00:00:00Z",
			updated_at: "2026-08-02T00:00:00Z",
		}),
	},
};

describe("a publish stopped while it sends", () => {
	it("sends nothing after the stop and keeps it in the draft", async () => {
		const stub = activate(CHANGE);
		const draft = toolNamed(stub, "review_draft");
		const change = "https://github.com/Shopify/world/pull/8";
		const run = (params: object, signal?: AbortSignal) =>
			draft.execute("x", { change, ...params }, signal, undefined, HEADLESS);
		const itemsLeft = async () =>
			(
				(await run({ action: "show" })) as {
					details?: { items?: number };
				}
			).details?.items;

		await run({ action: "finding", path: "a.ts", body: "First remark here." });
		await run({
			action: "verdict",
			verdict: "comment",
			body: "Looks fine overall.",
		});
		// The verdict rides on the review; the file-wide remark is its own
		// comment, sent after it.
		expect(await itemsLeft()).toBe(1);

		// The stop arrives while the first operation is on its way.
		const stop = new AbortController();
		const answered = stub.exec.getMockImplementation();
		stub.exec.mockImplementation(async (file: string, args: string[] = []) => {
			if (args.some((arg) => arg.endsWith("/reviews"))) stop.abort();
			return answered
				? answered(file, args)
				: { code: 0, stdout: "", stderr: "", killed: false };
		});
		const sent = stub.commands.length;
		await run({ action: "publish" }, stop.signal);

		const posts = stub.commands
			.slice(sent)
			.filter((command) => command.includes("POST"));
		expect(posts.length).toBe(1);
		expect(await itemsLeft()).toBe(1);
	});
});
