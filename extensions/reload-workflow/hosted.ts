/**
 * Reload in a multi-session host: the conversation asks its host, which
 * reloads that conversation alone and keeps its slots, so the request
 * and the landing wait in the conversation's own slot rather than the
 * process's reload slot, which every conversation shares. Nothing here
 * touches pi's settings: a host's conversations load the harness from
 * the one install it runs, so a hosted reload never swaps a tree in.
 * A reload reads that install from disk again, so once pi-packages
 * moves it, a reloaded conversation runs the new version while the
 * others keep the old one until each reloads; each conversation's own
 * follower (follow.ts) asks for that reload between its runs.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	hosted,
	type SessionContext,
	sessionKeyOf,
	sessionSlot,
} from "../../lib/core/session/index.ts";
import type {
	ReloadLanded,
	ReloadRequest,
} from "../../lib/internal/reload/slot.ts";

/** A conversation's reload, between its asking and its landing. */
interface HostedReload {
	/** Asked by the agent, waiting for the run to end. */
	request?: ReloadRequest;
	/** Handed to the host, to be said once the reloaded runtime starts. */
	landing?: ReloadLanded;
}

const SLOT = "agentic-harness.reload.hosted.v1";

/** Why a hosted conversation is refused a reload onto a tree. */
export const HOSTED_RELOAD_ONTO =
	"Nothing was reloaded: in a host every conversation loads the harness from the install the host runs, so a conversation can't reload onto another tree or name the install. Reload with no onto, or run the tree in a pi of its own.";

/** Whether this process is a host that can reload a conversation. */
export function hostReloads(): boolean {
	return hosted()?.reload !== undefined;
}

function state(ctx: SessionContext): HostedReload {
	return sessionSlot(SLOT, ctx, () => ({}));
}

/**
 * Ask the host to reload this conversation once its run ends. A named
 * tree is refused, since the host's extensions are every conversation's.
 */
export function requestHostedReload(
	ctx: SessionContext,
	reason: string,
	onto: string | undefined,
): string {
	const given = onto?.trim();
	if (given !== undefined && given !== "" && given !== "null") {
		throw new Error(HOSTED_RELOAD_ONTO);
	}
	state(ctx).request = { reason, by: "agent" };
	return [
		"Reload queued: the host reloads this conversation alone as soon as this run ends, so end your turn now, without another call.",
		"When it lands, a message says which code runs and you carry on from there.",
	].join(" ");
}

/**
 * At a settle, hand this conversation's waiting request to its host, or
 * call it off when the person stopped the run. Answers whether one was
 * waiting.
 */
export function settleHostedReload(
	ctx: ExtensionContext,
	aborted: boolean,
): boolean {
	const slot = state(ctx);
	const request = slot.request;
	if (request === undefined) return false;
	slot.request = undefined;
	if (aborted) {
		say(ctx, "Reload called off: you stopped the run.");
		return true;
	}
	void reloadThroughHost(ctx, request);
	return true;
}

/**
 * Ask the host to reload this conversation now. Not awaited: the host
 * waits for this conversation to be idle, which the hook or command
 * asking is holding it from. The reloaded runtime says the landing; a
 * reload that fails is said here, since this runtime is still the one
 * running. A request the agent left waiting goes with it, so the next
 * settle doesn't reload a second time. Answers whether the host
 * reloaded it, for a caller that keeps trying.
 */
export function reloadThroughHost(
	ctx: ExtensionContext,
	request: ReloadRequest,
): Promise<boolean> {
	const host = hosted();
	if (!host?.reload) return Promise.resolve(false);
	const slot = state(ctx);
	slot.request = undefined;
	slot.landing = request;
	return host.reload(sessionKeyOf(ctx), { reason: request.reason }).then(
		() => true,
		(error: unknown) => {
			slot.landing = undefined;
			const why = error instanceof Error ? error.message : String(error);
			say(
				ctx,
				`Nothing was reloaded: the host could not reload this conversation: ${why}.`,
			);
			return false;
		},
	);
}

/**
 * Who asked for this conversation's reload, waiting for its run to end
 * or handed to its host and not yet landed; nothing when none waits.
 */
export function hostedReloadAsker(
	ctx: SessionContext,
): ReloadRequest["by"] | undefined {
	const slot = state(ctx);
	return (slot.request ?? slot.landing)?.by;
}

/**
 * Why this conversation's reload, waiting for its run to end or handed
 * to its host and not yet landed, says it reloads; nothing when none
 * waits.
 */
export function hostedReloadReason(ctx: SessionContext): string | undefined {
	const slot = state(ctx);
	return (slot.request ?? slot.landing)?.reason;
}

/**
 * Say why again for a reload of the conversation's own that its host
 * has but hasn't landed, when more came in meanwhile, so the landing
 * names it all. One somebody else asked for keeps its own reason.
 */
export function retellHostedReload(ctx: SessionContext, reason: string): void {
	const slot = state(ctx);
	if (slot.request?.by === "self") slot.request = { ...slot.request, reason };
	if (slot.landing?.by === "self") slot.landing = { ...slot.landing, reason };
}

/** The landing a reloaded conversation's new runtime says, taken once. */
export function takeHostedLanding(
	ctx: SessionContext,
): ReloadLanded | undefined {
	const slot = state(ctx);
	const landing = slot.landing;
	slot.landing = undefined;
	return landing;
}

function say(ctx: ExtensionContext, text: string): void {
	try {
		ctx.ui.notify(text, "info");
	} catch {
		// A context with no screen to say it on.
	}
}
