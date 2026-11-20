/** Where each child's files are, named so no slot can reach outside its folder. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Said,
	slotFolder,
	slotOf,
	slotsIn,
	systemdUnits,
	unitsOver,
} from "../../../host/service/child-units.ts";

const key = "work-background";
const a = "a0000000-0000-4000-8000-000000000001";
const b = "b0000000-0000-4000-8000-000000000002";
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

	it("refuses a folder whose sockets no Unix could bind whole", () => {
		expect(() => slotOf(`/${"x".repeat(80)}`, key, a)).toThrow("too long");
	});

	it("is found by any of its files, passing over what isn't a slot", async () => {
		await writeFile(join(folder, `${a}.json`), "{}\n");
		await writeFile(join(folder, `${a}.sock`), "");
		await mkdir(join(folder, `${b}.d`));
		await writeFile(join(folder, "notes.json"), "{}\n");

		const found = (await slotsIn(folder, key)).map(({ name }) => name);
		expect(found.sort()).toEqual([a, b]);
		expect(await slotsIn(join(folder, "none"), key)).toEqual([]);
	});
});

describe("a child's unit, as systemd says", () => {
	const unit = `pi-conversation-${key}@${a}.service`;

	/** Units over a systemctl that says `out` to every ask. */
	function saying(out: string, code = 0) {
		const asked: (readonly string[])[] = [];
		const units = unitsOver(async (args): Promise<Said> => {
			asked.push(args);
			return { code, out };
		});
		return { asked, units };
	}

	it("has gone once stopped or failed with nothing queued", async () => {
		for (const state of ["inactive", "failed"]) {
			const { units } = saying(`ActiveState=${state}\nJob=\n`);
			expect(await units.gone(unit), state).toBe(true);
		}
	});

	it("hasn't gone while starting, running, stopping or with a start queued", async () => {
		for (const said of [
			"ActiveState=activating\nJob=41\n",
			"ActiveState=active\nJob=\n",
			"ActiveState=deactivating\nJob=\n",
			"ActiveState=inactive\nJob=42\n",
		]) {
			const { units } = saying(said);
			expect(await units.gone(unit), said).toBe(false);
		}
	});

	it("starts and stops without waiting on the job, and says when systemd won't", async () => {
		const { asked, units } = saying("");
		await units.start(unit);
		await units.stop(unit);
		expect(asked).toEqual([
			["start", "--no-block", unit],
			["stop", "--no-block", unit],
		]);

		const refusing = saying("", 5).units;
		await expect(refusing.start(unit)).rejects.toThrow("would not start");
		await expect(refusing.gone(unit)).rejects.toThrow("would not say");
	});

	it("asks the user's systemd, which says a unit that never ran has gone", async (context) => {
		// Only where a user's systemd answers, as it doesn't in a container.
		if (!(await userSystemdAnswers())) context.skip();
		const never = "pi-conversation-never-ran@0.service";
		expect(await systemdUnits.gone(never)).toBe(true);
	});
});

/** Whether `systemctl --user` reaches a running user manager. */
function userSystemdAnswers(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("systemctl", ["--user", "show-environment"], (error) =>
			resolve(error === null),
		);
	});
}
