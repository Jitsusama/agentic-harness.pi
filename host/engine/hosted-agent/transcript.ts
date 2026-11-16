/**
 * Durable's transcript mirrored to pi: every entry durable committed since
 * the newest pi saw, shown in order as pi's loop would have shown it, and
 * where the session file already stands, matched by what a pi message
 * keeps of the entry it came from.
 */
import type { EntryRecord } from "../durable-types.ts";
import type {
	AgentEvent,
	AgentMessage,
	AssistantMessage,
} from "../pi-types.ts";
import type { MessageQueue } from "../queue.ts";
import { type ToolRound, toolCalls } from "../tool-round.ts";
import type { DurableBinding } from "./binding.ts";
import {
	inputData,
	isAssistant,
	isToolResult,
	messageKey,
	newest,
	resultShown,
	unrunText,
} from "./messages.ts";
import type { Run } from "./run.ts";
import type { HostedAgentState } from "./state.ts";

const ENTRY_PAGE = 200;

/** What the transcript shows pi through, and the queues a placed input leaves. */
export interface TranscriptSide {
	readonly durable: DurableBinding;
	readonly state: HostedAgentState;
	readonly steering: MessageQueue;
	readonly followUp: MessageQueue;
	emit(event: AgentEvent): Promise<void>;
	startRound(run: Run, assistant: AssistantMessage): ToolRound;
}

/** Shows pi what durable committed, once and in order. */
export class Transcript {
	private readonly side: TranscriptSide;
	/**
	 * The newest durable entry pi has seen, or holds: found from the session
	 * file the first time it is needed, whether by the recovery or by a run
	 * something began before it, as an extension's start may.
	 */
	private cursor: number | undefined;
	private mirrorLine: Promise<unknown> = Promise.resolve();
	private readonly shownInputs = new Set<string>();

	constructor(side: TranscriptSide) {
		this.side = side;
	}

	/** Start from the newest entry the session file already holds. */
	async placeAtSession(): Promise<void> {
		this.cursor = await this.lastShown();
	}

	/** Mark an input pi was shown as it was admitted, so its entry is not shown again. */
	markShown(hostId: string): void {
		this.shownInputs.add(hostId);
	}

	/** Show pi, in order, every entry durable committed since the last one it saw. */
	mirror(run: Run, options: { showResults: boolean }): Promise<void> {
		const next = this.mirrorLine.then(() => this.mirrorNow(run, options));
		this.mirrorLine = next.catch(() => undefined);
		return next;
	}

	private async mirrorNow(
		run: Run,
		options: { showResults: boolean },
	): Promise<void> {
		for (const entry of await this.unseen()) {
			this.cursor = entry.id;
			await this.mirrorEntry(run, entry);
		}
		if (options.showResults) {
			for (const entry of this.inCallOrder(run, run.heldResults.splice(0)))
				await this.showResult(run, entry);
		}
	}

	/** Results in their calls' order, as pi shows a round's results; durable commits them as they finish. */
	private inCallOrder(run: Run, entries: EntryRecord[]): EntryRecord[] {
		const order = new Map(
			(run.round?.calls ?? []).map((call, index) => [call.id, index]),
		);
		const place = (entry: EntryRecord): number => {
			const [message] = entry.model ?? [];
			const id =
				message && isToolResult(message) ? message.toolCallId : undefined;
			return (id === undefined ? undefined : order.get(id)) ?? order.size;
		};
		return entries
			.map((entry, index) => ({ entry, index }))
			.sort((a, b) => place(a.entry) - place(b.entry) || a.index - b.index)
			.map(({ entry }) => entry);
	}

	private async mirrorEntry(run: Run, entry: EntryRecord): Promise<void> {
		const input = inputData(entry);
		if (input) {
			if (this.shownInputs.has(input.hostId)) return;
			this.side.steering.take(input.hostId);
			this.side.followUp.take(input.hostId);
			run.placed.push(...input.messages);
			return;
		}
		const [message] = entry.model ?? [];
		if (entry.kind === "pi.user" && message) {
			run.placed.push(message);
			return;
		}
		if (entry.kind === "pi.assistant" && message && isAssistant(message)) {
			await this.mirrorAnswer(run, message);
			return;
		}
		if (entry.kind === "pi.tool-result" && message) {
			run.heldResults.push(entry);
		}
	}

