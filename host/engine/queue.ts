/**
 * The agent's steering and follow-up queues, as pi keeps them, each
 * message also admitted to durable while a run is going so a restart keeps
 * it. pi's queue stays the truth for what peek and clear see; durable's
 * copy is withdrawn when the run ends, so an idle conversation's durable
 * inbox never runs a message ahead of the next prompt.
 */
import type { AgentMessage, QueueMode } from "./pi-types.ts";

/** One queued message and, while durable holds a copy, that submission. */
export interface QueuedMessage {
	readonly hostId: string;
	readonly message: AgentMessage;
	submissionId?: number;
}

/** A queue that drains as pi's PendingMessageQueue does. */
export class MessageQueue {
	private items: QueuedMessage[] = [];

	mode: QueueMode;

	constructor(mode: QueueMode) {
		this.mode = mode;
	}

	enqueue(item: QueuedMessage): void {
		this.items.push(item);
	}

	hasItems(): boolean {
		return this.items.length > 0;
	}

	all(): readonly QueuedMessage[] {
		return this.items;
	}

	/** What the next drain takes, without taking it. */
	peek(): QueuedMessage[] {
		if (this.mode === "all") return this.items.slice();
		const first = this.items[0];
		return first ? [first] : [];
	}

	drain(): QueuedMessage[] {
		const drained = this.peek();
		this.items = this.items.slice(drained.length);
		return drained;
	}

	/** Take the message durable placed, by its id. */
	take(hostId: string): QueuedMessage | undefined {
		const index = this.items.findIndex((item) => item.hostId === hostId);
		if (index < 0) return undefined;
		const [taken] = this.items.splice(index, 1);
		return taken;
	}

	clear(): QueuedMessage[] {
		const cleared = this.items;
		this.items = [];
		return cleared;
	}
}
