# Done Chime Widget

Rings when a run you typed is done: a loud, low ding. A machine can add
a voice saying which session is ready, such as "Agentic loop is
ready.", by naming one; none does by default.

## Why It Exists

A run you hand over takes minutes, and you look away. Joel, 16 October
2026: "give me that loud ding and spoken voice shit when you are done
thinking and have something to propose". Two days later he asked for it
lower, for his dog. A Mac played a sound only with a critical
notification, and Linux played nothing. On 9 November, asking why a
voice said a session was ready, he kept only the bell, so the voice is
off unless a machine names one.

## When It Rings

Only at the end of a run you typed into, in that window, and only once
it has run 20 seconds past the last thing you typed. About ten seconds
is how long a person watches a screen that's working before turning to
something else, so a quicker answer, one you're still watching for,
stays quiet. In the fortnight of logs before this was built, about 88%
of typed runs went longer than 20 seconds.

It never rings for:

- a run a mesh message, a steer from outside the window, a resume, a
  job's report or any other text the harness sent started
- a session nobody can be at: a subagent, print mode or JSON mode
- a run you stopped with Escape, since you're right there
- anything while you're away (`away-workflow`), so a night's work
  doesn't wake the house
- anything while the desktop's Do Not Disturb is on, where the machine
  names its file (`quiet` below)
- the test suite, which sets `PI_NOTIFY=off`

Dozens of sessions can run at once, and only the one you were talking
to rings.

Each ring heard writes a line to the system's log (the journal on
Linux, the unified log on macOS, as `pi`), such as `pi: done ding,
session <id>, 42 s after the person typed`, so the dings a day can be
counted. A ring nothing heard, for a missing player or Do Not Disturb,
writes none.

## What It Sounds Like

Where a machine names a voice, the session is named by its name, which
quest-workflow sets to the quest's short title, or by its folder when
that's a few words long, or as "pi".

| Platform | Ding          | Voice                                     |
| -------- | ------------- | ----------------------------------------- |
| Linux    | `pw-play`     | piper, lowered with sox's `pitch`         |
| macOS    | `afplay`      | `say`                                     |

The voice is a model on the machine, never a service. The line plays
once the ding is done; on Linux piper speaks it while the ding rings
out, so its start-up is not heard as a pause. A tool that's missing or
fails is silence, never an error.

## Configuring It

A machine describes its sound in
`~/.config/pi/agentic-harness.pi/done-chime-widget/sound.json`, which
a Nix module can write with each path in the store. Every field is
optional, and the file is read at each ring, so a change reaches every
session without a restart.

```json
{
  "ding": "/path/to/ding.wav",
  "player": "/path/to/pw-play",
  "voice": "/path/to/en_GB-alan-medium.onnx",
  "piper": "/path/to/piper",
  "sox": "/path/to/sox",
  "pitch": -300,
  "quiet": "quiet"
}
```

- `ding`: the sound played first.
- `player`: what plays a sound file; `pw-play` on Linux and `afplay` on
  macOS by default.
- `voice`: on Linux, the piper model, with its `.onnx.json` beside it;
  on macOS, a voice `say` knows.
- `piper` and `sox`: what speaks the line and lowers it, on Linux,
  found on the PATH by default.
- `pitch`: how far the line is moved, in cents; negative is lower, and
  0, the default, leaves the voice as it is.
- `quiet`: the file the desktop keeps its Do Not Disturb in, under
  `$XDG_RUNTIME_DIR` when relative. It reads `<since> <until>` in
  milliseconds since 1970, an until of 0 meaning until it's ended, and
  nothing rings while the until is 0 or still ahead. Empty or missing,
  it isn't quiet.

Without the file, a Mac rings with the Submarine sound and the Ralph
voice, the lowest of each that macOS ships. Linux has no sound or voice
every machine is sure to have, so it rings once the machine names them.
`PI_NOTIFY=off` silences it.

## Limits

- It can't tell that your desktop is holding notices (do not disturb),
  so it rings through it.
- A panel waiting on you mid-run is not a finished run, and doesn't
  ring.

## Where It Lives

`index.ts` wires pi's events, `when.ts` is the rule for when a run
rings, `ring.ts` the commands that make the sound and `sound.ts` reads
the machine's description.
