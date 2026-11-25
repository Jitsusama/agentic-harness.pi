/**
 * An arriving tree's clone the disk won't move into place or take out:
 * the tree is refused saying so, and where its clone is left, never
 * thrown out of the arrival. The disk is faked for the clone's own
 * folder alone, so it gets a file of its own: a mock of `node:fs`
 * covers every test in its file.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { CLONING } from "../../../../lib/internal/carry/twin.ts";
import { arrivals, fakeClock } from "./support/arriving.ts";
import { exec, folder, removeAll } from "./support/machines.ts";

/** What the disk refuses of an arriving clone's own folder, and with what. */
const refusing = vi.hoisted(() => ({
	rename: undefined as string | undefined,
	remove: undefined as string | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	/** A failure as node's own fs throws it, code and all. */
	const refused = (code: string, call: string, path: string) =>
		Object.assign(new Error(`${code}: refused, ${call} '${path}'`), { code });
	return {
		...real,
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			const from = String(args[0]);
			if (refusing.rename !== undefined && from.includes(".cloning-")) {
				throw refused(refusing.rename, "rename", from);
			}
			real.renameSync(...args);
		},
		rmSync: (...args: Parameters<typeof real.rmSync>) => {
			const path = String(args[0]);
			if (refusing.remove !== undefined && path.includes(".cloning-")) {
				throw refused(refusing.remove, "rm", path);
			}
			real.rmSync(...args);
		},
	};
});

const made: string[] = [];
afterEach(() => {
	refusing.rename = undefined;
	refusing.remove = undefined;
	removeAll(made);
});

const { carried, arriveAt } = arrivals(made);

/** What is in `folder`, or nothing where it was never made. */
const leftIn = (at: string) => (existsSync(at) ? readdirSync(at) : []);

describe("an arriving clone the disk won't put in place", () => {
	it("refuses its tree saying why, and takes the clone out", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		refusing.rename = "EACCES";

		const { whole, said } = await arriveAt(home, from);

		expect(whole, "a refused tree leaves the arrival not whole").toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: expect.stringMatching(
				/^Its clone couldn't be put in place: EACCES: refused, rename '.*\.cloning-[^']+'$/,
			),
		});
		expect(leftIn(join(home, "src")), "nothing of the clone").toEqual([]);
	});

	it("says where its clone is left when it can't be taken out either, rather than throwing", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		refusing.rename = "EACCES";
		refusing.remove = "EBUSY";

		const { whole, said } = await arriveAt(home, from);

		expect(whole).toBe(false);
		const [clone] = leftIn(join(home, "src"));
		expect(clone, "the clone stays, since it couldn't go").toContain(CLONING);
		const at = join(home, "src", clone ?? "");
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `Its clone couldn't be put in place: EACCES: refused, rename '${at}'. And its clone is left at ${at}, since it couldn't be taken out: EBUSY: refused, rm '${at}'.`,
		});
	});

	it("says where its clone is left when something arrived there meanwhile", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		const path = join(home, "src", "app");
		refusing.remove = "EBUSY";
		const racing: Exec = async (command, args) => {
			const done = await exec(command, args);
			if (command === "git" && args.includes("clone")) {
				mkdirSync(path);
				writeFileSync(join(path, "theirs"), "kept\n");
			}
			return done;
		};

		const { said } = await arriveAt(home, from, fakeClock(), [], {}, racing);

		const clone = leftIn(join(home, "src")).find((one) =>
			one.includes(CLONING),
		);
		const at = join(home, "src", clone ?? "");
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `Something arrived there while it was cloned. And its clone is left at ${at}, since it couldn't be taken out: EBUSY: refused, rm '${at}'.`,
		});
	});
});
