/**
 * A wake its host refused, kept beside the wake file it came through.
 *
 * A sender wakes a parked hosted conversation by writing to its wake
 * file (park.ts's askWake), naming the message that asked. The host
 * removes the file and wakes it, and a wake the host refuses, at its
 * rollout gate or as it stops, was told only to the host's own log: on
 * 11 November H2 found the sender, and anyone writing to it after,
 * heard nothing of why it slept on. So the host keeps the refusal here,
 * for the mesh to say beside the parked peer, and clears it as the
 * conversation next runs.
 */

import { readFileSync, rmSync } from "node:fs";
import { isRecord } from "../record.ts";
import { writeWhole } from "../write-whole.ts";

/** What asked for a wake, why its host refused it, and when. */
export interface RefusedWake {
	/**
	 * The message whose sender wrote the wake, when its file named one. A
	 * second written before the host took the file is folded into the same
	 * wake, so this names the first; both senders see the same reason.
	 */
	readonly messageId?: string;
	readonly reason: string;
	readonly at: string;
}

/** Where a wake file's refusal is kept. */
export function refusedWakePath(wake: string): string {
	return `${wake}.refused`;
}

/** Keep why the wake through `wake` was refused, replacing any before it. */
export function writeRefusedWake(wake: string, refused: RefusedWake): void {
	writeWhole(refusedWakePath(wake), `${JSON.stringify(refused)}\n`);
}

/** The refusal kept for the wake through `wake`, or nothing. */
export function readRefusedWake(wake: string): RefusedWake | undefined {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(refusedWakePath(wake), "utf8"));
	} catch {
		// None kept, or one being replaced, is no refusal to say.
		return undefined;
	}
	if (
		!isRecord(value) ||
		typeof value.reason !== "string" ||
		typeof value.at !== "string"
	)
		return undefined;
	return {
		...(typeof value.messageId === "string"
			? { messageId: value.messageId }
			: {}),
		reason: value.reason,
		at: value.at,
	};
}

/** Clear the refusal kept for the wake through `wake`, once it runs. */
export function clearRefusedWake(wake: string): void {
	rmSync(refusedWakePath(wake), { force: true });
}

/**
 * The message a wake file's content says asked for it, or nothing for
 * a write that names none: anything written wakes, so a bare one is
 * still a wake.
 */
export function wakeAskedBy(written: string): string | undefined {
	let value: unknown;
	try {
		value = JSON.parse(written);
	} catch {
		// Not a sender's record: a wake that names no message.
		return undefined;
	}
	return isRecord(value) && typeof value.messageId === "string"
		? value.messageId
		: undefined;
}
