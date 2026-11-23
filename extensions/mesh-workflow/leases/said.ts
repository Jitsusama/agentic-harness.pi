/**
 * The leases a peer holds, and the queue's jobs, as mesh_groups says
 * them.
 */

import type { QueueRecord } from "../../../lib/internal/priority/folder.ts";
import { KIND_SAID } from "../../../lib/internal/priority/queue.ts";
import {
	claimsCheckout,
	type Holding,
	isCurrent,
	type Lease,
	ownerOf,
} from "../../../lib/mesh/lease.ts";
import { clock, shortId } from "../../../lib/mesh/message.ts";
import { oneLine } from "../../../lib/mesh/one-line.ts";
import type { Presence } from "../../../lib/mesh/presence.ts";
import { heavySaid } from "./heavy-calls.ts";

/**
 * The leases of the peers still there, as mesh_groups lists them. Given
 * the queue's jobs, a peer's heavy work is what the queue says it runs
 * or waits for, and its heavy leases are left out: the lease says only
 * that a command started, the queue whether it has its turn. Each peer
 * writes its own board entry and queue record as it likes, so each line
 * is said as one, whatever its subjects and reasons carry.
 */
export function leasesText(
	board: readonly Holding[],
	present: readonly Presence[],
	now: number = Date.now(),
	jobs?: QueueRecord["jobs"],
): string {
	// A hand's work is the peer's it works for, as its leases were claimed.
	const owners = new Map(
		board.map((holding) => [holding.session, ownerOf(holding)]),
	);
	const lines = present.flatMap((one) => {
		const leases = board
			.filter((holding) => ownerOf(holding) === one.session)
			.flatMap((holding) => holding.leases)
			.filter((lease) => isCurrent(lease, now))
			.filter((lease) => jobs === undefined || lease.kind !== "heavy");
		const queued = (jobs ?? [])
			.filter(
				(job) =>
					(owners.get(job.owner.session) ?? job.owner.session) === one.session,
			)
			.map(jobSaid);
		const said = [
			...(leases.length > 0 ? [describeAll(leases)] : []),
			...queued,
		];
		return said.length > 0 && one.addresses[0]
			? [oneLine(`${one.addresses[0]}: ${said.join("; ")}`)]
			: [];
	});
	return lines.length > 0 ? `\nLeases:\n${lines.join("\n")}` : "";
}

/** A job as the queue holds it: running, or waiting at its place. */
function jobSaid(job: QueueRecord["jobs"][number]): string {
	const kind = KIND_SAID[job.kind] ?? job.kind;
	const since = clock({ at: job.since });
	return job.state === "running"
		? `running ${kind} since ${since} (${job.what})`
		: `waiting${job.place ? ` at place ${job.place}` : ""} to run ${kind}, since ${since} (${job.what})`;
}

/** A peer's leases in a phrase, its changes counted past the first few. */
function describeAll(leases: readonly Lease[]): string {
	const changes = leases.filter(
		(lease) => lease.kind === "change" && !claimsCheckout(lease),
	);
	const shown = changes.slice(0, 3).map((lease) => lease.subject);
	const more = changes.length - shown.length;
	const changing = [
		...leases
			.filter(claimsCheckout)
			.map(
				(lease) =>
					`rewrote the files of ${lease.subject}${lease.why ? ` (${lease.why})` : ""}`,
			),
		...(changes.length > 0
			? [`changing ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}`]
			: []),
	];
	const rest = leases
		.filter((lease) => lease.kind !== "change")
		.map((lease) => {
			const id = `[${shortId({ id: lease.subject })}]`;
			const why = lease.why ? ` (${lease.why})` : "";
			switch (lease.kind) {
				case "answer":
					return `answering ${id}${why}`;
				case "hold":
					return `holding ${id} until ${clock({ at: lease.until })}${why}`;
				case "wait":
					return `waiting on ${id}${why}`;
				default:
					return `running ${heavySaid(lease.subject)}${why}`;
			}
		});
	return [...changing, ...rest].join("; ");
}
