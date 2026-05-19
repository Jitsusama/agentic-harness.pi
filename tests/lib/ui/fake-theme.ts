import type { Theme } from "@mariozechner/pi-coding-agent";

/**
 * Test double for the pi `Theme` class.
 *
 * Wraps every styled string in markers so tests can assert
 * on the colour / weight that was applied without depending
 * on ANSI escape sequences. Renders as plain, readable
 * strings:
 *
 *   theme.fg("dim", "hello")   → "<dim>hello</dim>"
 *   theme.bold("world")        → "<b>world</b>"
 *
 * Only the methods the lib/ui primitives actually call are
 * implemented; the rest throw to surface accidental coupling.
 */
export function fakeTheme(): Theme {
	const stub: Partial<Theme> = {
		fg: ((color: string, text: string) =>
			`<${color}>${text}</${color}>`) as Theme["fg"],
		bg: ((color: string, text: string) =>
			`<bg:${color}>${text}</bg:${color}>`) as Theme["bg"],
		bold: ((text: string) => `<b>${text}</b>`) as Theme["bold"],
		italic: ((text: string) => `<i>${text}</i>`) as Theme["italic"],
		underline: ((text: string) => `<u>${text}</u>`) as Theme["underline"],
	};
	return stub as Theme;
}
