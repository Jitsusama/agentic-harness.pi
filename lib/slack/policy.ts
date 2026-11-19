/**
 * Whether this machine has turned direct Slack off, leaving the tool
 * gateway's Slack tools as the only way to read or send.
 *
 * A machine says so by placing a file at {@link gatewayOnlyPath}, which
 * its own configuration writes, so the choice lives with the machine and
 * not in a setting an agent edits. While the file is there, nothing in
 * this package reads the stored Slack token, signs in, takes Chrome's or
 * Slack's session, or calls Slack's API itself. The stored token is left
 * where it is: what else reads it is the machine's business.
 *
 * It is a rule this package keeps, not a boundary: a process outside the
 * agent fence can still read the keyring. The fence is what refuses that.
 */

import { existsSync } from "node:fs";
import { gatewayOnlyPath } from "./paths.ts";

/** What a refused direct Slack call says, wherever it is caught. */
export const DIRECT_SLACK_REFUSED =
	"Direct Slack is off on this machine: read and send Slack through the " +
	"tool gateway's slack tools instead.";

/** The error a refused direct Slack call throws. */
export class DirectSlackRefused extends Error {
	constructor() {
		super(DIRECT_SLACK_REFUSED);
		this.name = "DirectSlackRefused";
	}
}

/**
 * Whether direct Slack is off, read fresh each time so a machine that
 * turns it off is obeyed without waiting for a reload.
 */
export function directSlackRefused(path: string = gatewayOnlyPath()): boolean {
	return existsSync(path);
}

/** Throw {@link DirectSlackRefused} when direct Slack is off. */
export function refuseDirectSlack(path: string = gatewayOnlyPath()): void {
	if (directSlackRefused(path)) throw new DirectSlackRefused();
}
