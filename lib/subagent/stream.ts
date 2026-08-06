import {
	assistantMessage,
	isFinishedMessage,
	textOf,
	usageOf,
} from "./runpi/assistant.mjs";
import type {
	ReviewerUsage,
	ReviewerVerification,
	RunPiStreamEvent,
} from "./subagent.js";

/** Limits that keep reviewer stream parsing bounded in memory. */
export interface ReviewerStreamLimits {
	readonly maxLineBytes: number;
	readonly maxAssistantTextBytes: number;
	readonly maxWarnings: number;
}

/** Result extracted from a pi JSON stream. */
export interface ReviewerStreamResult {
	readonly finalAssistantText: string;
	readonly usage?: ReviewerUsage;
	readonly warnings: readonly string[];
	readonly truncated: boolean;
	readonly verification?: ReviewerVerification;
}

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_ASSISTANT_TEXT_BYTES = 512 * 1024;
const DEFAULT_MAX_WARNINGS = 20;
const WARNING_PREVIEW_CHARS = 80;
const MAX_PENDING_VERIFY_CALLS = 8;

/**
 * Incrementally parses a reviewer pi JSON stream without
 * retaining the full stdout buffer.
 */
export class ReviewerStreamParser {
	private readonly limits: ReviewerStreamLimits;
	private buffer = "";
	private discardingOversizedLine = false;
	private finishedText = "";
	private pendingText = "";
	private pendingUsage: ReviewerUsage | undefined;
	private usage: ReviewerUsage | undefined;
	private readonly warnings: string[] = [];
	private truncated = false;
	private verification: ReviewerVerification | undefined;
	private verifyAttempts = 0;
	private readonly pendingVerifyCalls = new Map<
		string,
		Record<string, unknown>
	>();
	private lastUnkeyedVerifyArgs: Record<string, unknown> | undefined;

	constructor(limits: Partial<ReviewerStreamLimits> = {}) {
		this.limits = {
			maxLineBytes: limits.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
			maxAssistantTextBytes:
				limits.maxAssistantTextBytes ?? DEFAULT_MAX_ASSISTANT_TEXT_BYTES,
			maxWarnings: limits.maxWarnings ?? DEFAULT_MAX_WARNINGS,
		};
	}

	/** Ingest a chunk and return complete parsed JSON events. */
	ingestChunk(chunk: Buffer | string): RunPiStreamEvent[] {
		this.buffer += chunk.toString();
		const events: RunPiStreamEvent[] = [];
		while (true) {
			const newlineIndex = this.buffer.indexOf("\n");
			if (newlineIndex < 0) {
				this.checkBufferedLineSize();
				break;
			}
			const line = this.buffer.slice(0, newlineIndex);
			this.buffer = this.buffer.slice(newlineIndex + 1);
			const event = this.ingestLine(line);
			if (event !== null) events.push(event);
		}
		return events;
	}

	/** Finish the stream, parsing any unterminated trailing line. */
	finish(): ReviewerStreamResult {
		if (this.buffer.length > 0 && !this.discardingOversizedLine) {
			this.ingestLine(this.buffer);
		}
		this.buffer = "";
		this.discardingOversizedLine = false;
		// The turn in flight when the run ended never reported its own
		// total, so its running one is the only account of it there is.
		const spent =
			this.pendingUsage === undefined
				? this.usage
				: addUsage(this.usage, this.pendingUsage);
		return {
			finalAssistantText: this.saidSoFar(),
			...(spent ? { usage: spent } : {}),
			warnings: [...this.warnings],
			truncated: this.truncated,
			...(this.verification ? { verification: this.verification } : {}),
		};
	}

	private checkBufferedLineSize(): void {
		if (
			!this.discardingOversizedLine &&
			Buffer.byteLength(this.buffer) > this.limits.maxLineBytes
		) {
			this.warn(
				`Reviewer stream line exceeded ${this.limits.maxLineBytes} bytes; skipped`,
			);
			this.buffer = "";
			this.discardingOversizedLine = true;
		}
	}

