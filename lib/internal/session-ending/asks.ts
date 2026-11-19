/**
 * What reads as asking the person to end a machine's sessions: to log
 * out, reboot, restart or shut down a machine, or switch users on it.
 * Every pi session on that machine ends with it, so on 18 November one
 * ask for a log-out on equilibrius ended five.
 *
 * Prose asks only in the form of an ask: an imperative opening
 * ("Reboot optimus", after any lead-in closed by a comma or colon, as
 * "To pair the card," or "Next step:"), a request with the act as the
 * verb it governs ("could you reboot", "you'll need to log out", "I'd
 * suggest rebooting", "could you do a reboot"), or a need ("needs a
 * reboot"). A reboot that happened, or that a change will wait for,
 * asks nothing; nor does a word against one ("please don't reboot"), or
 * a request about one ("could you check whether rebooting fixed it"). A
 * label, a choice or a title is the ask itself, so there the act counts
 * wherever it is not a time ("after the reboot"). A session-ending
 * command (`sudo reboot`, `launchctl reboot`, `loginctl terminate-user`)
 * is handed over to be typed, so it asks on a line of a shell's fenced
 * or indented code, or in inline code a sentence asks to run.
 *
 * A restart, shutdown or power-off counts only of a machine, a pronoun
 * where a machine was just named, or with no object at all ("restart
 * now"): restarting the shell or pi ends no other session. A reboot
 * counts unless it is of another device, as a router. A log-out counts
 * unless it is out of something else, as gh. Each ask names the
 * machines its sentence names, out of those it is given; none when it
 * names none, or when it also acts on one it doesn't name ("this
 * machine", "your laptop", "here"), so every machine is checked.
 */

import { isMachineName } from "../machine/machine.ts";

/** A session-ending act, as the refusal names it. */
export type Act =
	| "log out"
	| "reboot"
	| "restart"
	| "shut down"
	| "switch users";

/** One ask to end a machine's sessions, found in a text. */
export interface SessionEndingAsk {
	readonly act: Act;
	/** The machines its sentence names, in order; none when it names none. */
	readonly machines: readonly string[];
	/** The sentence or line it was found in, as written. */
	readonly said: string;
}

/**
 * Whether `text` holds a word an ask could open with, as a look cheap
 * enough for every reply, before the node is asked for its machines.
 */
export function mayAsk(text: string): boolean {
	return FIRST_LOOK.test(folded(text));
}

/**
 * The asks in a reply or a question's prompt: each sentence that asks
 * in the form of an ask, and each session-ending command in shell code.
 */
export function asksInProse(
	text: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	return asksIn(text, machines, "prose");
}

/**
 * The asks in a label, a choice or a title, which is the ask itself, so
 * any session-ending act in it counts.
 */
export function asksInLabel(
	text: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	return asksIn(text, machines, "label");
}

/** The asks of one command line, as a check a wait is done by. */
export function asksInCommand(
	line: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	return commandAsks(folded(line), machines);
}

const FIRST_LOOK =
	/\b(?:re-?boot(?:s|ed|ing)?|restart(?:s|ed|ing)?|authrestart|shut(?:s|ting)?[\s-]*down|shutdown|shut\s+(?:\S+\s+){1,3}down|power(?:s|ed|ing)?[\s-]*(?:off|down|cycle)|power(?:s|ed|ing)?\s+(?:\S+\s+){1,2}(?:off|down)|poweroff|turn(?:s|ed|ing)?\s+(?:\S+\s+){0,2}off|log(?:s|ged|ging)?[\s-]*(?:out|off)|logout|logoff|sign(?:s|ed|ing)?[\s-]*out|switch(?:es|ed|ing)?\s+(?:the\s+)?users?|switch(?:es|ed|ing)?\s+to\s+(?:another|a\s+different|the\s+other)\s+user|user\s+switch(?:ing)?|loginctl|halt|kexec|pkill|killall|kill\s+(?:-\S+\s+)*-1|niri\s+msg|(?:gnome|cinnamon|mate)-session-quit|bootout|loginwindow|windowserver|(?:tel)?init\s+[0-6]|swaymsg\s+exit|hyprctl\s+dispatch\s+exit|display-manager|gdm3?|sddm|lightdm|greetd|lxqt-leave|aevtr(?:rst|sdn|lgo)|systemctl\s[^\n]*\b(?:niri|sway|hyprland|gnome-shell|plasma|graphical-session)|login1|terminate(?:user|session|seat))\b/i;

/**
 * A text with its typography folded to what the patterns read: every
 * hyphen and dash a hyphen, every space a space, every quote straight.
 */
function folded(text: string): string {
	return text
		.replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
		.replace(/[\u00a0\u2007\u202f]/g, " ")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201c\u201d]/g, '"')
		.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "");
}

/** Words that pick a button or a menu item, which a quote may name. */
const UI_VERB =
	"(?:choose|select|click(?:\\s+on)?|pick|hit|press|tap(?:\\s+on)?)";

/**
 * Prose without what it quotes, as an example or a name, but for a
 * button or menu item it says to pick, or a command to run: `click
 * "Restart"`, `click the "Log Out" button`, `run "sudo reboot"`.
 */
const QUOTED = /"[^"]*"/g;

/** What a quote kept as what it says to pick or run comes after. */
const PICKED_BEFORE = new RegExp(
	`\\b(?:${UI_VERB}|run|type|paste|execute|enter)\\s+(?:the\\s+)?$`,
	"i",
);

/** Prose with each quote a quote, but what it says to pick or run. */
function withoutQuotes(plain: string): string {
	return plain.replace(QUOTED, (quote, at: number) =>
		PICKED_BEFORE.test(plain.slice(0, at)) ? quote : '""',
	);
}

/**
 * What follows a button or menu item that is the act, so the item is
 * the act alone, not "Restart Kernel" or "restart on the server".
 */
const UI_ITEM_ENDS =
	"(?=\\s*$|\\s*[\"'.,;!?)\\u2026]|\\s+(?:button|item|option|from|in\\s+the|and|then|now|to|when|once|first)\\b)";

