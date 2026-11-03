/**
 * What the browser tools cost a start that never uses them: neither
 * the browser driver's root nor the image codec is loaded with them.
 * Each took hundreds of milliseconds of every pi start on 3 November,
 * and most sessions never open a browser or compare a picture.
 */
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

describe("the browser tools", () => {
	it("load neither the browser driver's root nor the image codec", async () => {
		await import("../../../extensions/browser-integration/index.ts");

		expect([...loaded]).toEqual([]);
	});
});
