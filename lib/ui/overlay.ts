/**
 * How a modal panel is put on the screen.
 */

/**
 * Show a panel over the transcript rather than below it.
 *
 * Pi's `ctx.ui.custom` defaults to putting the component in the editor
 * container, which makes the rendered content taller by the height of
 * the panel. Everything above is pushed up, and whatever leaves the
 * viewport is in the terminal's scrollback, where no later redraw can
 * reach it. A tool row painted just before a gate opened is stranded
 * there, and the same row painted again when the gate closes reads as a
 * duplicate: the ghost.
 *
 * Overlay mode composites the panel across the lines already on screen
 * and pads only to the terminal's height, so nothing is displaced and
 * nothing is stranded.
 *
 * The positioning is not decoration. An overlay places itself, and the
 * default is centred at whatever width the component asks for, so
 * without this a gate would work perfectly and look like it belonged to
 * another program. Full width at the bottom is where the editor it
 * replaces already sat.
 *
 * `maxHeight` is the safeguard. An overlay taller than the screen makes
 * pi extend the working area to fit it, which reintroduces exactly the
 * growth this exists to prevent.
 *
 * A row narrower than the panel is left narrow. Padding every row out to the
 * full width was tried and made things worse rather than better: filling the
 * last column makes a terminal wrap, so every row gained a blank one under it
 * and the transcript showed through the gaps. Whatever the bleed is, it is
 * not rows being too short.
 */
export const OVERLAID = {
	overlay: true,
	overlayOptions: {
		width: "100%",
		maxHeight: "100%",
		anchor: "bottom-center",
	},
} as const;
