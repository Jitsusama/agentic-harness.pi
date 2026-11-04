/**
 * What the browser tools cost a start that never uses them: neither
 * the browser driver's root nor the image codec is loaded with them.
 * Each took hundreds of milliseconds of every pi start on 3 November,
 * and most sessions never open a browser or compare a picture. Nor is
 * the engine that drives a page, 126 modules on 4 November, until a
 * tool is called.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

const loaded = vi.hoisted(() => new Set<string>());

vi.mock("puppeteer-core", async (original) => {
	loaded.add("puppeteer-core");
	return original();
});
vi.mock("pngjs", async (original) => {
	loaded.add("pngjs");
	return original();
});
vi.mock("pixelmatch", async (original) => {
	loaded.add("pixelmatch");
	return original();
});
vi.mock("../../../lib/core/web/session.ts", async (original) => {
	loaded.add("the page engine");
	return original();
});

describe("the browser tools", () => {
	it("load neither the browser driver's root nor the image codec", async () => {
		await import("../../../extensions/browser-integration/index.ts");

		expect([...loaded]).toEqual([]);
	});

	it("register all four without loading the page engine", async () => {
		const { default: browserIntegration } = await import(
			"../../../extensions/browser-integration/index.ts"
		);
		const names: string[] = [];
		browserIntegration({
			registerTool: (tool: { name: string }) => names.push(tool.name),
			on: () => undefined,
		} as unknown as ExtensionAPI);

		expect(names.sort()).toEqual([
			"browser_check",
			"browser_do",
			"browser_go",
			"browser_see",
		]);
		expect([...loaded]).toEqual([]);
	});
});
