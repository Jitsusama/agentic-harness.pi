/**
 * Chords, as a person would write them.
 *
 * "Ctrl+Shift+K" is how a keyboard shortcut is written down
 * everywhere except in the protocol, which wants an ordered
 * sequence of key events and a bitmask. Parsing happens here so
 * that a mistyped chord is refused by name before anything is
 * dispatched, rather than silently pressing the wrong thing.
 *
 * The set of real key names is passed in rather than kept here.
 * The browser driver owns that table, and copying it would mean
 * maintaining a second opinion about what keys exist.
 */

/** The four modifiers the protocol tracks as a bitmask. */
export type ModifierName = "Alt" | "Control" | "Meta" | "Shift";

/**
 * The protocol's modifier bits.
 *
 * These are positional flags in a single integer, not an
 * arbitrary enumeration, so they are written as the powers of
 * two they are.
 */
export const MODIFIER_BITS: Readonly<Record<ModifierName, number>> = {
	Alt: 1,
	Control: 2,
	Meta: 4,
	Shift: 8,
};

/**
 * Names people actually type, mapped to what the browser calls
 * them. Cmd and Super are the same key under different
 * traditions, and refusing either would be pedantry.
 */
const ALIASES: Readonly<Record<string, string>> = {
	cmd: "Meta",
	command: "Meta",
	super: "Meta",
	win: "Meta",
	meta: "Meta",
	ctrl: "Control",
	control: "Control",
	alt: "Alt",
	opt: "Alt",
	option: "Alt",
	shift: "Shift",
	esc: "Escape",
	escape: "Escape",
	del: "Delete",
	delete: "Delete",
	ins: "Insert",
	return: "Enter",
	enter: "Enter",
	space: " ",
	spacebar: " ",
	up: "ArrowUp",
	down: "ArrowDown",
	left: "ArrowLeft",
	right: "ArrowRight",
	pgup: "PageUp",
	pgdn: "PageDown",
	pagedown: "PageDown",
	pageup: "PageUp",
};

/** One keypress, with whatever was held down for it. */
export interface Chord {
	readonly modifiers: readonly ModifierName[];
	readonly key: string;
	readonly bitmask: number;
}

/** What went wrong, and what might have been meant. */
export interface ChordRefusal {
	readonly token: string;
	readonly message: string;
	readonly candidates: readonly string[];
}

/** How many near misses are worth offering. */
const MAX_CANDIDATES = 5;

/** Modifiers are reported in this order, so chords compare. */
const MODIFIER_ORDER: readonly ModifierName[] = [
	"Control",
	"Alt",
	"Shift",
	"Meta",
];

const isModifier = (name: string): name is ModifierName =>
	name in MODIFIER_BITS;

/**
 * Parse a sequence of chords: "Tab Tab Enter", "Ctrl+K",
 * "Shift+ArrowDown".
 *
 * Chords are separated by spaces and keys within a chord by
 * plus. A literal space is written as the word Space, since a
 * space character is already doing the separating.
 */
export function parseChords(
	text: string,
	knownKeys: ReadonlySet<string>,
): { chords: readonly Chord[] } | { refusal: ChordRefusal } {
	const words = text.trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) {
		return {
			refusal: {
				token: "",
				message: "No keys were given.",
				candidates: [],
			},
		};
	}

	const chords: Chord[] = [];
	for (const word of words) {
		const parsed = parseChord(word, knownKeys);
		if ("refusal" in parsed) return parsed;
		chords.push(parsed.chord);
	}
	return { chords };
}

/** Parse one chord: modifiers, then the key they apply to. */
function parseChord(
	word: string,
	knownKeys: ReadonlySet<string>,
): { chord: Chord } | { refusal: ChordRefusal } {
	// A lone plus is a key, not a separator with nothing around
	// it, so splitting has to leave it alone.
	const tokens = word === "+" ? ["+"] : word.split("+").filter(Boolean);
	if (tokens.length === 0) {
		return {
			refusal: {
				token: word,
				message: `'${word}' is not a key.`,
				candidates: [],
			},
		};
	}

	const modifiers: ModifierName[] = [];
	let key: string | undefined;

	for (const token of tokens) {
		const canonical = canonicalize(token, knownKeys);
		if (canonical === undefined) {
			return {
				refusal: {
					token,
					message: `There is no key called '${token}'.`,
					candidates: nearest(token, knownKeys),
				},
			};
		}
		// A modifier is the key being pressed only when it stands
		// alone. Holding Shift is a real thing to do; Ctrl+Shift is
		// someone who has not finished typing the chord.
		const alone = tokens.length === 1;
		if (isModifier(canonical) && !alone) {
			modifiers.push(canonical);
			continue;
		}
		key = canonical;
	}

	if (key === undefined) {
		return {
			refusal: {
				token: word,
				message: `'${word}' is only modifiers, with no key to press.`,
				candidates: [],
			},
		};
	}

	const held = new Set(modifiers);
	const ordered = MODIFIER_ORDER.filter((name) => held.has(name));
	let bitmask = 0;
	for (const name of ordered) bitmask |= MODIFIER_BITS[name];

	return { chord: { modifiers: ordered, key, bitmask } };
}

/** What the browser calls the key this token names. */
function canonicalize(
	token: string,
	knownKeys: ReadonlySet<string>,
): string | undefined {
	// An exact match wins outright, so a single lowercase letter
	// stays lowercase and is not read as an alias.
	if (knownKeys.has(token)) return token;
	const alias = ALIASES[token.toLowerCase()];
	if (alias !== undefined && (knownKeys.has(alias) || isModifier(alias))) {
		return alias;
	}
	// Case-insensitive last, so that 'tab' finds Tab without
	// letting 'A' quietly become 'a'.
	for (const known of knownKeys) {
		if (known.toLowerCase() === token.toLowerCase()) return known;
	}
	return undefined;
}

/** Key names close enough to the token to be worth offering. */
function nearest(
	token: string,
	knownKeys: ReadonlySet<string>,
): readonly string[] {
	const wanted = token.toLowerCase();
	const scored: { name: string; score: number }[] = [];
	for (const known of knownKeys) {
		const name = known.toLowerCase();
		if (name.startsWith(wanted)) scored.push({ name: known, score: 0 });
		else if (name.includes(wanted)) scored.push({ name: known, score: 1 });
		else if (wanted.includes(name) && name.length > 1) {
			scored.push({ name: known, score: 2 });
		}
	}
	return scored
		.sort((a, b) => a.score - b.score || a.name.length - b.name.length)
		.slice(0, MAX_CANDIDATES)
		.map((entry) => entry.name);
}
