/**
 * Bending the network a session sees: mocked replies, blocked
 * requests and throttled throughput.
 *
 * Interception is only attached while there is a rule to apply.
 * Every paused request has to be answered or the page waits on
 * it forever, so an interceptor with nothing to say is a
 * liability rather than a neutral bystander.
 */

import type { Protocol } from "puppeteer-core";
import {
	type NetworkRule,
	resolveThrottle,
	ruleFor,
	type ThrottleConditions,
} from "../environment/index.js";
import type { SessionWires } from "./wires.js";

/** The rules and throttle a session's network answers to. */
export class NetworkShaper {
	/** Requests being mocked or blocked, first match winning. */
	private rules: readonly NetworkRule[] = [];

	/** How slow the network is being made, if at all. */
	private throttle?: ThrottleConditions;

	/** Whether the interceptor is currently attached. */
	private intercepting = false;

	constructor(private readonly wires: SessionWires) {}

	/** How the network is currently being bent. */
	get current(): {
		rules: readonly NetworkRule[];
		throttle: ThrottleConditions | undefined;
	} {
		return { rules: this.rules, throttle: this.throttle };
	}

	/**
	 * Mock a reply, block a request, slow it all down, or stop
	 * pretending.
	 */
	async shape(change: {
		rules?: readonly NetworkRule[];
		/** Conditions, or the name of a profile such as slow-3g. */
		throttle?: ThrottleConditions | string;
		clear?: boolean;
	}): Promise<{
		rules: readonly NetworkRule[];
		throttle: ThrottleConditions | undefined;
	}> {
		await this.wires.ready();

		if (change.clear) {
			this.rules = [];
			this.throttle = undefined;
		} else {
			if (change.rules) this.rules = [...this.rules, ...change.rules];
			// Resolved here so a profile name is as good as the conditions
			// it stands for. Passed a name, this used to read the fields
			// it wanted off a string, find none, and shape nothing at all.
			if (change.throttle) this.throttle = resolveThrottle(change.throttle);
		}

		await this.wires.cdp().send("Network.emulateNetworkConditions", {
			offline: this.throttle?.offline ?? false,
			latency: this.throttle?.latency ?? 0,
			// The protocol reads -1 as no limit, which is not the same
			// as zero, and zero would mean nothing may pass at all.
			downloadThroughput: this.throttle?.download || -1,
			uploadThroughput: this.throttle?.upload || -1,
		});

		if (this.rules.length === 0) {
			if (this.intercepting) {
				await this.wires.cdp().send("Fetch.disable");
				this.intercepting = false;
			}
		} else if (!this.intercepting) {
			this.wires.cdp().on("Fetch.requestPaused", (event) => {
				void this.answerPaused(event);
			});
			await this.wires
				.cdp()
				.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
			this.intercepting = true;
		}

		return { rules: this.rules, throttle: this.throttle };
	}

	/**
	 * Decide what a paused request gets.
	 *
	 * Whatever happens, it is answered. A handler that throws and
	 * says nothing leaves the page waiting forever on a request
	 * the browser has already stopped for us.
	 */
	private async answerPaused(event: {
		requestId: string;
		request: { url: string };
	}): Promise<void> {
		const rule = ruleFor(this.rules, event.request.url);
		try {
			if (rule?.action === "block") {
				await this.wires.cdp().send("Fetch.failRequest", {
					requestId: event.requestId,
					errorReason: (rule.reason ??
						"BlockedByClient") as Protocol.Network.ErrorReason,
				});
				return;
			}
			if (rule?.action === "mock") {
				await this.wires.cdp().send("Fetch.fulfillRequest", {
					requestId: event.requestId,
					responseCode: rule.status ?? 200,
					responseHeaders: [
						{
							name: "content-type",
							value: rule.contentType ?? "text/plain",
						},
					],
					body: Buffer.from(rule.body ?? "").toString("base64"),
				});
				return;
			}
			await this.wires.cdp().send("Fetch.continueRequest", {
				requestId: event.requestId,
			});
		} catch {
			// The request may already be resolved, or the page may have
			// navigated out from under it. Either way there is nothing
			// left to answer and nothing worth reporting.
		}
	}
}
