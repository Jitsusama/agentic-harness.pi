/**
 * Link Click Widget Extension
 *
 * Opens what a plain click lands on in pi's fullscreen whenever the
 * text there names a place: a URL, an absolute or `~/` path that
 * exists, `owner/repo#N`, a bare `#N` in a GitHub repo, or a quest or
 * document id. Joel, 4 November: "clicking on links in pi does not
 * work at all". Fullscreen takes the mouse, so kitty hands pi every
 * click, and pi opens one only on text it drew as an OSC 8 link, which
 * is a markdown link alone and nothing at all with hyperlinks off.
 *
 * pi's own press is wrapped once (lib/internal/links/press.ts): where
 * pi found no link, the plain text under the click is read and the
 * place it names becomes the link pi's own release opens. Nothing is
 * drawn differently.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen } from "@earendil-works/pi-tui";
import { answerPlainPresses } from "../../lib/internal/links/press.ts";
import { linkAtClick } from "../../lib/internal/links/resolve.ts";
import {
	type GithubRepo,
	originRepoOf,
	type PlaceWorld,
} from "../../lib/internal/links/targets.ts";
import { dataDir } from "../../lib/internal/paths.ts";

export default function linkClickWidget(pi: ExtensionAPI) {
	let release: (() => void) | undefined;

	// A session that starts again hands the wrap its own places; the
	// wrap stays the one already on.
	pi.on("session_start", async (_event, ctx) => {
		const world = sessionWorld(ctx.cwd);
		release = answerPlainPresses(
			TuiAltScreen.prototype,
			(screen, x, y, columns) => linkAtClick(screen, x, y, columns, world),
		);
	});

	pi.on("session_shutdown", async () => {
		release?.();
		release = undefined;
	});
}

/** The session's places: its home, the quests and its repo, asked of git once. */
function sessionWorld(cwd: string): PlaceWorld {
	let origin: { repo: GithubRepo | undefined } | undefined;
	return {
		home: homedir(),
		questsRoot: join(dataDir("quest-workflow"), "quests"),
		originRepo: () => {
			origin ??= { repo: originRepoOf(cwd) };
			return origin.repo;
		},
	};
}
