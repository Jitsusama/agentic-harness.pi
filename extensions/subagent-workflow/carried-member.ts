/**
 * One subagent of a carried fleet, read from what its supervisor left
 * on disk (carry.ts): how it ended, said as the dispatching session
 * says a subagent, or nothing while it still runs.
 *
 * Read from the files rather than from the run's answer, since the
 * process the run answered has gone: `result.json` for how it ended,
 * `progress.json` for what it was last doing, and the lease for whether
 * its supervisor is still there. One stopped as `parent-exit` was cut
 * off in the move, its hand-over having run out before anyone took the
 * fleet up; one whose supervisor went with no result is lost. Each is
 * said with its last activity and its transcript, never dropped.
 */

import { runRecordFrom } from "../../lib/core/observability/recorder.ts";
import type { RunRecord } from "../../lib/core/observability/types.ts";
import type {
	ReviewerArtifactsStore,
	ReviewerTerminalState,
} from "../../lib/subagent/artifacts.ts";
import type { SupervisorStanding } from "../../lib/subagent/lease.ts";
import { UNFINISHED } from "../../lib/subagent/reviewer-error.ts";
import type { SubagentUsage } from "../../lib/subagent/subagent.ts";
import { type FleetSubagentResult, summarizeStderrTail } from "./run.ts";

/** A subagent of a carried fleet, as the record of its run names it. */
export interface FleetMember {
	readonly id: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
}

/** What a supervisor's `result.json` says, as far as a fleet reads it. */
interface ResultOnDisk {
	readonly state?: ReviewerTerminalState | "parent-exit";
	readonly exitCode?: number;
	readonly finalAssistantText?: string;
	readonly usage?: SubagentUsage;
	readonly sessionIds?: readonly string[];
	readonly warnings?: readonly string[];
	readonly stderrTail?: string;
	readonly error?: { readonly stopReason?: string; readonly message?: string };
}

/** What a subagent's run was, for the run store, when it ran to a result. */
export interface MemberRan {
	readonly exitCode: number;
	readonly sessionIds: readonly string[] | null;
	readonly warnings: readonly string[];
	readonly usage?: SubagentUsage;
}

/** A subagent read once it has ended: as said, and as recorded. */
export interface MemberRead {
	readonly result: FleetSubagentResult;
	/** Nothing when it was cancelled or lost, as the dispatcher records neither. */
	readonly ran?: MemberRan;
}

/**
 * Read subagent `id` of run `runId`: how it ended, or nothing while its
 * supervisor still runs or starts, as `standing` says.
 */
export async function readMember(
	store: ReviewerArtifactsStore,
	runId: string,
	id: string,
	standing: () => Promise<SupervisorStanding>,
): Promise<MemberRead | undefined> {
	const paths = store.paths(runId, id);
	const where = async () => {
		const progress = await store.readJson<{ activity?: unknown }>(
			paths.progressPath,
		);
		const activity =
			typeof progress?.activity === "string" && progress.activity !== ""
				? `; last doing: ${progress.activity}`
				: "";
		return `${activity}; transcript: ${paths.eventsPath}`;
	};
	const onDisk = await store.readJson<ResultOnDisk>(paths.resultPath);
	if (onDisk === null) {
		const now = await standing();
		if (now.kind === "running" || now.kind === "starting") return undefined;
		// Its supervisor may have written the result as it went.
		const late = await store.readJson<ResultOnDisk>(paths.resultPath);
		if (late !== null) return endedAs(id, late, where);
		return {
			result: failed(
				id,
				"",
				[],
				`lost in the move: its supervisor is gone and left no result${await where()}`,
			),
		};
	}
	return endedAs(id, onDisk, where);
}

async function endedAs(
	id: string,
	file: ResultOnDisk,
	where: () => Promise<string>,
): Promise<MemberRead> {
	const text = file.finalAssistantText ?? "";
	const warnings = file.warnings ?? [];
	const exitCode = file.exitCode ?? -1;
	const ran: MemberRan = {
		exitCode,
		sessionIds: file.sessionIds ?? null,
		warnings,
		...(file.usage ? { usage: file.usage } : {}),
	};
	const usage = file.usage ? { usage: file.usage } : {};
	if (file.state === "cancelled")
		return {
			result: { id, finalAssistantText: "", warnings: [], state: "cancelled" },
		};
	if (file.state === "parent-exit")
		return {
			result: {
				...failed(
					id,
					text,
					warnings,
					`cut off in the move: nobody took the fleet up before its hand-over ran out, so its supervisor stopped it${await where()}`,
				),
				...usage,
			},
			ran,
		};
	if (exitCode !== 0) {
		const tail = summarizeStderrTail(file.stderrTail ?? "");
		return {
			result: {
				...failed(
					id,
					text,
					warnings,
					tail
						? `pi exited with code ${exitCode}: ${tail}`
						: `pi exited with code ${exitCode}`,
				),
				...usage,
			},
			ran,
		};
	}
	if (file.error !== undefined) {
		const message = file.error.message ?? "";
		return {
			result: {
				...failed(
					id,
					text,
					warnings,
					file.error.stopReason === UNFINISHED
						? `pi stopped before its run finished: ${message}`
						: `pi run ended on a ${file.error.stopReason ?? "unknown"} error: ${message}`,
				),
				...usage,
			},
			ran,
		};
	}
	return {
		result: {
			id,
			finalAssistantText: text,
			warnings,
			state: "complete",
			...usage,
		},
		ran,
	};
}

function failed(
	id: string,
	finalAssistantText: string,
	warnings: readonly string[],
	error: string,
): FleetSubagentResult {
	return { id, finalAssistantText, warnings, state: "failed", error };
}

/** The run store's record of one subagent, as the dispatcher writes it. */
export function memberRecord(
	fleet: { readonly runId: string; readonly startedAt: number },
	member: FleetMember,
	ran: MemberRan,
): RunRecord {
	return runRecordFrom({
		runId: fleet.runId,
		subagentId: member.id,
		kind: "fleet",
		model: member.model ?? "",
		persona: member.id,
		thinkingLevel: member.thinkingLevel ?? null,
		startedAt: fleet.startedAt,
		result: ran,
	});
}
