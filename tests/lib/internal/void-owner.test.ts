import { describe, expect, it } from "vitest";
import {
	type OpenQuest,
	placeLine,
	readLine,
	type Sources,
} from "../../../lib/internal/void-owner.ts";

const GIT: OpenQuest = {
	id: "QEST-20261105-2AF2DH",
	title:
		"Git Maintenance for World That Is Fast, Effective and Never in Joel's Way",
	aliases: [],
	body: "",
	repos: ["world"],
};
const AQUIFER: OpenQuest = {
	id: "QEST-20261101-WM4KSZ",
	title: "Aquifer, Part Deux",
	aliases: [],
	body: "",
	repos: ["world"],
};
const SITE: OpenQuest = {
	id: "QEST-20261109-EO6QV7",
	title: "SITE: A Quick Site for Aquifer Part Deux's Vision",
	parent: AQUIFER.id,
	aliases: [],
	body: "Live at https://aquifer-part-deux.quick.shopify.io/ and its pages.",
	repos: [],
};
const SLEEP: OpenQuest = {
	id: "QEST-20261114-9XFX1H",
	title: "Sleeping Sessions Close Their Windows and Wake in Place",
	aliases: [],
	body: "",
	repos: ["core.nix"],
};
const ROWS: OpenQuest = {
	id: "QEST-20261110-F8TT8O",
	title: "Wi-Fi and Displays Rows Come Ready From Their Daemons",
	short: "Wi-Fi And Displays",
	aliases: [],
	body: "",
	repos: ["core.nix"],
};
const QUESTS = [GIT, AQUIFER, SITE, SLEEP, ROWS];

const ZONE = "delta.shopify.io/shop/world/tree/main/areas/incubating/aquifer";
const ZONED: OpenQuest = {
	...AQUIFER,
	aliases: [{ type: "url", value: ZONE }],
};

function sources(
	quests: readonly OpenQuest[] = QUESTS,
	mesh: readonly { from: string; text: string }[] = [],
	files: Readonly<Record<string, readonly string[]>> = {},
): Sources {
	return {
		quests,
		sendersOf: (needles) =>
			mesh
				.filter((m) => needles.some((n) => m.text.includes(n)))
				.map((m) => m.from),
		filesOf: (pull) => files[`${pull.host}/${pull.repo}#${pull.number}`],
		relays: new Set(["8GYNJ6", "WCJQSG"]),
	};
}

function line(words: string, ...rows: string[]): string {
	return `${words}\n\nAttached:\n${rows.map((r) => `- ${r}`).join("\n")}\n`;
}

function addresses(text: string, from = sources()): string[] {
	return placeLine(text, from).candidates.map((c) => c.address);
}

describe("reading a line", () => {
	it("splits his words from the rows he attached", () => {
		const said = readLine(
			line(
				"make this sparser",
				"window: Google Chrome · Mark Edges Sparsely · shop/world#2430582 - Google Chrome",
				"tab: Mark Edges Sparsely · shop/world#2430582 · https://delta.shopify.io/shop/world/pull/2430582",
			),
		);

		expect(said.words).toBe("make this sparser");
		expect(said.attached.tabTitle).toBe(
			"Mark Edges Sparsely · shop/world#2430582",
		);
		expect(said.attached.tabUrl).toBe(
			"https://delta.shopify.io/shop/world/pull/2430582",
		);
	});

	it("reads a line with nothing attached as all words", () => {
		expect(readLine("weather has no drawer").words).toBe(
			"weather has no drawer",
		);
	});
});

