import { describe, expect, it } from "vitest";
import type { BranchReader } from "../../../../lib/internal/session/branch-walk.ts";
import {
	blockedLine,
	endingOf,
	lastRun,
	type SaidEntry,
} from "../../../../lib/internal/session/ending.ts";

describe("how a run said it ended", () => {
	it.each([
		["Done: all three PRs merged.", "done"],
		["Notes.\n\n**Blocked:** CI needs a secret only you have.", "blocked"],
		["- Done: shipped", "done"],
		["blocked: no access", "blocked"],
	] as const)("reads %j as %s", (text, ending) => {
		expect(endingOf(text)).toBe(ending);
	});

	it.each([
		"Blocked: the build.\n\nI'll try another approach next.",
		"Here's a summary of what I did.",
		"Should I go ahead with the PR?",
		"",
	])("reads %j as not ended", (text) => {
		expect(endingOf(text)).toBeUndefined();
	});
});

describe("blockedLine", () => {
	it("reads what the last line says it is blocked on", () => {
		expect(blockedLine("Did things.\n\n**Blocked: the OTP.**")).toBe(
			"the OTP.",
		);
		expect(blockedLine("- blocked: a decision")).toBe("a decision");
		expect(
			blockedLine("Notes.\n\n**Blocked:** CI needs a secret only you have."),
			"a bold label alone",
		).toBe("CI needs a secret only you have.");
	});

	it("is nothing for a run that did not end blocked", () => {
		expect(blockedLine("Blocked: early\nDone: all of it")).toBeUndefined();
	});
});

/** A session whose branch is these entries, oldest first. */
function branch(
	...entries: Omit<SaidEntry, "id" | "parentId">[]
): BranchReader<SaidEntry> {
	const linked = entries.map((entry, at) => ({
		...entry,
		id: `e${at}`,
		parentId: at === 0 ? null : `e${at - 1}`,
	}));
	const byId = new Map(linked.map((entry) => [entry.id, entry]));
	return {
		getLeafId: () => linked.at(-1)?.id ?? null,
		getEntry: (id) => byId.get(id),
	};
}

function said(...content: unknown[]): Omit<SaidEntry, "id" | "parentId"> {
	return { type: "message", message: { role: "assistant", content } };
}

function heard(text: string): Omit<SaidEntry, "id" | "parentId"> {
	return { type: "custom_message", message: { role: "custom", content: text } };
}

describe("what a run last said", () => {
	it("reads the last assistant message's text past what landed since", () => {
		const session = branch(
			{ type: "message", message: { role: "user", content: "go" } },
			said(
				{ type: "text", text: "Looked." },
				{ type: "text", text: "Blocked: 2AF2DH's sha." },
			),
			heard("a mesh message"),
			{ type: "model_change" },
		);
		expect(lastRun(session)).toEqual({
			id: "e1",
			text: "Looked.\nBlocked: 2AF2DH's sha.",
		});
	});

	it("is nothing when the last assistant message called a tool", () => {
		const session = branch(
			said({ type: "text", text: "Blocked: old." }),
			said(
				{ type: "text", text: "Checking." },
				{ type: "toolCall", id: "t", name: "bash" },
			),
		);
		expect(lastRun(session)).toBeUndefined();
	});

	it("is nothing for a session with nothing said", () => {
		expect(lastRun(branch())).toBeUndefined();
		expect(lastRun(branch(heard("only heard")))).toBeUndefined();
	});

	it.each([
		["a prompt", "user"],
		["a tool's result", "toolResult"],
	])("is nothing once %s came after, since a run is under way", (_, role) => {
		const session = branch(said({ type: "text", text: "Blocked: old." }), {
			type: "message",
			message: { role, content: "go" },
		});
		expect(lastRun(session)).toBeUndefined();
	});

	// A cell left blocked overnight hears hundreds of glances; on 24 Nov a
	// walk of 200 entries would have lost its Blocked: line to them.
	it("reads back past a night of what the mesh wrote", () => {
		const night = Array.from({ length: 2000 }, () => heard("noise"));
		const session = branch(
			said({ type: "text", text: "Blocked: far back." }),
			...night,
		);
		expect(lastRun(session)?.text).toBe("Blocked: far back.");
	});

	it("stops reading back after a bounded walk", () => {
		const behind = (noise: number) =>
			lastRun(
				branch(
					said({ type: "text", text: "Blocked: far back." }),
					...Array.from({ length: noise }, () => heard("noise")),
				),
			)?.text;
		expect(behind(9_999), "the last entry the walk reads").toBe(
			"Blocked: far back.",
		);
		expect(behind(10_000), "one past it").toBeUndefined();
	});
});