/** What a button or menu item that is the act may be named. */
const UI_ACT =
	"(?:re-?start|re-?boot|shut\\s*down|log[\\s-]*out|sign[\\s-]*out|switch\\s+users?|power\\s*off)\\b";

/**
 * A button or menu item picked that is the act: "click Restart",
 * "choose Apple menu > Log Out", "click the Restart button".
 */
const UI_ASK = new RegExp(
	`(?<![-\\w])${UI_VERB}\\s+(?:(?:the|apple\\s+menu|[\\w-]+(?:\\s+[\\w-]+)?\\s*[>\\u203a\\u2192])\\s*)*"?${UI_ACT}${UI_ITEM_ENDS}`,
);

/**
 * A sentence with each inline code span that holds an act said as
 * "code", so a command named in it reads as a name, not a verb; the
 * command is read as one where the sentence asks to run it.
 */
function withoutActsInCode(sentence: string): string {
	return sentence.replace(/`([^`]+)`/g, (span, code: string, at: number) =>
		FIRST_LOOK.test(code) && !PICKED_BEFORE.test(sentence.slice(0, at))
			? "code"
			: span,
	);
}

type Reading = "prose" | "label";

function asksIn(
	text: string,
	machines: readonly string[],
	reading: Reading,
): SessionEndingAsk[] {
	const words = machineWords(machines);
	const found: SessionEndingAsk[] = [];
	for (const part of parts(folded(text))) {
		for (const line of commandLines(part)) {
			found.push(...commandAsks(line, machines));
		}
		if (!part.prose) continue;
		for (const run of sentenceRuns(part.lines, words)) {
			run.forEach((sentence, at) => {
				const before = at > 0 ? run[at - 1] : undefined;
				found.push(...sentenceAsks(sentence, before, machines, words, reading));
			});
		}
	}
	return found;
}

/**
 * The asks of one sentence, one an act, by its words or its commands.
 * A pronoun stands for a machine when this sentence or the one before
 * names one.
 */
function sentenceAsks(
	sentence: string,
	before: string | undefined,
	machines: readonly string[],
	words: string,
	reading: Reading,
): SessionEndingAsk[] {
	const plain =
		reading === "prose"
			? withoutQuotes(
					plainOf(withoutActsInCode(withoutBoldLabel(sentence, words))),
				)
			: plainOf(sentence);
	const context =
		namesMachine(plain, machines) ||
		(before !== undefined && namesMachine(plainOf(before), machines));
	const objects = context ? `${words}|it|them` : words;
	const named = GENERIC_MACHINE.test(plain) ? [] : namedIn(plain, machines);
	const said = sentence.trim();
	const byAct = new Map<Act, SessionEndingAsk>();
	const asks =
		reading === "prose"
			? readsAsAsk(plain, words)
			: !DECLINED.test(plain) &&
				(LABEL_ACT.test(plain) || DO_NOUN.test(plain) || UI_ASK.test(plain));
	const nouns = UI_ASK.test(plain)
		? "named"
		: reading === "label" || DO_NOUN.test(plain);
	if (asks) {
		for (const act of actsIn(plain, objects, nouns)) {
			byAct.set(act, { act, machines: named, said });
		}
	}
	if (asksToRun(plain)) {
		for (const code of inlineCode(sentence)) {
			for (const one of commandAsks(code, machines)) {
				if (byAct.has(one.act)) continue;
				const where = one.machines.length > 0 ? one.machines : named;
				byAct.set(one.act, { act: one.act, machines: where, said });
			}
		}
	}
	return [...byAct.values()];
}

/**
 * A label that turns the act down rather than picking it: "Skip the
 * reboot", "No restart tonight", "Hold off on the restart".
 */
const DECLINED =
	/^(?:skip|no|not|don't|do\s+not|never|avoid|cancel|postpone|defer|delay|hold\s+off|without)\b/;

/**
 * A bold head closed by a colon, as a list item's "**Reboot at 22:29:**",
 * which labels what follows, however many words it has.
 */
const BOLD_LABEL =
	/^(\s*(?:[-+*>\u2022]\s+|\d+[.)]\s+)*)\*\*([^*]+?)(?::\*\*|\*\*:)\s*/;

/**
 * A sentence without a bold label heading it, unless the label names a
 * machine, as "**Reboot optimus:**" does, so what follows is read.
 */
function withoutBoldLabel(sentence: string, words: string): string {
	const label = BOLD_LABEL.exec(sentence);
	if (label === null) return sentence;
	const names = new RegExp(`\\b(?:${words})\\b`).test(
		(label[2] ?? "").toLowerCase(),
	);
	return names
		? sentence
		: `${label[1] ?? ""}${sentence.slice(label[0].length)}`;
}

/**
 * What a sentence asks to run: each span of inline code, or quote,
 * right after a word asking to run it ("run `sudo reboot`", "type this
 * in a terminal: `sudo reboot`"), not one it only names.
 */
const RUN_SPAN =
	/\b(?:run|type|paste|execute|enter)\s+(?:(?:this|that|the|following|these|command|commands|line|in|a|terminal|shell|as|root|there|it|on\s+[\w.-]+)\s*)*?:?\s*(?:`([^`]+)`|"([^"]+)")/gi;

/** The spans a sentence asks to run, as written. */
function inlineCode(sentence: string): string[] {
	return [...sentence.matchAll(RUN_SPAN)].flatMap(
		(one) => one[1] ?? one[2] ?? [],
	);
}

/**
 * How a part of the text is read: as prose, and for commands on every
 * line, only on a line opening with a prompt, or not at all.
 */
interface Part {
	readonly prose: boolean;
	readonly commands: "every" | "prompted" | "none";
	readonly lines: readonly string[];
}

/** Fences of commands to type, each line one. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "shell", "terminal"]);

/** Fences of a terminal's session, where a command follows a prompt. */
const SESSIONS = new Set([
	"",
	"console",
	"shell-session",
	"sh-session",
	"bash-session",
	"zsh-session",
]);

/** Fences of prose. */
const PROSE = new Set(["md", "markdown"]);

/** Fences of text that may be either prose or a session. */
const TEXTS = new Set(["text", "txt", "plain", "plaintext"]);

