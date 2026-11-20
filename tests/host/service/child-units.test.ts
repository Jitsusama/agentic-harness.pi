/** Where each child's files are, named so no slot can reach outside its folder. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	slotFolder,
	slotOf,
	slotsIn,
} from "../../../host/service/child-units.ts";

const key = "work-background";
const a = "a0000000-0000-4000-8000-000000000001";
let folder: string;

beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "cu-"));
});

afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe("a child's slot", () => {
	it("keeps its files in the host key's own folder, under its unit's instance", () => {
		expect(slotFolder("/run/user/1000", key)).toBe(
			"/run/user/1000/pi-host/work-background.d",
		);
		expect(slotOf(folder, key, a)).toEqual({
			name: a,
			socket: join(folder, `${a}.sock`),
			file: join(folder, `${a}.json`),
			folder: join(folder, `${a}.d`),
			unit: `pi-conversation-work-background@${a}.service`,
		});
	});

	it("refuses a name that could reach another path or unit", () => {
		expect(() => slotOf(folder, key, "../x")).toThrow("Not a slot's name");
		expect(() => slotOf(folder, key, `${a}.service x`)).toThrow(
			"Not a slot's name",
		);
		expect(() => slotFolder("run", key)).toThrow("absolute");
	});

	it("is found by its file alone, passing over what isn't a slot", async () => {
		await writeFile(join(folder, `${a}.json`), "{}\n");
		await writeFile(join(folder, "notes.json"), "{}\n");
		await writeFile(join(folder, `${a}.sock`), "");

		expect((await slotsIn(folder, key)).map(({ name }) => name)).toEqual([a]);
		expect(await slotsIn(join(folder, "none"), key)).toEqual([]);
	});
});
