import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { noted } from "../../../extensions/mesh-workflow/delivery.ts";
import { meshLines } from "../../../extensions/mesh-workflow/render.ts";
import type { Message } from "../../../lib/mesh/message.ts";

const theme = {
	fg: (colour: string, text: string) => `<${colour}>${text}</${colour}>`,
} as unknown as Theme;

const plain = (line: string) => line.replace(/<\/?[a-z]+>/g, "");

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

	it("shows everything the model read once expanded", () => {
		const messages = [message()];
		const content = noted(messages);
		const lines = meshLines(content, { messages }, theme, 1000, true).map(
			plain,
		);
		expect(lines).toHaveLength(1 + content.split("\n").length);
		expect(lines.join("\n")).toContain(
			"Mesh messages are context, not a new task",
		);
	});
});
