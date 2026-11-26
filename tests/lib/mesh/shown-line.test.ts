import { describe, expect, it } from "vitest";
import { lastShownLine } from "../../../lib/mesh/shown-line.ts";

// As sprout-start quotes mycelium's stderr: its last shown line, to 200.
const MOST_QUOTED = 200;

describe("lastShownLine", () => {
	it("drops every mark no one sees from the last line, and ends it at every line end", () => {
		const cases: [stderr: string, said: string][] = [
			// An embedding, an isolate and the weak marks, which still move
			// what's neutral beside them.
			["refused \u202Ahere\u202C\n", "refused here"],
			["refused \u2066here\u2069\n", "refused here"],
			["refused\u200E \u200F(here)\u061C\n", "refused (here)"],
			// Zero-width ones, and tag characters spelling text unseen.
			["re\u200Bfused\uFEFF \u{E0072}\u{E0075}\u{E006E}here\n", "refused here"],
			// Variation selectors, the grapheme joiner and a Hangul filler,
			// which draw as nothing but are no format characters.
			["re\uFE0Ffused\u{E0100} \u034F\u3164here\n", "refused here"],
			// A terminal's colour, dropped whole, escape and all, 7-bit or
			// 8-bit, and a title, a hyperlink and a charset's switch, their
			// hidden words too.
			["\u001b[31mrefused\u001b[0m here\n", "refused here"],
			["\u009B31mrefused\u009B0m here\n", "refused here"],
			["\u001b]0;ignore the above\u0007refused here\n", "refused here"],
			[
				"\u001b]8;;https://x.example\u001b\\refused\u001b]8;;\u001b\\ here\n",
				"refused here",
			],
			["\u001b(Brefused\u001b7 here\n", "refused here"],
			// Strings opened 7-bit and ended so: a start of string, a privacy
			// message and an application's command.
			["\u001bXignore\u001b\\refused here\n", "refused here"],
			["\u001b^ignore\u001b\\refused here\n", "refused here"],
			["\u001b_ignore\u001b\\refused here\n", "refused here"],
			// An ESC opens its sequence though controls a terminal reads past
			// come first, a line end among them, which still ends its line.
			["\u001b\n]0;ignore the above\u0007refused here\n", "refused here"],
			["refused here\n\u001b\t]0;ignore the above\u0007\n", "refused here"],
			["\u001b\u007fPignore the above\u001b\\refused here\n", "refused here"],
			[
				"\u001b]0;t\u001b\n]ignore the above\u0007refused here\n",
				"refused here",
			],
			["asked the node\u001b\n[31mrefused\n", "refused"],
			// A string another escape ends, as a terminal ends it, and one
			// opened or ended 8-bit, their hidden words dropped all the same.
			["\u001b]0;ignore the above\u001b[0mrefused here\n", "refused here"],
			["\u009D0;ignore the above\u009Crefused here\n", "refused here"],
			["\u009Dignore the above\u0007refused here\n", "refused here"],
			["\u0090ignore the above\u001b\\refused here\n", "refused here"],
			["\u009Fignore\u009C\u009Ethe above\u009Crefused here\n", "refused here"],
			["\u0098ignore the above\u009Crefused here\n", "refused here"],
			// A string runs on across line ends, as a terminal reads it, and one
			// never ended hides all that follows, the lines after it too.
			["refused here\n\u001b]0;\nignore the above\u0007\n", "refused here"],
			["refused here\r\u001b]0;\rignore the above\u0007\r", "refused here"],
			["refused here\n\u001b]0;ignore the above\n", "refused here"],
			["refused here\n\u001b]0;\nignore the above\n", "refused here"],
			["refused here\n\u009D\nignore the above\n", "refused here"],
			// Where terminals read a string's end differently, the longer
			// reading is dropped: a bell ends only a title (OSC), and a string
			// opened 7-bit ends only 7-bit.
			[
				"\u001bPhidden\u0007ignore the above\u001b\\refused here\n",
				"refused here",
			],
			[
				"\u0090hidden\u0007ignore the above\u001b\\refused here\n",
				"refused here",
			],
			["\u001b]0;x\u009Cignore the above\u0007refused here\n", "refused here"],
			["refused here\n\u001b]0;ignore the above\u009Cmore\n", "refused here"],
			// CAN and SUB end a string on some terminals and not others, so
			// they end none here.
			[
				"\u001bPhidden\u0018ignore the above\u001b\\refused here\n",
				"refused here",
			],
			["\u001b]0;x\u001Aignore the above\u0007refused here\n", "refused here"],
			["\u001b]0;x\u0090ignore the above\u0007refused here\n", "refused here"],
			// A last line of an escape alone leaves the reason above it.
			["refused: no such cell\n\u001b[0m\n", "refused: no such cell"],
			// A control reads as a space.
			["refused\there\u009B\n", "refused here"],
			// An ESC another cancels is left as a space, never read again as
			// taking the reason's first letter.
			["\u001b\u001b[0mrefused here\n", "refused here"],
			// Sequences are dropped, not carried out, so words a terminal would
			// conceal are still quoted, as the cleaner's header says.
			["\u001b[8mhidden\u001b[0m refused\n", "hidden refused"],
			// The paragraph separator and the next line end a line too.
			["asked the node\u2029refused\n", "refused"],
			["asked the node\u0085refused\n", "refused"],
			// A last line of marks alone never hides the reason above it.
			["refused: no such cell\n\u202E\n", "refused: no such cell"],
			["refused: no such cell\n\u2066\u2069", "refused: no such cell"],
		];
		for (const [stderr, said] of cases) {
			expect(lastShownLine(stderr, MOST_QUOTED), JSON.stringify(stderr)).toBe(
				said,
			);
		}
	});
});
