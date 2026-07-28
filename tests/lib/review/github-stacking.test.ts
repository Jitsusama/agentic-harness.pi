import { describe, expect, it } from "vitest";
import { type ChangeRef, createGitHubProvider } from "../../../lib/review";
import { fakeExec, type Reply } from "./support/fake-exec.js";

const repo = { key: "github:Shopify/world" };
const ref: ChangeRef = {
	provider: "github",
	repo,
	id: "2",
	label: "Shopify/world#2",
};

/** One pull request as `gh pr list --json` spells it. */
function pull(number: number, head: string, base: string) {
	return {
		number,
		title: `PR ${number}`,
		body: "",
		state: "OPEN",
		isDraft: false,
		author: { login: "someone" },
		baseRefName: base,
		headRefName: head,
		url: `https://github.com/Shopify/world/pull/${number}`,
	};
}

/** The pull request the walk starts from. */
function cursorReply(head: string, base: string, number = 2): Reply {
	return {
		when: [`pulls/${number}`],
		stdout: JSON.stringify({
			number,
			title: `PR ${number}`,
			body: "",
			state: "open",
			draft: false,
			merged_at: null,
			user: { login: "someone" },
			base: { ref: base },
			head: { ref: head, sha: "sha" },
			html_url: `https://github.com/Shopify/world/pull/${number}`,
		}),
	};
}

/** Answers a head-branch lookup. */
function byHead(branch: string, pulls: unknown[]): Reply {
	return { when: ["--head", branch], stdout: JSON.stringify(pulls) };
}

/** Answers a base-branch lookup. */
function byBase(branch: string, pulls: unknown[]): Reply {
	return { when: ["--base", branch], stdout: JSON.stringify(pulls) };
}

function provider(replies: Reply[]) {
	const { exec, calls } = fakeExec(replies);
	return { gh: createGitHubProvider({ exec }), calls };
}

describe("deriving a stack", () => {
	it("says the shape was derived, never recorded", async () => {
		const { gh } = provider([
			cursorReply("topic", "main"),
			byHead("main", []),
			byBase("topic", []),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.provenance).toBe("derived");
	});

	it("reports a lone change as a stack of one, on its trunk", async () => {
		const { gh } = provider([
			cursorReply("topic", "main"),
			byHead("main", []),
			byBase("topic", []),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.nodes.map((node) => node.ref)).toEqual(["topic"]);
		expect(stack?.nodes[0].parent).toBeUndefined();
		expect(stack?.trunk).toBe("main");
		expect(stack?.cursor).toBe(0);
	});

	it("walks up to a parent and down to a child, in order", async () => {
		const { gh } = provider([
			cursorReply("middle", "bottom"),
			byHead("bottom", [pull(1, "bottom", "main")]),
			byHead("main", []),
			byBase("middle", [pull(3, "top", "middle")]),
			byBase("top", []),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.nodes.map((node) => node.ref)).toEqual([
			"bottom",
			"middle",
			"top",
		]);
		expect(stack?.nodes.map((node) => node.parent)).toEqual([
			undefined,
			"bottom",
			"middle",
		]);
		expect(stack?.cursor).toBe(1);
		expect(stack?.trunk).toBe("main");
	});

	it("hangs the proposal it found on each node", async () => {
		const { gh } = provider([
			cursorReply("topic", "main"),
			byHead("main", []),
			byBase("topic", [pull(3, "child", "topic")]),
			byBase("child", []),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.nodes[0].proposal?.ref.id).toBe("2");
		expect(stack?.nodes[1].proposal?.title).toBe("PR 3");
	});

	it("keeps both children when the stack fans out", async () => {
		const { gh } = provider([
			cursorReply("trunk-ish", "main"),
			byHead("main", []),
			byBase("trunk-ish", [
				pull(3, "left", "trunk-ish"),
				pull(4, "right", "trunk-ish"),
			]),
			byBase("left", []),
			byBase("right", []),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.nodes.map((node) => node.ref)).toEqual([
			"trunk-ish",
			"left",
			"right",
		]);
		expect(stack?.nodes.map((node) => node.parent)).toEqual([
			undefined,
			"trunk-ish",
			"trunk-ish",
		]);
	});

	it("stops rather than looping when the names form a cycle", async () => {
		const { gh } = provider([
			cursorReply("a", "b"),
			byHead("b", [pull(1, "b", "a")]),
			byHead("a", [pull(2, "a", "b")]),
			byBase("a", [pull(1, "b", "a")]),
			byBase("b", [pull(2, "a", "b")]),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.nodes.length).toBeLessThanOrEqual(2);
	});

	it("truncates where the chain leaves open pull requests", async () => {
		// A merged parent is no longer listed, so the walk simply
		// ends: the honest limit of deriving a stack from names.
		const { gh } = provider([
			cursorReply("middle", "already-merged"),
			byHead("already-merged", []),
			byBase("middle", []),
		]);
		const stack = await gh.stacking?.stack(ref);
		expect(stack?.nodes.map((node) => node.ref)).toEqual(["middle"]);
		expect(stack?.trunk).toBe("already-merged");
	});

	it("asks only about open pull requests", async () => {
		const { gh, calls } = provider([
			cursorReply("topic", "main"),
			byHead("main", []),
			byBase("topic", []),
		]);
		await gh.stacking?.stack(ref);
		const lookups = calls.filter((call) => call.args.includes("list"));
		expect(lookups.length).toBeGreaterThan(0);
		for (const call of lookups) {
			expect(call.args.join(" ")).toContain("--state open");
		}
	});
});
