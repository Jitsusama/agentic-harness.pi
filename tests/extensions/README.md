# Extension Tests

The tests of `../../extensions/`, a folder for each extension, named as
its extension is, so an extension's tests are found by its name. Many
entries because the package ships more than sixty extensions, a folder
each, and its tests mirror them a folder each as the rest of `tests/`
does: grouping them any other way would part an extension from its tests.

The few files loose here test what no one extension owns:

- `gates-leave-the-queue.test.ts`: a Slack or review gate still waiting
  for the screen leaves when its turn or session ends.
- `no-screen-sends-nothing.test.ts`: a Slack or Google write that waits on
  the person's yes is refused where nobody can give it.
- `render-padding.test.ts`: no extension's tool renderer pads what pi
  already padded.
- `schema-actions.ts`: reads the actions a tool's schema offers, for the
  review and work tests that hold each action to a guide, with its own
  test beside it.
