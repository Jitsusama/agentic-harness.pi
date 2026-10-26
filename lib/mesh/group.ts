/**
 * Groups: the shared spaces every message on the mesh goes to.
 *
 * There are no direct messages. Joel, when the swarm grew inboxes: "i
 * never envisioned dms, that kills coordination and self organization.
 * every message needs to be in a potentially shared space". So a peer
 * is reached through its home group, written as its address with an @
 * (`@5GV2AH`), which it is always a member of and which any other peer
 * may join to follow it. Beside those:
 *
 * - `#machine` (once `#all`, which still names it), the machine's
 *   group, which every peer hears and none joins. It takes only holds
 *   and the answers that end them ({@link machineTakes}): on 25 October
 *   the Karst and walgit sessions heard the mission's progress and
 *   questions there, though none of it was their work.
 * - Named groups a peer joins for its work, such as `#harness`. They
 *   nest as subnets do, and a member of `#optimus/power` also hears
 *   `#optimus`, since what concerns the whole concerns each part.
 */

/**
 * The machine's group, which every peer on it hears. Kept as `#all` in
 * what is written, so a peer on an older harness still hears it.
 */
export const ALL = "#all";

/** The machine's group as it is said. */
export const MACHINE = "#machine";

/**
 * Whether the machine's group takes a message: a hold, or an answer to
 * one, which is how a hold ends for everyone it parked.
 */
export function machineTakes(
	intent: string,
	answers: { readonly intent: string } | undefined,
): boolean {
	return intent === "hold" || answers?.intent === "hold";
}

/**
 * A group as a person or a model types it, made canonical, or nothing
 * when it cannot be one.
 *
 * `machine`, `all` and `global`, with or without a #, are the machine. `#harness` and
 * `harness/x` with a # are named groups, lower-cased. Anything else is
 * a peer's address, upper-cased, with or without its @, standing for
 * that peer's home group.
 */
export function groupNamed(written: string): string | undefined {
	const one = written.trim();
	const bare = one.replace(/^[#@]/, "").toLowerCase();
	if (bare === "machine" || bare === "all" || bare === "global") return ALL;
	if (one.startsWith("#")) return isPath(bare) ? `#${bare}` : undefined;
	const address = one.replace(/^@/, "").toUpperCase();
	return /^[A-Z0-9]+$/.test(address) ? `@${address}` : undefined;
}

/**
 * Every group in a comma-separated list, canonical and without
 * repeats. What cannot be a group is kept as written, so a sender can
 * be told exactly which part reached nobody.
 */
export function groupsNamed(written: string): string[] {
	const named = written
		.split(",")
		.map((one) => one.trim())
		.filter((one) => one !== "")
		.map((one) => groupNamed(one) ?? one);
	return [...new Set(named)];
}

/**
 * What `to` says once the word `orchestrator` in it is read as the
 * address of the orchestrator above the sender's quest, from its own
 * presence (see internal/quest/orchestration.ts), so a session asks its
 * orchestrator without knowing which session that is. With none above
 * it, the word is dropped and `missing` says so.
 */
export function orchestratorNamed(
	written: string,
	orchestratedBy: string | undefined,
): { readonly to: string; readonly missing: boolean } {
	const parts = written.split(",").map((one) => one.trim());
	const word = (one: string) =>
		one.replace(/^[#@]/, "").toLowerCase() === ORCHESTRATOR;
	if (!parts.some(word)) return { to: written, missing: false };
	const to = parts
		.flatMap((one) =>
			word(one) ? (orchestratedBy ? [orchestratedBy] : []) : [one],
		)
		.filter((one) => one !== "")
		.join(", ");
	return { to, missing: orchestratedBy === undefined };
}

/** The word in `to` that names the sender's orchestrator. */
export const ORCHESTRATOR = "orchestrator";

/** The home group of a peer going by this address. */
export function homeOf(address: string): string {
	return `@${address}`;
}

/** Whether a canonical group is one a peer joins rather than is born in. */
export function isJoinable(group: string): boolean {
	return group !== ALL && (group.startsWith("#") || group.startsWith("@"));
}

/**
 * Whether a peer that is a member of these groups hears a message sent
 * to this one: when it is a member, or a member of one of its parts.
 */
export function hears(groups: readonly string[], group: string): boolean {
	return (
		group === ALL ||
		groups.some((own) => own === group || own.startsWith(`${group}/`))
	);
}

/** Segments of letters, digits and dashes, joined by /. */
function isPath(name: string): boolean {
	return name
		.split("/")
		.every((segment) => /^[a-z0-9][a-z0-9-]*$/.test(segment));
}