/** Fences of a language that is neither a shell nor prose. */
const CODE = new Set(
	"yaml yml json jsonc json5 toml ini conf cfg xml html css scss js jsx ts tsx mjs cjs javascript typescript py python rb ruby rs rust go java kt kotlin swift c h cpp hpp cc cs php lua nix qml sql graphql gql diff patch dockerfile make makefile cmake proto hcl tf terraform lisp el clj hs haskell ml scala dart vue svelte ex exs elixir erl zig perl pl r".split(
		" ",
	),
);

/** How a fence marked `language` is read. */
function fenced(language: string): Omit<Part, "lines"> {
	if (SHELLS.has(language)) return { prose: false, commands: "every" };
	if (SESSIONS.has(language)) return { prose: false, commands: "prompted" };
	if (PROSE.has(language)) return { prose: true, commands: "none" };
	if (CODE.has(language)) return { prose: false, commands: "none" };
	if (TEXTS.has(language)) return { prose: true, commands: "prompted" };
	return { prose: true, commands: "prompted" };
}

const OUTSIDE: Omit<Part, "lines"> = { prose: true, commands: "none" };

/**
 * The text cut into prose and fenced code, in order. A fence closes on
 * a run of its own mark at least as long, so a fence of four backticks
 * holds one of three.
 */
function parts(text: string): Part[] {
	const out: Part[] = [];
	let lines: string[] = [];
	let how = OUTSIDE;
	let fence: string | undefined;
	const flush = () => {
		if (lines.length > 0) out.push({ ...how, lines });
		lines = [];
	};
	for (const line of text.split(/\r?\n/)) {
		if (fence === undefined) {
			const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
			if (open) {
				flush();
				fence = open[1] ?? "```";
				how = fenced((open[2] ?? "").toLowerCase());
				continue;
			}
		} else {
			const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line)?.[1];
			if (close && close[0] === fence[0] && close.length >= fence.length) {
				flush();
				fence = undefined;
				how = OUTSIDE;
				continue;
			}
		}
		lines.push(line);
	}
	flush();
	return out;
}

