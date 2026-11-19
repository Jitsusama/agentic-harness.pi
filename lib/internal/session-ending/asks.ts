/**
 * What reads as asking the person to end a machine's sessions: to log
 * out, reboot, restart or shut down a machine, or switch users on it.
 * Every pi session on that machine ends with it, so on 18 November one
 * ask for a log-out on equilibrius ended five.
 *
 * Prose asks only in the form of an ask: an imperative opening
 * ("Reboot optimus"), a request ("could you", "you'll need to", "may
 * I"), or a need ("needs a reboot"). A reboot that happened, or that a
 * change will wait for, asks nothing. A label, a choice or a title is
 * the ask itself, so there any act counts. A line of fenced code that
 * opens with a session-ending command (`sudo reboot`, `systemctl
 * poweroff`, `loginctl terminate-user`) is a command handed over to be
 * typed, so it asks too.
 *
 * A restart, shutdown or power-off counts only of a machine: restarting
 * the shell or pi ends no other session. A log-out counts unless it is
 * out of something else, as gh. Each ask names the machines its
 * sentence names, out of those it is given; none means it said none.
 */

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
	return FIRST_LOOK.test(text);
}

/**
 * The asks in a reply or a question's prompt: each sentence that asks
 * in the form of an ask, and each session-ending command in fenced code.
 */
export function asksInProse(
	text: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	return asksIn(text, machines, true);
}

/**
 * The asks in a label, a choice or a title, which is the ask itself, so
 * any session-ending act in it counts.
 */
export function asksInLabel(
	text: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	return asksIn(text, machines, false);
}

const FIRST_LOOK =
	/\b(?:re-?boot|restart|shut|shutdown|power|turn\s+off|log[\s-]*(?:out|off)|logout|logoff|sign[\s-]*out|switch(?:es|ed|ing)?\s+(?:the\s+)?users?|switch(?:es|ed|ing)?\s+to\s+(?:another|a\s+different|the\s+other)\s+user|user\s+switch|loginctl|poweroff|halt|niri\s+msg|gnome-session-quit|bootout|loginwindow|windowserver)/i;

function asksIn(
	text: string,
	machines: readonly string[],
	asProse: boolean,
): SessionEndingAsk[] {
	const words = machineWords(machines);
	const found: SessionEndingAsk[] = [];
	for (const part of parts(text)) {
		if (part.code) {
			for (const line of part.lines) found.push(...commandAsks(line, machines));
			continue;
		}
		for (const sentence of sentences(part.lines)) {
			const plain = plainOf(sentence);
			const acts = actsIn(plain, words);
			if (acts.length === 0) continue;
			if (asProse && !readsAsAsk(plain)) continue;
			const named = namedIn(plain, machines);
			for (const act of acts) {
				found.push({ act, machines: named, said: sentence.trim() });
			}
		}
	}
	return found;
}

interface Part {
	readonly code: boolean;
	readonly lines: readonly string[];
}

