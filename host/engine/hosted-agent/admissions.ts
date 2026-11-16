/**
 * What the agent gives durable. Whoever waits on the next prompt hears
 * once durable admits it. Each word pi queues while a run admits them is
 * given to durable in turn as a steer or a follow-up, left in pi's queue
 * when an idle conversation refuses it, and withdrawn from durable once
 * pi drops it or the run ends.
 */
import type { MessageQueue, QueuedMessage } from "../queue.ts";
import type { DurableBinding } from "./binding.ts";
import { userContent } from "./messages.ts";
import { INPUT_KINDS, type InputData } from "./run.ts";

/** Gives durable what pi prompts and queues, one after another, and takes it back. */
export class Admissions {
	private readonly durable: DurableBinding;
	private readonly steering: MessageQueue;
	private readonly followUp: MessageQueue;
	private admissions: Promise<unknown> = Promise.resolve();
	private readonly admissionWaiters: {
		resolve: () => void;
		reject: (error: unknown) => void;
	}[] = [];

	constructor(
		durable: DurableBinding,
		steering: MessageQueue,
		followUp: MessageQueue,
	) {
		this.durable = durable;
		this.steering = steering;
		this.followUp = followUp;
	}

	/** Settles once the next prompt is committed to durable, or rejects with why it was not. */
	whenAdmitted(): Promise<void> {
		return new Promise((resolve, reject) => {
			this.admissionWaiters.push({ resolve, reject });
		});
	}

	/** Tell whoever waits that the prompt was admitted, or why not. */
	settleAdmission(error?: unknown): void {
		for (const waiter of this.admissionWaiters.splice(0)) {
			if (error === undefined) waiter.resolve();
			else waiter.reject(error);
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

	withdraw(items: readonly QueuedMessage[]): void {
		for (const item of items) void this.withdrawOne(item);
	}

	private async withdrawOne(item: QueuedMessage): Promise<void> {
		const id = item.submissionId;
		if (id === undefined) return;
		item.submissionId = undefined;
		await this.durable.abortSubmission(id).catch(() => "settled");
	}
}
