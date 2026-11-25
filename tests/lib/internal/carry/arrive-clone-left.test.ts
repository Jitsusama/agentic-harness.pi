/**
 * An arriving tree's clone the disk won't move into place or take out:
 * the tree is refused saying so, and where its clone is left, never
 * thrown out of the arrival. The disk is faked for the clone's own
 * folder, or one folder a test names, so it gets a file of its own: a
 * mock of `node:fs` covers every test in its file.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Exec } from "../../../../lib/core/exec/index.ts";
import { CLONING } from "../../../../lib/internal/carry/twin.ts";
import { arrivals, fakeClock } from "./support/arriving.ts";
import { cloneAt, exec, folder, removeAll } from "./support/machines.ts";

/**
 * What the disk refuses of an arriving clone's own folder, and with what;
 * or, for its removal, of the folders `removing` takes where it is given.
 */
const refusing = vi.hoisted(() => ({
	rename: undefined as string | undefined,
	remove: undefined as string | undefined,
	removing: undefined as ((path: string) => boolean) | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
	const real = await importOriginal<typeof import("node:fs")>();
	/** A failure as node's own fs throws it, code and all. */
	const refused = (code: string, call: string, path: string) =>
		Object.assign(new Error(`${code}: refused, ${call} '${path}'`), { code });
	/** Whether `path` is a clone's own folder, not a file within one. */
	const aClone = (path: string) => /\.cloning-[^/]+$/.test(path);
	return {
		...real,
		renameSync: (...args: Parameters<typeof real.renameSync>) => {
			const from = String(args[0]);
			if (refusing.rename !== undefined && aClone(from)) {
				throw refused(refusing.rename, "rename", from);
			}
			real.renameSync(...args);
		},
		rmSync: (...args: Parameters<typeof real.rmSync>) => {
			const path = String(args[0]);
			const named =
				refusing.removing === undefined
					? aClone(path)
					: refusing.removing(path);
			if (refusing.remove !== undefined && named) {
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
	refusing.removing = undefined;
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

	it("says where a clone of its twin is left when it can't be held to origin, never at the tree's own place", async () => {
		const { from, origin } = await carried();
		const home = folder(made, "arriving");
		await cloneAt(origin, join(home, "src", "twin"));
		refusing.remove = "EBUSY";
		const unpointed: Exec = async (command, args) =>
			args.includes("set-url")
				? { code: 128, stdout: "", stderr: "fatal: refused" }
				: await exec(command, args);

		const { whole, said } = await arriveAt(
			home,
			from,
			fakeClock(),
			[],
			{},
			unpointed,
		);

		expect(whole).toBe(false);
		const [clone, ...others] = leftIn(join(home, "src")).filter(
			(one) => one !== "twin",
		);
		expect(others, "nothing at the tree's own place").toEqual([]);
		expect(clone).toContain(CLONING);
		const at = join(home, "src", clone ?? "");
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `git couldn't point it at ${origin}: fatal: refused. And its clone is left at ${at}, since it couldn't be taken out: EBUSY: refused, rm '${at}'.`,
		});
	});

	it("arrives from its twin though the files it feeds git can't be taken out", async () => {
		const { from, origin, head } = await carried();
		const home = folder(made, "arriving");
		await cloneAt(origin, join(home, "src", "twin"));
		const fed: string[] = [];
		refusing.remove = "EBUSY";
		refusing.removing = (at) => {
			const feeding = /\/\.git\/carry-in-[^/]+$/.test(at);
			if (feeding) fed.push(at);
			return feeding;
		};

		const { whole, said } = await arriveAt(home, from);

		expect(fed.length, "git was fed lines through a file").toBeGreaterThan(0);
		expect(whole, "every tree arrived whole").toBe(true);
		expect(said[0]).toMatchObject({ did: "cloned" });
		expect(
			(
				await exec("git", ["-C", join(home, "src", "app"), "rev-parse", "HEAD"])
			).stdout.trim(),
		).toBe(head);
	});

	it("says where a cloned tree is left when settling it fails and it can't be taken out", async () => {
		const { from } = await carried();
		const home = folder(made, "arriving");
		const path = join(home, "src", "app");
		refusing.remove = "EBUSY";
		refusing.removing = (at) => at === path;
		const unsettled: Exec = async (command, args) =>
			args.includes("checkout") && args.includes("-B")
				? { code: 128, stdout: "", stderr: "fatal: refused" }
				: await exec(command, args);

		const { whole, said } = await arriveAt(
			home,
			from,
			fakeClock(),
			[],
			{},
			unsettled,
		);

		expect(whole).toBe(false);
		expect(said[0]).toMatchObject({
			did: "refused",
			why: `git couldn't check out topic: fatal: refused. And its clone is left at ${path}, since it couldn't be taken out: EBUSY: refused, rm '${path}'.`,
		});
	});
});
