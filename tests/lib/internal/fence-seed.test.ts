/**
 * The fence's own homes seeded from what the person's programs already
 * downloaded, one way only.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seedOwnHomes } from "../../../lib/internal/fence-seed.ts";

const made: string[] = [];

/** A home folder whose cargo fetched one crate, and an empty sandbox cache. */
function place(): { home: string; own: string } {
	const root = mkdtempSync(join(tmpdir(), "fence-seed-"));
	made.push(root);
	const home = join(root, "home");
	const crates = join(home, ".cargo/registry/cache/index.crates.io-1");
	mkdirSync(crates, { recursive: true });
	writeFileSync(join(crates, "itoa-1.0.19.crate"), "itoa");
	mkdirSync(join(home, ".cargo/registry/src/index.crates.io-1/itoa-1.0.19"), {
		recursive: true,
	});
	writeFileSync(
		join(home, ".cargo/registry/src/index.crates.io-1/itoa-1.0.19/lib.rs"),
		"pub fn f() {}",
	);
	const index = join(home, ".cargo/registry/index/index.crates.io-1/.cache");
	mkdirSync(index, { recursive: true });
	writeFileSync(join(index, "it"), "entry");
	return { home, own: join(root, "cache") };
}

afterEach(() => {
	for (const root of made.splice(0))
		rmSync(root, { recursive: true, force: true });
});

describe("seeding the fence's own homes", () => {
	it("copies the person's crates and index into the fence's cargo home", async () => {
		const { home, own } = place();
		await seedOwnHomes(home, own);
		const cargo = join(own, "cargo/registry");
		expect(
			readFileSync(
				join(cargo, "cache/index.crates.io-1/itoa-1.0.19.crate"),
				"utf8",
			),
			"a crate the person's cargo fetched is in the fence's cache",
		).toBe("itoa");
		expect(
			readFileSync(join(cargo, "index/index.crates.io-1/.cache/it"), "utf8"),
			"the index entry came too",
		).toBe("entry");
	});

	it("leaves out the unpacked crates, which the fenced cargo unpacks itself", async () => {
		const { home, own } = place();
		await seedOwnHomes(home, own);
		expect(
			readdirSync(join(own, "cargo/registry")).sort(),
			"only the archives and the index are seeded",
		).toEqual(["cache", "index"]);
	});

	it("keeps a file the fence's cargo holds already", async () => {
		const { home, own } = place();
		const crates = join(own, "cargo/registry/cache/index.crates.io-1");
		mkdirSync(crates, { recursive: true });
		writeFileSync(join(crates, "itoa-1.0.19.crate"), "fetched inside");
		await seedOwnHomes(home, own);
		expect(
			readFileSync(join(crates, "itoa-1.0.19.crate"), "utf8"),
			"the fence's own copy wasn't replaced",
		).toBe("fetched inside");
		expect(readdirSync(crates), "no half-made copy is left behind").toEqual([
			"itoa-1.0.19.crate",
		]);
	});

	it("never writes back into the person's home", async () => {
		const { home, own } = place();
		await seedOwnHomes(home, own);
		writeFileSync(
			join(own, "cargo/registry/cache/index.crates.io-1/itoa-1.0.19.crate"),
			"planted",
		);
		expect(
			readFileSync(
				join(home, ".cargo/registry/cache/index.crates.io-1/itoa-1.0.19.crate"),
				"utf8",
			),
			"a write to the fence's copy leaves the person's file as it was",
		).toBe("itoa");
	});

	it("follows no link out of the person's folder", async () => {
		const { home, own } = place();
		const secret = join(home, "secret");
		writeFileSync(secret, "key");
		symlinkSync(
			secret,
			join(home, ".cargo/registry/cache/index.crates.io-1/leak"),
		);
		await seedOwnHomes(home, own);
		expect(
			readdirSync(join(own, "cargo/registry/cache/index.crates.io-1")),
			"the link wasn't copied",
		).toEqual(["itoa-1.0.19.crate"]);
	});

	it("seeds again only once the last seeding is ten minutes old", async () => {
		const { home, own } = place();
		const now = Date.now();
		await seedOwnHomes(home, own, now);
		expect(
			seedOwnHomes(home, own, now + 60_000),
			"a minute later it doesn't walk the registry again",
		).toBeUndefined();
		const later = seedOwnHomes(home, own, now + 11 * 60_000);
		expect(later, "eleven minutes later it seeds again").toBeDefined();
		await later;
	});

	it("does nothing for a person with no cargo", async () => {
		const root = mkdtempSync(join(tmpdir(), "fence-seed-"));
		made.push(root);
		await seedOwnHomes(join(root, "home"), join(root, "cache"));
		expect(readdirSync(root), "no own home is made from nothing").toEqual([]);
	});
});
