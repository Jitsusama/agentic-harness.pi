# Data

What the package keeps as data, for its own code and for programs
outside it to read from the install, so the two can't drift.

- `fence-hidden.json`: what the agent fence keeps from every command,
  read by `lib/internal/fence-hidden.ts`. Core's secret asks read it
  through the install's current link, to hide the same paths from a
  released command. `version` changes only when a field changes
  meaning:
  - `home`: paths from the home folder emptied inside, a trailing `/`
    for a folder emptied whole;
  - `sshKept`: regular expressions naming the files in `~/.ssh` a
    command may read; every other file there is emptied;
  - `npmrc`: npm's settings, from the home folder, read inside only
    as a copy without its tokens.
