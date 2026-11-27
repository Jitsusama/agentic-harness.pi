import { describe, expect, it } from "vitest";
import { quietFor, until } from "../../support/until.ts";
import {
	type Answer,
	agreed,
	link,
	linked,
	node,
	presence,
	useStandInNode,
} from "../../support/worker-node.ts";

useStandInNode();

/** The node as agreed, answering an End as `ending` says. */
const endingWith =
	(ending: string): Answer =>
	(asked, on) =>
		"End" in asked ? [ending] : agreed()(asked, on);

describe("ending a held session through its link", () => {
	it("says the End on the connection holding its presence, once taken", async () => {
		const held = await node(endingWith('{"Ok":"Ending"}'));
		linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		const ended = await link?.end("holder-1");

		expect(ended, "the node's Ok settles it as ended").toEqual({ ok: true });
		expect(
			held.connections[0]?.said,
			"the End follows the presence it holds",
		).toEqual([
			{ Presence: { presence: presence() } },
			{ End: { held: "holder-1" } },
		]);
		expect(held.connections, "no connection is opened for it").toHaveLength(2);
		expect(held.connections[1]?.said, "the watch says no End").toEqual([
			expect.objectContaining({ Watch: expect.anything() }),
		]);
	});

	it("settles as refused, with the node's why, when the node says no", async () => {
		const held = await node(endingWith('{"Err":"no holder by that id"}'));
		linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		expect(await link?.end("holder-1")).toEqual({
			refused: "no holder by that id",
		});
	});

	it("writes nothing and settles as refused with no presence held", async () => {
		const held = await node(endingWith('{"Ok":"Ending"}'));
		linked();

		const ended = await link?.end("holder-1");
		await quietFor(10, 5);

		expect(ended, "there is no connection to say it on").toEqual({
			refused:
				"the node holds no presence of this session yet, and an end goes only on the connection holding one",
		});
		expect(held.connections, "none is opened for it").toHaveLength(0);
	});

	it("writes nothing before the node took the presence it said", async () => {
		const held = await node((asked, on) =>
			"Presence" in asked ? [] : endingWith('{"Ok":"Ending"}')(asked, on),
		);
		linked();
		link?.present(presence());
		await until(
			"the presence is said",
			() => (held.connections[0]?.said.length ?? 0) === 1,
		);

		const ended = await link?.end("holder-1");
		await quietFor(10, 5);

		expect(ended, "the node holds no presence to end it by").toEqual({
			refused:
				"the node holds no presence of this session yet, and an end goes only on the connection holding one",
		});
		expect(held.connections[0]?.said, "only the presence was said").toEqual([
			{ Presence: { presence: presence() } },
		]);
	});

	it("writes nothing and settles as refused once the link closed", async () => {
		const held = await node(endingWith('{"Ok":"Ending"}'));
		linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);
		link?.close();

		const ended = await link?.end("holder-1");

		expect(ended).toEqual({
			refused: "the session's link to the node had closed",
		});
		expect(held.connections[0]?.said, "only the presence was said").toEqual([
			{ Presence: { presence: presence() } },
		]);
	});

	it("settles as refused when the connection drops before the node answers", async () => {
		const held = await node((asked, on) => {
			if ("End" in asked) {
				on.socket.destroy();
				return [];
			}
			return agreed()(asked, on);
		});
		linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		expect(await link?.end("holder-1")).toEqual({
			refused:
				"the connection holding this session's presence closed before the node answered",
		});
	});
});
