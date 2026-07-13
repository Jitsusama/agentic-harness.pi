import type { EventBus } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	hostFrontEndBus,
	isFrontEndProvider,
	MCP_UNREGISTER_FRONTEND,
	provideFrontEnd,
} from "../../../../lib/mcp/frontend/events.js";
import type { FrontEndProvider } from "../../../../lib/mcp/frontend/types.js";

/** A minimal in-memory EventBus for driving the wiring. */
function fakeBus(): EventBus {
	const handlers = new Map<string, Array<(data: unknown) => void>>();
	return {
		on(channel, handler) {
			const list = handlers.get(channel) ?? [];
			list.push(handler);
			handlers.set(channel, list);
			return () =>
				handlers.set(
					channel,
					(handlers.get(channel) ?? []).filter((h) => h !== handler),
				);
		},
		emit(channel, data) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
	};
}

function provider(overrides: Partial<FrontEndProvider> = {}): FrontEndProvider {
	return {
		serverId: "s",
		providerId: "p",
		match: { kind: "glob", pattern: "slack_*" },
		renderResult: (() => ({})) as never,
		...overrides,
	};
}

describe("isFrontEndProvider", () => {
	it("accepts a well-formed provider", () => {
		expect(isFrontEndProvider(provider())).toBe(true);
	});

	it("rejects payloads missing ids, a matcher, or with a non-function hook", () => {
		expect(isFrontEndProvider(null)).toBe(false);
		expect(
			isFrontEndProvider({
				serverId: "s",
				match: { kind: "glob", pattern: "x" },
			}),
		).toBe(false);
		expect(
			isFrontEndProvider({
				serverId: "s",
				providerId: "p",
				match: { kind: "nope" },
			}),
		).toBe(false);
		expect(isFrontEndProvider({ ...provider(), shape: "not a function" })).toBe(
			false,
		);
	});
});

describe("hostFrontEndBus", () => {
	it("registers a valid provider for its server and reconciles", () => {
		const bus = fakeBus();
		const registry = { register: vi.fn(), unregister: vi.fn() };
		const onChange = vi.fn();
		hostFrontEndBus(bus, "s", registry, onChange);
		provideFrontEnd(bus, provider());
		expect(registry.register).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalled();
	});

	it("ignores a provider bound to another server", () => {
		const bus = fakeBus();
		const registry = { register: vi.fn(), unregister: vi.fn() };
		hostFrontEndBus(bus, "s", registry, vi.fn());
		provideFrontEnd(bus, provider({ serverId: "other" }));
		expect(registry.register).not.toHaveBeenCalled();
	});

	it("survives a throwing registration without faulting the bus", () => {
		const bus = fakeBus();
		const registry = {
			register: vi.fn(() => {
				throw new Error("boom");
			}),
			unregister: vi.fn(),
		};
		hostFrontEndBus(bus, "s", registry, vi.fn());
		expect(() => provideFrontEnd(bus, provider())).not.toThrow();
	});

	it("registers whichever order host and provider start in", () => {
		// Provider first: its immediate register is lost, then the host's ready
		// prompts a re-register.
		const bus = fakeBus();
		const registry = { register: vi.fn(), unregister: vi.fn() };
		provideFrontEnd(bus, provider());
		expect(registry.register).not.toHaveBeenCalled();
		hostFrontEndBus(bus, "s", registry, vi.fn());
		expect(registry.register).toHaveBeenCalledOnce();
	});

	it("drops the provider when it disposes", () => {
		const bus = fakeBus();
		const registry = { register: vi.fn(), unregister: vi.fn() };
		hostFrontEndBus(bus, "s", registry, vi.fn());
		const dispose = provideFrontEnd(bus, provider());
		dispose();
		expect(registry.unregister).toHaveBeenCalledWith("s", "p");
	});

	it("emits unregister with the right ids on dispose", () => {
		const bus = fakeBus();
		const seen: unknown[] = [];
		bus.on(MCP_UNREGISTER_FRONTEND, (d) => seen.push(d));
		const dispose = provideFrontEnd(bus, provider());
		dispose();
		expect(seen).toEqual([{ serverId: "s", providerId: "p" }]);
	});
});
