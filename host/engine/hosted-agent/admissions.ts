/**
 * What the agent gives durable. Whoever watches for the next words pi
 * gives hears once durable holds those words, committed in a prompt or
 * taken as queued, and not before: an open waited on whichever prompt
 * came next, and words queued behind a run under way, which commit none,
 * left it waiting for good. Each word pi queues while a run admits them is
 * given to durable in turn as a steer or a follow-up, left in pi's queue
 * when an idle conversation refuses it, and withdrawn from durable once
 * pi drops it or the run ends.
 */
import type { AgentMessage } from "../pi-types.ts";
import type { MessageQueue, QueuedMessage } from "../queue.ts";
import type { DurableBinding } from "./binding.ts";
import { userContent } from "./messages.ts";
import { INPUT_KINDS, type InputData } from "./run.ts";

/** What a watch settles as when durable holds its words. */
const HELD = "held";

/** Someone waiting until durable holds the next words pi gives, and those words once given. */
interface Watch {
	words?: readonly AgentMessage[];
	readonly resolve: () => void;
	readonly reject: (error: unknown) => void;
}

/** Gives durable what pi prompts and queues, one after another, and takes it back. */
export class Admissions {
	private readonly durable: DurableBinding;
	private readonly steering: MessageQueue;
	private readonly followUp: MessageQueue;
	private admissions: Promise<unknown> = Promise.resolve();
	private watches: Watch[] = [];

	constructor(
		durable: DurableBinding,
		steering: MessageQueue,
		followUp: MessageQueue,
	) {
		this.durable = durable;
		this.steering = steering;
		this.followUp = followUp;
	}

	/**
	 * Settles once durable holds the next words pi gives, or rejects as the
	 * prompt carrying them fails or pi drops them before durable held them.
	 */
	whenNextHeld(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.watches.push({ resolve, reject });
		});
	}

	/** pi gave the agent `words`, which every watch not yet given any watches for. */
	given(words: readonly AgentMessage[]): void {
		for (const watch of this.watches) watch.words ??= words;
	}

	/** Durable committed `prompts` as a prompt, or refused them with `error`. */
	committed(prompts: readonly AgentMessage[], error?: unknown): void {
		this.settle(prompts, error === undefined ? HELD : { error });
	}

	/** Settle every watch for any of `words`, as `outcome` says. */
	private settle(
		words: readonly AgentMessage[],
		outcome: typeof HELD | { readonly error: unknown },
	): void {
		const settling = this.watches.filter((watch) =>
			watch.words?.some((message) => words.includes(message)),
		);
		this.watches = this.watches.filter((watch) => !settling.includes(watch));
		for (const watch of settling) {
			if (outcome === HELD) watch.resolve();
			else watch.reject(outcome.error);
		}
	}

	/** Settles once every admission begun so far has. */
	settled(): Promise<unknown> {
		return this.admissions;
	}

	admitQueued(item: QueuedMessage, mode: "steer" | "followUp"): void {
		const data: InputData = { hostId: item.hostId, messages: [item.message] };
		const { conversation, context } = this.durable;
		this.admissions = this.admissions.then(async () => {
			try {
				const submission = await conversation.submit(
					{
						type: "input",
						content: userContent([item.message]),
						whenBusy: mode,
						whenIdle: "reject",
						entry: {
							kind: mode === "steer" ? INPUT_KINDS.steer : INPUT_KINDS.followUp,
							data,
						},
					},
					context,
				);
				item.submissionId = submission.id;
				this.settle([item.message], HELD);
			} catch {
				// An idle conversation refuses it: it stays in pi's queue for the next prompt or continue, as in pi.
			}
		});
	}

	/** Durable copies of what pi still queues, admitted once the run's own input is in. */
	readmitQueued(): void {
		for (const item of this.steering.all()) {
			if (item.submissionId === undefined) this.admitQueued(item, "steer");
		}
		for (const item of this.followUp.all()) {
			if (item.submissionId === undefined) this.admitQueued(item, "followUp");
		}
	}

	async withdrawQueued(): Promise<void> {
		await this.admissions;
		const held = [...this.steering.all(), ...this.followUp.all()];
		await Promise.all(held.map((item) => this.withdrawOne(item)));
	}

	/** pi dropped `items`: durable gives up its copies, and words watched for that it never held won't be. */
	withdraw(items: readonly QueuedMessage[]): void {
		for (const item of items) void this.withdrawOne(item);
		this.settle(
			items.map((item) => item.message),
			{ error: new Error("pi dropped the words before durable held them") },
		);
	}

	private async withdrawOne(item: QueuedMessage): Promise<void> {
		const id = item.submissionId;
		if (id === undefined) return;
		item.submissionId = undefined;
		await this.durable.abortSubmission(id).catch(() => "settled");
	}
}
