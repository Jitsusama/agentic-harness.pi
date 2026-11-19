/**
 * What reads as asking the person to end a machine's sessions: to log
 * out, reboot, restart or shut down a machine, or switch users on it.
 * Every pi session on that machine ends with it, so on 18 November one
 * ask for a log-out on equilibrius ended five.
 *
 * Prose asks only in the form of an ask: an imperative opening
 * ("Reboot optimus", after any "if the mic is dead," or "try"), a
 * request followed by the act as a verb ("could you reboot", "you'll
 * need to log out", "may I"), or a need ("needs a reboot"). A reboot
 * that happened, or that a change will wait for, asks nothing, and nor
 * does a request about one ("could you check whether the reboot
 * fixed it"). A label, a choice or a title is the ask itself, so there
 * the act counts whenever it is a verb rather than a time ("after the
 * reboot"). A session-ending command (`sudo reboot`, `systemctl
 * poweroff`, `loginctl terminate-user`) is handed over to be typed, so
 * it asks on a line of a shell's fenced code, or in inline code a
 * sentence asks to run.
 *
 * A restart, shutdown or power-off counts only of a machine, or with no
 * object at all ("restart now"): restarting the shell or pi ends no
 * other session. A reboot counts unless it is of another device, as a
 * router. A log-out counts unless it is out of something else, as gh.
 * Each ask names the machines its sentence names, out of those it is
 * given; none means it said none.
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
	/\b(?:re-?boot|restart|shut|shutdown|power|turn\s+off|log[\s-]*(?:out|off)|logout|logoff|sign[\s-]*out|switch(?:es|ed|ing)?\s+(?:the\s+)?users?|switch(?:es|ed|ing)?\s+to\s+(?:another|a\s+different|the\s+other)\s+user|user\s+switch|loginctl|poweroff|halt|kexec|pkill|killall|niri\s+msg|gnome-session-quit|bootout|loginwindow|windowserver)/i;

function asksIn(
	text: string,
	machines: readonly string[],
	asProse: boolean,
): SessionEndingAsk[] {
	const words = machineWords(machines);
	const found: SessionEndingAsk[] = [];
	for (const part of parts(text)) {
		if (part.code) {
			if (!part.shell) continue;
			for (const line of part.lines) found.push(...commandAsks(line, machines));
			continue;
		}
		for (const sentence of sentences(part.lines)) {
			found.push(...sentenceAsks(sentence, machines, words, asProse));
		}
	}
	return found;
}

/** The asks of one sentence, one an act, by its words or its commands. */
function sentenceAsks(
	sentence: string,
	machines: readonly string[],
	words: string,
	asProse: boolean,
): SessionEndingAsk[] {
	const plain = plainOf(sentence);
	const named = namedIn(plain, machines);
	const said = sentence.trim();
	const byAct = new Map<Act, SessionEndingAsk>();
	const asks = asProse ? readsAsAsk(plain) : ACT_VERB.test(plain);
	if (asks) {
		for (const act of actsIn(plain, words)) {
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

/** The spans of inline code in a sentence, as written. */
function inlineCode(sentence: string): string[] {
	return [...sentence.matchAll(/`([^`]+)`/g)].flatMap((one) => one[1] ?? []);
}

interface Part {
	readonly code: boolean;
	/** Whether fenced code is a shell's, so its lines are commands. */
	readonly shell: boolean;
	readonly lines: readonly string[];
}

/** The languages a fence of commands to type is marked with, or none. */
const SHELLS = new Set([
	"",
	"sh",
	"bash",
	"zsh",
	"fish",
	"shell",
	"console",
	"terminal",
	"text",
]);

/** The text cut into prose and fenced code, in order. */
function parts(text: string): Part[] {
	const out: Part[] = [];
	let lines: string[] = [];
	let code = false;
	let shell = false;
	for (const line of text.split(/\r?\n/)) {
		const fence = /^\s*(?:```|~~~)\s*(\S*)/.exec(line);
		if (fence) {
			if (lines.length > 0) out.push({ code, shell, lines });
			lines = [];
			code = !code;
			shell = code && SHELLS.has((fence[1] ?? "").toLowerCase());
			continue;
		}
		lines.push(line);
	}
	if (lines.length > 0) out.push({ code, shell, lines });
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
		.replace(/^\[[ x]\]\s+/, "")
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

/** Devices a reboot may be of without ending a machine's sessions. */
const NOT_MACHINES =
	"router|modem|phone|iphone|ipad|vm|container|pod|switch|printer|tv|watch|access\\s+point|cluster";

/**
 * What may follow a restart, shutdown or power-off with no object, as
 * "restart now" or "shut down to finish", leaving it one of the machine.
 */
const NO_OBJECT =
	"(?=\\s*$|\\s*[.!?,;:)]|\\s+(?:now|to|and|when|once|so|first|later|tonight|then|again|if|after|before|asap|soon|please)\\b)";

function actsIn(plain: string, words: string): Act[] {
	const machine = `(?:${words})\\b`;
	const acts: Act[] = [];
	const reboot = new RegExp(
		`\\bre-?boot(?:s|ed|ing)?\\b(?!\\s+${DETERMINERS}(?:${NOT_MACHINES})\\b)`,
	);
	if (reboot.test(plain)) acts.push("reboot");
	const restart = [
		`\\brestart(?:s|ed|ing)?${NO_OBJECT}`,
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
		`\\b(?:shut(?:s|ting)?\\s*down|shutdown|power(?:s|ed|ing)?\\s*(?:off|down))${NO_OBJECT}`,
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

/**
 * What may come before an imperative and leave it one: a word, a clause
 * closed by a comma ("if the mic is still dead,"), or "try to".
 */
const OPENING =
	/^(?:(?:please|then|now|next|so|ok(?:ay)?|first|finally|and|just|joel|go\s+ahead\s+and|(?:when|whenever)\s+you\s+can|at\s+your\s+convenience|after\s+that|tonight|step\s+\d+)\s*[,:]?|(?:if|when|whenever|once|after|before|as\s+soon\s+as)\s+[^,]{1,80},|try\s+to)\s+/;

const IMPERATIVE =
	/^(?:re-?boot|restart|shut\s*down|shut|power\s*(?:off|down)|power-?cycle|turn\s+off|log[\s-]*(?:out|off)|logout|sign[\s-]*out|switch)\b/;

/** An act offered to try, which asks for it as an imperative does. */
const TRY =
	/^try\s+(?:re-?booting|restarting|shutting\s*down|powering\s*(?:off|down)|logging[\s-]*(?:out|off)|signing[\s-]*out|switching\s+users?)\b/;

/**
 * A session-ending act as a verb, not a noun or a time: "reboot" in
 * "could you reboot", not in "the reboot" or "since the last reboot".
 */
const ACT_VERB =
	/(?<!\b(?:the|a|an|another|last|next|that|this|since|after|before|during|from|of|its|your|my|our|any|no|each|every|one|until|till|pending)\s+)\b(?:re-?boot(?:ing)?|restart(?:ing)?|shut(?:ting)?\s*down|shut(?:ting)?|power(?:ing)?\s*(?:off|down)|power-?cycle|turn(?:ing)?\s+off|log(?:ging)?[\s-]*(?:out|off)|logout|sign(?:ing)?[\s-]*out|switch(?:ing)?\s+(?:the\s+)?users?)\b/;

/** Words that make a sentence a request of the person, when an act follows. */
const REQUEST =
	/\b(?:please|pls|could\s+you|can\s+you|would\s+you|will\s+you|you(?:'ll|\s+will|'d|\s+would)?\s+(?:need|have|want)\s+to|you\s+must|you\s+should|need\s+you\s+to|i(?:'m|\s+am)?\s+ask(?:ing)?\s+(?:you|joel)\s+to|i'?d\s+like\s+you\s+to|want\s+you\s+to|time\s+to|ready\s+to|go\s+ahead\s+and|do\s+you\s+want\s+to|shall\s+(?:we|i)|may\s+i|can\s+i|could\s+i|ok(?:ay)?\s+to|fine\s+to|safe\s+to|is\s+it\s+(?:ok|okay|alright|fine)\s+to|let\s+me\s+know\s+when\s+you)\b/;

/** A request, then the act as a verb later in the same sentence. */
const REQUESTED = new RegExp(`${REQUEST.source}.*?${ACT_VERB.source}`);

/** An act the person is to have done before something else follows. */
const DONE_FIRST =
	/\b(?:once|after|when|until)\s+you(?:'ve|\s+have)\s+(?:re-?booted|restarted|logged[\s-]*(?:out|off)|signed[\s-]*out|shut\s*down|powered\s*(?:off|down)|switched\s+users?)\b/;

/** Words that hand a command over to be typed. */
const RUN = "(?:run|type|paste|execute|enter)\\b";

/** A need for an act, which asks for it as plainly. */
const NEED =
	/\b(?:needs?|requires?|wants?|calls?\s+for|due\s+for|takes?)\s+(?:a|another|one\s+more)\s+(?:re-?boot|restart|log[\s-]*out|logout|shutdown)\b|\b(?:re-?boot|restart|log[\s-]*out|logout)\s+(?:is|'s)\s+(?:needed|required|due)\b/;

/** A sentence without the words that may come before an imperative. */
function openingOf(plain: string): string {
	let opening = plain;
	for (let rest = opening.replace(OPENING, ""); rest !== opening; ) {
		opening = rest;
		rest = opening.replace(OPENING, "");
	}
	return opening;
}

function readsAsAsk(plain: string): boolean {
	const opening = openingOf(plain);
	return (
		IMPERATIVE.test(opening) ||
		TRY.test(opening) ||
		REQUESTED.test(plain) ||
		DONE_FIRST.test(plain) ||
		NEED.test(plain)
	);
}

/** Whether a sentence asks for the code in it to be typed. */
function asksToRun(plain: string): boolean {
	return (
		new RegExp(`^${RUN}`).test(openingOf(plain)) ||
		new RegExp(`${REQUEST.source}\\s+${RUN}`).test(plain)
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

/** Session-ending commands, by the act each is. */
const COMMANDS: readonly (readonly [RegExp, Act])[] = [
	[
		/^(?:reboot(?=\s|$)|shutdown\s+(?:\S+\s+)*-r\b|systemctl\s+(?:reboot|soft-reboot|kexec)(?=\s|$))/,
		"reboot",
	],
	[
		/^(?:shutdown|poweroff|halt)(?=\s|$)|^systemctl\s+(?:poweroff|halt)(?=\s|$)/,
		"shut down",
	],
	[
		/^(?:loginctl\s+(?:terminate|kill)-(?:user|session)(?=\s|$)|niri\s+msg\s+action\s+quit(?=\s|$)|gnome-session-quit(?=\s|$)|launchctl\s+bootout\s+gui\/|osascript\s.*\blog\s*out\b|(?:pkill|killall)\s.*\b(?:loginwindow|windowserver|niri|gnome-shell)\b)/,
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
		const known = machine ? knownAs(machine, machines) : undefined;
		found.push({ act, machines: known ? [known] : [], said: line.trim() });
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
