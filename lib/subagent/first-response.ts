/**
 * When a supervised run's first response has begun.
 *
 * A round's reviewers share a brief, and the cache can only give a
 * reviewer what another has already written. Anthropic makes an entry
 * readable once the response that wrote it begins, and four reviewers
 * started together all ask before any of them has one: measured, every
 * one of them wrote the brief and read none of it. So a round starts one
 * reviewer, waits for this, and then starts the rest.
 *
 * Read from the run's event log rather than from the runner's own
 * events, because the waiting runner forwards only what the supervisor
 * summarises and the detached one forwards nothing at all. The log is
 * pi's own stream, written as it arrives, and pi announces the
 * assistant's message the moment the provider starts answering.
 */

import { open } from "node:fs/promises";
import { isRecord } from "../internal/record.ts";

/** How often the log is read while waiting. */
const READ_EVERY_MS = 250;

/** What waiting was told. */
export interface FirstResponseWait {
	/** Stop waiting after this long, whatever the log says. */
	withinMs: number;
	/** Stop waiting when this aborts. */
	signal?: AbortSignal;
}

/**
 * Wait until the log at this path shows the run's first response
 * begun, answering whether it did.
 *
 * False when the time ran out or the wait was abandoned: whoever is
 * waiting goes ahead either way, since a reviewer started without the
 * cache costs what every reviewer cost before, and one never started
 * costs the round. A log that does not exist yet is a run that has not
 * got that far, not an error.
 */
export async function firstResponseBegun(
	path: string,
	wait: FirstResponseWait,
): Promise<boolean> {
	const reader = new LogReader(path);
	const deadline = Date.now() + wait.withinMs;
	while (wait.signal?.aborted !== true) {
		if (await reader.sawResponse()) return true;
		const left = deadline - Date.now();
		if (left <= 0) return false;
		await pause(Math.min(READ_EVERY_MS, left), wait.signal);
	}
	return false;
}

/** A log read from where it was last read to. */
class LogReader {
	private readonly path: string;
	private offset = 0;
	private partial = "";

	constructor(path: string) {
		this.path = path;
	}

	/** Whether anything appended since the last read begins a response. */
	async sawResponse(): Promise<boolean> {
		for (const line of await this.newLines()) {
			if (beginsResponse(line)) return true;
		}
		return false;
	}

	private async newLines(): Promise<string[]> {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(this.path, "r");
		} catch {
			// Not written yet: the supervisor creates it when the child
			// first says anything, which is after the wait began.
			return [];
		}
		try {
			const { size } = await handle.stat();
			if (size < this.offset) {
				// Rotated away under us: what is there now is all new.
				this.offset = 0;
				this.partial = "";
			}
			if (size === this.offset) return [];
			const buffer = Buffer.alloc(size - this.offset);
			const { bytesRead } = await handle.read(
				buffer,
				0,
				buffer.length,
				this.offset,
			);
			this.offset += bytesRead;
			const lines =
				`${this.partial}${buffer.toString("utf8", 0, bytesRead)}`.split("\n");
			this.partial = lines.pop() ?? "";
			return lines;
		} finally {
			await handle.close();
		}
	}
}

/** Whether one line of pi's stream is the assistant starting to answer. */
function beginsResponse(line: string): boolean {
	// Most lines are not, and some are the whole brief, so the cheap test
	// comes before the parse.
	if (!line.includes('"message_start"')) return false;
	try {
		const event: unknown = JSON.parse(line);
		return (
			isRecord(event) &&
			event.type === "message_start" &&
			isRecord(event.message) &&
			event.message.role === "assistant"
		);
	} catch {
		// A torn or foreign line is not a response starting.
		return false;
	}
}

/** Wait a while, or until the signal aborts. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
	});
}
