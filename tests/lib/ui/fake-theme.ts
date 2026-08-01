import type { Theme } from "@earendil-works/pi-coding-agent";

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
/**
 * A theme that styles nothing, for tests about layout.
 *
 * `fakeTheme` wraps every styled run in markers, which the layout code
 * counts as visible width: a strip measured through it reports itself far
 * wider than it is and elides tabs that fit. Use this one whenever the
 * assertion is about how much fits, and `fakeTheme` when it is about which
 * colour was asked for.
 */
export function plainTheme(): Theme {
	const stub: Partial<Theme> = {
		fg: ((_color: string, text: string) => text) as Theme["fg"],
		bg: ((_color: string, text: string) => text) as Theme["bg"],
		bold: ((text: string) => text) as Theme["bold"],
		italic: ((text: string) => text) as Theme["italic"],
		underline: ((text: string) => text) as Theme["underline"],
	};
	return stub as Theme;
}

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
