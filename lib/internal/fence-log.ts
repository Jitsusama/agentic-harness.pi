/**
 * A line in the system's log for each call a sandbox refuses in pi's own
 * process, so a reader outside the session (a health daemon) can see an
 * agent probing the fence. Before this a refusal showed only in the
 * tool's answer, which nothing but the model reads.
 *
 * Each line has one fixed shape under the identifier `pi-fence`:
 * `refused kind=<path|program> tool=<name> sandbox=<name>
 * session=<id>`. It never holds what was asked for, no path, command or
 * reason text, since the log is kept for weeks and read by more than the
 * person. Every value is a plain word, or `unknown` when it isn't one,
 * so nothing a model chose can bend the shape.
 *
 * It goes through the system's own `logger`, which reaches the journal
 * on Linux and the unified log on macOS, found where only root puts
 * programs. What the kernel refuses inside the fence (a read-only bind,
 * Landlock) never passes through pi; Landlock's own audit records cover
 * that.
 */

import { execFile } from "node:child_process";
import { quoted } from "./sandbox-shell.ts";
import { systemProgram } from "./system-program.ts";

/** The identifier every refusal's line carries in the system's log. */
export const FENCE_LOG_TAG = "pi-fence";

/** What a refusal kept from the agent, as a kind, never the thing. */
export type RefusedKind = "path" | "program";

/** One refusal, as the log holds it. */
export interface Refusal {
	/** A path for pi's file tools, a program for a command. */
	readonly kind: RefusedKind;
	/** The tool whose call was refused. */
	readonly tool: string;
	/** The sandbox the session asked for, as `PI_SANDBOX` names it. */
	readonly sandbox: string | undefined;
	/** pi's id for the session, when it has one. */
	readonly session: string | undefined;
}

/** How long the logger may take before a refusal is called unrecorded. */
const LOGGER_TIMEOUT_MS = 2000;

/** A value the line keeps as it is: a short plain word. */
const PLAIN = /^[A-Za-z0-9._-]{1,80}$/;

/** The facility and level: who may act, and worth a reader's notice. */
const PRIORITY = "auth.notice";

/** What a refused call's answer adds when the log didn't take it. */
const UNRECORDED = "The system log didn't take this refusal";

function plain(value: string | undefined): string {
	const trimmed = value?.trim();
	return trimmed !== undefined && PLAIN.test(trimmed) ? trimmed : "unknown";
}

/** The one line a refusal leaves in the system's log. */
export function refusalLine(refusal: Refusal): string {
	return [
		"refused",
		`kind=${refusal.kind}`,
		`tool=${plain(refusal.tool)}`,
		`sandbox=${plain(refusal.sandbox)}`,
		`session=${plain(refusal.session)}`,
	].join(" ");
}

/**
 * The one line a session leaves when it runs its commands with no
 * fence: `unfenced sandbox=<off|none> session=<id>`, `off` when it
 * said so and `none` when the fence couldn't be had. It says nothing of
 * why, as a refusal's line doesn't.
 */
export function unfencedLine(
	sandbox: string | undefined,
	session: string | undefined,
): string {
	return [
		"unfenced",
		`sandbox=${plain(sandbox ?? "none")}`,
		`session=${plain(session)}`,
	].join(" ");
}

/**
 * Writes a session's unfenced line to the system's log, so an opt-out
 * shows outside the session; answers why it couldn't, as
 * `recordRefusal` does.
 */
export function recordUnfenced(
	sandbox: string | undefined,
	session: string | undefined,
	logger: string | undefined,
): Promise<string | undefined> {
	return writeLine(unfencedLine(sandbox, session), logger);
}

/** The system's own `logger`, or undefined when it has none. */
export function systemLogger(): string | undefined {
	return systemProgram("logger");
}

function loggerArguments(line: string): string[] {
	return ["-t", FENCE_LOG_TAG, "-p", PRIORITY, "--", line];
}

/**
 * Writes a refusal to the system's log from pi's process, answering why
 * it couldn't when it couldn't, for the refused call's answer to say.
 * The logger is named, never defaulted, so `undefined` means there is
 * none rather than "look one up": `systemLogger()` looks it up.
 */
export function recordRefusal(
	refusal: Refusal,
	logger: string | undefined,
): Promise<string | undefined> {
	return writeLine(refusalLine(refusal), logger);
}

/** Writes one line under the fence's tag, answering why it couldn't. */
function writeLine(
	line: string,
	logger: string | undefined,
): Promise<string | undefined> {
	if (logger === undefined) {
		return Promise.resolve(
			`${UNRECORDED}: there is no logger in the system's own programs.`,
		);
	}
	return new Promise((resolve) => {
		execFile(
			logger,
			loggerArguments(line),
			{ timeout: LOGGER_TIMEOUT_MS },
			(error) =>
				resolve(error ? `${UNRECORDED}: ${error.message.trim()}.` : undefined),
		);
	});
}

/**
 * The shell text that writes a refusal to the system's log with
 * `logger` before a refused command says why, and says so on stderr
 * when the log didn't take it. It runs where the refusal does, outside
 * any sandbox, and the sandbox found the logger as it found its own
 * programs.
 */
export function recordedInShell(
	refusal: Refusal,
	logger: string | undefined,
): string {
	const unrecorded = `printf '%s\\n' ${quoted(`${UNRECORDED}.`)} >&2`;
	if (logger === undefined) return unrecorded;
	const call = [logger, ...loggerArguments(refusalLine(refusal))]
		.map(quoted)
		.join(" ");
	return `${call} || ${unrecorded}`;
}
