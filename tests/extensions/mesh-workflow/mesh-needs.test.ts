/**
 * Sending to `need`: a message goes to the live cell that works on what
 * it is about, found over the node's ties, and is kept for the measure;
 * a need nothing within reach works on is refused, and passed to nobody
 * in its place.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	FIND_WHILE_QUIET,
	FIND_WHO_OWNS_IT,
	NEED_GRANTS_NOTHING,
} from "../../../extensions/mesh-workflow/tools/need.ts";
import { createPresences } from "../../../lib/mesh/presence.ts";
import { folderTransport } from "../../../lib/mesh/transport.ts";
import { fixture, peer, startSession } from "./support/mesh.ts";
import { asker, expectNoBarAbove, sending } from "./support/need.ts";
import { closeNodes, node } from "./support/node.ts";

afterEach(closeNodes);

describe("sending to a need", () => {
	it("goes to the live cell along the ties that works on it, and is kept", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:5HJZ8Z", title: "Carry a Session", repo: "mycelium" },
			],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said).toContain("Sent as 7M6JKG");
		expect(said).toContain("went to 5HJZ8Z");
		// A fit works on it, which is no grant: that comes from the person or
		// the peer whose quest holds the work, and the answer says how to see.
		expect(said).toContain(NEED_GRANTS_NOTHING);
		expect(NEED_GRANTS_NOTHING).toContain(
			"the person or from the work's owner: the peer whose own quest holds it (mesh_groups names each peer's own quest)",
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(id && transport.read(id)).toMatchObject({
			to: ["@5HJZ8Z"],
			intent: "question",
		});
		const [day] = readdirSync(join(fixture.paths.mesh, "needs"));
		const kept = JSON.parse(
			readFileSync(join(fixture.paths.mesh, "needs", day ?? ""), "utf8"),
		);
		expect(kept).toMatchObject({
			asker: "7M6JKG",
			words: ["carry"],
			path: ["5HJZ8Z"],
			fit: "5HJZ8Z",
		});
	});

	it("is refused, and sent to nobody, when no cell works on any word of its about", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who keeps the launcher's fonts?",
			about: "fonts",
		});

		expect(said).toContain("Not sent: no word of its about");
		expect(said, "nothing above to ask").toContain(FIND_WHO_OWNS_IT);
		expect(said).toContain("counted as lost and passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	it("is refused, and sent to nobody, when no cell works on any word of its text", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who keeps the launcher's fonts?",
		});

		expect(said).toContain("Not sent: no word of its text");
		expect(said, "nothing above to ask").toContain(FIND_WHO_OWNS_IT);
		expect(said).toContain("counted as lost and passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	it("keeps only the text's words a cell works on when about is left out", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "fyi",
			text: `The carry failed with ghp_${"Ab3".repeat(14)} in its log.`,
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "a text's words go unsaid").not.toContain("No cell works on");
		expect(said.toLowerCase()).not.toContain("ab3ab3");

		const [day] = readdirSync(join(fixture.paths.mesh, "needs"));
		const file = readFileSync(
			join(fixture.paths.mesh, "needs", day ?? ""),
			"utf8",
		);
		expect(JSON.parse(file)).toMatchObject({ words: ["carry"] });
		expect(file).not.toContain("ghp");
		expect(file.toLowerCase()).not.toContain("ab3ab3");
	});

	it("takes no cell the node keeps that isn't on the mesh now, and names it", async () => {
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said).toContain("Not sent: no live cell within three ties");
		expect(said, "nothing above to ask").toContain(FIND_WHO_OWNS_IT);
		expect(said).toContain("counted as lost and passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
		expect(said).toContain("5HJZ8Z works on it but has ended");
		expect(said, "with no stopper, any peer may be named").toContain(
			"Name the peers it is for by address.",
		);
	});

	it("is refused, naming the owner that ended and the live cell found, when the owner worked on more of it", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:J7XHQN", title: "Dates Delivery" },
				{ key: "cell:5HJZ8Z", title: "Delivery Lanes" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{
					key: "tie:7M6JKG~J7XHQN",
					strength: 1,
					heard: Date.now(),
					today: [0, 1],
				},
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "When does the delivery land?",
			about: "dates delivery",
		});

		expect(said, "a live cell was found, so it never says none was").toContain(
			"Not sent: J7XHQN worked on more of dates delivery than 5HJZ8Z, the live cell found, but isn't present now, so it was not sent to a cell sharing less of it.",
		);
		expect(said).not.toContain("no live cell within three ties");
		expect(said).toContain(
			"Sending it again once J7XHQN is present reaches J7XHQN or a cell covering as much of it or more, unless J7XHQN has stopped this one.",
		);
		expect(said, "only the owner works on dates").toContain(
			"No live cell works on dates, so it found nobody and the live cell was found by delivery alone.",
		);
		expect(said, "never said to be routed, being sent nowhere").not.toContain(
			"routed by",
		);
		expect(said).toContain("Name 5HJZ8Z or another peer it is for by address");
		expect(said, "nothing above to ask").toContain(FIND_WHO_OWNS_IT);
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
		const [day] = readdirSync(join(fixture.paths.mesh, "needs"));
		const kept = JSON.parse(
			readFileSync(join(fixture.paths.mesh, "needs", day ?? ""), "utf8"),
		);
		expect(kept, "kept as lost, naming who fell short").toMatchObject({
			fit: null,
			ended: ["J7XHQN"],
			fellShort: "5HJZ8Z",
			path: [],
		});
	});

	it("names the words no cell works on in a refusal for an owner not present", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:J7XHQN", title: "Dates Delivery" },
				{ key: "cell:5HJZ8Z", title: "Delivery Lanes" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{
					key: "tie:7M6JKG~J7XHQN",
					strength: 1,
					heard: Date.now(),
					today: [0, 1],
				},
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "When does the delivery land, fonts and all?",
			about: "dates delivery fonts",
		});

		expect(said).toContain("J7XHQN worked on more of dates delivery");
		expect(said).toContain(
			"No cell works on fonts, and no live cell on dates, so they found nobody and the live cell was found by delivery alone.",
		);
	});

	it("names the words no cell works on in a refusal for a need found nowhere, never saying it was routed", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Dates Delivery" }],
			[],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "When does the delivery land, fonts and all?",
			about: "dates delivery fonts",
		});

		expect(said).toContain(
			"works on dates delivery. No cell works on fonts. It is counted as lost",
		);
		expect(said).not.toContain("routed by");
	});

	it("says nothing of a joined id whose every part routed it", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Mesh Workflow" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who reads a need's words?",
			about: "mesh-workflow need",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "need, held by none, is still named").toContain(
			"No cell works on need, so it found nobody",
		);
		expect(said).not.toContain("mesh-workflow, ");
		expect(said).not.toContain("No cell works on mesh-workflow");
	});

	// The asker wrote check out, so check says it; check-out is an id it
	// never wrote (#2220's seventh round, F69).
	it("names a phrase no cell works on by its first word alone", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Lease Files" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who can look at the lease files?",
			about: "check out the lease files",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "check alone, as written").toContain(
			"No cell works on check, so it found nobody",
		);
		expect(said, "no id the asker never wrote").not.toContain("check-out");
	});

	it("says nothing of a joined id whose short part could never be a word, but names a numbered one", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Pi Host" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who runs leg 27 on the pi host?",
			about: "pi-host leg-27",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "pi is too short to be a word").not.toMatch(
			/No cell works on [^.]*pi-host/,
		);
		expect(said, "its number said apart may be anything's").toMatch(
			/No cell works on [^.]*leg-27/,
		);
	});

	// A leg-26 cell holds leg, and the reply once said a need for leg 27
	// was routed by it, though no cell took it on leg (#2118's round 2).
	it("says a need for leg 27 was routed by no word only another leg's cell holds", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		peer("session-d", ["L26AAA"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:5HJZ8Z", title: "Easing" },
				{ key: "cell:L26AAA", title: "Leg 26" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{ key: "tie:7M6JKG~L26AAA", strength: 3, heard: Date.now() },
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Who eases leg 27?",
			about: "easing leg-27",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "leg-27, its leg said with it").toContain(
			"No cell works on leg-27, so it found nobody and it was routed by easing alone.",
		);
	});

	it("says nothing of the words no cell works on once it kept the most a need keeps", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{
					key: "cell:5HJZ8Z",
					title:
						"Carry Fonts Glyphs Kerning Ligatures Hinting Weights Widths Serifs Italics Accents Spacing Margins",
				},
			],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep all of these?",
			about:
				"carry fonts glyphs kerning ligatures hinting weights widths serifs italics accents spacing margins",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "a held word was dropped, so none is named").not.toContain(
			"No cell works on",
		);
	});

	it("names every word no cell works on, however many, when it kept fewer than the most", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep all of these?",
			about:
				"carry fonts glyphs kerning ligatures hinting weights widths serifs italics accents spacing margins",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said).toContain("No cell works on fonts, glyphs, kerning,");
		expect(said).toContain(
			"margins, so they found nobody and it was routed by carry alone.",
		);
	});

	it("never names a word too long to be one, as it may be a token", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep it?",
			about: `carry ghp_${"Ab3".repeat(14)}`,
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said.toLowerCase()).not.toContain("ab3ab3");
	});

	it("takes the live cell found when its owner was last heard over six hours ago", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:J7XHQN", title: "Dates Delivery" },
				{ key: "cell:5HJZ8Z", title: "Delivery Lanes" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{
					key: "tie:7M6JKG~J7XHQN",
					strength: 1,
					heard: Date.now() - 7 * 60 * 60 * 1000,
					today: [0, 1],
				},
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "When does the delivery land?",
			about: "dates delivery",
		});

		expect(said, "a record that old owns nothing").toContain("went to 5HJZ8Z");
		expect(said).not.toContain("isn't present now");
		expect(said, "its asker still hears of dates").toContain(
			"No live cell works on dates, so it found nobody and it was routed by delivery alone.",
		);
	});

	it("says which words of its about no cell works on, when it goes by the rest", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its fonts?",
			about: "fonts carry",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said).toContain(
			"No cell works on fonts, so it found nobody and it was routed by carry alone.",
		);
	});

	// The asker's own title says funnel, and the reply once said the need
	// was routed by it too, though a word it holds routes nowhere
	// (#2118's council F15).
	it("says it went by no word only its asker works on", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep the funnel's fonts?",
			about: "fonts carry funnel",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said).toContain(
			"No cell works on fonts, so it found nobody and it was routed by carry alone.",
		);
	});

	it("names an ended cell heard from lately that works on a word no live cell does", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:J7XHQN", title: "Dates" },
				{ key: "cell:5HJZ8Z", title: "Delivery Lanes" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{
					key: "tie:7M6JKG~J7XHQN",
					strength: 1,
					heard: Date.now(),
					today: [0, 1],
				},
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "When does the delivery land?",
			about: "dates delivery",
		});

		expect(said).toContain("went to 5HJZ8Z");
		expect(said, "its asker hears of dates").toContain(
			"J7XHQN works on it but has ended, so it was passed over.",
		);
	});

	it("takes no cell that stopped this one, since it can't be written to", async () => {
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-c",
			addresses: ["5HJZ8Z"],
			groups: [],
			worksOn: "",
			owns: [],
			busy: false,
			stops: [{ address: "7M6JKG", at: new Date().toISOString() }],
			at: new Date().toISOString(),
		});
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said).toContain("Not sent");
		expect(said).toContain("counted as lost");
		expect(said, "it names who works on it and why not").toContain(
			"5HJZ8Z works on it but stopped this peer",
		);
		expect(said, "it points at another peer, not the one refusing").toContain(
			"Name another peer it is for by address",
		);
		expect(said, "nothing above to ask").toContain(FIND_WHO_OWNS_IT);
		expect(said, "it is there, so it never reads as ended").not.toContain(
			"has ended",
		);
	});

	it("finds a need through a cell that stopped this one, which never hears it", async () => {
		createPresences(join(fixture.paths.mesh, "presence")).publish({
			session: "session-c",
			addresses: ["5HJZ8Z"],
			groups: [],
			worksOn: "",
			owns: [],
			busy: false,
			stops: [{ address: "7M6JKG", at: new Date().toISOString() }],
			at: new Date().toISOString(),
		});
		peer("session-d", ["0TUD09"], []);
		const env = await node(
			[
				asker,
				{ key: "cell:5HJZ8Z", title: "Carry a Session" },
				{ key: "cell:0TUD09", title: "Carry a Tree" },
			],
			[
				{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() },
				{ key: "tie:5HJZ8Z~0TUD09", strength: 3, heard: Date.now() },
			],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "question",
			text: "Does a carry keep its tree's network?",
			about: "carry",
		});

		expect(said, "0TUD09, one tie past the stopper").toContain(
			"went to 0TUD09",
		);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		const [id] = transport.ids();
		expect(
			id && transport.read(id),
			"the stopper is never written to",
		).toMatchObject({
			to: ["@0TUD09"],
		});
	});

	it("never crosses into another realm", async () => {
		peer("session-c", ["5HJZ8Z"], []);
		const env = await node(
			[asker, { key: "cell:5HJZ8Z", title: "Carry a Session" }],
			[{ key: "tie:7M6JKG~5HJZ8Z", strength: 3, heard: Date.now() }],
		);
		const { tools } = await startSession(env);

		const said = await sending(tools, {
			to: "need",
			intent: "fyi",
			text: "The carry note is up.",
			about: "carry",
			realm: "home",
		});

		expect(said).toContain("Not sent");
		expect(said).toContain("can't cross into another");
	});

	it("is refused when no node answers", async () => {
		const { tools } = await startSession({
			MYCELIUM_REALM: "work",
			XDG_RUNTIME_DIR: join(fixture.root, "nowhere"),
		});

		const said = await sending(tools, {
			to: "need",
			intent: "fyi",
			text: "The carry note is up.",
			about: "carry",
		});

		expect(said).toContain("Not sent: no node answered");
		// A quiet node says nothing of what is above, and none is kept.
		expect(said, "none found while quiet").toContain(FIND_WHILE_QUIET);
		expect(said).not.toContain(FIND_WHO_OWNS_IT);
		expect(said).toContain("passed to nobody in its place");
		expectNoBarAbove(said);
		const transport = folderTransport(join(fixture.paths.mesh, "messages"));
		expect(transport.ids()).toEqual([]);
	});

	// Every session reads mesh_send's description in its tool list, long
	// before any refusal, so it may no more bar asking above than they.
	it("is described in mesh_send's own words as passed to nobody, never as kept from above", async () => {
		const { tools } = await startSession();

		const tool: unknown = tools.get("mesh_send");
		const description =
			typeof tool === "object" &&
			tool !== null &&
			"description" in tool &&
			typeof tool.description === "string"
				? tool.description
				: "";

		expect(description).toContain("passed to nobody in its place");
		expectNoBarAbove(description);
	});
});
