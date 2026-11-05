/**
 * A reviewer's request marks where the brief it shares ends.
 *
 * Measured before this existed: four reviewers sent the same 64,000
 * token brief each wrote all of it to the cache and read none of it,
 * because the only mark on the first message was at the end of each
 * reviewer's own lens. With a mark at the end of the brief, and the
 * second reviewer started after the first had begun answering, the
 * second read 63,950 tokens and wrote 14.
 */

import { describe, expect, it } from "vitest";
import { withBriefBreakpoint } from "../../../lib/subagent/brief-breakpoint.ts";

const CONTROL = { type: "ephemeral", ttl: "1h" };
const BRIEF =
	'<file name="/tmp/pi-reviewer-prompt-1-abc.md">\nthe diff\n</file>\n';
const LENS = "## Your lens\n\nDistrust a green suite.";

/** A first request the way pi's Anthropic transport builds one. */
function firstRequest(text: string) {
	return {
		model: "claude-opus-5-5",
		tools: [{ name: "read" }, { name: "grep", cache_control: CONTROL }],
		system: [
			{ type: "text", text: "You review changes.", cache_control: CONTROL },
		],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text, cache_control: CONTROL }],
			},
		],
	};
}

type Request = ReturnType<typeof firstRequest>;

function blocksOf(payload: unknown) {
	return (payload as Request).messages[0]?.content ?? [];
}

describe("marking where the shared brief ends", () => {
	it("splits the first message after the last file and marks the brief", () => {
		const marked = withBriefBreakpoint(firstRequest(`${BRIEF}${LENS}`));

		expect(blocksOf(marked)).toEqual([
			{ type: "text", text: BRIEF, cache_control: CONTROL },
			{ type: "text", text: LENS, cache_control: CONTROL },
		]);
	});

	it("gives every reviewer of a round the same first block", () => {
		// The whole point: what differs is only what comes after the mark.
		const one = blocksOf(withBriefBreakpoint(firstRequest(`${BRIEF}${LENS}`)));
		const two = blocksOf(
			withBriefBreakpoint(firstRequest(`${BRIEF}## Your lens\n\nAttack it.`)),
		);

		expect(one[0]).toEqual(two[0]);
		expect(one[1]).not.toEqual(two[1]);
	});

	it("cuts at the last file's close, not one quoted inside the brief", () => {
		// A change's own description can hold the line, being markdown
		// somebody else wrote.
		const quoting =
			'<file name="/b.md">\nThe body says\n</file>\nand goes on.\n</file>\n';

		const marked = withBriefBreakpoint(firstRequest(`${quoting}${LENS}`));

		expect(blocksOf(marked)[0]).toMatchObject({ text: quoting });
	});

	it("marks the brief on later turns too, so a reviewer keeps reading it", () => {
		// A later turn's first message carries no mark of its own; the mark
		// copies the request's, so the brief lives as long as the rest.
		const later = {
			...firstRequest(`${BRIEF}${LENS}`),
			messages: [
				{ role: "user", content: [{ type: "text", text: `${BRIEF}${LENS}` }] },
				{ role: "assistant", content: [{ type: "text", text: "Reading." }] },
				{
					role: "user",
					content: [{ type: "text", text: "result", cache_control: CONTROL }],
				},
			],
		};

		const marked = withBriefBreakpoint(later);

		expect(blocksOf(marked)).toEqual([
			{ type: "text", text: BRIEF, cache_control: CONTROL },
			{ type: "text", text: LENS },
		]);
	});

	it("leaves alone a message that is nothing but files", () => {
		// pi already marks the end of it, which is the end of the brief.
		expect(withBriefBreakpoint(firstRequest(BRIEF))).toBeUndefined();
	});

	it("leaves alone a first message that did not come from a file", () => {
		expect(
			withBriefBreakpoint(firstRequest(`Hello.\n</file>\n${LENS}`)),
		).toBeUndefined();
	});

	it("leaves alone a request that caches nothing", () => {
		// A mark of ours would turn caching on where somebody turned it off.
		const uncached = {
			model: "m",
			messages: [
				{ role: "user", content: [{ type: "text", text: `${BRIEF}${LENS}` }] },
			],
		};

		expect(withBriefBreakpoint(uncached)).toBeUndefined();
	});

	it("leaves alone a request with no room for another mark", () => {
		// Anthropic refuses a fifth, and a refused request costs the turn.
		const full = firstRequest(`${BRIEF}${LENS}`);
		full.system.push({ type: "text", text: "More.", cache_control: CONTROL });

		expect(withBriefBreakpoint(full)).toBeUndefined();
	});

	it("leaves alone a request in some other provider's shape", () => {
		expect(withBriefBreakpoint({ input: `${BRIEF}${LENS}` })).toBeUndefined();
		expect(withBriefBreakpoint(undefined)).toBeUndefined();
	});
});
