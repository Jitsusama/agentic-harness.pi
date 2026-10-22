/**
 * A draft's id stands for the change it was opened against.
 *
 * A draft keeps its target, yet a call naming only the draft left the
 * change unbound, so planning, publishing, replying and deciding all
 * refused with "Name the change rather than a draft id". Naming the
 * change as well was ignored while a draft id was there, so following
 * the refusal met the same refusal again.
 */

import { describe, expect, it } from "vitest";
import { activate, HEADLESS, toolNamed } from "./support/review-extension.ts";

/** A hosted change as the fake GitHub answers it. */
function pull(number: number, title: string) {
	return {
		stdout: JSON.stringify({
			number,
			title,
			body: "",
			state: "open",
			draft: false,
			merged_at: null,
			user: { login: "someone" },
			base: { ref: "main" },
			head: { ref: `topic-${number}`, sha: `abc123${number}` },
			html_url: `https://github.com/Shopify/world/pull/${number}`,
			created_at: "2026-08-01T00:00:00Z",
			updated_at: "2026-08-02T00:00:00Z",
		}),
	};
}

const CHANGES = {
	"Shopify/world/pulls/7": pull(7, "Teach the widget to fly"),
	"Shopify/world/pulls/8": pull(8, "Teach the widget to land"),
};

const SEVEN = "https://github.com/Shopify/world/pull/7";
const EIGHT = "https://github.com/Shopify/world/pull/8";

type Answer = { content: { text: string }[]; details?: { id?: string } };

/** The review_draft tool, called headless. */
function draftTool() {
	const draft = toolNamed(activate(CHANGES), "review_draft");
	return (params: Record<string, unknown>) =>
		draft.execute(
			"call",
			params,
			undefined,
			undefined,
			HEADLESS,
		) as Promise<Answer>;
}

/** A draft on change 7, by its id. */
async function draftOnSeven(call: ReturnType<typeof draftTool>) {
	const opened = await call({ action: "open", change: SEVEN });
	const id = opened.details?.id;
	expect(id).toBeDefined();
	return id as string;
}

describe("a draft named by its id", () => {
	it("plans against the change it was opened on, with no change named", async () => {
		const call = draftTool();
		const id = await draftOnSeven(call);

		const planned = await call({ action: "plan", draft: id });

		expect(planned.content[0]?.text).not.toMatch(/Name the change/);
		expect(planned.content[0]?.text).not.toMatch(/could not be found again/);
	});

	it("takes the same change named beside it", async () => {
		const call = draftTool();
		const id = await draftOnSeven(call);

		const planned = await call({ action: "plan", draft: id, change: SEVEN });

		expect(planned.content[0]?.text).not.toMatch(/Name the change|is for/);
	});

	it("refuses a different change named beside it, saying which is which", async () => {
		const call = draftTool();
		const id = await draftOnSeven(call);

		const planned = await call({ action: "plan", draft: id, change: EIGHT });

		expect(planned.content[0]?.text).toMatch(
			new RegExp(`Draft ${id} is for .+#7, not .+#8\\.`),
		);
	});
});
