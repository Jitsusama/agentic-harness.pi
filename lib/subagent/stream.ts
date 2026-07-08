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
	private finalAssistantText = "";
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
		return {
			finalAssistantText: this.finalAssistantText,
			...(this.usage ? { usage: this.usage } : {}),
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
		const message = readAssistantMessage(event);
		if (message === null) return;
		const text = readTextContent(message);
		if (text !== null) {
			this.finalAssistantText = this.truncateAssistantText(text);
		}
		const usage = readUsage(message);
		if (usage !== undefined) this.usage = addUsage(this.usage, usage);
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
		if (Buffer.byteLength(text) <= this.limits.maxAssistantTextBytes)
			return text;
		this.truncated = true;
		this.warn(
			`Reviewer assistant text exceeded ${this.limits.maxAssistantTextBytes} bytes; truncated`,
		);
		let end = text.length;
		while (end > 0) {
			const candidate = text.slice(0, end);
			if (Buffer.byteLength(candidate) <= this.limits.maxAssistantTextBytes) {
				return candidate;
			}
			end--;
		}
		return "";
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

function readAssistantMessage(event: unknown): Record<string, unknown> | null {
	if (typeof event !== "object" || event === null) return null;
	const e = event as Record<string, unknown>;
	if (e.type !== "message_end") return null;
	const message = e.message;
	if (typeof message !== "object" || message === null) return null;
	const m = message as Record<string, unknown>;
	if (m.role !== "assistant") return null;
	return m;
}

function readTextContent(message: Record<string, unknown>): string | null {
	if (!Array.isArray(message.content)) return null;
	const textParts: string[] = [];
	for (const part of message.content) {
		if (typeof part !== "object" || part === null) continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") {
			textParts.push(p.text);
		}
	}
	return textParts.length === 0 ? null : textParts.join("\n");
}

function readUsage(
	message: Record<string, unknown>,
): ReviewerUsage | undefined {
	const usage = message.usage;
	if (typeof usage !== "object" || usage === null) return undefined;
	const u = usage as Record<string, unknown>;
	const costRaw = u.cost;
	const cost =
		typeof costRaw === "object" && costRaw !== null
			? (costRaw as Record<string, unknown>)
			: {};
	const input = readNumber(u.input ?? u.input_tokens);
	const output = readNumber(u.output ?? u.output_tokens);
	const cacheRead = readNumber(u.cacheRead ?? u.cache_read_input_tokens);
	const cacheWrite = readNumber(u.cacheWrite ?? u.cache_creation_input_tokens);
	return {
		tokens: {
			input,
			output,
			cacheRead,
			cacheWrite,
			total:
				readNumber(u.totalTokens) || input + output + cacheRead + cacheWrite,
		},
		cost: {
			input: readNumber(cost.input),
			output: readNumber(cost.output),
			cacheRead: readNumber(cost.cacheRead),
			cacheWrite: readNumber(cost.cacheWrite),
			total: readNumber(cost.total ?? u.cost_usd),
		},
	};
}

function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

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
