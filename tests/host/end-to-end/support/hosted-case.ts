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
import { STEERED_RESULTS } from "../../../../extensions/job-workflow/outbox.ts";
import { isRecord } from "../../../../lib/internal/record.ts";
import { inboxOf, type SteerAct } from "../../../../lib/mesh/steer.ts";
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
		// A skip thrown by the work is passed on as it is: vitest still skips
		// one rewrapped, but keeps its reason only from the error it threw.
		if (skipped(error)) throw error;
		throw new Error(`${String(error)}\n${said()}`);
	}
}

/** Whether `error` is what vitest's skip throws. */
function skipped(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && error.code === VITEST_SKIPPED
	);
}

/** The code vitest's skip gives the error it throws. */
const VITEST_SKIPPED = "VITEST_PENDING";

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

/** How many answers the model has given in a session file. */
export function repliesIn(file: string | undefined): number {
	return textOf(file)
		.split("\n")
		.filter((line) => entryMessage(line)?.role === "assistant").length;
}

/**
 * Whether a session file's latest turn has ended: its last message is the
 * model's reply that calls no tool. A log that stops on a tool call or its
 * result is one job-workflow's cut-off reads as killed mid-run, and a host
 * started on it gives the conversation that run again (cut-off.ts).
 */
export function turnEnded(file: string | undefined): boolean {
	const messages = textOf(file)
		.split("\n")
		.map(entryMessage)
		.filter((message) => message !== undefined);
	const last = messages.at(-1);
	return last?.role === "assistant" && last.stopReason !== "toolUse";
}

/**
 * Whether the last thing said in a session file is the model's answer
 * that calls no tool and ended of itself, not on an error a retry may
 * answer again. A job's end said into a run under way is a custom message
 * (job-workflow's steered results), which `turnEnded` passes over, so it
 * is read here too: until the model answers after it, the turn it joined
 * hasn't ended. Other custom messages needn't start a turn, so they're
 * passed over, as a note written after the answer would hold it open.
 */
export function answeredLast(file: string | undefined): boolean {
	const last = entriesOf(file)
		.filter(
			(entry) =>
				entry.type === "message" ||
				(entry.type === "custom_message" &&
					entry.customType === STEERED_RESULTS),
		)
		.at(-1);
	const message = isRecord(last?.message) ? last.message : undefined;
	return message?.role === "assistant" && message.stopReason === "stop";
}

/** Every entry a session file records, each as its parsed record. */
export function entriesOf(file: string | undefined): Record<string, unknown>[] {
	return textOf(file)
		.split("\n")
		.map(entryOf)
		.filter((entry) => entry !== undefined);
}

/** The message a session file's line records, if it records one. */
function entryMessage(line: string): Record<string, unknown> | undefined {
	const entry = entryOf(line);
	return isRecord(entry?.message) ? entry.message : undefined;
}

/** The entry a session file's line records, if it parses as one. */
function entryOf(line: string): Record<string, unknown> | undefined {
	try {
		const entry: unknown = JSON.parse(line);
		return isRecord(entry) ? entry : undefined;
	} catch {
		// A line still being written, or the blank one after the last: none.
		return undefined;
	}
}

/**
 * Steer `text` to the session going by `address` under `seal`, as the
 * launcher does: written under a temporary name, then renamed into the
 * inbox, so the session never reads half a steer. With `act`, it is
 * the launcher's button of that name, as its Stop and Close on a hosted
 * row are (core #2827).
 */
export async function steerInbox(
	seal: Seal,
	address: string,
	text: string,
	act?: SteerAct,
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
		JSON.stringify({
			text,
			...(act ? { act } : {}),
			at: new Date().toISOString(),
			from: "joel",
		}),
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
			// A poll's interval: what is asked about is written by another
			// process, a host, a node or a plain pi, which sends no event here.
			if (!first) await pause(ASK_EVERY_MS);
			first = false;
			return asked();
		},
		timeoutMs,
	);
}
