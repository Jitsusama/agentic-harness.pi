/**
 * Asking the resident language server for the errors in a set of
 * files, within a wall and until the run is stopped, and keeping what
 * each file answered.
 */

import type { FileError } from "../../lib/verification/index.ts";
import type { VerificationState } from "./state.ts";

/** The slice of an LSP backend the checks use. */
export interface DiagnosticsBackend {
	diagnostics: (
		path: string,
		options?: { signal?: AbortSignal },
	) => Promise<readonly unknown[]>;
}

/** What a diagnostics pass found. */
export interface DiagnosticsResult {
	readonly errors: FileError[];
	/** The files the server answered for; the rest were never checked. */
	readonly checked: readonly string[];
	/** True when a file went unchecked, so "no errors" is not "checked clean". */
	readonly failed: boolean;
}

/**
 * The error-severity diagnostics on each file, within `wallMs` and
 * until the run is stopped. A backend may ignore the signal it is
 * handed, so each call is also raced against it.
 */
export async function collectErrors(
	backend: DiagnosticsBackend,
	files: readonly string[],
	run: AbortSignal | undefined,
	wallMs: number,
): Promise<DiagnosticsResult> {
	const outOfTime = new AbortController();
	const clock = setTimeout(() => outOfTime.abort(), wallMs);
	const signal = run
		? AbortSignal.any([outOfTime.signal, run])
		: outOfTime.signal;
	try {
		return await collectWithin(backend, files, signal);
	} finally {
		clearTimeout(clock);
	}
}

/**
 * Keep what each checked file answered: its errors when it has any,
 * and nothing when it came back clean. A file that was not reached
 * keeps what it had.
 */
export function rememberChecked(
	state: VerificationState,
	result: DiagnosticsResult,
): void {
	for (const path of result.checked) {
		const errors = result.errors.filter((e) => e.path === path);
		if (errors.length > 0) state.known.set(path, errors);
		else state.known.delete(path);
	}
}

/** A file error as one line: its position and what is wrong. */
export function describeError(error: FileError): string {
	return `${error.path}:${error.line}:${error.character} ${error.message}`;
}

async function collectWithin(
	backend: DiagnosticsBackend,
	files: readonly string[],
	signal: AbortSignal,
): Promise<DiagnosticsResult> {
	const errors: FileError[] = [];
	const checked: string[] = [];
	let failed = false;
	for (const path of files) {
		if (signal.aborted) {
			// Out of time or stopped: the files left were never checked.
			failed = true;
			break;
		}
		let diagnostics: readonly unknown[];
		try {
			diagnostics = await untilStopped(
				backend.diagnostics(path, { signal }),
				signal,
			);
		} catch {
			// The server errored, ran out of time or was stopped for a
			// file it was expected to serve. Remember that so the caller
			// does not report "clean" for a check that never actually ran.
			failed = true;
			continue;
		}
		checked.push(path);
		for (const raw of diagnostics) {
			const d = raw as {
				severity?: string;
				message?: string;
				range?: { start?: { line?: number; character?: number } };
			};
			if (d.severity !== "error") continue;
			errors.push({
				path,
				line: d.range?.start?.line ?? 1,
				character: d.range?.start?.character ?? 0,
				message: d.message ?? "error",
			});
		}
	}
	return { errors, checked, failed };
}

/** The work's answer, or a rejection as soon as the signal stops it. */
function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const stop = (): void => reject(new Error("stopped"));
		signal.addEventListener("abort", stop, { once: true });
		work.then(resolve, reject).finally(() => {
			signal.removeEventListener("abort", stop);
		});
	});
}