	private ingestLine(line: string): RunPiStreamEvent | null {
		if (this.discardingOversizedLine) {
			this.discardingOversizedLine = false;
			return null;
		}
		const trimmed = line.trim();
		if (!trimmed) return null;
		if (Buffer.byteLength(trimmed) > this.limits.maxLineBytes) {
			this.warn(
				`Reviewer stream line exceeded ${this.limits.maxLineBytes} bytes; skipped`,
			);
			return null;
		}
		let event: unknown;
		try {
			event = JSON.parse(trimmed);
		} catch {
			this.warn(
				`Malformed JSON event line: ${truncate(trimmed, WARNING_PREVIEW_CHARS)}`,
			);
			return null;
		}
		if (typeof event !== "object" || event === null) return null;
		this.captureAssistantMessage(event);
		this.captureVerification(event);
		return event as RunPiStreamEvent;
	}

	private captureAssistantMessage(event: unknown): void {
		const message = assistantMessage(event);
		if (message === null) return;
		const text = textOf(message);
		const usage = usageOf(message);

		// A turn's usage is a running total, not an increment, so a
		// partial's is held rather than added: held it can be replaced by
		// the next update and counted once at the end, where adding it
		// would bill the turn once per update. Skipping partials outright
		// is the opposite mistake and bills a stopped reviewer's longest
		// turn at nothing, which deletes the number that made this whole
		// class of failure visible.
		if (!isFinishedMessage(event)) {
			if (text !== null) this.pendingText = this.truncateAssistantText(text);
			if (usage !== undefined) this.pendingUsage = usage;
			return;
		}

		if (text !== null) {
			this.finishedText = this.truncateAssistantText(text);
		}
		// The turn ended, so whatever it was running up is now final and
		// arrives on the message itself.
		this.pendingText = "";
		this.pendingUsage = undefined;
		if (usage !== undefined) this.usage = addUsage(this.usage, usage);
	}

	/**
	 * Everything the assistant had said, in the order it said it.
	 *
	 * A run cut off mid-message has both a last finished message and an
	 * unfinished one, and which of them holds the answer cannot be
	 * decided here. A reviewer that answered and was then cut off
	 * revising has its answer in the finished one; a reviewer cut off
	 * writing its first answer has it in the fragment. Handing over
	 * both lets the reader find it either way, where picking one throws
	 * away a whole answer in the case it picked wrong.
	 */
	private saidSoFar(): string {
		if (this.pendingText === "") return this.finishedText;
		if (this.finishedText === "") return this.pendingText;
		return `${this.finishedText}\n\n${this.pendingText}`;
	}

	private captureVerification(event: unknown): void {
		if (typeof event !== "object" || event === null) return;
		const e = event as Record<string, unknown>;
		if (e.toolName !== "verify_output") return;
		const callId = typeof e.toolCallId === "string" ? e.toolCallId : "";
		if (e.type === "tool_execution_start") {
			const args = objectValue(e.args);
			if (callId && args) {
				this.pendingVerifyCalls.set(callId, args);
				this.trimPendingVerifyCalls();
			} else {
				this.lastUnkeyedVerifyArgs = args;
			}
			return;
		}
		if (e.type !== "tool_execution_end") return;
		this.verifyAttempts += 1;
		const args =
			(callId ? this.pendingVerifyCalls.get(callId) : undefined) ??
			objectValue(e.args) ??
			this.lastUnkeyedVerifyArgs ??
			{};
		if (callId) this.pendingVerifyCalls.delete(callId);
		else this.lastUnkeyedVerifyArgs = undefined;
		const result = objectValue(e.result) ?? {};
		const details = objectValue(result.details) ?? {};
		const ok = details.ok === true;
		// Per-stage verify extensions emit `stage` on
		// `details`; older `args.stage` is honoured as a
		// fallback for any callers still on the single-tool
		// shape.
		const stage =
			typeof details.stage === "string"
				? details.stage
				: typeof args.stage === "string"
					? args.stage
					: undefined;
		this.verification = {
			called: true,
			ok,
			attempts: this.verifyAttempts,
			...(stage !== undefined ? { stage } : {}),
			...(typeof details.count === "number" ? { count: details.count } : {}),
			...(Array.isArray(details.warnings)
				? { warnings: details.warnings.filter(isString) }
				: {}),
			...(verifierMessage(result) ? { message: verifierMessage(result) } : {}),
			...(ok && "output" in args
				? { output: normalizedVerifierOutput(args.output) }
				: {}),
		};
	}

