/**
 * Whether what a reply shows the person to type is plain enough for a
 * spare to stand on: every command in it a plain spelling of an act the
 * guard reads exactly, and none in its prose. Reading each spelling of
 * every act let one more through each time it widened, so anything off
 * this short list spares nothing rather than being read.
 */

import { codeSpans, folded, parts } from "./asks.ts";

/**
 * The commands a spare may stand beside, each read whole, after a
 * prompt and a `sudo`: a reboot, a shut-down or a log-out, and nothing
 * that would change what it does.
 */
const PLAIN: readonly RegExp[] = [
	/^systemctl\s+(?:reboot|poweroff)$/,
	/^(?:reboot|poweroff)$/,
	/^shutdown\s+(?:-[rhP]\s+)?now$/,
	/^loginctl\s+terminate-session(?:\s+[\w.-]+)?$/,
	/^niri\s+msg\s+action\s+quit(?:\s+(?:--skip-confirmation|-s))?$/,
];

/** What a command line may open with before the command itself. */
const OPENING = /^(?:[$#%>]\s+)?(?:sudo\s+)?/;

/**
 * A word in prose that is a command or opens one, so prose holding it
 * says to run something nothing here reads whole: `sudo`, `systemctl`,
 * `kexec`, `init 1`, a kill with an option. A soft or userspace
 * reboot keeps the boot however it is spelt, so its word counts too,
 * and so does linger or KillUserProcesses: a reply changing either
 * changes what a log-out ends after logind was read.
 */
const COMMAND_WORD =
	/\b(?:soft|user[\s-]?space|linger(?:ing|s)?|killuserprocesses|sudo|doas|run0|pkexec|systemctl|loginctl|busctl|dbus-send|gdbus|qdbus|kexec|telinit|pkill|killall|ssh|swaymsg|hyprctl|osascript|launchctl|niri\s+msg|kill\s+-|init\s+[0-6sS]\b|shutdown\s+(?:-|now\b|\+)|reboot\s+-|poweroff\s+-|halt\b)/i;

/** A shell comment, or a line with nothing on it, which runs nothing. */
const NOTHING_RUN = /^\s*(?:#.*)?$/;

/** Whether `line` is one of the plain commands, whole. */
function plainCommand(line: string): boolean {
	const bare = line.trim().replace(/\s+/g, " ").replace(OPENING, "");
	return PLAIN.some((one) => one.test(bare));
}

/**
 * Whether every command in `texts`, a reply's prose and labels, is a
 * plain spelling of a reboot, shut-down or log-out: each span of inline
 * code and each line of fenced code on the list, and its prose holding
 * no command word. A reply with no command at all is plain.
 */
export function plainlySaid(texts: readonly string[]): boolean {
	for (const text of texts) {
		for (const part of parts(folded(text))) {
			const prose = part.prose && part.commands === "none";
			if (!prose) {
				const run = part.lines.filter((line) => !NOTHING_RUN.test(line));
				if (!run.every(plainCommand)) return false;
				continue;
			}
			const written = part.lines.join("\n");
			if (!codeSpans(written).every(plainCommand)) return false;
			if (COMMAND_WORD.test(written.replace(/`[^`]*`/g, " "))) return false;
		}
	}
	return true;
}
