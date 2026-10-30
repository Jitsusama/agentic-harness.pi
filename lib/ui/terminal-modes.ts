/**
 * The terminal modes pi is in, said again to whatever terminal shows it.
 *
 * pi enters its modes once, as it starts: the alternate screen with
 * autowrap off and mouse reporting in fullscreen, bracketed paste, and
 * kitty's keyboard protocol or xterm's modifyOtherKeys. A held session is
 * shown by a terminal that joins it later, which was never told, so on 30
 * October every window Joel used after a restore lacked them: no mouse,
 * no bracketed paste, a screen drawn into scrollback, and an editor that
 * lost its bottom rule. Each mode here is the sequence pi-tui writes for
 * it (terminal.js and tui-alt-screen.js), so entering one pi is already
 * in changes nothing, with one exception: kitty's keyboard flags are a
 * stack, so they are popped before they are pushed, leaving one entry
 * however often this runs, which pi's single pop at exit clears.
 */

/** What pi's terminal is in, as read off its own state. */
export interface TerminalModes {
	/** Fullscreen: the alternate screen, with autowrap off. */
	readonly altScreen: boolean;
	/** Mouse reporting, in fullscreen. */
	readonly mouse: boolean;
	/** Only button motion is reported, as pi asks under a multiplexer. */
	readonly buttonMotionOnly: boolean;
	/** kitty's keyboard protocol was pushed. */
	readonly kittyKeyboard: boolean;
	/** xterm's modifyOtherKeys, where kitty's protocol isn't spoken. */
	readonly modifyOtherKeys: boolean;
}

/** The kitty keyboard flags pi pushes: disambiguate, report events and alternates. */
const KITTY_KEYBOARD_FLAGS = 7;

/**
 * The sequence that puts a terminal in `modes`, bracketed paste always,
 * since pi enters it in every mode.
 */
export function enterModes(modes: TerminalModes): string {
	const motion = modes.buttonMotionOnly ? "" : "\x1b[?1003h";
	return [
		...(modes.altScreen ? ["\x1b[?1049h", "\x1b[?7l"] : []),
		...(modes.altScreen && modes.mouse
			? [`\x1b[?1000h\x1b[?1002h${motion}\x1b[?1004h\x1b[?1006h`]
			: []),
		"\x1b[?2004h",
		...(modes.kittyKeyboard ? [`\x1b[<u\x1b[>${KITTY_KEYBOARD_FLAGS}u`] : []),
		...(!modes.kittyKeyboard && modes.modifyOtherKeys ? ["\x1b[>4;2m"] : []),
	].join("");
}

/**
 * The modes a pi-tui TUI is in, read from its fields, which pi-tui keeps
 * private: a field missing or of another type reads as off, so a pi that
 * renames one loses that mode's re-entry rather than gaining a wrong one.
 */
export function modesOf(tui: object): TerminalModes {
	const terminal = Reflect.get(tui, "terminal");
	const flag = (from: unknown, name: string) =>
		typeof from === "object" &&
		from !== null &&
		Reflect.get(from, name) === true;
	const term = process.env.TERM?.toLowerCase() ?? "";
	return {
		altScreen: flag(tui, "altScreenActive"),
		mouse: flag(tui, "mouseEnabled"),
		// As pi decides it (tui-alt-screen.js): multiplexers lag on every motion.
		buttonMotionOnly:
			process.env.TMUX !== undefined ||
			process.env.ZELLIJ !== undefined ||
			process.env.STY !== undefined ||
			term.startsWith("tmux") ||
			term.startsWith("screen"),
		kittyKeyboard: flag(terminal, "kittyProtocolActive"),
		modifyOtherKeys: flag(terminal, "modifyOtherKeysActive"),
	};
}
