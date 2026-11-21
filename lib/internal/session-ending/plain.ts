/**
 * Whether what a reply shows the person to type is plain enough for a
 * spare to stand on: every command in it a plain spelling of an act the
 * guard reads exactly, and none in its prose. Reading each spelling of
 * every act let one more through each time it widened, so anything off
 * this short list spares nothing rather than being read.
 */

import {
	codeSpans,
	folded,
	type Part,
	parts,
	spansToRun,
	withoutSpansToRun,
} from "./asks.ts";

/**
 * The commands a spare may stand beside, each read whole, after a
 * prompt and a `sudo`: a reboot, a shut-down or a log-out, and nothing
 * that would change what it does.
 */
const PLAIN: readonly RegExp[] = [
	/^systemctl\s+(?:reboot|poweroff)$/,
	/^(?:reboot|poweroff)$/,
	/^shutdown\s+(?:-[rhP]\s+)?now$/,
	// A session's id, never an option such as `-H` naming another host.
	/^loginctl\s+terminate-session(?:\s+(?!-)[\w.-]+)?$/,
	/^niri\s+msg\s+action\s+quit(?:\s+(?:--skip-confirmation|-s))?$/,
];

/** What a command line may open with before the command itself. */
const OPENING = /^(?:[$#%>]\s+)?(?:sudo\s+)?/;

/**
 * A word in prose that is a command or opens one, so prose holding it
 * says to run something nothing here reads whole: `sudo`, `systemctl`,
 * `kexec`, `init 1`, any kill, an option after a reboot (a hyphen with
 * a space after it is a dash). A soft or userspace reboot keeps the
 * boot however it is spelt, so its word counts too, and so does a next
 * root, which makes a reboot soft; and linger or KillUserProcesses: a
 * reply changing either changes what a log-out ends after logind was
 * read.
 */
const COMMAND_WORD =
	/\b(?:soft(?!ware)|user[\s-]?space|nextroot|linger(?:ing|s)?|killuserprocesses|sudo|doas|run0|pkexec|systemctl|loginctl|busctl|dbus-send|gdbus|qdbus|kexec|telinit|kill|skill|pkill|killall|ssh|swaymsg|hyprctl|osascript|launchctl|niri\s+msg|init\s+[0-6sS]\b|shutdown\s+(?:-+\w|now\b|\+)|reboot\s+-+\w|poweroff\s+-+\w|halt\b)/i;

/** A line with nothing on it, which runs nothing. */
const BLANK = /^\s*$/;

/**
 * A shell's comment, which runs nothing only in a fence of commands: in
 * a terminal's session, or a fence that may be one, `#` is root's
 * prompt. A reader still follows what a comment says, so its words are
 * held to prose's check.
 */
const COMMENT = /^\s*#/;

/**
 * A line in prose a reader takes as a command: indented as code, or
 * opening with a shell's prompt, in a blockquote or not.
 */
const SHOWN_LINE = /^(?:\s*>)*(?:(?: {4}|\t)\s*\S|\s*[$%]\s+\S)/;

/** A line holding what may open or close a fence. */
const FENCE_MARK = /`{3,}|~{3,}/;

/**
 * The one shape of a fence line read as one: indented three spaces at
 * most, and a backtick fence's info holding no backtick. A fence in a
 * blockquote, on a list's marker, or indented further is drawn by some
 * renderers and not others, so it is not plain.
 */
const FENCE_LINE = /^ {0,3}(?:`{3,}[^`]*|~{3,}.*)$/;

/** What names a backtick left unpaired, which has no text of its own. */
const UNPAIRED = "an unpaired backtick";

/**
 * Inline code, paired as `codeSpans` pairs it, so what is hidden from
 * the word check is exactly what was checked as code.
 */
const CODE_SPAN = /`[^`]+`/g;

/** Whether `line` is one of the plain commands, whole. */
function plainCommand(line: string): boolean {
	const bare = line.trim().replace(/\s+/g, " ").replace(OPENING, "");
	return PLAIN.some((one) => one.test(bare));
}

/**
 * Whether every command in `texts`, a reply's prose and labels, is a
 * plain spelling of a reboot, shut-down or log-out: each span of inline
 * code, quote it asks to run, indented line and line of fenced code on
 * the list, and its prose holding no command word. A reply with no
 * command at all is plain.
 */
export function plainlySaid(texts: readonly string[]): boolean {
	return notPlainIn(texts) === undefined;
}

/**
 * What first stops `texts` being plainly said, as `plainlySaid` reads
 * them: the command shown, the fence line or the word in prose, or
 * that a backtick was left unpaired. Nothing where all is plain.
 */
export function notPlainIn(texts: readonly string[]): string | undefined {
	for (const text of texts) {
		const said = folded(text);
		const fence = said
			.split("\n")
			.find((line) => FENCE_MARK.test(line) && !FENCE_LINE.test(line));
		if (fence !== undefined) return fence.trim();
		for (const part of parts(said)) {
			const offence = notPlainPart(part);
			if (offence !== undefined) return offence;
		}
	}
	return undefined;
}

/**
 * What first stops one part of a text, prose or fenced, being plain.
 * Every fence is read line by line, a markdown one too, since it is
 * drawn as code whatever its language.
 */
function notPlainPart(part: Part): string | undefined {
	if (part.fenced || !part.prose || part.commands !== "none") {
		const comments = part.commands === "every";
		for (const line of part.lines.filter((one) => !BLANK.test(one))) {
			if (comments && COMMENT.test(line)) {
				const offence = notPlainPart(proseOf(line.replace(COMMENT, "")));
				if (offence !== undefined) return offence;
			} else if (!plainCommand(line)) return line.trim();
		}
		return undefined;
	}
	const written = part.lines.join("\n");
	const shownLines = part.lines.filter((line) => SHOWN_LINE.test(line));
	const shown = [
		...codeSpans(written),
		...spansToRun(written),
		...shownLines,
	].find((one) => !plainCommand(one));
	if (shown !== undefined) return shown.trim();
	// What was shown is plain, so its own words, cut where they sit, are
	// no command in prose; the same words written bare still are.
	const rest = withoutSpansToRun(
		part.lines.filter((line) => !SHOWN_LINE.test(line)).join("\n"),
	).replace(CODE_SPAN, " ");
	// A backtick left unpaired may open code a renderer shows, unchecked.
	if (rest.includes("`")) return UNPAIRED;
	return COMMAND_WORD.exec(rest)?.[0];
}

/** One line read as prose, as a comment's words are. */
function proseOf(line: string): Part {
	return { prose: true, commands: "none", lines: [line] };
}
