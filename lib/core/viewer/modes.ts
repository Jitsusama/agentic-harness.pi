/**
 * What pi has asked of its terminal beyond what it draws: the private modes
 * (the alternate screen, autowrap, mouse reports, a hidden cursor) it sets
 * once as it starts, so a viewer joining later is given them first.
 */

const ESCAPE = "\x1b";

/** The longest unfinished sequence kept across writes; longer is no mode. */
const LONGEST = 64;

/** Private modes saying which screen is drawn on, given last. */
const SCREENS = new Set([47, 1047, 1049]);

/** Synchronized output brackets a frame rather than setting a mode. */
const FRAME = 2026;

/** The largest number a private mode takes; anything past it is no mode. */
const LARGEST_MODE = 65_535;

/** Kitty keyboard flags pi asks for: disambiguate, events, alternates. */
const KITTY_KEYBOARD_FLAGS = 7;

// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this reads.
const PRIVATE_MODE = /^\x1b\[\?([0-9;]*)([hl])/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what this reads.
const UNFINISHED_PRIVATE_MODE = /^\x1b(?:\[(?:\?[0-9;]*)?)?$/;

/** The private modes a terminal has been told to set, read from its output. */
export class TerminalModes {
	private readonly modes = new Map<number, boolean>();
	private partial = "";

	/** Read pi's output for the modes it sets; a split sequence waits once. */
	saw(output: string): void {
		const text = this.partial + output;
		this.partial = "";
		let at = text.indexOf(ESCAPE);
		while (at !== -1) {
			const rest = text.slice(at);
			const whole = PRIVATE_MODE.exec(rest);
			if (whole) {
				this.set(whole[1] ?? "", whole[2] === "h");
				at = text.indexOf(ESCAPE, at + whole[0].length);
				continue;
			}
			if (UNFINISHED_PRIVATE_MODE.test(rest)) {
				if (rest.length <= LONGEST) this.partial = rest;
				return;
			}
			at = text.indexOf(ESCAPE, at + 1);
		}
	}

	/**
	 * What brings a fresh viewer to pi's modes, written before its first
	 * repaint: every mode but the screen, then the screen, then kitty's
	 * keyboard flags and bracketed paste, which a hosted pi always expects.
	 * Kitty keeps keyboard flags for each screen, so they follow the switch.
	 */
	restored(): string {
		const set = (mode: number, on: boolean) => `\x1b[?${mode}${on ? "h" : "l"}`;
		const modes = [...this.modes];
		const others = modes.filter(([mode]) => !SCREENS.has(mode));
		const screens = modes.filter(([mode]) => SCREENS.has(mode));
		return [
			...others.map(([mode, on]) => set(mode, on)),
			...screens.map(([mode, on]) => set(mode, on)),
			`\x1b[>${KITTY_KEYBOARD_FLAGS}u`,
			"\x1b[?2004h",
		].join("");
	}

	private set(numbers: string, on: boolean): void {
		for (const word of numbers.split(";")) {
			const mode = Number.parseInt(word, 10);
			if (!Number.isInteger(mode) || mode > LARGEST_MODE || mode === FRAME)
				continue;
			this.modes.delete(mode);
			this.modes.set(mode, on);
		}
	}
}