describe("placing a line", () => {
	it("puts an attached pi session first", () => {
		const text = line(
			"should sessions put to sleep even have windows?",
			"window: kitty · π - Wi-Fi And Displays… - core.nix",
			"pi session: Wi-Fi and Displays Rows Come Ready From Their Daemons · F8TT8O",
		);

		expect(addresses(text)).toEqual(["F8TT8O", "9XFX1H"]);
	});

	it("sends a pull request to the quest that holds it as an alias", () => {
		const claimed = {
			...GIT,
			aliases: [{ type: "delta-pr", value: "shop/world#2430582" }],
		};
		const text = line(
			"we don't want new git flags",
			"tab: Mark Edges Sparsely · https://delta.shopify.io/shop/world/pull/2430582",
		);

		expect(addresses(text, sources([claimed, AQUIFER]))).toEqual(["2AF2DH"]);
	});

	it("sends a pull request no quest holds to the session that wrote of it", () => {
		const text = line(
			"we don't want new git flags",
			"tab: Mark Edges Sparsely · shop/world#2430582 · https://delta.shopify.io/shop/world/pull/2430582",
		);
		const mesh = [
			{ from: "2AF2DH", text: "opened shop/world#2430582 as a draft" },
			{ from: "2AF2DH", text: "pushed shop/world#2430582 again" },
			{ from: "WCJQSG", text: "Joel said of shop/world#2430582" },
			{ from: "5FWIUS", text: "saw shop/world#2430582 go by" },
		];

		const placement = placeLine(text, sources(QUESTS, mesh));

		expect(placement.candidates[0]).toEqual({
			address: "2AF2DH",
			title: GIT.title,
			how: "wrote of shop/world#2430582 on the mesh",
		});
	});

	it("sends a page to the quest whose README names its site, then the quest above it", () => {
		const text = line(
			"the drawings look blown up",
			"tab: How a sandbox works · https://aquifer-part-deux.quick.shopify.io/sandbox.html",
		);

		expect(addresses(text)).toEqual(["EO6QV7", "WM4KSZ"]);
	});

	it("puts the quest above a site's quest straight after it", () => {
		const threads = {
			...ROWS,
			id: "QEST-20261113-KQL3KB",
			body: "saw aquifer-part-deux.quick.shopify.io",
		};
		const text = line(
			"give the five access",
			"tab: Aquifer · https://aquifer-part-deux.quick.shopify.io/",
		);

		expect(addresses(text, sources([SITE, threads, AQUIFER]))).toEqual([
			"EO6QV7",
			"WM4KSZ",
			"KQL3KB",
		]);
	});

	it("takes a site claimed as an alias over one only named in a README", () => {
		const claimed = {
			...AQUIFER,
			aliases: [{ type: "quick-site", value: "aquifer-part-deux" }],
		};
		const text = line(
			"give the five access",
			"tab: Aquifer · https://aquifer-part-deux.quick.shopify.io/",
		);

		expect(addresses(text, sources([claimed, SITE]))[0]).toBe("WM4KSZ");
	});

	it("names a pi window's quest by its short name when no session row came", () => {
		const text = line(
			"these rows lag",
			"window: kitty · π - Wi-Fi And Displays… - core.nix",
		);

		expect(addresses(text)[0]).toBe("F8TT8O");
	});

	it("matches his words against open quests' titles", () => {
		expect(addresses("sleeping sessions keep their windows open")).toEqual([
			"9XFX1H",
		]);
	});

	it("never offers a relay, and says what it tried when nothing fits", () => {
		const text = line(
			"under now, weather has no drawer",
			"pi session: Bootstrap optimus · WCJQSG",
		);

		const placement = placeLine(text, sources());

		expect(placement.candidates).toEqual([]);
		expect(placement.tried).toEqual([
			"the attached pi session WCJQSG",
			"his words (no title shares two)",
		]);
	});
});

describe("placing a pull request by the zone it touches", () => {
	const PULL = "https://delta.shopify.io/shop/world/pull/2431000";
	const KEY = "delta.shopify.io/shop/world#2431000";
	const text = line("why is this one stuck?", `tab: Tidy the sandbox · ${PULL}`);

	it("sends it to the quest that claims the tree its files sit under", () => {
		const files = {
			[KEY]: [
				"areas/incubating/aquifer/sandbox/main.rs",
				"areas/incubating/aquifer/README.md",
			],
		};

		const placement = placeLine(text, sources([GIT, ZONED], [], files));

		expect(placement.candidates[0]).toEqual({
			address: "WM4KSZ",
			title: AQUIFER.title,
			how: "claims areas/incubating/aquifer, where 2 of its 2 files sit",
		});
	});

	it("puts the zone's owner before the session that wrote of it", () => {
		const files = { [KEY]: ["areas/incubating/aquifer/api/lib.rs"] };
		const mesh = [{ from: "2AF2DH", text: "pushed shop/world#2431000" }];

		expect(addresses(text, sources([GIT, ZONED], mesh, files))).toEqual([
			"WM4KSZ",
			"2AF2DH",
		]);
	});

	it("prefers the deepest tree claimed over one above it", () => {
		const deeper = {
			...SITE,
			aliases: [{ type: "url", value: `https://${ZONE}/deploy` }],
		};
		const files = { [KEY]: ["areas/incubating/aquifer/deploy/v3.nix"] };

		expect(addresses(text, sources([ZONED, deeper], [], files))[0]).toBe(
			"EO6QV7",
		);
	});

	it("leaves a claimed tree alone when no file sits under it", () => {
		const files = { [KEY]: ["areas/tools/git/zone.nix"] };

		const placement = placeLine(text, sources([GIT, ZONED], [], files));

		expect(placement.candidates).toEqual([]);
		expect(placement.tried[0]).toBe(
			"the pull request shop/world#2431000 (no quest claims it or a tree its 1 file sits under, no session wrote of it)",
		);
	});

	it("never takes a sibling folder sharing the tree's name for the tree", () => {
		const files = { [KEY]: ["areas/incubating/aquifer-old/x.rs"] };

		expect(addresses(text, sources([ZONED], [], files))).toEqual([]);
	});
});

describe("placing a page under a claimed tree", () => {
	it("sends a file's page in the tree to the quest that claims it", () => {
		const text = line(
			"this README is out of date",
			`tab: README · https://delta.shopify.io/shop/world/blob/main/areas/incubating/aquifer/README.md`,
		);

		expect(addresses(text, sources([GIT, ZONED]))[0]).toBe("WM4KSZ");
	});

	it("never lets a tree's claim take every page on its host", () => {
		const text = line(
			"what's this?",
			"tab: Git · https://delta.shopify.io/shop/world/tree/main/areas/tools/git",
		);

		expect(addresses(text, sources([ZONED]))).toEqual([]);
	});
});
