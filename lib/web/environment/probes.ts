/**
 * Asking the page what it is actually experiencing.
 *
 * Page source rather than a function, for the same reason the
 * accessibility observer is: the compiler wraps named inner
 * bindings in a __name helper the page has never heard of, so
 * a serialized function that declares helpers of its own throws
 * on arrival.
 */

/**
 * Read the environment as the page sees it.
 *
 * Every value here comes from the page's own APIs rather than
 * from what we asked the browser for, because the two differ
 * often enough that reporting the request would be reporting a
 * guess.
 */
export const ENVIRONMENT_PROBE = `(() => {
  const on = (query) => window.matchMedia(query).matches;
  const pick = (name, values, fallback) => {
    for (const value of values) {
      if (on("(" + name + ": " + value + ")")) return value;
    }
    return fallback;
  };
  return {
    colorScheme: pick("prefers-color-scheme", ["dark", "light"], "light"),
    reducedMotion: on("(prefers-reduced-motion: reduce)"),
    contrast: pick("prefers-contrast", ["more", "less", "custom"], "no-preference"),
    forcedColors: on("(forced-colors: active)"),
    print: on("print"),
    width: window.innerWidth,
    height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    maxTouchPoints: navigator.maxTouchPoints,
    touchEvents: "ontouchstart" in window,
    language: navigator.language,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
})()`;
