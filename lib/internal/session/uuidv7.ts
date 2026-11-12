/**
 * Session ids as pi makes them, in a module of their own so a script
 * that names a session or a request, such as scripts/spawn-decide.ts,
 * loads none of pi's packages to do it.
 */

import { randomBytes } from "node:crypto";

/**
 * A UUIDv7, the form pi gives session ids: its first 48 bits are the
 * time in milliseconds, so ids sort as logs were started.
 */
export function uuidv7(
	now: number = Date.now(),
	random: Buffer = randomBytes(10),
): string {
	const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
	const time = hex(now, 12);
	const rand = random.toString("hex");
	const version = `7${rand.slice(0, 3)}`;
	const variant = (
		(Number.parseInt(rand.slice(3, 4), 16) & 0x3) |
		0x8
	).toString(16);
	return [
		time.slice(0, 8),
		time.slice(8, 12),
		version,
		`${variant}${rand.slice(4, 7)}`,
		rand.slice(7, 19),
	].join("-");
}
