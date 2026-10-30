/**
 * The terminal modes pi is in, said again to a terminal that joins it.
 */

import { describe, expect, it } from "vitest";
import {
	enterModes,
	modesOf,
	type TerminalModes,
} from "../../../lib/ui/terminal-modes.ts";

const PLAIN: TerminalModes = {
	altScreen: false,
	mouse: false,
	buttonMotionOnly: false,
	kittyKeyboard: false,
	modifyOtherKeys: false,
};

describe("the modes said again", () => {
	it("are pi-tui's own fullscreen sequences, mouse and kitty keys included", () => {
		expect(
			enterModes({
				...PLAIN,
				altScreen: true,
				mouse: true,
				kittyKeyboard: true,
			}),
		).toBe(
			"\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?2004h\x1b[<u\x1b[>7u",
		);
	});

	it("pop kitty's keyboard flags before pushing them, so the stack stays one deep", () => {
		const said = enterModes({ ...PLAIN, kittyKeyboard: true });
		expect(said.split("\x1b[>7u")).toHaveLength(2);
		expect(said.indexOf("\x1b[<u")).toBeLessThan(said.indexOf("\x1b[>7u"));
	});

	it("say bracketed paste alone for pi outside fullscreen, and no frame bracket", () => {
		expect(enterModes(PLAIN)).toBe("\x1b[?2004h");
		expect(enterModes({ ...PLAIN, mouse: true })).toBe("\x1b[?2004h");
		expect(enterModes({ ...PLAIN, modifyOtherKeys: true })).toBe(
			"\x1b[?2004h\x1b[>4;2m",
		);
		expect(
			enterModes({
				...PLAIN,
				altScreen: true,
				mouse: true,
				buttonMotionOnly: true,
			}),
		).not.toContain("?1003h");
	});
});

describe("the modes pi is in", () => {
	it("are read off pi-tui's fields, and a missing one reads as off", () => {
		const terminal = {
			get kittyProtocolActive() {
				return true;
			},
			modifyOtherKeysActive: false,
		};
		expect(
			modesOf({ terminal, altScreenActive: true, mouseEnabled: true }),
		).toMatchObject({ altScreen: true, mouse: true, kittyKeyboard: true });
		expect(modesOf({})).toMatchObject({
			altScreen: false,
			mouse: false,
			kittyKeyboard: false,
			modifyOtherKeys: false,
		});
	});
});
