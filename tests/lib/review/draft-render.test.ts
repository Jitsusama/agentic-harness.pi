import { describe, expect, it } from "vitest";
import {
	addFinding,
	addReply,
	type DraftState,
	emptyDraft,
	type LineAnchor,
	type ReviewTarget,
	renderDraft,
	setVerdict,
	type Thread,
} from "../../../lib/review";

const localStack: ReviewTarget = {
	kind: "stack",
	repo: { key: "local:/src/app" },
	refs: ["refs/heads/one", "refs/heads/two"],
};

const anchor: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 12,
};

function draft(): DraftState {
	return emptyDraft("d1", localStack);
}

describe("renderDraft", () => {
	it("names what was reviewed", () => {
		const doc = renderDraft(draft());
		expect(doc.title).toContain("refs/heads/one");
		expect(doc.title).toContain("refs/heads/two");
	});

	it("says plainly when a review found nothing to say", () => {
		expect(renderDraft(draft()).markdown).toMatch(/no remarks/i);
	});

	it("leads with the summary", () => {
		const state = setVerdict(draft(), "comment", "two small things");
		expect(renderDraft(state).markdown).toContain("two small things");
	});

	it("writes each finding under the file it is about", () => {
		let state = addFinding(draft(), { anchor, body: "this leaks" });
		state = addFinding(state, {
			anchor: { ...anchor, path: "lib/other.ts", line: 4 },
			body: "and this shadows",
		});
		const { markdown } = renderDraft(state);
		expect(markdown).toContain("lib/app.ts");
		expect(markdown).toContain("this leaks");
		expect(markdown).toContain("lib/other.ts");
		expect(markdown).toContain("and this shadows");
		expect(markdown.indexOf("lib/app.ts")).toBeLessThan(
			markdown.indexOf("lib/other.ts"),
		);
	});

	it("groups several findings on one file together", () => {
		let state = addFinding(draft(), { anchor, body: "first" });
		state = addFinding(state, {
			anchor: { ...anchor, line: 20 },
			body: "second",
		});
		const { markdown } = renderDraft(state);
		expect(markdown.match(/lib\/app\.ts/g)).toHaveLength(1);
		expect(markdown).toContain("first");
		expect(markdown).toContain("second");
	});

	it("says which line and which side of the diff a finding is on", () => {
		const state = addFinding(draft(), { anchor, body: "here" });
		const { markdown } = renderDraft(state);
		expect(markdown).toContain("12");
		expect(markdown).toContain("new");
	});

	it("shows a range as a range", () => {
		const state = addFinding(draft(), {
			anchor: { ...anchor, startLine: 8 },
			body: "this block",
		});
		expect(renderDraft(state).markdown).toContain("8-12");
	});

	it("records an approval as a Reviewed-by trailer", () => {
		const state = setVerdict(draft(), "approve", "good");
		const doc = renderDraft(state, {
			author: { id: "joel@shopify.com", name: "Joel Gerber" },
		});
		expect(doc.trailers).toEqual([
			"Reviewed-by: Joel Gerber <joel@shopify.com>",
		]);
		expect(doc.markdown).toContain("Reviewed-by:");
	});

	it("records requested changes as a Nacked-by trailer", () => {
		const state = setVerdict(draft(), "request-changes", "not yet");
		const doc = renderDraft(state, { author: { id: "joel@shopify.com" } });
		expect(doc.trailers).toEqual(["Nacked-by: joel@shopify.com"]);
	});

	it("leaves a comment-only review without a verdict trailer", () => {
		const state = setVerdict(draft(), "comment", "just notes");
		const doc = renderDraft(state, { author: { id: "joel@shopify.com" } });
		expect(doc.trailers).toEqual([]);
	});

	it("omits the trailer when nobody is named as the reviewer", () => {
		const doc = renderDraft(setVerdict(draft(), "approve", "good"));
		expect(doc.trailers).toEqual([]);
	});

	it("notes a reply that has no thread to land in", () => {
		const thread: Thread = {
			id: "t1",
			resolved: false,
			comments: [{ id: "c1", author: { id: "someone" }, body: "why?" }],
		};
		const state = addReply(draft(), thread, "because of the retry");
		const { markdown } = renderDraft(state);
		expect(markdown).toContain("because of the retry");
		expect(markdown).toMatch(/repl/i);
	});

	it("keeps a multi-line remark attached to its own list item", () => {
		// Every remark worth making runs past one line: a header, a
		// blank, then the reasoning. Indenting only the first line
		// ends the list at that blank, and the reasoning reads as
		// loose prose belonging to nobody.
		const state = addFinding(draft(), {
			anchor,
			body: "**issue:** it leaks\n\nThe handle is never closed.",
		});

		const tail = renderDraft(state)
			.markdown.split("\n")
			.find((line) => line.includes("The handle is never closed"));
		expect(tail).toBeDefined();
		expect(tail?.startsWith(" ")).toBe(true);
	});

	it("keeps a multi-line reply attached to its own list item", () => {
		const thread: Thread = {
			id: "t1",
			resolved: false,
			comments: [{ id: "c1", author: { id: "someone" }, body: "why?" }],
		};
		const state = addReply(
			draft(),
			thread,
			"Fixed in the last push.\n\nThe retry now backs off.",
		);

		const tail = renderDraft(state)
			.markdown.split("\n")
			.find((line) => line.includes("The retry now backs off"));
		expect(tail).toBeDefined();
		expect(tail?.startsWith(" ")).toBe(true);
	});

	it("leaves a blank line inside a remark genuinely blank", () => {
		// Padding the gap with indent spaces would leave trailing
		// whitespace on every paragraph break in the document.
		const state = addFinding(draft(), {
			anchor,
			body: "**issue:** it leaks\n\nThe handle is never closed.",
		});
		expect(renderDraft(state).markdown).not.toMatch(/[ \t]+\n/);
	});
});
