/**
 * Glances waiting for the model's next turn.
 *
 * A glance is shown on screen the moment it arrives and recorded in the
 * session as it is; it reaches the model with whatever delivery comes
 * next. Every delivery records the ids of the glances it carried, so a
 * session that reloads before its next turn finds the ones still
 * waiting in its own entries, and none is lost or handed over twice.
 */

import type { Said, Turn } from "../../lib/mesh/damping.ts";
import { type Message, messageFrom } from "../../lib/mesh/message.ts";
import { type Delivered, GLANCE, GLANCES, NOTED } from "./delivery.ts";

/** A session entry, as far as glances need to read one. */
export interface Entry {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly details?: unknown;
}

export interface Glances {
	/** Wait for the next delivery. */
	add(message: Message): void;
	/** Everything waiting, which is then no longer waiting. */
	take(): Message[];
	/** Stop waiting on one, as when its sender replaces it. */
	drop(id: string): void;
	/** What was still waiting when these entries were written. */
	recover(entries: readonly Entry[]): void;
}

export function createGlances(): Glances {
	let waiting: Message[] = [];
	return {
		add(message) {
			if (!waiting.some((one) => one.id === message.id)) {
				waiting = [...waiting, message];
			}
		},
		take() {
			const taken = waiting;
			waiting = [];
			return taken;
		},
		drop(id) {
			waiting = waiting.filter((one) => one.id !== id);
		},
		recover(entries) {
			const carried = new Set(entries.flatMap(glancedBy));
			waiting = entries
				.map(glanceIn)
				.filter((one): one is Message => one !== undefined)
				.filter((one) => !carried.has(one.id));
		},
	};
}

/** The glance a screen entry recorded, if it is one. */
function glanceIn(entry: Entry): Message | undefined {
	if (entry.type !== "custom" || entry.customType !== GLANCE) return undefined;
	return messageFrom((entry.data as { message?: unknown } | null)?.message);
}

/**
 * Every message these entries show handed over, in full or as a glance.
 * The read marker never passes one still waiting, so a start can catch
 * up on some it handed over beside it; these it leaves be.
 */
export function handedIn(entries: readonly Entry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		const glanced = glanceIn(entry);
		if (glanced) ids.add(glanced.id);
		if (entry.type !== "custom_message" || entry.customType !== NOTED) {
			continue;
		}
		const messages = (entry.details as Partial<Delivered> | null)?.messages;
		for (const one of Array.isArray(messages) ? messages : []) {
			const message = messageFrom(one);
			if (message) ids.add(message.id);
		}
	}
	return ids;
}

/**
 * What deliveries in these entries counted against the peer's limits:
 * the turns they started, and the messages they handed over in full.
 */
export function countedIn(entries: readonly Entry[]): {
	turns: Turn[];
	said: Said[];
} {
	const turns: Turn[] = [];
	const said: Said[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== NOTED) {
			continue;
		}
		const details = entry.details as Partial<Delivered> | null;
		if (typeof details?.at !== "number") continue;
		const messages = (Array.isArray(details.messages) ? details.messages : [])
			.map(messageFrom)
			.filter((one): one is Message => one !== undefined);
		if (details.turn === true) {
			turns.push({ at: details.at, from: messages.map((one) => one.from) });
		}
		for (const one of messages) {
			said.push({ at: details.at, from: one.from, text: one.text, id: one.id });
		}
	}
	return { turns, said };
}

/** The ids of the glances a delivery carried, if it is one. */
function glancedBy(entry: Entry): string[] {
	if (entry.type !== "custom_message") return [];
	if (entry.customType !== NOTED && entry.customType !== GLANCES) return [];
	const glanced = (entry.details as Partial<Delivered> | null)?.glanced;
	return Array.isArray(glanced)
		? glanced.filter((id) => typeof id === "string")
		: [];
}
