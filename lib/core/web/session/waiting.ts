/**
 * Waiting for the page to reach a state, and saying what was true
 * instead when it never does.
 *
 * Kept apart from the session because each condition is its own
 * small probe with its own way of failing honestly, and they grow
 * one condition at a time. A wait reads the page and the request
 * log and nothing else.
 */

import type { ElementHandle } from "puppeteer-core";
import { matchesPattern } from "../environment/index.ts";
import { requestStatus } from "../telemetry/index.ts";
import {
	inFlight,
	isIdle,
	type WaitCondition,
	type WaitOutcome,
} from "../wait/index.ts";
import type { SessionTelemetry } from "./telemetry.ts";
import type { SessionWires } from "./wires.ts";

/** How long a wait runs before it gives up and says so. */
const DEFAULT_WAIT_MS = 10_000;

/** How often a wait looks again. */
const WAIT_POLL_MS = 100;

/** Waits on the page, polled through the session's tab. */
export class SessionWaiting {
	/** The live view of the browser the page is polled through. */
	private readonly wires: SessionWires;

	/** The request log a request or idle wait reads. */
	private readonly telemetry: SessionTelemetry;

	constructor(wires: SessionWires, telemetry: SessionTelemetry) {
		this.wires = wires;
		this.telemetry = telemetry;
	}

	/**
	 * Wait for the page to reach a state, and say what happened.
	 *
	 * The timeout is a real answer rather than an error. A page
	 * that never reaches the state is the finding, so the outcome
	 * carries what was true instead.
	 */
	async waitFor(
		condition: WaitCondition,
		timeoutMs: number = DEFAULT_WAIT_MS,
	): Promise<WaitOutcome> {
		await this.wires.ready();
		const startedAt = Date.now();
		const waited = () => Date.now() - startedAt;

		if (condition.kind === "duration") {
			await new Promise((resolve) => setTimeout(resolve, condition.ms));
			return { met: true, waitedMs: waited(), condition };
		}

		// Where the request log stood when the wait began. Waiting
		// for a request used to search the whole session's log, which
		// is never cleared, so the second lap of an observe-act-wait
		// loop was satisfied instantly by the previous lap's response
		// and reported its old status. That is a green wait in the
		// log hiding a race, which is the most expensive shape of
		// test defect to chase.
		const since = this.telemetry.protocolNow();

		while (waited() < timeoutMs) {
			const reached = await this.check(condition, since);
			if (reached.met) {
				return {
					met: true,
					waitedMs: waited(),
					condition,
					...(reached.detail === undefined ? {} : { detail: reached.detail }),
				};
			}
			await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
		}

		const missed = await this.check(condition);
		return {
			met: false,
			waitedMs: waited(),
			condition,
			...(missed.saw === undefined ? {} : { saw: missed.saw }),
		};
	}

