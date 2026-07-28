import { describe, expect, it } from "vitest";
import {
	addFinding,
	addReaction,
	addReply,
	addResolution,
	type DraftState,
	emptyDraft,
	type LineAnchor,
	type ReviewTarget,
	removeItem,
	setVerdict,
	type Thread,
} from "../../../lib/review";

const target: ReviewTarget = {
	kind: "proposal",
	change: {
		provider: "meteorite",
		repo: { key: "gitstream:shop/world" },
		id: "2000970",
	},
};

const anchor: LineAnchor = {
	subject: "line",
	path: "lib/app.ts",
	blob: "new",
	line: 12,
};

const thread: Thread = {
	id: "thread-1",
	resolved: false,
	comments: [{ id: "c1", author: { id: "someone" }, body: "why?" }],
};

function draft(): DraftState {
	return emptyDraft("d1", target);
}

describe("a review draft", () => {
	it("starts empty, with no verdict chosen", () => {
		const state = draft();
		expect(state.id).toBe("d1");
		expect(state.items).toEqual([]);
		expect(state.verdict).toBeUndefined();
	});

	it("remembers the target it is about", () => {
		expect(draft().target).toEqual(target);
	});

	it("takes an anchored finding and gives it an id", () => {
		const state = addFinding(draft(), { anchor, body: "this leaks" });
		expect(state.items).toHaveLength(1);
		const [item] = state.items;
		expect(item.kind).toBe("finding");
		expect(item.id).toBeTruthy();
		expect(item.kind === "finding" && item.body).toBe("this leaks");
	});

	it("numbers items so a person can refer to one", () => {
		let state = addFinding(draft(), { anchor, body: "first" });
		state = addFinding(state, { anchor, body: "second" });
		expect(state.items.map((item) => item.id)).toEqual(["1", "2"]);
	});

	it("takes a reply into an existing thread", () => {
		const state = addReply(draft(), thread, "because of the retry");
		const [item] = state.items;
		expect(item.kind).toBe("reply");
		expect(item.kind === "reply" && item.thread.id).toBe("thread-1");
		expect(item.kind === "reply" && item.body).toBe("because of the retry");
	});

	it("takes a resolution of an existing thread", () => {
		const state = addResolution(draft(), thread);
		expect(state.items[0].kind).toBe("resolution");
	});

	it("takes a reaction to a message", () => {
		const state = addReaction(draft(), thread.comments[0], "rocket");
		const [item] = state.items;
		expect(item.kind).toBe("reaction");
		expect(item.kind === "reaction" && item.reaction).toBe("rocket");
	});

	it("keeps a verdict and its summary apart from the items", () => {
		const state = setVerdict(draft(), "request-changes", "two things");
		expect(state.verdict).toBe("request-changes");
		expect(state.summary).toBe("two things");
		expect(state.items).toEqual([]);
	});

	it("replaces a verdict rather than stacking them", () => {
		let state = setVerdict(draft(), "approve");
		state = setVerdict(state, "comment", "actually just notes");
		expect(state.verdict).toBe("comment");
		expect(state.summary).toBe("actually just notes");
	});

	it("drops an item by id and leaves the rest numbered as they were", () => {
		let state = addFinding(draft(), { anchor, body: "first" });
		state = addFinding(state, { anchor, body: "second" });
		state = removeItem(state, "1");
		expect(state.items.map((item) => item.id)).toEqual(["2"]);
	});

	it("keeps numbering past a removal so ids stay stable", () => {
		let state = addFinding(draft(), { anchor, body: "first" });
		state = removeItem(state, "1");
		state = addFinding(state, { anchor, body: "second" });
		expect(state.items.map((item) => item.id)).toEqual(["2"]);
	});

	it("ignores a removal of something that is not there", () => {
		const state = removeItem(addFinding(draft(), { anchor, body: "x" }), "9");
		expect(state.items).toHaveLength(1);
	});

	it("never mutates the state it was given", () => {
		const before = draft();
		addFinding(before, { anchor, body: "x" });
		setVerdict(before, "approve");
		expect(before.items).toEqual([]);
		expect(before.verdict).toBeUndefined();
	});
});
