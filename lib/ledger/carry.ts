/**
 * What a scan carries from one pass over a log to the next, as JSON.
 *
 * A pass that reads a grown log from where the last one stopped needs
 * everything the lines before told the scan: each entry's inherited
 * thinking level, booking and branch, the calls still open, the
 * compaction boundaries, and the compactions not yet settled. Most
 * entries share their parent's level, booking and branch, so each is
 * written once in a table and every entry names its row.
 */

import type {
	CompactionFacts,
	SessionRecord,
	TurnPrecedent,
	TurnRecord,
} from "../core/observability/index.ts";
import { isRecord } from "../internal/record.ts";
import { type BranchState, BranchWalk, type OpenCompaction } from "./branch.ts";
import type { Booking, Boundary, ScanState } from "./scan.ts";
import type { ToolCallRecord } from "./types.ts";

/**
 * The shape of what is carried, as a number. Bump it with any change to
 * what a scan carries from line to line (a new map in `startScan`, a
 * new field on a branch's state), so a pass meeting an older carry
 * reads its log whole rather than carrying on from the wrong state.
 */
export const CARRY_VERSION = 1;

/** A branch's state as written: its set as a list, its open compaction by place. */
interface WrittenState extends Omit<BranchState, "seen" | "awaiting"> {
	readonly seen: readonly TurnPrecedent[];
	/** An unsettled compaction by its place in the carry's list, or a settled one's facts. */
	readonly awaiting: number | CompactionFacts | null;
}

/** What a scan carries, written out. */
export interface CarriedScan {
	readonly version: number;
	/** Every entry id, in the order the log first gave it. */
	readonly ids: readonly string[];
	readonly levelTable: readonly (string | null)[];
	readonly levels: readonly number[];
	readonly bookingTable: readonly Booking[];
	readonly bookings: readonly number[];
	readonly stateTable: readonly WrittenState[];
	readonly states: readonly number[];
	readonly calls: readonly ToolCallRecord[];
	readonly targets: readonly (readonly [string, string])[];
	readonly boundaries: readonly Boundary[];
	readonly session: SessionRecord;
	readonly lastModel: string;
	readonly unsettled: readonly TurnRecord[];
}

/**
 * A table of distinct values, each written once, and each id's row in
 * it, or -1 for an id with none.
 */
function tabled<T, W>(
	ids: readonly string[],
	of: ReadonlyMap<string, T>,
	write: (value: T) => W,
): { table: W[]; rows: number[] } {
	const table: W[] = [];
	const rowOfValue = new Map<T, number>();
	const rowOfId = new Map<string, number>();
	for (const [id, value] of of) {
		let at = rowOfValue.get(value);
		if (at === undefined) {
			at = table.length;
			rowOfValue.set(value, at);
			table.push(write(value));
		}
		rowOfId.set(id, at);
	}
	return { table, rows: ids.map((id) => rowOfId.get(id) ?? -1) };
}

function same<T>(value: T): T {
	return value;
}

/** Write a scan's state as JSON. */
export function writeCarry(state: ScanState): CarriedScan {
	const ids = [...state.entryOrder.keys()];
	const unsettled = [...state.unsettled];
	const awaitingAt = new Map<OpenCompaction, number>();
	unsettled.forEach((turn, at) => {
		if (turn.compaction) awaitingAt.set(turn.compaction, at);
	});
	const levels = tabled(ids, state.levels, same);
	const bookings = tabled(ids, state.bookings, same);
	const states = tabled(
		ids,
		state.branches.soFar(),
		(branch): WrittenState => ({
			...branch,
			seen: [...branch.seen],
			awaiting:
				branch.awaiting === null
					? null
					: (awaitingAt.get(branch.awaiting) ?? { ...branch.awaiting }),
		}),
	);
	return {
		version: CARRY_VERSION,
		ids,
		levelTable: levels.table,
		levels: levels.rows,
		bookingTable: bookings.table,
		bookings: bookings.rows,
		stateTable: states.table,
		states: states.rows,
		calls: [...state.calls.values()],
		targets: [...state.targets],
		boundaries: state.boundaries,
		session: state.session,
		lastModel: state.lastModel,
		unsettled,
	};
}

/** Each id's value, from its row in the table; an id with none gets none. */
function untabled<T>(
	ids: readonly string[],
	table: readonly T[],
	rows: readonly number[],
): Map<string, T> {
	const of = new Map<string, T>();
	ids.forEach((id, at) => {
		const row = rows[at];
		const value = row === undefined ? undefined : table[row];
		if (value !== undefined) of.set(id, value);
	});
	return of;
}

/** Whether a parsed value has the carry's shape at this version. */
function isCarried(value: unknown): value is CarriedScan {
	if (!isRecord(value) || value.version !== CARRY_VERSION) return false;
	const lists = [
		"ids",
		"levelTable",
		"levels",
		"bookingTable",
		"bookings",
		"stateTable",
		"states",
		"calls",
		"targets",
		"boundaries",
		"unsettled",
	];
	return (
		lists.every((name) => Array.isArray(value[name])) &&
		isRecord(value.session) &&
		typeof value.lastModel === "string"
	);
}

/**
 * Read a written carry back into a scan's state, or nothing when it is
 * not one this version wrote. Every unsettled compaction comes back as
 * one object, shared by its turn and by each branch still awaiting it,
 * as the scan that wrote it held it.
 */
export function readCarry(value: unknown): ScanState | undefined {
	if (!isCarried(value)) return undefined;
	const unsettled = value.unsettled.map((turn) => ({
		...turn,
		...(turn.compaction ? { compaction: { ...turn.compaction } } : {}),
	}));
	const awaiting = (written: WrittenState["awaiting"]) => {
		if (written === null) return null;
		if (typeof written === "number")
			return unsettled[written]?.compaction ?? null;
		return { ...written };
	};
	const stateTable: BranchState[] = value.stateTable.map((written) => ({
		...written,
		seen: new Set(written.seen),
		awaiting: awaiting(written.awaiting),
	}));
	return {
		calls: new Map(value.calls.map((call) => [call.callId, call])),
		targets: new Map(value.targets),
		entryOrder: new Map(value.ids.map((id, at) => [id, at])),
		boundaries: value.boundaries,
		session: value.session,
		lastModel: value.lastModel,
		levels: untabled(value.ids, value.levelTable, value.levels),
		bookings: untabled(value.ids, value.bookingTable, value.bookings),
		branches: new BranchWalk(untabled(value.ids, stateTable, value.states)),
		unsettled,
	};
}
