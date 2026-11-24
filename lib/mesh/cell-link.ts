/**
 * The link the map and the launcher go to a cell by,
 * `mycelium:cell/<address>@<machine>/go`, which raises its window or
 * opens one. Both /needs and /cell build it from names another session
 * or the node wrote, so a name that would reshape the link is refused
 * rather than opened.
 */

import { isMachineName } from "../internal/machine/machine.ts";

/** What can be a cell's address: what a steer takes. */
export const CELL_ADDRESS = /^[A-Za-z0-9]{1,16}$/u;

/**
 * The link that goes to the cell `address` on `machine`, or nothing when
 * either isn't a name the link can carry.
 */
export function cellLink(address: string, machine: string): string | undefined {
	if (!CELL_ADDRESS.test(address) || !isMachineName(machine)) return undefined;
	return `mycelium:cell/${address.toUpperCase()}@${machine}/go`;
}
