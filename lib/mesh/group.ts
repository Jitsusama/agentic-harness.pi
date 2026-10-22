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
 * - `#all`, the machine's group, which every peer hears and none joins.
 * - Named groups a peer joins for its work, such as `#harness`. They
 *   nest as subnets do, and a member of `#optimus/power` also hears
 *   `#optimus`, since what concerns the whole concerns each part.
 */

/** The machine's group, which every peer on it hears. */
export const ALL = "#all";

/**
 * A group as a person or a model types it, made canonical, or nothing
 * when it cannot be one.
 *
 * `all`, `#all` and `#global` are the machine. `#harness` and
 * `harness/x` with a # are named groups, lower-cased. Anything else is
 * a peer's address, upper-cased, with or without its @, standing for
 * that peer's home group.
 */
export function groupNamed(written: string): string | undefined {
	const one = written.trim();
	const bare = one.replace(/^[#@]/, "").toLowerCase();
	if (bare === "all" || bare === "global") return ALL;
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
