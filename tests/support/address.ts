/**
 * A test session's address, minted as `sessionAddress` mints one, with
 * anything but letters and digits left out first so a fixture's name
 * like `s-1` still makes one, and padded with X to six where a short
 * name falls below an address's shape, which no real session id does.
 * A presence read from a file keeps only addresses of that shape, so a
 * fixture minting any other way would find its peer missing.
 */

import { sessionAddress } from "../../lib/mesh/address.ts";

/** A test session's address, in an address's shape. */
export function addressOf(session: string): string {
	return sessionAddress(session.replace(/[^A-Za-z0-9]/g, "")).padEnd(6, "X");
}
