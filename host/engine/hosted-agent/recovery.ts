/**
 * Carrying on what a restart cut off: durable resumes the run it holds
 * as a run of pi's, once that run has its turn, words said meanwhile
 * queue behind it, a request the stop cut off is asked again, and pi's
 * extensions hear the runs settle once both are over.
 */
import type { RunFailure } from "../durable-types.ts";
import type { AgentMessage, AssistantMessage } from "../pi-types.ts";
import type { MessageQueue, QueuedMessage } from "../queue.ts";
import {
	beganWithPersonsWords,
	type GiveBack,
	type TakeTurn,
} from "../resume-turns.ts";
import type { ToolRound } from "../tool-round.ts";
import type { Admissions } from "./admissions.ts";
import type { DurableBinding, ShowQueued } from "./binding.ts";
import { newestCompaction, type PiCompaction } from "./compaction-head.ts";
import { cutOffAnswer, queuedText } from "./messages.ts";
import type { ActiveRun, Run } from "./run.ts";
import type { HostedAgentState } from "./state.ts";
import type { Transcript } from "./transcript.ts";

/** Durable's reason for a run whose request the host stopped during. */
const INTERRUPTED = "interrupted";

/** What the recovery asks of the agent, each read as it is needed. */
export interface RecoverySide {
	readonly durable: DurableBinding;
	readonly state: HostedAgentState;
	readonly transcript: Transcript;
	readonly followUp: MessageQueue;
	readonly admissions: Admissions;
	/** Tell durable where pi's newest compaction keeps from, so its reads start there. */
	markCompaction(compaction: PiCompaction | undefined): Promise<void>;
	/** Say a fault that leaves the recovery going, such as a marking that failed. */
	report(error: unknown): void;
	/** Aborts once the conversation parks. */
	readonly parking: AbortSignal;
	active(): ActiveRun | undefined;
	parked(): boolean;
	/** Whether words Joel typed have come in since the restart. */
	joelTyped(): boolean;
	pending(): ShowQueued | undefined;
	runWithLifecycle(start: (run: Run) => Promise<void>): Promise<Run>;
	/** Run pi's continue: a run asking the model again on what it holds. */
	continueRun(): Promise<Run>;
	/**
	 * Hold the run of pi's that the agent's own runs open until the answer
	 * is called, which resolves once pi settled it.
	 */
	holdPiRun(): () => Promise<void>;
	startRound(
		run: Run,
		assistant: AssistantMessage,
		options: { recovered?: boolean },
	): ToolRound;
	queue(
		queue: MessageQueue,
		message: AgentMessage,
		mode: "steer" | "followUp",
	): QueuedMessage;
}

/** The conversation's one recovery, and the turn it gives back once answered. */
export class Recovery {
	private readonly side: RecoverySide;
	/**
	 * The recovery, once begun: by the host, or by a prompt that came
	 * first, so each caller shares the one.
	 */
	private recovery: Promise<{ readonly settled: Promise<void> }> | undefined;
	/** Gives back a carried run's turn as the first answer streamed after the restart ends. */
	private answered: GiveBack | undefined;

	constructor(side: RecoverySide) {
		this.side = side;
	}

	/** Whether the recovery has begun. */
	get begun(): boolean {
		return this.recovery !== undefined;
	}

	recover(turn?: TakeTurn): Promise<{ readonly settled: Promise<void> }> {
		this.recovery ??= this.recoverOnce(turn);
		return this.recovery;
	}

	/** Give back the carried run's turn, once its first answer streamed. */
	answer(): void {
		const answered = this.answered;
		this.answered = undefined;
		answered?.();
	}

