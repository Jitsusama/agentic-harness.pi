/**
 * Shared date helpers for the quest workflow.
 *
 * Every quest write that stamps an `updated` field, every
 * Journey bullet, every document's first scaffolded
 * `updated` value asks the same question: what is today in
 * YYYY-MM-DD form, using the local time zone? Put the
 * answer here once.
 *
 * `now` is injectable so callers under test can pin the
 * date stamp without monkey-patching `Date`.
 */

/** YYYY-MM-DD in the local time zone. */
export function nowYmd(now: () => Date = () => new Date()): string {
	const d = now();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}
