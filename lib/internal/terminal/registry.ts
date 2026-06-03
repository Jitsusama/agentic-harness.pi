/**
 * Terminal driver registry: process-global map from driver
 * id to `TerminalDriver`. Symmetric with refs and people
 * libraries; uses the same `globalThis` symbol slot
 * pattern.
 */

import type { TerminalDriver } from "../../terminal/types.js";

const REGISTRY_KEY = Symbol.for("pi:terminal-drivers");

type Registry = Map<string, TerminalDriver>;
type GlobalRegistry = Record<symbol, Registry | undefined>;

function getRegistry(): Registry {
	const slot = globalThis as GlobalRegistry;
	const existing = slot[REGISTRY_KEY];
	if (existing) return existing;
	const fresh: Registry = new Map();
	slot[REGISTRY_KEY] = fresh;
	return fresh;
}

export function register(driver: TerminalDriver): void {
	getRegistry().set(driver.id, driver);
}

export function unregister(id: string): void {
	getRegistry().delete(id);
}

export function clear(): void {
	getRegistry().clear();
}

export function get(id: string): TerminalDriver | undefined {
	return getRegistry().get(id);
}

export function list(): TerminalDriver[] {
	return [...getRegistry().values()];
}