	private async mirrorAnswer(
		run: Run,
		committed: AssistantMessage,
	): Promise<void> {
		const answer = run.answer;
		const message = answer?.message ?? committed;
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			// Settled with the run, as pi ends a turn on such an answer.
			run.answer = { ...(answer ?? { started: false }), message };
			return;
		}
		run.answer = undefined;
		if (!answer?.started) {
			await this.side.emit({ type: "message_start", message: { ...message } });
			if (!answer) run.context.messages.push(message);
		}
		await this.side.emit({ type: "message_end", message });
		run.newMessages.push(message);
		if (message.stopReason === "toolUse" && toolCalls(message).length > 0)
			this.side.startRound(run, message);
	}

	/**
	 * Show a result durable committed, as its round made it. One the
	 * session already holds is shown once only; one whose call is in no
	 * round pi has open is shown as durable committed it, so a result left
	 * over from before a restart can never break the round after it.
	 */
	private async showResult(run: Run, entry: EntryRecord): Promise<void> {
		const [committed] = entry.model ?? [];
		if (!committed || !isToolResult(committed)) return;
		if (resultShown(run.context.messages, committed.toolCallId)) return;
		const round = run.round;
		let shown = round?.messages.get(committed.toolCallId);
		const called = round?.calls.some(
			(call) => call.id === committed.toolCallId,
		);
		if (!shown && round && called) {
			await round.settleUnrun(
				committed.toolCallId,
				unrunText(entry, committed),
			);
			shown = round.messages.get(committed.toolCallId);
		}
		await this.show(run, shown ?? committed);
	}

	async show(run: Run, message: AgentMessage): Promise<void> {
		await this.side.emit({ type: "message_start", message });
		await this.side.emit({ type: "message_end", message });
		run.context.messages.push(message);
		run.newMessages.push(message);
	}

	/** Entries newer than the cursor, oldest first. */
	private async unseen(): Promise<EntryRecord[]> {
		const { conversation, context } = this.side.durable;
		this.cursor ??= await this.lastShown();
		const from = this.cursor;
		const found: EntryRecord[] = [];
		let cursor: unknown;
		do {
			const page = await conversation.entries(
				{ minEntryId: from + 1, order: "ascending" },
				ENTRY_PAGE,
				cursor,
				context,
			);
			found.push(...page.items.filter((entry) => entry.id > from));
			cursor = page.next;
		} while (cursor !== undefined);
		return found;
	}

	/**
	 * The newest durable entry the session file already holds, matched by
	 * what a pi message keeps of it: an input's id, a message's role,
	 * timestamp and tool call.
	 */
	async lastShown(): Promise<number> {
		const kept = new Set(this.side.state.messages.map(messageKey));
		const { conversation, context } = this.side.durable;
		let cursor: unknown;
		do {
			const page = await conversation.entries(
				{ order: "descending" },
				ENTRY_PAGE,
				cursor,
				context,
			);
			for (const entry of page.items) {
				const messages =
					inputData(entry)?.messages ??
					(entry.kind === "pi.system" ? [] : (entry.model ?? []));
				if (messages.some((message) => kept.has(messageKey(message))))
					return entry.id;
			}
			cursor = page.next;
		} while (cursor !== undefined);
		return 0;
	}

	/**
	 * The answer durable committed as `entryId`, as the session already
	 * holds it: a restart came after pi showed it, before durable heard
	 * what follows it. On 13 November a helper resumed with its tool's
	 * result shown and the decision cut off, and its turn was refused.
	 */
	async answerShownBefore(
		run: Run,
		entryId: number,
	): Promise<AssistantMessage | undefined> {
		const { conversation, context } = this.side.durable;
		const page = await conversation.entries(
			{ minEntryId: entryId, order: "ascending" },
			1,
			undefined,
			context,
		);
		const [committed] =
			page.items.find((entry) => entry.id === entryId)?.model ?? [];
		if (!committed) return undefined;
		const key = messageKey(committed);
		const shown = newest(
			run.context.messages,
			(message) => messageKey(message) === key,
		);
		return shown && isAssistant(shown) ? shown : undefined;
	}
}
