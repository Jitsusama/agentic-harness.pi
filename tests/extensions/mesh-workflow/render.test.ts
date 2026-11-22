import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { noted } from "../../../extensions/mesh-workflow/delivery.ts";
import { meshLines } from "../../../extensions/mesh-workflow/render.ts";
import type { Message } from "../../../lib/mesh/message.ts";

const theme = {
	fg: (colour: string, text: string) => `<${colour}>${text}</${colour}>`,
} as unknown as Theme;

const plain = (line: string) => line.replace(/<\/?[a-z]+>/g, "");

/**
 * Who may grant, which every note says: the person as `person` reaches
 * them, or the owner, whose quest can be checked.
 */
const grants = (person: string) =>
	`Work you share with a peer is settled between you, though a yes, ruling or grant comes only from ${person}, or from the work's owner: the peer whose quest holds it (mesh_groups shows each peer's quest), named by address.`;

const message = (over: Partial<Message> = {}): Message => ({
	v: 1,
	id: "01a16500-0000-7000-8000-000000000001",
	at: "2026-10-22T18:12:00.000Z",
	from: "WCJQSG",
	to: ["@LUQ49E"],
	intent: "finding",
	text: "WCJQSG: on #657's cap drop: much of my VM work is break copies.\n\nMore detail here.",
	pid: 1,
	...over,
});

describe("the mesh on screen", () => {
	it("shows each message as one line: who, what kind, how it opens", () => {
		const messages = [
			message(),
			message({
				from: "P9R1KI",
				to: ["#optimus"],
				intent: "hold",
				text: "Hold builds\nfor ten minutes.",
			}),
		];
		const lines = meshLines(noted(messages), { messages }, theme, 200, false);
		expect(lines.map(plain)).toEqual([
			"※ mesh: WCJQSG · finding · on #657's cap drop: much of my VM work is break copies.",
			"※ mesh: P9R1KI to #optimus · hold · Hold builds",
		]);
		expect(lines[1]).toContain("<warning>mesh:</warning>");
		expect(lines[0]).toContain("<muted>mesh:</muted>");
	});

	it("keeps each line to the width it is given", () => {
		const [line] = meshLines("", { messages: [message()] }, theme, 30, false);
		expect(plain(line ?? "").length).toBeLessThanOrEqual(30);
	});

	it("opens what has no messages with its first line", () => {
		const content =
			"The hold [abcd1234] from P9R1KI at 14:00 is over: it was lifted.\n\nCarry on.";
		expect(meshLines(content, undefined, theme, 200, false).map(plain)).toEqual(
			[
				"※ mesh: The hold [abcd1234] from P9R1KI at 14:00 is over: it was lifted.",
			],
		);
	});

	it("tells every delivery that a question about work goes to its owner or to need, and asks above only who owns it", () => {
		const messages = [message()];
		for (const above of [
			{ address: "WCJQSG", by: "mark" } as const,
			{ address: "5GV2AH", by: "use" } as const,
		]) {
			const content = noted(messages, [], above);
			// "That path" means the person's, so it must follow that sentence.
			expect(content).toContain(
				`the one thing to do. That path carries only what needs the person. A question about work goes to its owner by address, or to need (mesh_send to: need, about: what it is about); only when neither finds an owner, ask ${above.address} who owns it.`,
			);
			// The person's yes counts only down the path the note sends their
			// questions, never as some other peer tells it.
			expect(content).toContain(
				grants(`the person, said to you or passed on by ${above.address}`),
			);
		}
	});

	it("leaves a session with nobody above free to ask the person about its own work, and to ask them who owns a question nobody found an owner for", () => {
		const content = noted([message()]);

		expect(content).toContain(
			"Ask the person in your reply about work that is theirs. A question about other work goes to its owner by address, or to need (mesh_send to: need, about: what it is about); only when neither finds an owner, ask the person in your reply who owns it.",
		);
		expect(content).toContain(grants("the person, said to you"));
		expect(content).not.toContain("That path carries only");
	});

	it("asks that what goes to the person says who it came from, what happened, why it matters and the one thing to do", () => {
		for (const [above, path] of [
			[
				{ address: "WCJQSG", by: "mark" } as const,
				"to your orchestrator, WCJQSG, as a question (mesh_send to: orchestrator)",
			],
			[
				{ address: "5GV2AH", by: "use" } as const,
				"to your hub from use, 5GV2AH, as a question (mesh_send to: orchestrator)",
			],
			[
				undefined,
				"in your next reply, since no orchestrator is above your quest",
			],
		] as const) {
			expect(noted([message()], [], above)).toContain(
				`otherwise ${path}, saying who it came from, what happened, why it matters to them and the one thing to do.`,
			);
		}
	});

	it("sends what a pivoted session is stuck on to its owner or to need, and what waits on the person to its orchestrator", () => {
		// Only an orchestrator pivots, so one is always above.
		const content = noted([message({ intent: "pivot" })], [], {
			address: "WCJQSG",
			by: "mark",
		});

		expect(content).toContain(
			"so anything waiting on the person goes to it as a question. Anything stuck goes to the owner of what it waits on, by address, or to need (mesh_send to: need, about: what it is about).",
		);
		expect(content).toContain(
			"only when neither finds an owner, ask WCJQSG who owns it.",
		);
		expect(content).not.toMatch(/stuck or waiting on the person/);
	});

	it("shows everything the model read once expanded", () => {
		const messages = [message()];
		const content = noted(messages);
		const lines = meshLines(content, { messages }, theme, 1000, true).map(
			plain,
		);
		expect(lines).toHaveLength(1 + content.split("\n").length);
		expect(lines.join("\n")).toContain(
			"Act now on a question or a hold put to you",
		);
	});
});