	/** Look once: is the condition true right now? */
	private async check(
		condition: WaitCondition,
		/**
		 * Protocol time the wait began. A request that finished
		 * before this belongs to an earlier lap and cannot satisfy
		 * the condition.
		 */
		since?: number,
	): Promise<{ met: boolean; detail?: string; saw?: string }> {
		switch (condition.kind) {
			case "selector":
			case "gone": {
				// A probe that could not run is not an absent element. A
				// detached frame or a dead renderer used to come back as
				// null, which satisfied kind "gone" outright, so the wait
				// succeeded precisely when the page was broken and the
				// real failure surfaced several calls later.
				let found: ElementHandle | null;
				try {
					found = await this.wires.page().$(condition.selector);
				} catch (error) {
					return {
						met: false,
						saw: `The page could not be asked: ${String(error)}`,
					};
				}
				const present = found !== null;
				if (found) await found.dispose();
				const met = condition.kind === "selector" ? present : !present;
				return {
					met,
					...(met
						? {}
						: {
								saw: present
									? "It is still there."
									: "Nothing matches that selector.",
							}),
				};
			}
			case "text": {
				const has = await this.wires.page()
					.evaluate(
						(needle: string) =>
							(document.body?.innerText ?? "").includes(needle),
						condition.text,
					)
					.catch(() => false);
				return {
					met: has,
					...(has ? {} : { saw: "The page does not contain it." }),
				};
			}
			case "idle": {
				const requests = this.telemetry.requests();
				const met = isIdle(
					requests,
					condition.quietMs,
					this.telemetry.protocolNow(),
				);
				const busy = inFlight(requests);
				return {
					met,
					...(met
						? {}
						: {
								saw:
									busy.length > 0
										? `${busy.length} still in flight, including ` +
											`${busy[0]?.url}.`
										: "The page keeps starting new requests.",
							}),
				};
			}
			case "request": {
				const fresh = this.telemetry.requests().filter(
					(request) => since === undefined || request.startedAt >= since,
				);
				const matched = fresh.filter(
					(request) =>
						matchesPattern({
							pattern: condition.pattern,
							url: request.url,
						}) && request.state !== "pending",
				);
				const last = matched.at(-1);
				if (!last) {
					const pending = fresh.filter((request) =>
						matchesPattern({
							pattern: condition.pattern,
							url: request.url,
						}),
					);
					return {
						met: false,
						saw:
							pending.length > 0
								? `${pending.length} matching, none finished yet.`
								: "Nothing has requested it.",
					};
				}
				if (
					condition.status !== undefined &&
					last.status !== condition.status
				) {
					// Keep waiting rather than declaring the condition met.
					// A retry may still answer with the status asked for, and
					// if none does, the timeout reports the status that kept
					// arriving, which is the finding.
					return {
						met: false,
						saw: `${last.method} ${last.url} answered ${requestStatus(last)}.`,
					};
				}
				return {
					met: true,
					// A cancelled request usually carries no failure text,
					// and printing the field raw said "cancelled: undefined"
					// to someone waiting on a request that never arrived.
					detail:
						last.state === "complete"
							? `${last.method} ${last.url} answered ${requestStatus(last)}.`
							: `${last.method} ${last.url} ${requestStatus(last)}.`,
				};
			}
			case "attribute": {
				// Read through one evaluate rather than a handle, so an
				// element replaced between finding it and reading it is
				// simply absent on the next poll instead of throwing on a
				// stale handle.
				let held: string | null | undefined;
				try {
					held = await this.wires.page().evaluate(
						(selector: string, attribute: string) => {
							const found = document.querySelector(selector);
							if (found === null) return undefined;
							return found.getAttribute(attribute);
						},
						condition.selector,
						condition.attribute,
					);
				} catch (error) {
					return {
						met: false,
						saw: `The page could not be asked: ${String(error)}`,
					};
				}

				if (held === undefined) {
					// Absent element and absent attribute are different
					// answers. Treating the first as "attribute is gone"
					// would satisfy a wait for a control that never rendered.
					return { met: false, saw: "Nothing matches that selector." };
				}

				const met =
					condition.value === undefined
						? held === null
						: held === condition.value;
				return {
					met,
					...(met
						? {}
						: {
								saw:
									held === null
										? `It has no ${condition.attribute}.`
										: `Its ${condition.attribute} is "${held}".`,
							}),
				};
			}
			case "count": {
				let seen: number;
				try {
					seen = await this.wires.page().evaluate(
						(selector: string) => document.querySelectorAll(selector).length,
						condition.selector,
					);
				} catch (error) {
					return {
						met: false,
						saw: `The page could not be asked: ${String(error)}`,
					};
				}
				const met = seen === condition.count;
				return {
					met,
					...(met ? {} : { saw: `There are ${seen}.` }),
				};
			}
			case "animations": {
				// Catching to zero declared the animations settled
				// whenever the probe itself failed, which is the same
				// false pass as the selector arm above.
				let running: number;
				try {
					running = await this.wires.page().evaluate(
						() =>
							document
								.getAnimations()
								.filter((animation) => animation.playState === "running")
								.length,
					);
				} catch (error) {
					return {
						met: false,
						saw: `The page could not be asked: ${String(error)}`,
					};
				}
				return {
					met: running === 0,
					...(running === 0
						? {}
						: { saw: `${running} animations are still running.` }),
				};
			}
			case "duration":
				return { met: true };
		}
	}
}
