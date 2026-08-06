/**
 * Types for the assistant stream reader.
 *
 * The reader is plain `.mjs` because the supervisor script is run
 * directly by node and cannot import TypeScript. Its other caller is
 * TypeScript, and taking it as `any` would defeat the point of having
 * one reader: the two sides would agree at runtime and part company in
 * the types, which is where the drift would next appear.
 */

/** What one turn cost, in tokens and in money. */
export interface AssistantUsage {
	readonly tokens: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
	readonly cost: {
		readonly input: number;
		readonly output: number;
		readonly cacheRead: number;
		readonly cacheWrite: number;
		readonly total: number;
	};
}

/** The assistant message an event carries, finished or not. */
export function assistantMessage(
	event: unknown,
): Record<string, unknown> | null;

/** Whether this event carries a message that is done. */
export function isFinishedMessage(event: unknown): boolean;

/** Everything the assistant said in one message, or nothing. */
export function textOf(message: Record<string, unknown>): string | null;

/** What one turn cost, in both currencies. */
export function usageOf(
	message: Record<string, unknown>,
): AssistantUsage | undefined;
