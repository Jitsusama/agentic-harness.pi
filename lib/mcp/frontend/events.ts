import type { EventBus } from "@mariozechner/pi-coding-agent";
import type { FrontEndRegistry } from "./registry.js";
import type { FrontEndMatcher, FrontEndProvider } from "./types.js";

/** Channel a provider emits to offer itself to a host. Payload: a FrontEndProvider. */
export const MCP_REGISTER_FRONTEND = "mcp:register-frontend";
/** Channel a provider emits to withdraw. Payload: { serverId, providerId }. */
export const MCP_UNREGISTER_FRONTEND = "mcp:unregister-frontend";
/** Channel a host emits once its registry is listening. Payload: { serverId }. */
export const MCP_READY = "mcp:ready";

const HOOK_KEYS = ["shape", "renderCall", "renderResult", "wrap"] as const;

/** Whether an inbound bus payload is a usable front-end provider, since it may come from a third party. */
export function isFrontEndProvider(data: unknown): data is FrontEndProvider {
	if (typeof data !== "object" || data === null) return false;
	const p = data as Record<string, unknown>;
	if (typeof p.serverId !== "string" || typeof p.providerId !== "string")
		return false;
	if (!isMatcher(p.match)) return false;
	if (p.priority !== undefined && typeof p.priority !== "number") return false;
	return HOOK_KEYS.every(
		(key) => p[key] === undefined || typeof p[key] === "function",
	);
}

function isMatcher(value: unknown): value is FrontEndMatcher {
	if (typeof value !== "object" || value === null) return false;
	const m = value as Record<string, unknown>;
	switch (m.kind) {
		case "tool":
			return typeof m.name === "string";
		case "glob":
			return typeof m.pattern === "string";
		case "backend":
			return typeof m.backend === "string";
		case "predicate":
			return typeof m.test === "function";
		default:
			return false;
	}
}

/**
 * Attach the host's register and unregister listeners for `serverId`, then
 * announce readiness. A registration that throws is isolated so one bad
 * provider cannot fault the bus. Returns a disposer that detaches the
 * listeners.
 */
export function hostFrontEndBus(
	bus: EventBus,
	serverId: string,
	registry: Pick<FrontEndRegistry, "register" | "unregister">,
	onChange: () => void,
): () => void {
	const offRegister = bus.on(MCP_REGISTER_FRONTEND, (data) => {
		if (!isFrontEndProvider(data) || data.serverId !== serverId) return;
		try {
			registry.register(data);
			onChange();
		} catch {
			// A provider's own registration should never fault the host bus.
		}
	});
	const offUnregister = bus.on(MCP_UNREGISTER_FRONTEND, (data) => {
		if (typeof data !== "object" || data === null) return;
		const { serverId: sid, providerId } = data as Record<string, unknown>;
		if (sid !== serverId || typeof providerId !== "string") return;
		registry.unregister(serverId, providerId);
		onChange();
	});

	bus.emit(MCP_READY, { serverId });

	return () => {
		offRegister();
		offUnregister();
	};
}

/**
 * Offer a provider to its host now and again whenever the host announces it is
 * ready, so neither load order drops the registration. Returns a disposer that
 * withdraws the provider.
 */
export function provideFrontEnd(
	bus: EventBus,
	provider: FrontEndProvider,
): () => void {
	bus.emit(MCP_REGISTER_FRONTEND, provider);
	const offReady = bus.on(MCP_READY, (data) => {
		if (
			typeof data === "object" &&
			data !== null &&
			(data as Record<string, unknown>).serverId === provider.serverId
		) {
			bus.emit(MCP_REGISTER_FRONTEND, provider);
		}
	});
	return () => {
		offReady();
		bus.emit(MCP_UNREGISTER_FRONTEND, {
			serverId: provider.serverId,
			providerId: provider.providerId,
		});
	};
}
