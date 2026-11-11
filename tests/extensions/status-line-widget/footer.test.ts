/**
 * The footer outlives its session. A reload or a session switch shuts
 * the session down and then makes every context it handed out throw,
 * while the screen may still draw the old footer until the new session
 * sets its own. On 11 November one such frame threw and took a pi host
 * down with it.
 */
import { expect, it, vi } from "vitest";
import statusLine from "../../../extensions/status-line-widget/index.ts";
import { extensionRunner } from "../../support/extension-runner.ts";

vi.mock("../../../extensions/status-line-widget/git.ts", () => ({
	Engine: class {
		ask() {}
		stop() {}
	},
}));
vi.mock(
	"../../../extensions/status-line-widget/where.ts",
	async (original) => ({
		...(await original<object>()),
		readWhere: () => ({ engine: "fake", roots: [], marks: {} }),
	}),
);

interface Footer {
	render(columns: number): string[];
}
type FooterFactory = (tui: unknown, theme: unknown, data: unknown) => Footer;

/** A screen that keeps the footer it's given, and does nothing else. */
function screen() {
	const held: { factory?: FooterFactory } = {};
	const ui = new Proxy(
		{
			setFooter(factory: FooterFactory) {
				held.factory = factory;
			},
		},
		{
			get: (target, name) =>
				name in target ? Reflect.get(target, name) : () => undefined,
		},
	);
	const footer = (): Footer | undefined =>
		held.factory?.(
			{ requestRender() {} },
			{ fg: (_colour: string, text: string) => text },
			{
				onBranchChange: () => () => {},
				getGitBranch: () => null,
				getExtensionStatuses: () => new Map<string, string>(),
			},
		);
	return { ui, footer };
}

it("draws its last line once the session it read from is shut down", async () => {
	const session = extensionRunner(statusLine, "/work/a");
	const { ui, footer } = screen();
	session.runner.setUIContext(ui as never, "tui");
	await session.start();
	const drawn = footer();
	const before = drawn?.render(80);

	await session.stop();
	session.runner.invalidate("This extension ctx is stale.");

	expect(before, "the footer drew while the session lived").toBeDefined();
	expect(drawn?.render(80)).toEqual(before);
	expect(session.errors).toEqual([]);
});