/** The text cut into prose and fenced code, in order. */
function parts(text: string): Part[] {
	const out: Part[] = [];
	let lines: string[] = [];
	let code = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(?:```|~~~)/.test(line)) {
			if (lines.length > 0) out.push({ code, lines });
			lines = [];
			code = !code;
			continue;
		}
		lines.push(line);
	}
	if (lines.length > 0) out.push({ code, lines });
	return out;
}

/** Each sentence of some prose lines; a line break ends one too. */
function sentences(lines: readonly string[]): string[] {
	return lines.flatMap((line) =>
		line.split(/(?<=[.!?;])\s+/).filter((one) => one.trim() !== ""),
	);
}

/**
 * A sentence lowercased, without the markdown around its words: a
 * bullet or number opening it, code ticks, emphasis, curly apostrophes.
 */
function plainOf(sentence: string): string {
	return sentence
		.toLowerCase()
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[`*_]/g, "")
		.replace(/^\s*(?:[-+>#]+|\d+[.)])\s+/, "")
		.trim();
}

function escaped(word: string): string {
	return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What can be the machine a restart, shutdown or power-off is of. */
function machineWords(machines: readonly string[]): string {
	const names = machines.map((name) => escaped(name.toLowerCase()));
	return [
		"machine",
		"computer",
		"laptop",
		"macbook(?:\\s+(?:pro|air))?",
		"mac",
		"desktop",
		"workstation",
		"system",
		"box",
		"host",
		...names,
	].join("|");
}

/** The words between a verb and its machine: the, your, both of. */
const DETERMINERS =
	"(?:(?:the|your|this|that|my|our|a|both|each|every|all|of|joel's)\\s+)*";

/** What a log-out may be out of and still end the machine's sessions. */
const LOG_OUT_OF =
	"macos|session|desktop|account|user|gui|login|niri|gnome|kde|plasma|graphical|everything";

function actsIn(plain: string, words: string): Act[] {
	const machine = `(?:${words})\\b`;
	const acts: Act[] = [];
	if (/\bre-?boot(?:s|ed|ing)?\b/.test(plain)) acts.push("reboot");
	const restart = [
		`\\brestart(?:s|ed|ing)?\\s+${DETERMINERS}${machine}`,
		`\\brestart\\s+of\\s+${DETERMINERS}${machine}`,
		`\\b${machine}\\s+(?:needs|requires|wants|will\\s+need|has\\s+to|must|should)\\s+(?:a\\s+restart|to\\s+(?:be\\s+)?restart(?:ed)?)`,
	];
	if (restart.some((pattern) => new RegExp(pattern).test(plain))) {
		acts.push("restart");
	}
	const shutDown = [
		`\\b(?:shut(?:s|ting)?\\s*down|shutdown|power(?:s|ed|ing)?\\s*(?:off|down)|power-?cycle|turn(?:s|ed|ing)?\\s+off)\\s+${DETERMINERS}${machine}`,
		`\\bshut(?:s|ting)?\\s+${DETERMINERS}${machine}\\s+down\\b`,
	];
	if (shutDown.some((pattern) => new RegExp(pattern).test(plain))) {
		acts.push("shut down");
	}
	const logOut = new RegExp(
		`\\b(?:log(?:s|ged|ging)?[\\s-]*(?:out|off)|logout|logoff|sign(?:s|ed|ing)?[\\s-]*out)\\b(?!\\s+(?:of|from)\\s+(?!${DETERMINERS}(?:${LOG_OUT_OF}|${words})\\b))`,
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

/** What may come before an imperative and leave it one. */
const OPENING =
	/^(?:please|then|now|next|so|ok(?:ay)?|first|finally|and|just|joel|go\s+ahead\s+and|when\s+you(?:'re|\s+are)\s+ready|(?:when|whenever)\s+you\s+can|once\s+[^,]{1,60}|at\s+your\s+convenience|after\s+that|tonight|step\s+\d+)\s*[,:]?\s+/;

const IMPERATIVE =
	/^(?:re-?boot|restart|shut\s*down|shut|power\s*(?:off|down)|power-?cycle|turn\s+off|log[\s-]*(?:out|off)|logout|sign[\s-]*out|switch)\b/;

/** Words that make a sentence a request of the person. */
const REQUEST =
	/\b(?:please|pls|could\s+you|can\s+you|would\s+you|will\s+you|you(?:'ll|\s+will|'d|\s+would)?\s+(?:need|have|want)\s+to|you\s+must|you\s+should|need\s+you\s+to|ask(?:ing)?\s+(?:you|joel|him|her|them|the\s+person)\s+to|i'?d\s+like\s+you\s+to|want\s+you\s+to|time\s+to|ready\s+to|go\s+ahead\s+and|do\s+you\s+want\s+to|shall\s+(?:we|i)|may\s+i|can\s+i|could\s+i|ok(?:ay)?\s+to|fine\s+to|safe\s+to|is\s+it\s+(?:ok|okay|alright|fine)\s+to|let\s+me\s+know\s+when\s+you|when\s+you|once\s+you|after\s+you)\b/;

/** A need for an act, which asks for it as plainly. */
const NEED =
	/\b(?:needs?|requires?|wants?|calls?\s+for|due\s+for|takes?)\s+(?:a|another|one\s+more)\s+(?:re-?boot|restart|log[\s-]*out|logout|shutdown)\b|\b(?:re-?boot|restart|log[\s-]*out|logout)\s+(?:is|'s)\s+(?:needed|required|due)\b/;

function readsAsAsk(plain: string): boolean {
	let opening = plain;
	for (let rest = opening.replace(OPENING, ""); rest !== opening; ) {
		opening = rest;
		rest = opening.replace(OPENING, "");
	}
	return IMPERATIVE.test(opening) || REQUEST.test(plain) || NEED.test(plain);
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

/** Session-ending commands, by the act each is. */
const COMMANDS: readonly (readonly [RegExp, Act])[] = [
	[
		/^(?:reboot\b|shutdown\s+(?:\S+\s+)*-r\b|systemctl\s+(?:reboot|soft-reboot|kexec)\b)/,
		"reboot",
	],
	[
		/^(?:shutdown|poweroff|halt)\b|^systemctl\s+(?:poweroff|halt)\b/,
		"shut down",
	],
	[
		/^(?:loginctl\s+(?:terminate|kill)-(?:user|session)\b|niri\s+msg\s+action\s+quit\b|gnome-session-quit\b|launchctl\s+bootout\s+gui\/|osascript\b.*\blog\s*out\b|(?:pkill|killall)\b.*\b(?:loginwindow|windowserver|niri|gnome-shell)\b)/,
		"log out",
	],
];

/** What a command line may open with before the command itself. */
const PROMPT = /^\s*(?:[$#%>]\s+)?/;
const ELEVATE = /^(?:sudo|run0|doas)(?:\s+-\S+)*\s+/;

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
 * The asks in one line of fenced code: each of its commands, split on
 * `&&`, `||` and `;`, that ends sessions, on the machine an ssh in
 * front of it names, else on none named.
 */
function commandAsks(
	line: string,
	machines: readonly string[],
): SessionEndingAsk[] {
	const found: SessionEndingAsk[] = [];
	for (const piece of line.replace(PROMPT, "").split(/&&|\|\||;/)) {
		let command = piece.trim();
		let machine: string | undefined;
		const remote = sshTo(command);
		if (remote) {
			machine = remote.host;
			command = remote.command;
		}
		command = command.replace(/^["']|["']$/g, "").replace(ELEVATE, "");
		const act = COMMANDS.find(([pattern]) =>
			pattern.test(command.toLowerCase()),
		)?.[1];
		if (!act) continue;
		found.push({
			act,
			machines: machine ? [knownAs(machine, machines)] : [],
			said: line.trim(),
		});
	}
	return found;
}

/** The host and command of an ssh, or nothing for another command. */
function sshTo(command: string): { host: string; command: string } | undefined {
	const words = command.split(/\s+/);
	if (words[0] !== "ssh") return undefined;
	let at = 1;
	while (at < words.length && words[at]?.startsWith("-")) {
		at += SSH_VALUED.has(words[at] ?? "") ? 2 : 1;
	}
	const host = words[at];
	if (!host) return undefined;
	return { host, command: words.slice(at + 1).join(" ") };
}

/** A host as the machine it names: no user, no domain, as listed. */
function knownAs(host: string, machines: readonly string[]): string {
	const bare = (host.split("@").pop() ?? host).split(".")[0] ?? host;
	return (
		machines.find((name) => name.toLowerCase() === bare.toLowerCase()) ??
		bare.toLowerCase()
	);
}