/** What a command line may open with before the command itself. */
const PROMPT = /^\s*(?:[$#%>]\s+)?/;
const PROMPTED = /^\s*[$#%>]\s+\S/;

/** A shell's comment, which runs nothing. */
const SHELL_COMMENT = /^\s*#/;

/**
 * A line that ends a sentence, after any closing marks, which in code
 * with no prompts is prose, not a command.
 */
const ENDS_SENTENCE = /[.!?:;]["')\]*_`]*\s*$/;

/** A line that opens with a capital, as a new sentence does. */
const OPENS_CAPITAL = /^\s*(?:[-+*>#|\u2022]+\s*|\d+[.)]\s*)*["'`*_]*[A-Z]/;

/** A line `last` prints of a boot or a shutdown, which asks nothing. */
const BOOT_RECORD = /^\s*(?:reboot|shutdown)\s+system\s+(?:boot|down)\b/i;

/**
 * The lines of a part read as commands: in a session, those after a
 * prompt, or every line when none has one; and in prose, those indented
 * as code.
 */
function commandLines(part: Part): string[] {
	const lines = part.lines.filter((line) => !BOOT_RECORD.test(line));
	if (part.commands === "every") {
		return lines.filter((line) => !SHELL_COMMENT.test(line));
	}
	if (part.commands === "prompted") {
		const prompted = lines.filter((line) => PROMPTED.test(line));
		if (prompted.length > 0) return prompted;
		return lines.filter((line) => !ENDS_SENTENCE.test(line));
	}
	if (!part.prose) return [];
	return lines.filter((line) => /^(?: {4}|\t)\s*\S/.test(line));
}

/**
 * The sentences of some prose lines, in runs whose order says which
 * came before which: each line's (a table's cells each a line), and,
 * for a paragraph wrapped over lines, the paragraph's as one. A line of
 * a paragraph is read on its own only where a sentence could open it:
 * the paragraph's first, one after a line that ends a sentence, or one
 * that opens with a capital, so the rest of a wrapped sentence ("goes
 * on / reboot handling and more") isn't read as one of its own.
 */
function sentenceRuns(lines: readonly string[], words: string): string[][] {
	const names = new RegExp(`\\b(?:${words})\\b`);
	const kept = lines.filter(
		(line) =>
			!BOOT_RECORD.test(line) &&
			!TICKED.test(line) &&
			(!HEADING.test(line) || names.test(line.toLowerCase())),
	);
	const alone = paragraphsOf(kept).flatMap((paragraph) =>
		paragraph.filter(
			(line, at) =>
				at === 0 ||
				ENDS_SENTENCE.test(paragraph[at - 1] ?? "") ||
				OPENS_CAPITAL.test(line),
		),
	);
	const byLine = alone.flatMap(cellsOf).flatMap(sentencesOf);
	const wrapped = paragraphsOf(kept)
		.filter((paragraph) => paragraph.length > 1)
		.map((paragraph) => sentencesOf(paragraph.join(" ")));
	return [byLine, ...wrapped];
}

function sentencesOf(line: string): string[] {
	return line.split(/(?<=[.!?;])\s+/).filter((one) => one.trim() !== "");
}

/** A table row's cells, each read as a line; any other line as it is. */
function cellsOf(line: string): string[] {
	if (!/^\s*\|/.test(line)) return [line];
	return line
		.split("|")
		.map((cell) => cell.trim())
		.filter((cell) => cell !== "" && !/^:?-+:?$/.test(cell));
}

/**
 * A markdown heading, which names what follows and asks nothing,
 * unless it names a machine, as a step's "### 2. Reboot optimus" does.
 */
const HEADING = /^\s{0,3}#{1,6}\s/;

/** A ticked task box, which says a step is done, never asks for it. */
const TICKED = /^\s*(?:[-+*\u2022]\s+)?\[[xX]\]\s/;

/** A line that opens a block of its own: a list item, a heading, a quote. */
const BLOCK = /^\s*(?:[-+*>#|\u2022]|\d+[.)]\s|\[[ x]\]|(?: {4}|\t))/;

/** Lines run into paragraphs, a blank line or a new block ending one. */
function paragraphsOf(lines: readonly string[]): string[][] {
	const paragraphs: string[][] = [];
	let current: string[] = [];
	for (const line of lines) {
		if (line.trim() === "" || BLOCK.test(line)) {
			if (current.length > 0) paragraphs.push(current);
			current = line.trim() === "" ? [] : [line];
			continue;
		}
		current.push(line);
	}
	if (current.length > 0) paragraphs.push(current);
	return paragraphs;
}

/**
 * A sentence lowercased, without the markdown around its words: every
 * bullet, quote or number opening it, a task box, code ticks, emphasis.
 */
function plainOf(sentence: string): string {
	let plain = sentence.toLowerCase();
	for (;;) {
		const rest = plain.replace(
			/^\s*(?:[-+*>#\u2022\u25e6\u2023]+|\d+[.)]|\[[ x]\])\s+/,
			"",
		);
		if (rest === plain) break;
		plain = rest;
	}
	return plain.replace(/[`*_]/g, "").trim();
}

function escaped(word: string): string {
	return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Words for a machine, whichever it is. */
const MACHINE_WORDS = [
	"machines?",
	"computers?",
	"laptops?",
	"macbook(?:\\s+(?:pro|air))?",
	"imac",
	"mac(?:\\s+(?:mini|studio|pro))?",
	"desktop",
	"workstation",
	"system",
	"box",
	"pc",
	"thinkpad",
	"both",
];

/** What can be the machine a restart, shutdown or power-off is of. */
function machineWords(machines: readonly string[]): string {
	const names = machines
		.filter(isMachineName)
		.map((name) => escaped(name.toLowerCase()));
	return [...MACHINE_WORDS, ...names].join("|");
}

/**
 * Words that name a machine plainly enough for a pronoun after them to
 * be one: not "both", "system" or "host", which name much else.
 */
const A_MACHINE =
	/\b(?:machines?|computers?|laptops?|macbook|imac|mac|desktop|workstation|pc|thinkpad)\b/;

/** Whether a sentence names a machine, by its name or as a machine. */
function namesMachine(plain: string, machines: readonly string[]): boolean {
	return namedIn(plain, machines).length > 0 || A_MACHINE.test(plain);
}

/**
 * A machine a sentence acts on without naming it, so the machines it
 * does name may not be the one meant.
 */
const GENERIC_MACHINE =
	/\b(?:(?:this|your|my|joel's|the\s+same|the)\s+(?:machine|computer|laptop|macbook|mac|desktop|workstation|box|system)|here(?!'s|\s+(?:is|are)\b)|locally)\b/;

/** The words between a verb and its machine: the, your, both of. */
const DETERMINERS =
	"(?:(?:the|your|this|that|my|our|a|both|each|every|all|of|joel's|current|active|whole|entire|own)\\s+)*";

/**
 * What a log-out may be out of, or from, and still end the machine's
 * sessions: macOS, the session, the Apple menu.
 */
const LOG_OUT_OF =
	"macos|session|desktop|account|user|gui|login|niri|gnome|kde|plasma|graphical|wayland|x11|hyprland|sway|everything|apple|menu|start|system|panel|top|computer|machine|laptop";

/** Devices a reboot may be of without ending a machine's sessions. */
const NOT_MACHINES =
	"router|modem|phone|iphone|ipad|vm|container|pod|switch|printer|tv|watch|access\\s+point|cluster";

/**
 * What may follow a restart, shutdown or power-off with no object, as
 * "restart now" or "shut down to finish", leaving it one of the machine.
 */
const NO_OBJECT =
	'(?=\\s*$|\\s*[.!?,;:)"]|\\s+(?:now|to|and|when|once|so|first|later|tonight|then|again|if|after|before|asap|soon|please)\\b)';

/** A word that makes the act after it a noun: "a restart", "one more". */
const A_NOUN =
	"(?<!\\b(?:a|an|the|one|another|more|its|their|this|that|next|last|each|every|any|no|own|his|her|our|your|my)\\s+(?:[\\w-]+\\s+)?)";

/**
 * Where an act word is a word, not part of a name: `restart.ts`,
 * `restart-carry`. A slash after it is a choice, as "log out/in".
 */
const WORD_START = "(?<![-./\\w])";
const WORD_END = "(?![-.]\\w)";

/** Words before an act that make it a time: "after the reboot". */
const NOT_A_TIME =
	"(?<!\\b(?:after|before|since|until|till|during|from|following)\\s+(?:(?:the|a|an|that|this|your|my|its|our|each|every)\\s+)?(?:(?:last|next|previous|recent|latest|first)\\s+)?|\\b(?:last|next|previous|recent|latest)\\s+)";

/**
 * The acts in a sentence read as an ask. With no object, a restart or
 * shutdown counts as a verb ("restart now", "try restarting"), and as a
 * noun ("a restart tonight") only where `nouns` says the sentence asks
 * for the thing itself, as a label or "do a restart" does; a button or
 * menu item picked ("named") counts wherever its name stands.
 */
function actsIn(
	plain: string,
	objects: string,
	nouns: boolean | "named",
): Act[] {
	const machine = `(?:${objects})\\b`;
	const acts: Act[] = [];
	const reboot = new RegExp(
		`${NOT_A_TIME}${WORD_START}re-?boot(?:s|ed|ing)?\\b${WORD_END}(?!\\s+${DETERMINERS}(?:${NOT_MACHINES})\\b)`,
	);
	if (reboot.test(plain)) acts.push("reboot");
	const alone =
		nouns === "named"
			? [`${WORD_START}re-?start\\b${WORD_END}`]
			: nouns
				? [
						`(?<!\\bfor\\s+(?:[\\w'-]+\\s+){1,4}to\\s+)${WORD_START}restart(?:s|ed|ing)?${WORD_END}${NO_OBJECT}`,
					]
				: [
						`${A_NOUN}${WORD_START}restart${WORD_END}${NO_OBJECT}`,
						`(?<=\\b(?:try|consider|suggest|recommend|mind|start)\\s+)restarting${NO_OBJECT}`,
					];
	const restart = [
		...alone,
		`${WORD_START}restart(?:s|ed|ing)?\\s+(?:on\\s+)?${DETERMINERS}${machine}`,
		`\\brestart\\s+of\\s+${DETERMINERS}${machine}`,
		`\\b${machine}\\s+(?:needs|requires|wants|will\\s+need|has\\s+to|must|should)\\s+(?:a\\s+restart|restarting|to\\s+(?:be\\s+)?restart(?:ed)?)`,
		`\\b${machine}\\s+a\\s+restart\\b`,
	];
	if (restart.some((pattern) => new RegExp(pattern).test(plain))) {
		acts.push("restart");
	}
	const shutAlone =
		nouns === "named"
			? `${WORD_START}(?:shut\\s*down|power\\s*off)\\b`
			: nouns
				? `${WORD_START}(?:shut(?:s|ting)?\\s*down|shutdown|power(?:s|ed|ing)?\\s*(?:off|down))${NO_OBJECT}`
				: `${A_NOUN}${WORD_START}(?:shut\\s*down|shutdown|power\\s*(?:off|down))${WORD_END}${NO_OBJECT}`;
	const shutDown = [
		`${WORD_START}(?:shut(?:s|ting)?\\s*down|shutdown|power(?:s|ed|ing)?\\s*(?:off|down)|power-?cycle|turn(?:s|ed|ing)?\\s+off)\\s+(?:on\\s+)?${DETERMINERS}${machine}`,
		`\\b(?:shut(?:s|ting)?|power(?:s|ed|ing)?|turn(?:s|ed|ing)?)\\s+${DETERMINERS}${machine}\\s+(?:down|off)\\b`,
		shutAlone,
	];
	if (shutDown.some((pattern) => new RegExp(pattern).test(plain))) {
		acts.push("shut down");
	}
	const logOut = new RegExp(
		`${NOT_A_TIME}${WORD_START}(?:log(?:s|ged|ging)?[\\s-]*(?:out|off)|logout|logoff|sign(?:s|ed|ing)?[\\s-]*out)\\b${WORD_END}(?!\\s+(?:of|from)\\s+(?!${DETERMINERS}(?:${LOG_OUT_OF}|${objects})\\b))`,
	);
	if (logOut.test(plain)) acts.push("log out");
	if (
		/\bswitch(?:es|ed|ing)?\s+(?:the\s+)?users?\b|\bfast\s+user\s+switch|\buser\s+switch(?:ing)?\b|\bswitch(?:es|ed|ing)?\s+to\s+(?:another|a\s+different|the\s+other)\s+user\b/.test(
			plain,
		)
	) {
		acts.push("switch users");
	}
	return acts;
}

/**
 * Words that may come before an imperative and leave it one, as the
 * imperative of another step before it: "save your work and".
 */
const OPENING =
	/^(?:(?:please|then|now|next|so|ok(?:ay)?|first|finally|lastly|also|afterwards?|and|but|just|joel|kindly|let's|let\s+us|go\s+ahead\s+and|(?:when|whenever)\s+you\s+can|at\s+your\s+convenience|after\s+that|tonight|step\s+\d+)\s*(?:[,:]|-{1,2})?|try\s+to|(?:save|close|quit|finish|wrap\s+up|commit|push|park|unplug|disconnect|update|install)\b[^,;:.!?]{0,60}?\s+(?:and(?:\s+then)?|then))\s+/;

/**
 * A lead-in closed by a comma, a colon or a dash ("if the mic is still
 * dead,", "to pair the card,", "next step:", "last thing -"), which
 * leaves what follows an imperative unless the act is in the lead-in
 * itself, as in a list. Folding has made every dash a hyphen.
 */
const LEAD_IN = /^([^,:;]{1,80}?)(?:[,:]|\s-{1,2})\s+/;

/** A noun of the act after a verb that does it: "do a reboot". */
const DO_NOUN =
	/\b(?:do|give|run|schedule|perform|try|go\s+with|go\s+for|approve)\s+(?:(?!(?:after|before|since|until|till|during|from|following)\b)[\w'-]+\s+){0,2}?(?:a|an|the|another|one\s+more)\s+(?:(?:quick|full|clean|cold|hard)\s+)?(?:re-?boot|restart|log-?\s?out|logout|shutdown|power-?cycle)\b/;

/**
 * A noun after an act word that the act only qualifies: "the reboot
 * check", "log-out handling", "the restart limit". Not "button", which
 * names what to press.
 */
const QUALIFIES =
	"(?!\\s+(?:check|checks|guards?|detection|detectors?|handling|handlers?|fix|fixes|tests?|loops?|paths?|scripts?|holds?|records?|logs?|counts?|limits?|flags?|logic|bugs?|issues?|steps?|timers?|notices?|prompts?|races?|code|banners?|dialogs?|reasons?|support|policy|hooks?|helpers?|markers?|signals?|state|status)\\b)";

/**
 * What after an act word makes it the subject, not an imperative: a
 * verb ("reboot didn't help", "reboot passed", "reboot and log-out
 * are"), or a verb after the noun it qualifies ("reboot handling
 * landed").
 */
const NOT_IMPERATIVE =
	`${QUALIFIES}` +
	"(?!\\s+(?:didn't|did|doesn't|does|wasn't|was|isn't|is|won't|will|would|should|might|may|can|could|must|has|had|fixes|helps|works|fails|breaks|seems|makes|takes|ends|kills|clears|stops|came|went|means|[\\w-]+ed)\\b)(?!\\s+and\\s+\\S+\\s+(?:are|were)\\b)(?!\\s+(?!(?:the|a|an|your|this|that|my|our|it|them|both|all|on|of|out|off|down|now|to|and|once|when)\\b)[\\w-]+\\s+(?:[\\w-]+ed|is|was|are|were|has|had)\\b)";

/**
 * The words before a colon a few words into a sentence: a label, as
 * "Restart:" or "Reboot hold:", unless they name a machine, as
 * "Reboot optimus: the kernel only loads at boot" does.
 */
const LABEL_HEAD = /^([^\s:.,;!?]+(?:\s+[^\s:.,;!?]+)?):/;

const IMPERATIVE = new RegExp(
	`^(?:(?:re-?boot|restart|shut\\s*down|shut|power\\s*(?:off|down)|power-?cycle|power\\s+\\S+\\s+(?:off|down)|turn\\s+(?:\\S+\\s+)?off|log[\\s-]*(?:out|off)|logout|sign[\\s-]*out|switch\\s+(?:the\\s+)?users?|switch\\s+to\\s+(?:another|a\\s+different|the\\s+other)\\s+user)\\b${WORD_END}${NOT_IMPERATIVE}|${DO_NOUN.source.replace(/^\\b/, "")})`,
);

/** An act offered to try, which asks for it as an imperative does. */
const TRY =
	/^try\s+(?:re-?booting|restarting|shutting\s*down|powering\s*(?:off|down)|logging[\s-]*(?:out|off)|signing[\s-]*out|switching\s+users?)\b/;

/** The acts' words, in any form. */
const ACT_WORDS =
	"re-?boot(?:s|ed|ing)?|restart(?:s|ed|ing)?|shut(?:s|ting)?\\s*down|shutdown|shut(?:s|ting)?|power(?:s|ed|ing)?\\s*(?:off|down)|power-?cycle|turn(?:s|ed|ing)?\\s+off|log(?:s|ged|ging)?[\\s-]*(?:out|off)|logout|logoff|sign(?:s|ed|ing)?[\\s-]*out|switch(?:es|ed|ing)?\\s+(?:the\\s+)?users?";

/**
 * A session-ending act as a verb, not a noun or a time: "reboot" in
 * "could you reboot", not in "the reboot" or "since the last reboot".
 */
const ACT_VERB =
	/(?<!\b(?:the|a|an|another|last|next|that|this|since|after|before|during|from|of|its|your|my|our|any|no|each|every|one|until|till|pending)\s+)\b(?:re-?boot(?:ing)?|restart(?:ing)?|shut(?:ting)?\s*down|shut(?:ting)?|power(?:ing)?\s*(?:off|down)|power-?cycle|turn(?:ing)?\s+off|log(?:ging)?[\s-]*(?:out|off)|logout|sign(?:ing)?[\s-]*out|switch(?:ing)?\s+(?:the\s+)?users?)\b/;

/**
 * A session-ending act in a label, anywhere but as a time: "a restart
 * tonight" asks for one, "after the reboot" only says when.
 */
const LABEL_ACT = new RegExp(
	`(?<!\\b(?:after|before|since|until|till|during|from|following)\\s+(?:(?:the|a|an|that|this|your|my|its|our|each|every)\\s+)?(?:(?:last|next|previous|recent|latest|first)\\s+)?|\\b(?:last|next|previous|recent|latest)\\s+)\\b(?:${ACT_WORDS})\\b${QUALIFIES}`,
);

/** Words that make a sentence a request of the person, when an act follows. */
const REQUEST =
	/\b(?:please|pls|kindly|could\s+you|can\s+you|would\s+you|will\s+you|you\s+can|(?:you|we)(?:'ll|\s+will|'d|\s+would)?(?:\s+(?:may|might|probably|likely|also|just|really|still))?\s+(?:need|have|want)\s+to|(?:can|could|should)\s+we|we\s+(?:should|could|can|must)|feel\s+free\s+to|you\s+must|you\s+should|you\s+ought\s+to|need\s+you\s+to|i(?:'m|\s+am)?\s+ask(?:ing)?\s+(?:you|joel)\s+to|i'?d\s+like\s+you\s+to|want\s+you\s+to|time\s+to|ready\s+to|go\s+ahead\s+and|do\s+you\s+want\s+to|shall\s+(?:we|i)|may\s+i|can\s+i|could\s+i|ok(?:ay)?\s+to|fine\s+to|safe\s+to|best\s+to|is\s+it\s+(?:ok|okay|alright|fine)\s+to|let\s+me\s+know\s+(?:when|once|after|as\s+soon\s+as)\s+you|let's|let\s+us|make\s+sure(?:\s+(?:you|to))?|be\s+sure\s+to|remember\s+to|don't\s+forget\s+to|(?:i'?d\s+|i\s+)?(?:suggest|recommend|advise)|(?:^|would\s+you\s+|do\s+you\s+)mind|consider)\b/;

/**
 * Words between a request and an act that turn it from asking for the
 * act: against it ("don't", "avoid", "hold off"), or about it ("check
 * whether", "tell me if").
 */
const AGAINST =
	"(?:not|never|no|avoid|without|whether|if|how|why|what|which|that|hold|holding|refrain|stop|check|confirm|tell|see|verify|know|recall|find|look|wait|against|than|instead)\\b|[\\w]+n't\\b";

/** Up to four words between a request and its act, none against it. */
const GAP = `(?:(?!${AGAINST})[\\w'-]+,?\\s+){0,4}?`;

/**
 * A word against a request a word or two before it: "not safe to",
 * "isn't it time to", "nothing needs", "doesn't seem to need".
 */
const NOT_BEFORE =
	"(?<!\\b(?:not|never|no|nothing|nobody|none)\\s+(?:[\\w']+\\s+){0,2}|n't\\s+(?:[\\w']+\\s+){0,2})";

/**
 * A request, then the act as the verb it governs; or a button or menu
 * item to pick, which must be the act itself: `click "Restart"`.
 */
const REQUESTED = new RegExp(
	`${NOT_BEFORE}(?:${REQUEST.source}\\s+${GAP}(?:${ACT_VERB.source}|${DO_NOUN.source})|${UI_ASK.source})`,
);

/** An act the person is to have done before something else follows. */
const DONE_FIRST = new RegExp(
	`${NOT_BEFORE}\\b(?:once|after|when|until)\\s+you(?:'ve|\\s+have)\\s+(?:re-?booted|restarted|logged[\\s-]*(?:out|off)|signed[\\s-]*out|shut\\s*down|powered\\s*(?:off|down)|switched\\s+users?)\\b`,
);

/**
 * An act the person is to do first, said in the present, then a step
 * after the comma: "once you log out, pair the card". What follows has
 * to be the step, not what the act would do ("when you reboot, the
 * sessions end"), and "if" only says what would follow.
 */
const DONE_FIRST_NOW =
	/^(?:once|after|when|as\s+soon\s+as)\s+you\s+(?:re-?boot|restart|log[\s-]*(?:out|off)|sign[\s-]*out|shut\s*down|power\s*(?:off|down)|switch\s+users?)\b[^,;:.!?]{0,60}?,\s+([\w'-]+)/;

/** Words that open a clause's subject, not a step's verb. */
const SUBJECT =
	/^(?:you|i|we|it|they|he|she|this|that|these|those|the|a|an|all|every|each|some|any|no|its|your|my|our|their|there|nothing|everything|everyone|nobody|\d+|one|two|three|four|five|six|seven|eight|nine|ten|[\w'-]*[^s\W]s)$/;

/** Whether a sentence asks for an act before a step after it. */
function doneFirstNow(plain: string, words: string): boolean {
	const machine = new RegExp(`^(?:${words})$`);
	return openingsOf(plain).some((opening) => {
		const next = DONE_FIRST_NOW.exec(opening)?.[1];
		return next !== undefined && !SUBJECT.test(next) && !machine.test(next);
	});
}

/** Words that hand a command over to be typed. */
const RUN = "(?:run|type|paste|execute|enter)\\b";

/** A need for an act, which asks for it as plainly. */
const NEED = new RegExp(
	`${NOT_BEFORE}(?:\\b(?:needs?|requires?|wants?|calls?\\s+for|due\\s+for|takes?|recommend|suggest|propose|advise)\\s+(?:a|another|one\\s+more)\\s+(?:(?:quick|full)\\s+)?(?:re-?boot|restart|log[\\s-]*out|logout|shutdown)\\b|\\b(?:re-?boot|restart|log[\\s-]*out|logout)\\s+(?:is|'s)\\s+(?:needed|required|due|recommended)\\b|\\bneeds?\\s+(?:to\\s+be\\s+)?(?:re-?boot(?:ed|ing)|restart(?:ed|ing)|shut\\s*down|powered\\s+(?:off|down)))`,
);

/**
 * A sentence as written and with each opening taken off in turn, so an
 * imperative is read wherever its lead-ins end.
 */
function openingsOf(plain: string): string[] {
	const openings = [plain];
	let opening = plain;
	for (let rest = shorn(opening); rest !== opening; rest = shorn(opening)) {
		opening = rest;
		openings.push(opening);
	}
	return openings;
}

/**
 * A lead-in ending on an act, so the comma after it goes on with a list
 * of acts, not the imperative a lead-in leaves: "asks Joel to log out,
 * reboot or restart".
 */
const LISTED_ACT = new RegExp(`\\b(?:${ACT_WORDS})\\s*$`);

/**
 * A sentence with its first opening taken off: a word that leaves an
 * imperative, or a lead-in that doesn't end on an act, since "restart,
 * reboot or log out" is a list, not a lead-in.
 */
function shorn(opening: string): string {
	const word = opening.replace(OPENING, "");
	if (word !== opening) return word;
	const lead = LEAD_IN.exec(opening);
	if (lead === null || LISTED_ACT.test(lead[1] ?? "")) return opening;
	return opening.slice(lead[0].length);
}

/** Whether a sentence asks, `words` being what names a machine. */
function readsAsAsk(plain: string, words: string): boolean {
	return (
		openingsOf(plain).some(
			(opening) =>
				(IMPERATIVE.test(opening) && !labelled(opening, words)) ||
				TRY.test(opening),
		) ||
		REQUESTED.test(plain) ||
		DONE_FIRST.test(plain) ||
		doneFirstNow(plain, words) ||
		NEED.test(plain)
	);
}

/**
 * Whether an imperative is a label's head instead, "Restart:" or
 * "Reboot hold:", naming no machine before its colon. A head of the act
 * and a time, "Reboot now:", is the imperative with its reason after.
 */
function labelled(opening: string, words: string): boolean {
	const head = LABEL_HEAD.exec(opening)?.[1];
	return (
		head !== undefined &&
		!TIMED_HEAD.test(head) &&
		!new RegExp(`\\b(?:${words})\\b`).test(head)
	);
}

/** A label head's second word that makes it an act now, not a name. */
const TIMED_HEAD = /^\S+\s+(?:now|tonight|today|first|again|please)$/;

/** Whether a sentence asks for the code in it to be typed. */
function asksToRun(plain: string): boolean {
	return (
		openingsOf(plain).some((opening) => new RegExp(`^${RUN}`).test(opening)) ||
		new RegExp(`${NOT_BEFORE}${REQUEST.source}\\s+${GAP}${RUN}`).test(plain)
	);
}

/** The machines out of `machines` a sentence names, in its order. */
function namedIn(plain: string, machines: readonly string[]): string[] {
	return machines
		.map((name) => ({
			name,
			at: plain.search(new RegExp(`\\b${escaped(name.toLowerCase())}\\b`)),
		}))
		.filter((one) => one.at >= 0)
		.sort((a, b) => a.at - b.at)
		.map((one) => one.name);
}

/** systemctl with any options before its verb, as `-i` or `--user`. */
const SYSTEMCTL = String.raw`systemctl(?:\s+-\S+)*\s+`;

/** logind's manager over D-Bus, as busctl, dbus-send or gdbus call it. */
const LOGIN1 = String.raw`(?:busctl|dbus-send|gdbus)\s.*login1.*`;

/** Session-ending commands, by the act each is, macOS's and Linux's. */
const COMMANDS: readonly (readonly [RegExp, Act])[] = [
	[
		new RegExp(
			String.raw`^(?:reboot(?=\s|$)|shutdown\s+(?:\S+\s+)*-r\b|${SYSTEMCTL}(?:reboot|soft-reboot|kexec)(?=\s|$)|${SYSTEMCTL}(?:isolate|start)\s+(?:reboot|soft-reboot|kexec)\.target|(?:tel)?init\s+6(?=\s|$)|launchctl\s+reboot(?!\s+logout)(?=\s|$)|fdesetup\s+authrestart(?=\s|$)|osascript\s.*\b(?:restart|aevtrrst)\b|${LOGIN1}\breboot\b|qdbus\s.*\blogoutandreboot\b)`,
		),
		"reboot",
	],
	[
		new RegExp(
			String.raw`^(?:(?:shutdown(?![^|;&]*\s-c\b)|poweroff|halt)(?=\s|$)|${SYSTEMCTL}(?:poweroff|halt)(?=\s|$)|${SYSTEMCTL}(?:isolate|start)\s+(?:poweroff|halt)\.target|(?:tel)?init\s+0(?=\s|$)|osascript\s.*\b(?:shut\s*down|aevtrsdn)\b|${LOGIN1}\b(?:power-?off|halt)\b|qdbus\s.*\blogoutandshutdown\b)`,
		),
		"shut down",
	],
	[
		new RegExp(
			String.raw`^(?:loginctl\s+(?:terminate|kill)-(?:user|session|seat)(?=\s|$)|niri\s+msg\s+action\s+quit(?=\s|$)|(?:gnome|cinnamon|mate)-session-quit(?=\s|$)|xfce4-session-logout(?=\s|$)|lxqt-leave(?=\s|$)|qdbus\s.*\bshutdown\s.*\blogout\b|launchctl\s+bootout\s+(?:gui|user)\/|launchctl\s+reboot\s+logout|osascript\s.*\b(?:log\s*out|aevtrlgo)\b|(?:pkill|killall)\s.*\b(?:loginwindow|windowserver|niri|gnome-shell|sway|hyprland|kwin\w*|plasmashell)\b|(?:pkill|killall)(?:\s+-\w+)*\s+-u\s+\S+(?:\s+-(?![fx]\b)\w+)*\s*$|kill\s+(?:-\S+\s+)*-1(?=\s|$)|${SYSTEMCTL}(?:restart|stop|kill)\s+(?:display-manager|gdm3?|sddm|lightdm|greetd|niri|sway|hyprland|gnome-shell\S*|plasma-\S+|graphical-session\.target)(?:\.service)?(?=\s|$)|${LOGIN1}\bterminate(?:user|session|seat)\b|swaymsg\s+exit(?=\s|$)|hyprctl\s+dispatch\s+exit(?=\s|$))`,
		),
		"log out",
	],
];

/**
 * What may wrap a command and leave it the same command: elevation with
 * its options and their values, env and its settings, nohup and the
 * like, a shell's -c or su's, quotes, and the folder it is run from.
 */
const WRAPPERS: readonly RegExp[] = [
	/^["']+|["']+$/g,
	/^(?:\.?\/)?(?:[\w.-]+\/)+(?=[\w.-]+(?:\s|$))/,
	/^su\s+(?:[-\w]+\s+)*?-c\s+/,
	/^(?:sudo|run0|doas|pkexec)(?:\s+(?:-[ugCDhpRrTt]\s+\S+|--[\w-]+(?:=\S+)?|-[\w-]+))*\s+/,
	/^env(?:\s+-\S+)*(?:\s+\w+=\S*)*\s+/,
	/^(?:nohup|exec|command|time|setsid|nice(?:\s+-n\s*\S+)?)\s+/,
	/^\w+=\S*\s+/,
	/^(?:sh|bash|zsh|dash)\s+-c\s+/,
	/^timeout(?:\s+-\S+)*\s+\S+\s+/,
	/^systemd-run(?:\s+(?:-[pE]\s+\S+|--[\w-]+(?:=\S+)?|-\w+))*\s+/,
	/^xargs(?:\s+-\S+)*\s+/,
	/^(?:then|do|else)\s+/,
	/^[({]\s*|\s*[)}]$/g,
];

/** A command without what wraps it. */
function unwrapped(command: string): string {
	let bare = command.trim();
	for (;;) {
		const rest = WRAPPERS.reduce(
			(text, wrapper) => text.replace(wrapper, ""),
			bare,
		).trim();
		if (rest === bare) return bare;
		bare = rest;
	}
}

/** The options of ssh that take a value after them. */
const SSH_VALUED = new Set([
	"-p",
	"-i",
	"-o",
	"-l",
	"-J",
	"-F",
	"-b",
	"-c",
	"-E",
	"-L",
	"-R",
	"-D",
	"-W",
	"-S",
	"-m",
	"-O",
	"-Q",
	"-w",
	"-B",
	"-e",
	"-I",
]);

/**
 * The asks in one command line: each of its commands, split on `&&`,
 * `||`, `;`, `|` and `&`, that ends sessions, on the machine an ssh in
 * front of it names, else on none named.
 */
function commandAsks(
	line: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	const found: SessionEndingAsk[] = [];
	for (const piece of line.replace(PROMPT, "").split(/&&|\|\||[;|&]/)) {
		let command = unwrapped(piece);
		let machine: string | undefined;
		const remote = sshTo(command);
		if (remote) {
			machine = remote.host;
			command = unwrapped(remote.command);
		}
		const act = COMMANDS.find(([pattern]) =>
			pattern.test(command.toLowerCase()),
		)?.[1];
		if (!act) continue;
		const known = machine ? knownAs(machine, machines) : undefined;
		found.push({ act, machines: known ? [known] : [], said: line.trim() });
	}
	return found;
}

/**
 * The host and command of an ssh, or nothing for another command. An
 * option after the host, as `-t`, is ssh's, not the command's.
 */
function sshTo(command: string): { host: string; command: string } | undefined {
	const words = command.split(/\s+/);
	if (words[0] !== "ssh") return undefined;
	let at = 1;
	while (at < words.length && words[at]?.startsWith("-")) {
		at += SSH_VALUED.has(words[at] ?? "") ? 2 : 1;
	}
	const host = words[at];
	if (!host) return undefined;
	let rest = at + 1;
	while (rest < words.length && words[rest]?.startsWith("-")) rest++;
	return { host, command: words.slice(rest).join(" ") };
}

/**
 * A host as the machine it names, without its user or domain, or
 * nothing when it is none listed, as an address or an alias: then it
 * names no machine, and every one is checked.
 */
function knownAs(
	host: string,
	machines: readonly string[],
): string | undefined {
	const bare = (host.split("@").pop() ?? host).split(".")[0] ?? host;
	return machines.find((name) => name.toLowerCase() === bare.toLowerCase());
}
