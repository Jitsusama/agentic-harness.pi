/**
 * Reaching the person at the machine through a desktop notification.
 *
 * Some work cannot go on without the person: a decision only they can
 * make, a one-time password, a hold only they can lift. A message in the
 * session's own transcript reaches them only if they happen to look at
 * that window, and with a dozen sessions running overnight they rarely
 * do. A desktop notification reaches them wherever they are looking, so
 * a session can say what it needs and get on with everything that does
 * not need them.
 *
 * This decides how a notification is shown, never when: the mesh decides
 * when the person is reached, and what for. It answers whether the
 * notification was shown, never throws, and stays quiet where there is no
 * desktop to show it on (no notify-send or osascript, no session bus, a
 * remote shell), since a missing desktop is an answer, not an error.
 *
 * Linux uses notify-send, which talks to whatever notification daemon
 * the desktop runs (mako, dunst, GNOME's). macOS uses osascript, handing
 * it the text as arguments rather than splicing it into the script, so
 * no quote or backslash in a title can change what the script does.
 * Anything else answers false.
 *
 * `PI_NOTIFY=off` silences it, which the test suite sets so that no run
 * of it puts notifications on the developer's desktop.
 */

import { type Exec, spawnExec } from "../core/exec/index.ts";

/** How much the notification asks of the person. */
export type Urgency = "low" | "normal" | "critical";

/** What a notification says. */
export interface Notice {
	/** One line naming what it is about. */
	title: string;
	/** What is needed, in a sentence or two. */
	body?: string;
	/** Defaults to normal. Critical stays on screen until dismissed on Linux. */
	urgency?: Urgency;
}

/** The parts of the machine a notification depends on, for tests. */
export interface NotifyDeps {
	/** Defaults to the running platform. */
	platform?: NodeJS.Platform;
	/** Defaults to running the command unattended, with a short clock. */
	exec?: Exec;
	/** Defaults to the process environment. */
	env?: NodeJS.ProcessEnv;
}

/**
 * How long showing one notification may take.
 *
 * Both tools hand the notification to a daemon and return within tens of
 * milliseconds; one that has not answered in five seconds is talking to a
 * bus that will not answer, and the caller should not wait on it.
 */
export const NOTIFY_LIMIT_MS = 5_000;

/** The name notifications appear under, so the person knows who asked. */
const APP_NAME = "pi";

/**
 * The AppleScript that shows a notification from its arguments, so the
 * text is data and never part of the script.
 */
const APPLESCRIPT = [
	"on run argv",
	"display notification (item 2 of argv) with title (item 1 of argv)",
	"end run",
];

/** The AppleScript that does the same and plays a sound, for critical. */
const APPLESCRIPT_CRITICAL = [
	"on run argv",
	'display notification (item 2 of argv) with title (item 1 of argv) sound name "Funk"',
	"end run",
];

/** The command that shows `notice` on `platform`, or none where nothing can. */
export function notifyCommand(
	notice: Notice,
	platform: NodeJS.Platform,
): { command: string; args: string[] } | undefined {
	const body = notice.body ?? "";
	const urgency = notice.urgency ?? "normal";
	if (platform === "darwin") {
		const script = urgency === "critical" ? APPLESCRIPT_CRITICAL : APPLESCRIPT;
		return {
			command: "osascript",
			args: [...script.flatMap((line) => ["-e", line]), notice.title, body],
		};
	}
	if (
		platform === "linux" ||
		platform === "freebsd" ||
		platform === "openbsd"
	) {
		// `--` ends the options, so a title that opens with a dash is text.
		const text = body === "" ? [notice.title] : [notice.title, body];
		return {
			command: "notify-send",
			args: [`--app-name=${APP_NAME}`, `--urgency=${urgency}`, "--", ...text],
		};
	}
	return undefined;
}

/**
 * Show `notice` on the desktop, answering whether it was shown.
 *
 * Never throws, and answers false wherever it could not be shown: on a
 * platform with no notifier, when the tool is missing or refuses, when it
 * does not answer in time, and when `PI_NOTIFY=off`.
 */
export async function notify(
	notice: Notice,
	deps: NotifyDeps = {},
): Promise<boolean> {
	const env = deps.env ?? process.env;
	if (env.PI_NOTIFY === "off") return false;
	const shown = notifyCommand(notice, deps.platform ?? process.platform);
	if (!shown) return false;
	const exec = deps.exec ?? spawnExec({ timeoutMs: NOTIFY_LIMIT_MS });
	try {
		const result = await exec(shown.command, shown.args);
		return result.code === 0;
	} catch {
		return false;
	}
}
