/**
 * What a Chrome launch that never came up says about itself: the
 * exit code and Chrome's own stderr lifted out of the driver's
 * error, and the message a person reads.
 *
 * Kept apart from the launch because the wording and the parsing
 * change with puppeteer's error format and with what helps a person
 * recover, not with how Chrome is started.
 */

/** Diagnostic detail teased out of a failed Chrome launch. */
export interface LaunchFailureInfo {
	exitCode?: number;
	chromeStderr?: string;
}

/** Parse a Puppeteer launch error into an exit code and Chrome's stderr. */
export function classifyLaunchError(err: unknown): LaunchFailureInfo {
	const message = err instanceof Error ? err.message : String(err);
	const info: LaunchFailureInfo = {};
	const code = message.match(/Code:\s*(\d+)/);
	if (code) info.exitCode = Number(code[1]);
	// Puppeteer frames Chrome's own output between a `stderr:` header
	// and its troubleshooting footer; lift whatever sits in between.
	const stderr = message.match(/stderr:\s*\n([\s\S]*?)\n\s*TROUBLESHOOTING/);
	const captured = stderr?.[1]?.trim();
	if (captured) info.chromeStderr = captured;
	return info;
}

/** Build a human-readable message for a launch that never came up. */
export function formatLaunchFailure(
	info: LaunchFailureInfo,
	attempts: number,
	fallback?: string,
): string {
	const code =
		info.exitCode === undefined ? "" : ` (exit code ${info.exitCode})`;
	const lines = [
		`Chrome could not be launched after ${attempts} attempts${code}.`,
		"This is often transient on macOS when Chrome is auto-updating in " +
			"the background, and retrying in a minute usually clears it. If it " +
			"keeps failing, check that Google Chrome opens normally, or set " +
			"CHROME_PATH to a working binary.",
	];
	if (info.chromeStderr) lines.push("", "Chrome said:", info.chromeStderr);
	// When the failure is not a parseable Chrome exit (an EACCES or
	// ENOSPC from the profile, say), keep the raw reason rather than
	// discarding it behind the generic hint.
	else if (fallback) lines.push("", fallback);
	return lines.join("\n");
}

/** Thrown when Chrome could not be launched after the retry budget. */
export class BrowserLaunchFailed extends Error {
	readonly exitCode?: number;
	readonly chromeStderr?: string;
	constructor(cause: unknown, attempts: number) {
		const info = classifyLaunchError(cause);
		const fallback = cause instanceof Error ? cause.message : String(cause);
		super(formatLaunchFailure(info, attempts, fallback));
		this.name = "BrowserLaunchFailed";
		this.exitCode = info.exitCode;
		this.chromeStderr = info.chromeStderr;
		this.cause = cause;
	}
}
