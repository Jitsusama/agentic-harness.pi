/**
 * A custom message whose renderer draws nothing takes no row on pi's
 * screen, drawn through pi's own component. Joel, 11 November 2026: "for
 * mesh quiet, it is still printing blank lines to my pi terminal."
 */
import {
	CustomMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { dropEmptyMessages } from "../../../lib/ui/no-empty-messages.ts";

const WIDTH = 60;

/** A message as pi hands one to its renderer. */
const message = {
	role: "custom" as const,
	customType: "mesh",
	content: "merged #1379",
	display: true,
	timestamp: 0,
};

/** pi's component for `message`, drawn by `lines`. */
function row(lines: readonly string[]): CustomMessageComponent {
	return new CustomMessageComponent(message, () => ({
		render: () => [...lines],
		invalidate: () => {},
	}));
}

beforeAll(() => {
	initTheme();
	dropEmptyMessages();
});

describe("a custom message on pi's screen", () => {
	it("takes no row when its renderer draws nothing", () => {
		expect(row([]).render(WIDTH)).toEqual([]);
	});

	it("keeps the blank line above one that draws something", () => {
		expect(row(["merged #1379"]).render(WIDTH)).toEqual(["", "merged #1379"]);
	});

	it("keeps pi's own drawing of a message with no renderer", () => {
		const plain = new CustomMessageComponent(message);
		expect(plain.render(WIDTH).join("\n")).toContain("merged #1379");
	});

	it("keeps a drawn blank line, which is a row its renderer asked for", () => {
		expect(row([""]).render(WIDTH)).toEqual(["", ""]);
	});

	it("takes no row when its renderer's component draws nothing", () => {
		const empty = new CustomMessageComponent(message, () => new Text("", 0, 0));
		expect(empty.render(WIDTH)).toEqual([]);
	});

	it("draws its renderer's component once a frame, reading pi's layout", () => {
		// pi keeps each child's rows as `mouseLayout`; should it rename that,
		// the wrap would draw every message twice a frame, and this fails.
		let draws = 0;
		const counted = new CustomMessageComponent(message, () => ({
			render: () => {
				draws += 1;
				return ["merged #1379"];
			},
			invalidate: () => {},
		}));
		counted.render(WIDTH);
		expect(draws).toBe(1);
	});

	it("wraps pi's drawing once, however many times it loads", () => {
		dropEmptyMessages();
		dropEmptyMessages();
		expect(row([]).render(WIDTH)).toEqual([]);
		expect(row(["one"]).render(WIDTH)).toEqual(["", "one"]);
	});
});
