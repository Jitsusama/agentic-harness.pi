/**
 * The host's section of the package's config file: the quiet collection
 * on unless it says false, and a section that can't be read said in the
 * journal with the defaults kept.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostSettings } from "../../../host/service/settings.ts";

describe("the host's settings", () => {
	let dir: string;
	let path: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "host-settings-"));
		path = join(dir, "config.json");
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function written(sections: unknown): string {
		writeFileSync(path, JSON.stringify({ version: 1, sections }));
		return path;
	}

	it("collects when quiet with no config file", async () => {
		const said: string[] = [];
		expect(await hostSettings((one) => said.push(one), path)).toEqual({
			collectWhenQuiet: true,
		});
		expect(said).toEqual([]);
	});

	it("collects when quiet with a host section that doesn't say", async () => {
		expect(await hostSettings(() => {}, written({ host: {} }))).toEqual({
			collectWhenQuiet: true,
		});
	});

	it("turns the quiet collection off when the section says false", async () => {
		const settings = await hostSettings(
			() => {},
			written({ host: { collectWhenQuiet: false } }),
		);
		expect(settings).toEqual({ collectWhenQuiet: false });
	});

	it("keeps the default and says why when the value isn't true or false", async () => {
		const said: string[] = [];
		const settings = await hostSettings(
			(one) => said.push(one),
			written({ host: { collectWhenQuiet: "off" } }),
		);
		expect(settings).toEqual({ collectWhenQuiet: true });
		expect(said).toEqual([
			expect.stringContaining("collectWhenQuiet that isn't true or false"),
		]);
	});

	it("keeps the defaults and says why when the file isn't JSON", async () => {
		writeFileSync(path, "{");
		const said: string[] = [];
		expect(await hostSettings((one) => said.push(one), path)).toEqual({
			collectWhenQuiet: true,
		});
		expect(said).toEqual([expect.stringContaining("Could not parse")]);
	});
});
