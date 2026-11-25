import { describe, expect, it } from "vitest";
import { quietFor, until } from "../../support/until.ts";
import {
	agreed,
	heardAs,
	link,
	linked,
	message,
	node,
	presence,
	stamped,
	useStandInNode,
} from "../../support/worker-node.ts";

useStandInNode();

describe("what a worker's link tells of its node", () => {
	it("tells once a node it can't reach", async () => {
		const session = linked();

		link?.present(presence());
		await until("the refusal is told", () => session.refused.length === 1);
		await quietFor(30, 5);

		expect(session.refused).toHaveLength(1);
		expect(session.refused[0]?.what).toBe("presence");
		expect(session.refused[0]?.why).toContain("can't be reached (ENOENT)");
		expect(session.reachedAgain, "nothing was reached").toBe(0);
	});

	it("says once the node it couldn't reach takes its presence", async () => {
		const session = linked();
		link?.present(presence());
		await until("the refusal is told", () => session.refused.length === 1);

		const held = await node(agreed());
		await until("the watch opens", () => held.connections.length === 2);
		link?.present({ ...presence(), busy: true });
		await until(
			"a later presence is taken too",
			() => (held.connections[0]?.said.length ?? 0) === 2,
		);
		await quietFor(10, 3);

		expect(session.reachedAgain, "said once, not on each taken").toBe(1);
		expect(session.refused).toHaveLength(1);
	});

	it("takes a send the node already holds as sent", async () => {
		const held = await node((asked, on) =>
			"Send" in asked
				? [
						'{"Err":"3-W0RK3R-42-cc is said already, and a worker can\'t write over it"}',
					]
				: agreed()(asked, on),
		);
		const session = linked();
		link?.present(presence());

		link?.relay(message("3-W0RK3R-42-cc"));
		await until(
			"the send is answered",
			() => (held.connections[0]?.said.length ?? 0) === 2,
		);
		await quietFor(10, 5);

		expect(session.refused).toEqual([]);
	});

	it("tells a send refused as another message said already", async () => {
		await node((asked, on) =>
			"Send" in asked
				? [
						'{"Err":"3-W0RK3R-42-aa is said already, and a worker can\'t write over it"}',
					]
				: agreed()(asked, on),
		);
		const session = linked();
		link?.present(presence());

		link?.relay(message("3-W0RK3R-42-cc"));
		await until("the refusal is told", () => session.refused.length === 1);

		expect(session.refused[0]).toMatchObject({
			what: "send",
			id: "3-W0RK3R-42-cc",
		});
	});

	it("hangs up a connection that says a line too long, reading nothing after it", async () => {
		let flooded = false;
		const held = await node((asked, on) => {
			if ("Presence" in asked && !flooded) {
				flooded = true;
				// Too long, then what would read as the presence's answer.
				return [`${"x".repeat(300)}`, '{"Ok":"Present"}'];
			}
			return agreed()(asked, on);
		});
		const session = linked([], undefined, undefined, 256);

		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 3);
		await quietFor(20, 3);

		expect(session.refused).toEqual([
			{ what: "presence", why: "it said a line over 256 characters" },
		]);
		expect(
			held.connections[1]?.said,
			"the presence goes again on a new connection",
		).toEqual([{ Presence: { presence: presence() } }]);
	});

	it("hangs up a connection whose line runs past the most with no end yet", async () => {
		let flooded = false;
		const held = await node((asked, on) => {
			if ("Presence" in asked && !flooded) {
				flooded = true;
				// No end of line, as a node gone wrong that never stops.
				on.socket.write("x".repeat(200));
				on.socket.write("x".repeat(100));
				return [];
			}
			return agreed()(asked, on);
		});
		const session = linked([], undefined, undefined, 256);

		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 3);

		expect(session.refused).toEqual([
			{ what: "presence", why: "it said a line over 256 characters" },
		]);
	});

	it("drops a watch's line too long and reads on, rather than asking for it again", async () => {
		const later = message(stamped(1000), "after");
		const held = await node((asked, on) =>
			"Watch" in asked
				? [
						'{"Ok":"Watching"}',
						JSON.stringify({
							MessagesChanged: {
								messages: [message(stamped(2000), "y".repeat(300))],
							},
						}),
						JSON.stringify({ Message: { message: later } }),
					]
				: agreed()(asked, on),
		);
		const session = linked([], undefined, undefined, 256);

		link?.present(presence());
		await until("what came after is kept", () => session.kept.length === 1);
		await quietFor(20, 3);

		expect(session.kept).toEqual([heardAs(later)]);
		expect(session.refused).toEqual([
			{
				what: "unkept",
				why: "the node said it in a line over 256 characters, which was dropped",
			},
		]);
		expect(held.connections, "the watch stays open").toHaveLength(2);
	});

	it("keeps back a send too long for the node's reply to it to be read", async () => {
		const held = await node(agreed());
		const session = linked([], undefined, undefined, 2048);
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		link?.relay(message("6-W0RK3R-42-ff", "z".repeat(1500)));
		await until("it is told", () => session.refused.length === 1);

		expect(session.refused[0]).toMatchObject({
			what: "unsent",
			id: "6-W0RK3R-42-ff",
		});
		expect(held.connections[0]?.said, "it never went").toHaveLength(1);
	});

	it("tells a refusal said again only once", async () => {
		const held = await node(() => ['{"Err":"that session lives elsewhere"}']);
		const session = linked();

		link?.present(presence());
		await until("the first is refused", () => session.refused.length === 1);
		link?.present({ ...presence(), busy: true });
		// Each refused presence is said again on the hold's backoff too.
		await until(
			"the second presence and a retry are answered",
			() => (held.connections[0]?.said.length ?? 0) >= 3,
		);
		await quietFor(10, 5);

		expect(session.refused, "the second refusal is the first's").toHaveLength(
			1,
		);
	});

	it("tells a refusal again once the node takes one of its kind, not another's", async () => {
		const id = "3-W0RK3R-42-cc";
		const held = await node((asked, on) =>
			JSON.stringify(asked).includes(id)
				? ['{"Err":"a worker sends no hold"}']
				: agreed()(asked, on),
		);
		const session = linked();
		link?.present(presence());
		await until("the watch opens", () => held.connections.length === 2);

		link?.relay(message(id));
		await until("the send is refused", () => session.refused.length === 1);
		link?.present({ ...presence(), busy: true });
		link?.relay(message(id));
		await until(
			"all are answered",
			() => (held.connections[0]?.said.length ?? 0) === 4,
		);
		// The node has the 4th line; the link may not yet have its reply.
		await quietFor(10, 3);
		expect(session.refused, "a presence taken clears no send's").toHaveLength(
			1,
		);

		link?.relay(message("4-W0RK3R-42-dd"));
		await until(
			"the taken send is answered",
			() => (held.connections[0]?.said.length ?? 0) === 5,
		);
		await quietFor(10, 3);
		link?.relay(message(id));
		await until("the send is refused again", () => session.refused.length >= 2);
		await quietFor(10, 3);
		expect(session.refused).toHaveLength(2);
	});
});