	private async recoverOnce(
		turn: TakeTurn | undefined,
	): Promise<{ readonly settled: Promise<void> }> {
		const side = this.side;
		// A run begun before the recovery, as by an extension's start, ends
		// first: durable admits nothing new while a turn it holds is cut off.
		for (let active = side.active(); active; active = side.active())
			await active.promise;
		await side.transcript.placeAtSession();
		// Before durable resumes, so the first request it prepares reads only what pi kept.
		// Only a shortcut: one that fails leaves durable reading the whole log, and the conversation still opens.
		await side
			.markCompaction(newestCompaction(side.state.messages))
			.catch((error: unknown) => side.report(error));
		const before = await side.durable.runFailure();
		const waits = turn !== undefined && (await side.durable.carrying());
		let giveBack: GiveBack = () => {};
		let resumed = () => {};
		const started = new Promise<void>((done) => {
			resumed = done;
		});
		// One run of pi's for the carried run and its ask again, as pi's own run settles once its continues are: settled between them, an extension's prompt would race the ask again.
		const release = side.holdPiRun();
		const settled = side.runWithLifecycle(async (run) => {
			if (waits) {
				// Words said meanwhile queue behind this run, as behind any other.
				resumed();
				const began = beganWithPersonsWords(side.state.messages);
				giveBack = await turn(
					() => (side.joelTyped() ? "typing" : began ? "began" : "not"),
					AbortSignal.any([run.controller.signal, side.parking]),
				);
				this.answered = giveBack;
				// Parked while it waited: durable keeps the run for the start that opens it next.
				if (side.parked()) return;
			}
			const cut = cutOffAnswer(side.state.messages);
			if (cut) side.startRound(run, cut, { recovered: true });
			side.durable.resume();
			resumed();
		});
		// Chained before the race, so a run that fails before it starts still lets pi's run go.
		const over = settled
			.then(async () => {
				await this.askAgainIfCutOff(before);
				await release();
			})
			.finally(async () => {
				await release();
				this.answered = undefined;
				giveBack();
			});
		try {
			await Promise.race([started, settled]);
		} catch (error) {
			over.catch(() => {
				// The same failure, thrown to this recovery's caller just below.
			});
			throw error;
		}
		return { settled: over };
	}

	/**
	 * Ask the model again when the run the recovery carried on ended because
	 * the host stopped during its request. Durable retries such a request
	 * only under its own retry, which stays off since pi owns model retries,
	 * so the turn would otherwise sit unanswered until a new word arrived,
	 * as one did for four minutes on 14 November. A failure from before this
	 * recovery is left alone, and so is `restart_limit`, durable's own end to
	 * a request cut off again and again. Answers the run it asked in, if it
	 * asked.
	 */
	private async askAgainIfCutOff(
		before: RunFailure | undefined,
	): Promise<Run | undefined> {
		const side = this.side;
		if (side.parked() || side.active()) return undefined;
		const failure = await side.durable.runFailure();
		if (failure?.reason !== INTERRUPTED || failure.taskId === before?.taskId)
			return undefined;
		if (side.parked() || side.active()) return undefined;
		return side.continueRun();
	}

	/**
	 * Queue words behind the turn the recovery carries on, as pi queues a
	 * prompt while it is busy, so durable holds them through another restart
	 * rather than only an unresolved prompt. True once the run that answers
	 * them ended, as pi's agent resolves a prompt: pi's session continues
	 * the agent once it does. False, with the recovery's run ended, when
	 * durable carried nothing on.
	 */
	async followCarriedOn(messages: readonly AgentMessage[]): Promise<boolean> {
		const side = this.side;
		const recovering = side.active();
		if (!recovering) return false;
		// Ready settles just as the run begins admitting what pi queues.
		await recovering.run.ready;
		if (recovering.run.admitting) {
			const items = messages.map((message) =>
				side.queue(side.followUp, message, "followUp"),
			);
			// Shown at once, as pi shows its own queued words: pi takes each off
			// as its message starts, whether durable answers it after the turn
			// or refused it and it runs as a prompt below.
			for (const message of messages) {
				const text = queuedText(message);
				if (text) side.pending()?.(text, "followUp");
			}
			await side.admissions.settled();
			if (items[0]?.submissionId !== undefined) {
				for (let active = side.active(); active; active = side.active())
					await active.promise;
				return true;
			}
			// An idle conversation refused them: nothing carried on, so they run as a prompt.
			for (const item of items) side.followUp.take(item.hostId);
		}
		for (let active = side.active(); active; active = side.active())
			await active.promise;
		return false;
	}
}
