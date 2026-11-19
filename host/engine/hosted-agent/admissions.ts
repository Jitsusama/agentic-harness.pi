/**
 * What the agent gives durable. Whoever watches for words pi gives hears
 * once durable holds them, committed in a prompt or taken as queued, and
 * not before: an open waited on whichever prompt came next, and words
 * queued behind a run under way, which commit none, left it waiting for
 * good. A watch takes the words pi gives next or gave last, as pi's
 * answer says, so another sender's words never answer for them. Each word
 * pi queues while a run admits them is given to durable in turn as a steer
 * or a follow-up, left in pi's queue when an idle conversation refuses it,
 * and withdrawn from durable once pi drops it or the run ends.
 */
import type { AgentMessage } from "../pi-types.ts";
import type { MessageQueue, QueuedMessage } from "../queue.ts";
import type { DurableBinding } from "./binding.ts";
import { userContent } from "./messages.ts";
import { INPUT_KINDS, type InputData } from "./run.ts";

/** What a watch settles as when durable holds its words. */
const HELD = "held";

/** How durable took some words: held, or refused with an error. */
type Outcome = typeof HELD | { readonly error: unknown };

/** Someone waiting until durable holds the words it watches, and those words once chosen. */
interface Watch {
	words?: readonly AgentMessage[];
	/** Takes the next words pi gives. */
	awaiting: boolean;
	resolve: () => void;
	reject: (error: unknown) => void;
}

/** A watch for words pi is about to give or just gave, told which as pi answers. */
export interface WordsWatch {
	/** Settles once durable holds the words, or rejects as it refuses them, pi drops them or the watcher stops. */
	readonly held: Promise<void>;
	/**
	 * pi said what it did with the words, as its prompt's preflight does. A
	 * run it started is given its words next, with no await between; words
	 * it queued it gave just before, though a microtask passes before it
	 * says so, and another sender's words given in that tick would be taken
	 * for these. Words it handled reach no agent, so are watched no more.
	 */
	told(disposition: Disposition): void;
}

/** What pi's prompt says it did with words before it answers. */
export type Disposition = "handled" | "queued" | "started";

/** Gives durable what pi prompts and queues, one after another, and takes it back. */
export class Admissions {
	private readonly durable: DurableBinding;
	private readonly steering: MessageQueue;
	private readonly followUp: MessageQueue;
	private admissions: Promise<unknown> = Promise.resolve();
	private watches: Watch[] = [];
	private lastGiven: readonly AgentMessage[] = [];
	/** How durable took each message, since it may take queued words before pi says it queued them. */
	private readonly outcomes = new WeakMap<AgentMessage, Outcome>();

	constructor(
		durable: DurableBinding,
		steering: MessageQueue,
		followUp: MessageQueue,
	) {
		this.durable = durable;
		this.steering = steering;
		this.followUp = followUp;
	}

	/** Watch for words pi gives, until `signal` says the watcher stopped. */
	watch(signal?: AbortSignal): WordsWatch {
		const watch: Watch = {
			awaiting: false,
			resolve: () => {},
			reject: () => {},
		};
		const held = new Promise<void>((resolve, reject) => {
			watch.resolve = resolve;
			watch.reject = reject;
		});
		this.watches.push(watch);
		const stop = () =>
			this.finish(watch, { error: new Error("the watcher stopped") });
		if (signal?.aborted) stop();
		else signal?.addEventListener("abort", stop, { once: true });
		return {
			held,
			told: (disposition) => {
				if (disposition === "started") watch.awaiting = true;
				else if (disposition === "queued") this.choose(watch, this.lastGiven);
				else stop();
			},
		};
	}

	/** pi gave the agent `words`, which a watch awaiting the next words watches. */
	given(words: readonly AgentMessage[]): void {
		this.lastGiven = words;
		for (const watch of [...this.watches]) {
			if (watch.awaiting) this.choose(watch, words);
		}
	}

	/** `watch` watches `words`, settled at once where durable already took them. */
	private choose(watch: Watch, words: readonly AgentMessage[]): void {
		watch.awaiting = false;
		if (watch.words !== undefined) return;
		watch.words = words;
		const taken = words
			.map((message) => this.outcomes.get(message))
			.find((outcome) => outcome !== undefined);
		if (taken !== undefined) this.finish(watch, taken);
	}

	/** Settle `watch` as `outcome` says, and watch for nothing more. */
	private finish(watch: Watch, outcome: Outcome): void {
		if (!this.watches.includes(watch)) return;
		this.watches = this.watches.filter((other) => other !== watch);
		if (outcome === HELD) watch.resolve();
		else watch.reject(outcome.error);
	}

	/** Durable committed `prompts` as a prompt, or refused them with `error`. */
	committed(prompts: readonly AgentMessage[], error?: unknown): void {
		this.settle(prompts, error === undefined ? HELD : { error });
	}

	/** Settle every watch for any of `words`, as `outcome` says. */
	private settle(words: readonly AgentMessage[], outcome: Outcome): void {
		for (const message of words) this.outcomes.set(message, outcome);
		const settling = this.watches.filter((watch) =>
			watch.words?.some((message) => words.includes(message)),
		);
		for (const watch of settling) this.finish(watch, outcome);
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
