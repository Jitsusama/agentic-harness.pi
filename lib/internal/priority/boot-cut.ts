/**
 * Whether a boot cut a queued job off, and when: a Mac's queue folder
 * is its cache folder, which outlasts a reboot, and a pid comes back as
 * another process after one, so a job asked in an earlier boot has
 * ended whatever its pid names now. Told by the boot token a job was
 * stamped with, or for one with none by the boot's time, which moves
 * with the clock.
 */

import type { Job } from "./queue.ts";

/**
 * How long before the boot a job with no boot token to tell it by must
 * have begun to be taken as cut off by it. The boot's time is the clock
 * less the uptime, so it moves with the clock: one stepped forward after
 * the job was asked, as a Mac waking from sleep often is, puts the boot
 * after work running since it, and this is that step's room. It costs
 * both ways: an unstamped job a reboot cut off within this of its start
 * is judged by its shell's pid alone, which a reboot may give another
 * process, and a step forward past this gives up an unstamped job still
 * running, which can't be taken back. Only jobs asked by a session
 * before tokens, or while its token read missed, go unstamped.
 */
export const UNSTAMPED_BOOT_SLACK_MS = 15 * 60_000;

/** What telling a boot reads of the machine, as the queue's processes say it. */
export interface BootReadings {
	bootToken?(): string | undefined;
	bootedAt?(): number;
}

/**
 * When the boot came, if the job was asked in an earlier one, which
 * ended it: never before the job began, nor after now. A job stamped
 * with its boot's token is told by that alone, and while this reader
 * has no token of its own it waits for one: a miss is read again
 * within half a minute, and a job given up by the clock meanwhile can't
 * be taken back. One with no token is told by the boot's time, as
 * before tokens, only once begun well before it, so a clock stepped a
 * little gives up nothing running.
 */
export function cutOffAt(
	job: Job,
	now: number,
	boot: BootReadings,
): number | undefined {
	const stamped = typeof job.boot === "string";
	if (stamped) {
		const token = boot.bootToken?.();
		if (token === undefined || job.boot === token) return undefined;
	}
	const bootedAt = boot.bootedAt?.();
	const began = Date.parse(job.started ?? job.since);
	if (!stamped) {
		const before =
			bootedAt !== undefined && began < bootedAt - UNSTAMPED_BOOT_SLACK_MS;
		if (!before) return undefined;
	}
	const booted = Math.min(bootedAt ?? now, now);
	return Number.isNaN(began) ? booted : Math.min(Math.max(began, booted), now);
}

/**
 * When a boot cut off a job seen to have ended, should its shell have
 * said nothing of its end; undefined for one that ran into this boot.
 * Beside what {@link cutOffAt} gives up, a job no token places in this
 * boot whose clock says it began before the boot, its shell gone,
 * ended with the boot: remembered as ending now, its run would span
 * the time the machine was down. Only its record is dated so, never
 * whether it ended, so a stepped clock costs one run's time, nothing
 * running.
 */
export function cutAtOf(
	job: Job,
	now: number,
	boot: BootReadings,
): number | undefined {
	const cutAt = cutOffAt(job, now, boot);
	if (cutAt !== undefined) return cutAt;
	const thisBoot =
		typeof job.boot === "string" && job.boot === boot.bootToken?.();
	const bootedAt = boot.bootedAt?.();
	const began = Date.parse(job.started ?? job.since);
	return !thisBoot && bootedAt !== undefined && began < bootedAt
		? Math.min(bootedAt, now)
		: undefined;
}