	private trimPendingVerifyCalls(): void {
		while (this.pendingVerifyCalls.size > MAX_PENDING_VERIFY_CALLS) {
			const oldest = this.pendingVerifyCalls.keys().next().value;
			if (oldest === undefined) return;
			this.pendingVerifyCalls.delete(oldest);
		}
	}

	private truncateAssistantText(text: string): string {
		const cap = this.limits.maxAssistantTextBytes;
		// This runs on every delta now that a message is read while it is
		// still being written, so the common case has to cost nothing. A
		// character is at most four bytes, so anything this short is
		// certainly within the cap and needs no measuring.
		if (text.length * 4 <= cap) return text;
		if (Buffer.byteLength(text) <= cap) return text;
		this.truncated = true;
		this.warn(`Reviewer assistant text exceeded ${cap} bytes; truncated`);
		return cutToBytes(text, cap);
	}

	private warn(message: string): void {
		if (this.warnings.length < this.limits.maxWarnings) {
			this.warnings.push(message);
		}
	}
}

/** Return the latest assistant usage block from a pi JSON stream. */
export function extractUsageFromPiStream(
	stdout: string,
): ReviewerUsage | undefined {
	const parser = new ReviewerStreamParser({ maxWarnings: 0 });
	parser.ingestChunk(stdout);
	return parser.finish().usage;
}

/**
 * The longest prefix of a string that fits in a byte budget.
 *
 * Cut in the bytes and stepped back off a continuation byte, so a
 * multi-byte character is never split in half. The obvious version
 * shortens by one character and re-measures the whole string, which is
 * quadratic in the length and was reached once per delta.
 */
function cutToBytes(text: string, maxBytes: number): string {
	const held = Buffer.from(text, "utf8");
	if (held.length <= maxBytes) return text;
	let end = maxBytes;
	while (end > 0 && ((held[end] ?? 0) & 0xc0) === 0x80) end--;
	return held.subarray(0, end).toString("utf8");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: undefined;
}

function verifierMessage(result: Record<string, unknown>): string {
	const content = Array.isArray(result.content) ? result.content : [];
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue;
		const text = (part as Record<string, unknown>).text;
		if (typeof text === "string") return text;
	}
	return "";
}

function normalizedVerifierOutput(output: unknown): unknown {
	if (typeof output !== "string") return output;
	try {
		return JSON.parse(output);
	} catch {
		// Keep the original verifier argument when it is not JSON.
		return output;
	}
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

// What an assistant message is, what it said and what it cost are
// read by the shared module in runpi, because the supervisor script
// reads the same stream and cannot import TypeScript. These were two
// implementations, line for line the same, and the two callers are the
// live path and the recovery path: a disagreement means a round read
// one way while it ran and another way when it was collected, with
// nothing to notice, since each side agrees with itself.

/**
 * Add one turn's usage onto the running total. A subagent
 * emits one `message_end` per turn, each carrying that
 * turn's own usage, so the run total is their sum. Keying
 * on `message_end` means each turn is counted once, so
 * summation cannot double-count.
 */
function addUsage(
	total: ReviewerUsage | undefined,
	turn: ReviewerUsage,
): ReviewerUsage {
	if (total === undefined) return turn;
	return {
		tokens: {
			input: total.tokens.input + turn.tokens.input,
			output: total.tokens.output + turn.tokens.output,
			cacheRead: total.tokens.cacheRead + turn.tokens.cacheRead,
			cacheWrite: total.tokens.cacheWrite + turn.tokens.cacheWrite,
			total: total.tokens.total + turn.tokens.total,
		},
		cost: {
			input: total.cost.input + turn.cost.input,
			output: total.cost.output + turn.cost.output,
			cacheRead: total.cost.cacheRead + turn.cost.cacheRead,
			cacheWrite: total.cost.cacheWrite + turn.cost.cacheWrite,
			total: total.cost.total + turn.cost.total,
		},
	};
}

function truncate(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}...`;
}
