/**
 * What every E check on the host's pi shares: the pi found or the case
 * skipped, a failure that says what the host wrote, a conversation's
 * session file read as it grows, and a poll for what a process answers,
 * spaced so each ask doesn't spawn a program every few milliseconds,
 * and a steer written into a conversation's inbox as the launcher does.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import { isRecord } from "../../../../lib/internal/record.ts";
import { inboxOf } from "../../../../lib/mesh/steer.ts";
import { until } from "../../../support/until.ts";
import { hostPiFor } from "./host-pi.ts";
import type { Seal } from "./seal.ts";

/** A round trip: two conversations loading the whole harness, four turns. */
export const ROUND_TRIP_MS = 90_000;

/** How long to leave between asks of a program. */
const ASK_EVERY_MS = 250;

/**
 * Run a case on the host's pi, skipped or failed as host-pi.ts says
 * where there is none, saying what `said` gives when it fails: what the
 * host, and any node, wrote.
 */
export async function onHostPi(
	skip: (note: string) => never,
	said: () => string,
	work: (pi: string) => Promise<void>,
): Promise<void> {
	const pi = hostPiFor(skip);
	try {
		await work(pi);
	} catch (error) {
		throw new Error(`${String(error)}\n${said()}`);
	}
}

/** A session file's text, or nothing while it isn't written yet. */
export function textOf(file: string | undefined): string {
	if (!file) return "";
	try {
		return readFileSync(file, "utf8");
	} catch {
		// Not written yet: the poll asks again.
		return "";
	}
}

/**
 * The text of the latest answer `tool` gave in a session file, or
 * nothing before it has answered. Read from the tool's own result, since
 * the file also holds the system prompt, whose tool docs cite examples.
 */
export function toolAnswer(
	file: string | undefined,
	tool: string,
): string | undefined {
	let answer: string | undefined;
	for (const line of textOf(file).split("\n")) {
		const message = entryMessage(line);
		if (message?.role !== "toolResult" || message.toolName !== tool) continue;
		const content = Array.isArray(message.content) ? message.content : [];
		answer = content
			.map((part) =>
				isRecord(part) && typeof part.text === "string" ? part.text : "",
			)
			.join("");
	}
	return answer;
}

/** The message a session file's line records, if it records one. */
function entryMessage(line: string): Record<string, unknown> | undefined {
	try {
		const entry: unknown = JSON.parse(line);
		return isRecord(entry) && isRecord(entry.message)
			? entry.message
			: undefined;
	} catch {
		// A line still being written, or the blank one after the last: none.
		return undefined;
	}
}

/**
 * Steer `text` to the session going by `address` under `seal`, as the
 * launcher does: written under a temporary name, then renamed into the
 * inbox, so the session never reads half a steer.
 */
export async function steerInbox(
	seal: Seal,
	address: string,
	text: string,
): Promise<void> {
	const root = join(
		seal.env.XDG_STATE_HOME ?? "",
		"pi",
		"agentic-harness.pi",
		"steer",
	);
	const inbox = inboxOf(root, address);
	await mkdir(inbox, { recursive: true });
	const name = randomUUID();
	const writing = join(inbox, `${name}.tmp`);
	await writeFile(
		writing,
		JSON.stringify({ text, at: new Date().toISOString(), from: "joel" }),
	);
	await rename(writing, join(inbox, `${name}.json`));
}

/** Wait until `asked` holds, asking at most every quarter second. */
export function untilAnswered(
	what: string,
	asked: () => Promise<boolean>,
	timeoutMs = ROUND_TRIP_MS,
): Promise<void> {
	let first = true;
	return until(
		what,
		async () => {
			if (!first) await pause(ASK_EVERY_MS);
			first = false;
			return asked();
		},
		timeoutMs,
	);
}
