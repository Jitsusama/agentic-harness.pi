/**
 * Whether what a reply shows the person to type is plain enough for a
 * spare to stand on: every command in it a plain spelling of an act the
 * guard reads exactly, and none in its prose. Reading each spelling of
 * every act let one more through each time it widened, so anything off
 * this short list spares nothing rather than being read.
 */

import { codeSpans, folded, type Part, parts, spansToRun } from "./asks.ts";

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
 * prompt.
 */
const COMMENT = /^\s*#/;

/**
 * A line in prose a reader takes as a command: indented as code, or
 * opening with a shell's prompt.
 */
const SHOWN_LINE = /^(?:(?: {4}|\t)\s*\S|\s*[$%]\s+\S)/;

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
	return texts.every((text) => parts(folded(text)).every(plainPart));
}

/** Whether one part of a text, prose or fenced, is plain. */
function plainPart(part: Part): boolean {
	if (!part.prose || part.commands !== "none") {
		const comments = part.commands === "every";
		return part.lines
			.filter((line) => !BLANK.test(line))
			.filter((line) => !(comments && COMMENT.test(line)))
			.every(plainCommand);
	}
	const written = part.lines.join("\n");
	const shown = [
		...codeSpans(written),
		...spansToRun(written),
		...part.lines.filter((line) => SHOWN_LINE.test(line)),
	];
	const rest = written.replace(CODE_SPAN, " ");
	// A backtick left unpaired may open code a renderer shows, unchecked.
	return (
		shown.every(plainCommand) && !rest.includes("`") && !COMMAND_WORD.test(rest)
	);
}
