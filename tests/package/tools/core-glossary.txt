# Glossary

What every thing on Joel's machines and in their tooling is called, used the
same way in code, directories, docs, on screen and in what agents say. [The
design][design] says how things look and behave; this says what they're
called. A word that isn't here yet hasn't been settled, and a word under
[Still to Settle](#still-to-settle) waits on one choice.

The words are kept in bounded contexts, one section each. Inside a context,
each concept has one term, and the term is what's written, what's shown and
what Joel types: there are no synonyms, so a term is learned once. An old
name still finds what it named, never shown, so a rename loses nothing
(Joel, 2026-10-26: "i didn't know its name had changed, i was used to
calling it caffeinate"). A word may mean its own thing in another context, and
the launcher's place, with its crumbs, says which: Network › Address is the
machine's, Agents › Sessions › Language › Address is a session's.

Each table has the same columns:

- **Word**: the term, as it's written in prose, shown on screen and typed.
  In prose it's in lower case unless it's a name, such as Bluetooth or Keep
  Awake, which is written as its title everywhere.
- **Means**: what it is, in a few plain words.
- **Not**: names it replaces. They're never written or shown, in any
  context; typed, one still finds the thing it named, whose row says
  "Once called" it.
- **In code**: how code spells it, where code has to spell it otherwise, such
  as a program's name for a module or NixOS's own option.

A title, the name of a place, a row or an act on screen, is in Title Case:
every word takes a capital but a, an, the, and, or, but, of, to, in, on, at,
by, for and with, which take one only as the first or last word, as in Keep
Awake, Do Not Disturb, Start a Session and Turn the Radio Off (Joel,
2026-10-26: "i hate things that look like sentences without punctuation"). A
note, a notice and what an empty list says are sentences, and a command is
written as it's typed, in lower case.

The-glossary-names-each-thing-once holds every table to that: no word names two
things in one context, and no replaced name is written for anything.
No-name-says-a-replaced-word holds core's own names to it: no check's name
and no `jitsusama.*` option's says a replaced name, but the ones
`tests/names-kept.nix` keeps as another sense of the word or as a rename still
waiting on its owner, and what it keeps only shrinks. A repository built on
core holds its own names the same way, through `core.lib.namesSayTheGlossary`.
A launcher row that names a thing gives its term as `Context/word`, and a
place named for a context gives the context alone, as `Network`;
the-launcher-names-each-thing-its-term holds the row's name to it.

## The Context Map

Seven contexts are the launcher's places. Six are home's rows, in its order
after Now: Agents, Programs, Desktop, Machine, Network and Keyboards, so home
has seven rows. Disk's place is inside Machine, beside Processor, Memory and
Heat, and Mail and Calendar are places inside Programs. Three contexts are
never places: Security, which the others lean on, and the Library and Checks,
which are core.nix's own.

- **Desktop shows every context.** Each launcher place belongs to one; Now is a
  view onto the others' rows, each kept in its own place, with rows of its
  own last: the time, the date, the weather and the next meeting. A filling
  disk shows in Now, with its forecast, while it fills.
- **Agents uses Machine's queue**: a session's heavy work waits there, shown on
  the session as what it's waiting on, and listed whole in Agents' Queue.
- **Disk acts on Machine's jobs**: the disk guard freezes and thaws them.
- **Security seals Disk and signs Agents' work**: the TPM unlocks the disk,
  and Joel's key and the agents' key sign commits.
- **Network carries every context's traffic**, and the shaper keeps a call
  quick under it.
- **The Library builds every context**, and Checks prove it.

## Agents

The models working for Joel, what they work on, and what they cost. Its places
are Orchestrators, Quests, Sessions and AI spend. An orchestrator or a session
can be talked to, opened, paused and stopped; a quest can start a session, go
first in the queue and conclude.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| agent | a model working for Joel, as a session or a subagent | AI, assistant, bot | |
| quest | a piece of Joel's work, with its own folder, README and documents | task, project, todo | `QEST-` ids, the `quest` tool |
| short name | a quest's name in two or three words, on its windows and in the launcher | | `short:` |
| subquest | a quest that is part of another's work | | `kind: subquest` |
| sidequest | a quest that came up beside another, not part of it | | `kind: sidequest` |
| plan | a quest's document for building something, through think, draft and build | | `PLAN-` ids |
| research | a quest's document for finding something out: question, method, findings, verdict | | `RSCH-` ids |
| brief | a quest's document asking someone for something: audience, ask, background, recommendation | | `BRIF-` ids |
| report | a quest's document on what happened, its outcomes and lessons | | |
| landing | what a session finished and handed Joel: a merged change, a built plan or a hand-off, at its ref, with a line saying what to try | | presence `landings` |
| Journey | a quest's dated log of what happened | | `quest journal` |
| session | a pi working for Joel on a quest, in a window of its own | | `agents` in the launcher |
| orchestrator | a session whose quest holds other quests: it hands out their work and gathers what waits on Joel | steward | `orchestrator: true` |
| orchestration | an orchestrator and every session on a quest below it | | `#orchestration/<address>` |
| talk | Joel's words to an orchestrator or a session, typed in its field from outside its window | steer | `steer/<ADDRESS>/` |
| pause | Joel stopping a session after its turn, from outside its window, until he resumes it, talks to it or types in it | | presence `paused` |
| resume | Joel letting a paused session carry on where it left off | | |
| park | a session ending itself while idle to give back its memory, until a message or a key wakes it in its window | | presence `parked`, park-workflow |
| reopen | opening a closed session again where it left off, in its own window and folder | restore | `restore.json` |
| Sessions to Reopen | the sessions the last boot's end took away and those another machine carried here | Reopen Last Boot's Sessions | `toReopen` |
| carried | a session another machine handed this one as it went away, to reopen here | | `carried` in `restore.json` |
| waiting on | what a session can't go on without: Joel, an answer, or its turn in the queue | | |
| Working on | the line a session tells its peers about its work | Works on | `worksOn` |
| peer | another session on the same machine, reached over the mesh | instance, swarm | |
| mesh | how sessions on one machine message each other | | `mesh_send` |
| node | mycelium's program on a machine, carrying its mesh to the machines it links with | | `mycelium node` |
| link | two machines' nodes joined, carrying the mesh's messages and sessions between them | | `mycelium link`, `jitsusama.mycelium.links` |
| realm | a set of machines whose nodes link, such as Joel's work or personal ones, with nothing crossing between realms | | `jitsusama.mycelium.realm` |
| link key | the key a realm's node signs in to the realm's other machines with, held apart from every other realm's | | `jitsusama.linkKeys`, `<realm>-link` |
| address | a peer's own group on the mesh, six letters | | |
| group | a set of peers a mesh message goes to, such as an orchestration's | | `#quest/<id>` |
| question | a mesh message asking peers for an answer | mesh question | `intent: question` |
| unanswered question | a question no peer has answered in five minutes | stuck question | |
| turn | a mesh message that starts a peer's turn at once, the mesh's loudest attention level | | |
| glance | a mesh message given to a peer as one line, since it's another peer's own business | | |
| hold | a peer asking every other to put something off, such as a switch, until it says it's over | | `intent: hold` |
| pivot | an orchestrator changing what a session it orchestrates is doing, each answering once it has changed course | | `intent: pivot` |
| fyi | a mesh message given as context only, asking nothing | | `intent: fyi` |
| hand | a subagent, seen on the mesh as its parent's hands | | `hand.ts` |
| tree | a folder holding a repository's files to work in: a worktree or a snapshot | working tree | the `work` tool |
| worktree | a tree checked out at a branch, one session's alone | | `git worktree` |
| snapshot | a tree pinned at a commit, read only and shareable | | |
| checkout | a repository's clone, which trees are cut from | | |
| cut | making a tree | scaffold | `work tree` |
| release | giving back a tree one holds | prune, reap | `work release`; `quest tree-prune`, to be renamed |
| tidy | reporting which trees on the machine are spent, removing nothing | | `work tidy` |
| reclaim | taking back the trees nobody owns | | `work reclaim` |
| scratch folder | a quest's folder for clones, data and builds, its tmp/ cleared when it concludes | | the quest workspace |
| version | one commit of a pi package installed on the machine, which a pi runs | | `versions/<commit>` |
| sweep | pi-packages removing the versions no pi runs, keeping current and the one before, at each pi's start or end | | `pi-packages sweep` |
| background command | a command a session runs without waiting on it | background job | the `jobs` tool |
| background work | a session's background commands, fleets and review rounds together | | `/jobs` |
| fleet | subagents run at once on one piece of work | fan-out, batch | the `subagent` tool |
| subagent | a pi a session starts to do part of its work | helper, sub-agent, worker, lane | the `subagent` tool |
| run | one running of subagents, a fleet, a council or a judge's round, as a whole | | `runs` in the launcher |
| council | reviewing models each reading one change on their own | | `review_ask council` |
| judge | the model that consolidates a council's findings | | |
| finding | something a review or a peer found, for whoever owns what it's about | | `intent: finding` |
| change | work put up for review | PR, pull request, proposal | |
| AI spend | what agents have cost | cost, usage, tokens | spend-watch |
| bill | what a provider charged for AI spend, as its feed reports it, rather than estimated from list prices | | |
| budget | a named source of money a model call draws on: a Claude plan, an API key, the AI proxy, a team's token | | |
| AI proxy | the service a work machine's model calls go through, whose feed gives spend-watch its bill | model gateway, LLM gateway, LLM proxy | |
| Claude plan | Joel's Claude subscription, whose allowances stop turns when spent | subscription | `claude-plan` |
| allowance | how much of a budget one window allows: a share of a Claude plan's five hours or week, or dollars of the AI proxy's week | limit | `5h`, `wk` |
| window | the stretch of time an allowance counts over, such as five hours or a week | | |
| Joel | the human every session works for | user, human, operator | |
| status line | the line under a session saying how it stands | status bar | |

## Programs

What Joel runs, and the terminal he types commands into, and the mail,
meetings and calls he has through them, and the people they're with. A
program can be opened, opened below, given a new window and quit. A meeting
can be joined or seen, and an invitation answered yes, maybe or no; mail can
be read, marked unread and archived.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| program | something Joel runs, with or without a window | app, application | the `applications` provider |
| shell | zsh, which Joel types commands into in a terminal | | zsh |
| prompt | the line the shell writes before each command | | |
| Google account | the account Joel's mail and calendar are kept in, which the desktop's own program holds | | the `google` program |
| mail | Joel's messages in his Google account, and the place in Programs holding them | | Gmail |
| wants you | mail waiting on Joel's answer | | |
| unread | mail Joel hasn't opened yet, or a Slack conversation with messages he hasn't read, which Slack's program lists as its Unread | | |
| read | mail Joel has opened | | |
| archive | taking mail out of the inbox, kept where it's found again | | |
| calendar | Joel's meetings in his Google account, and the place in Programs holding them | | Google Calendar |
| meeting | an event on Joel's calendar with a call or with others | | |
| invitation | a meeting someone asks Joel to, answered yes, maybe or no | | |
| going | an invitation Joel answered yes | accepted | `yes` |
| maybe | an invitation Joel answered maybe | tentative | |
| not going | an invitation Joel answered no | declined | `no` |
| not answered | an invitation Joel hasn't answered yet | needs action | `waiting` |
| person | someone Joel deals with, the same one by their email across mail, meetings, calls and chat | | |
| call | a talk with others over Meet or Tuple, with sound and sometimes pictures | | Meet, Tuple |
| transcript | what was said on a call, Joel's words and the others' in the order they were said, written on the machine as the call goes | | `call-transcripts` |
| summary | a call's transcript summed up once it ends, on the machine: the lines a model picked as worth reading, each quoted word for word with who said it to whom and when | | `summary.md` |
| noise cancelled | a microphone's voice with the sounds around it taken out on the machine, offered as a microphone of its own named for it | noise suppression, denoised | `noise-cancelled` |
| join | going into a meeting's call, or a call another sends | | |
| see | looking at a meeting's details in the launcher: when, its call, who's going | | |
| cancel | taking a meeting Joel holds off everyone's calendar, Google telling each guest | delete | |
| Slack message | a message in Slack, found by searching Slack and opened in its conversation | | the Slack daemon's `slack-message` |

## Desktop

The screen and everything on it around the windows, the launcher among them.
A window can be gone to, closed, floated or tiled, moved and sized; a screen's
brightness, scale and rotation can be set; an item in a list, such as a notice
or a copy, can be opened, copied or forgotten.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| desktop | the screen and everything on it around the windows: the launcher, notices, the margin and niri's workspaces | | niri, Quickshell |
| screen | a monitor, built in or plugged in | display, monitor | niri's outputs |
| brightness | how bright a screen is, which follows the room's light | | the `backlight` program |
| workspace | one of niri's rows of windows on a screen | | |
| overview | niri's view of every workspace and its windows, on Super+A | | |
| window | a program's rectangle on the screen | | |
| This Window | the launcher's first row in Desktop: the window Joel is in | | |
| wallpaper | the picture behind every window | painting | |
| notice | a card at the top right saying what a program said | notification | `Notifications.qml`, `org.freedesktop.Notifications` |
| Do Not Disturb | the setting that holds notices back while it's on | dnd, quiet | `session:quiet` |
| question | a centred box asking Joel something, such as a password or a yes | | `Polkit.qml`, `Askpass.qml` |
| mark | one drawn symbol, such as each one in the margin | glyph, icon | `glyphs.nix` |
| margin | the row of marks at the top of the screen saying what's true now | corner | `Margin.qml`, `overview.pieces` |
| meter | a level shown while it changes, such as the volume | overlay | `Meter.qml` |
| card | the one frame the launcher, held notices and a notice are drawn in, all it holds the inset from its edge | | `Card.qml` |
| launcher | the window on Super+Space that finds programs, windows, actions and answers | palette, command palette | `Launcher.qml` |
| place | a list the launcher opens, belonging to one context, such as Agents or Network | category, collection | |
| row | one thing in a place | | |
| home | the launcher's first place: Now, Agents, Programs, Desktop, Machine, Network and Keyboards | | |
| crumbs | where Joel is in the launcher, from home | | |
| field | the line at the top of every place: the find line, or the command line in its place | | |
| back | going up one place, to the row he was on, with h, - or Backspace | | the `out` act |
| action | what a row can do: the same set for every row of its kind | verb | |
| go to | the action moving to something already open, such as a window or a session, a row named Go To with where at its side | | |
| open | the action starting something, such as a program or a file | | |
| turn on | the action starting a setting, a radio or a light | | |
| turn off | the action stopping a setting, a radio or a light | | |
| forget | the action taking an item out of its list, such as a notice, a copy or what's waiting | let it go | |
| foot | the status line at the bottom of the launcher and held notices: the mode, the position and what the keys do | | `foot` |
| Now | the launcher's view of what's on and waiting, on Super+O | What's on | `WhatsOn.qml` |
| Needs You | what only Joel can do, each raised by the session that needs him | waiting on you, to do | `WaitingOnYou.qml` |
| clipboard | what was copied last, and what was copied before it | | |
| capture | taking a picture or a recording of the screen | | |
| screenshot | a picture Joel takes of the screen | screen shot | |
| screenshot text | the words in a screenshot, read on the machine as it's taken, so it's found by them and they can be copied | OCR | `screen-text` |
| location | where the laptop is, its town and the zone it keeps, Now's row and the one place the weather and everything that depends on it read it from | | `Location.qml`, the `whereabouts` program |
| here | where the weather is when no town is typed: the location, else the town set, else the clock's time zone's city | | the weather provider's `place` |

## Machine

The computer and its parts, its power and its sleep. A Bluetooth device is
paired, connected, disconnected and forgotten in Bluetooth, and used in its
kind's place, such as a headset's volume in Sound; a setting can be set,
raised and lowered; the machine can sleep, lock, log out, reboot and power
off.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| machine | one computer | host, computer | `nixosConfigurations.laptop`; `hostName`, which NixOS requires |
| firmware | the program in the machine's chip that starts it, and its settings | BIOS, UEFI | |
| processor | what runs every program | CPU | |
| memory | what programs run in while the machine is on | RAM | |
| swap | memory set aside out of the way, compressed first, then in the swap file | swapfile | zswap |
| memory pressure | how long programs are waiting for memory | | PSI |
| lag | how long the desktop takes to answer a key or a click, and what made it wait | slow, jank, stutter | `lag-watch` |
| trace | one thing a program did, followed through its steps, each a span with a start and an end | | OpenTelemetry's traces |
| collector | the program keeping the machine's traces, to read any moment back | observability backend | `collector` |
| cargo's builds | the filesystem of cargo's own, an image on the system's disk, where every account's builds keep their intermediates | build scratch | `cargo-builds.service`, `jitsusama.cargo.builds` |
| compile cache | sccache's store of compiled crates, keyed by their inputs, which every worktree's cargo build reads before compiling one | build cache | `sccache`, `~/.cache/sccache` |
| job | work Joel or an agent starts, run below the desktop so it gives way to it | | `jobs.slice` |
| kind of work | what a job is, which says how much the machine favours it: what Joel waits on at a terminal, timed work or agents' work | job class | the slices `jobs-awaited`, `jobs-timed` and `jobs-work` |
| shared work | a job other sessions wait on, such as a push holding one of a repository's walk slots, run beside jobs at the sessions' own disk target | | `shared.slice`, `SHARED_SLICE` |
| queue | heavy work, such as builds and VM tests, waiting its turn on the machine | machine queue | |
| warm | of an offload builder for VM tests, holding what they need, having built it as it stood; a fresh one is cold | primed | `there::warm`, `--warm` |
| offload builder | a builder elsewhere lent to the machine while its queue has builds one could take, and given back once idle | remote builder | `nix-offload` |
| slice | a share of the machine's processor, memory and disk that a group of programs runs in | | a systemd `.slice` |
| agents' slice | the slice agents' sessions run in, beside Joel's programs rather than among them | | `agents.slice` |
| power profile | how hard the processor and firmware run: performance, balanced or power saver | thermal mode, platform profile | power-profiles-daemon |
| chosen | of a setting's choices, the one it's at, whoever picked it: Joel, the charger or a profile | | |
| in use | held by a program, as a camera Chrome has open or a microphone in a call | | |
| charger | the power cable, and what it's plugged into | mains | AC |
| Keep Awake | the setting that keeps the machine from sleeping or locking while it's on | Caffeinate | |
| sleep | the machine paused with its memory kept, until it wakes | suspend | `systemctl suspend`, s2idle |
| wake | coming back from sleep, as the machine does, or from a park, as a session does | | |
| idle | of the machine, every session left untouched past the screens going off, and nothing holding it awake | inactive | logind's `IdleHint` |
| idle sleep | the sleep a laptop falls into left idle on battery, never on the charger | autosuspend | `idle-sleep`, logind's `IdleAction` |
| hibernate | the machine off with its memory written to the swap file, until it starts again from it | | `systemctl hibernate` |
| log out | ending the desktop, back to the greeter | sign out | `session:` |
| reboot | starting the machine again | restart | |
| power off | turning the machine off | shut down | |
| lid | the laptop's lid, whose closing puts it to sleep away from a desk | | `lid-docked`, `lid-hinge` |
| hinge | the lid's angle from the keyboard, as a sensor in the laptop reads it | | IIO's `hinge` |
| docked | the laptop at a desk with a monitor plugged in, kept awake with its lid shut | on a dock, at a desk | |
| Bluetooth | the radio that reaches headphones, keyboards and mice, and the place listing every device it reaches, to pair and connect | | BlueZ |
| camera board | the part in the lid holding the built-in camera, which Dell fits in more than one kind | camera module | `jitsusama.dellXps14.cameraBoard` |
| image processor | the part turning the built-in camera's raw picture into an image | ISP, IPU | |
| IR camera | the infrared camera beside the built-in camera, for signing in by face | | `ir-camera`, Howdy |
| desk light | the light on the screen, lit while a camera is in use | | Litra |
| console | the text screen the machine starts on, and the ones past Ctrl+Alt+F2 | | kmscon |
| splash | the picture shown while the machine starts and stops | boot screen | Plymouth |
| device check | the program that tells Joel a device stopped working | | `device-check`, smartd |
| VM | a computer run as a program on this one | virtual machine | libvirt, QEMU |
| Linux builder | a VM on a Mac that builds what Linux machines run, so the Mac's work builds there | | `darwinModules.linux-builder`, `darwin.linux-builder-vz` |
| container | a program run apart from the machine, with its own files | | Podman |
| update | the machine switched to its repository's main, signed, by root's own choosing when asked | upgrade, self-update | `update-to-main` |

## Network

How the machine reaches out: Wi-Fi, Ethernet, a VPN and tethering. A network
can be connected, signed in to and forgotten; Wi-Fi's radio can be turned off.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| connection | the network link out of the machine | line, uplink | |
| speed | how fast the connection carries data now, each way | network speed, connection speed, bandwidth | `traffic` |
| address | an address the machine has on a network | network address, IP | `networks` |
| Wi-Fi | the network without a cable | WLAN, wireless | `wifid`, `wifi` |
| Ethernet | the network through a cable | wired | |
| tethering | reaching out through a phone's connection, over its cable | | |
| sign-in page | the page a network shows before it lets the machine out, as a hotel's does | captive portal, network sign-in page | `wifid-sign-in` |
| VPN | a private link to another network, carried through this one | tunnel | `jitsusama.shaper.vpns` |
| firewall | what keeps others' connections out | | nftables |
| shaper | the program that keeps the network's queue on the machine, sorted by slice, so a call stays quick | | `shaper`, CAKE |

## Disk

The disk, its filesystems, and the guard that keeps them from filling, whose
place is inside Machine. A filesystem can say what's filling it, be cleared
now, and keep or stop keeping a folder.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| disk | the machine's storage | drive, SSD, storage | NVMe; `jitsusama.disk`, from disko |
| boot partition | the disk's small first part, which the firmware starts from | ESP | `/boot` |
| filesystem | how a disk's room is kept as files | | Btrfs, a subvolume |
| snapshot | a filesystem's copy kept from a moment, which the guard may clear | | a Btrfs snapshot |
| disk guard | the program that keeps each filesystem from filling: one for the machine, one for the account | | `disk-guard system`, `disk-guard user` |
| freeze | the disk guard stopping a program that fills a filesystem, until there's room | frozen | `SIGSTOP` |
| thaw | letting a frozen program carry on | | `disk-guard thaw` |
| filling | the disk guard's first band, under a quarter free, when it starts taking room back | pressure | `pressure` |
| nearly full | the disk guard's second band, under a tenth free, when it takes more | urgent | `urgent` |
| critically full | the disk guard's last band, under 4% free, when it may freeze what fills the disk | critical | `critical` |
| forecast | how long a filesystem has until it's full, at the rate it's filling | | |
| holder | a folder the disk guard names as taking a filesystem's room, with whose it is | | `holders` |
| ledger | the disk guard's record of what held each filesystem over two days, so a holder says how much it grew | history | `ledger.json`, a holder's `grew` |
| keep | Joel telling the disk guard never to clear a folder, with his reason | pin, protect, exclude | `disk-guard keep`, `disk-guard unkeep` |
| clear | the disk guard removing builds, caches and waste it may, as a band allows or at once when Joel asks | purge, wipe | `disk-guard clear` |
| footprint | what files take on a filesystem, which compressed can be far less than their size | | `disk-guard footprint`, `Request::Footprint` |

## Keyboards

The keyboards plugged in, their keys, layers and light. A keyboard can switch
layer, lock a layer on and release it, and set its light; its keys and
shortcuts are listed inside it.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| keyboard | one keyboard, built in or plugged in | | |
| key | one key on a keyboard | | |
| layer | what a keyboard's keys do, one set of several, which a key switches between | Keys and layers | the ErgoDox's layers, `Layer.qml` |
| map | the keyboard's layout, shown on screen | | `KeyboardMap.qml` |
| release | letting go of a layer locked on, back to the one beneath | | |
| light | the keyboard's own light | backlight | |
| shortcut | keys pressed together that do one thing | binding, bind | niri's `binds` |
| key language | the one set of keys every surface of ours speaks, Vim's as Joel's Neovim has it | | `modules/keys/language.toml` |
| act | one thing the key language's keys do, named once, as down or close | | `acts.<name>` |
| surface | a program of ours keys act on, of one or more kinds: field, list, page or player | | `jitsusama.surfaces` |
| mode | what keys do at a moment, each with one purpose: normal, the find line, the command line, insert, visual or an operator waiting | | `modes` |
| normal | the mode standing on a thing and acting on it, where nothing types | | |
| find line | the / line that narrows a list as it's typed | | the `find` mode |
| search | a page's /, moving to a match and hiding nothing | | |
| command line | the : line, where a command is named | | the `command` mode |
| menu | what the command line lists: every command the cursor row, the selection or the surface takes | | |
| insert | the mode writing a prompt's words | | |
| prompt | a line of words written to be handed over: a reply, a new name, a save name | | the `prompt` kind |
| secret | a one-line password, with no modes | | the `secret` kind |
| cursor row | the one row normal stands on | | |
| visual | the mode choosing several things | | |
| selection | what visual has chosen | | |
| gathered | files collected across folders for one answer, with :arga | | the arglist |
| done | a notice forgotten, marked read first where its sender offers it | | |
| leader | Space, starting a sequence of keys in normal and visual | | `mapleader` |
| mark | a place kept under a letter, set with m and gone back to with ' | | |

## Security

What proves it's Joel or his agents, keeps the disk sealed, and installs or
recovers a machine from a stick. Never a launcher place: each of its things
shows where it's used.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| TPM | the chip that keeps the machine's keys and seals its disk | security chip | |
| firmware password | the password that keeps the firmware's settings shut | BIOS password | |
| login key | the SSH key that signs Joel in to other machines, kept in the TPM | everyday SSH key | `id_ecdsa.tpm`, ssh-tpm-agent |
| spare | the login key's copy on the YubiKey, for when the TPM can't be used | | `<account>@yubikey` |
| Joel's key | the key that signs Joel's own commits | Joel's signing key | `joel-signing`, `joelKey` |
| agents' key | the key that signs agents' commits | agents' signing key, agent's key | `agent-signing`, `agentKey` |
| passkey | a key the TPM holds for signing in to websites | FIDO security key | `linux-id` |
| keyring | where passwords programs keep are held, opened at sign-in | | gnome-keyring |
| greeter | what asks Joel to sign in when the machine starts | | greetd, tuigreet |
| lock screen | what hides the desktop while Joel is away, until he signs in again | | swayidle |
| stick | the USB stick the guide writes for one machine, to install or reinstall it | reinstall stick | |
| repair stick | a stick written for no machine, to repair any | | |
| writer | the machine writing a stick for another, which the guide shows beside the machine it's for | | `guide host` |

## The Library

The words core.nix is built from. Never a launcher place.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| machine repository | a repository of machines built on core.nix, adding its own modules | | any flake with core.nix as an input |
| module | one program or subsystem, configured | | `modules/bat/` becomes `homeModules.bat` |
| kernel module | a part of the kernel loaded on its own, always written whole | | `boot.kernelModules` |
| role | what a machine is for | | `roles/workstation/` becomes `nixosModules.workstation` |
| hardware | one machine model, and what it needs | | `nixosModules.dell-xps-14-da14260` |
| identity | who Joel is on a machine | | `jitsusama.identity.email` |
| age key | the file that opens what was sealed to it with age | age identity | |
| theme | the look every program Joel sees shares | | `jitsusama.theme` |
| colour | what a colour means in the theme, such as the accent | colour role | `jitsusama.theme.colours`, a theme file's `[colours]` |
| face | one of the theme's typefaces, named by its kind: mono, sans, serif or script | typeface | `jitsusama.theme.font` |
| serif face | the theme's serif: italic, the desktop's voice, what the launcher says to Joel; upright, the words to read beside a mono name | voice face | `jitsusama.theme.font.serif`, `Theme.serif` |
| serif text | the serif face upright at large, cut into a font of its own, for a program that can't set a variable font's axes | | `jitsusama.theme.font.serif.text`, `modules/fonts/serif-text.nix` |
| sans face | the theme's sans-serif, only for other people's programs that draw their own interface | proportional face | `jitsusama.theme.font.sans` |
| step | one size on the theme's type scale, by its power of the ratio, such as large | | `jitsusama.theme.type` |
| level | one rank of text on the desktop: its face, step, weight, case and colour together, such as Name or Note | style, text style | `jitsusama.theme.type.levels`, `Theme.level` |
| pitch | how far apart two lines of one thing at a level sit, baseline to baseline | | `jitsusama.theme.type.levels.<level>.pitch`, `Theme.level.<level>.pitch` |
| rung | the space one level of structure sits apart by, wider than the rung inside it, such as items or frames | | `jitsusama.theme.space.rung`, `Theme.space.rung` |
| beat | half the large pitch, which every space between blocks down a surface is a whole number of | | `jitsusama.theme.space.beat`, `Theme.space.beat` |
| script face | Noto, script by script, for the letters the other faces lack, with a cut a script beside the serif and mono faces | | `jitsusama.theme.font.script` |
| account | the account on a machine that home-manager configures | | `home-manager.users.<account>` |

## Checks

How core.nix proves what it promises. A check's name is a sentence saying what
it holds, subject first, with no prefix but `vm-`, which marks a VM test and
nothing else; its description in `check-descriptions.nix` finishes the
sentence. It may name the program its module is named after, since that
says which module broke.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| check | one promise that `nix flake check` builds and holds | | `checks.x86_64-linux.<name>` |
| VM test | a check that boots machines in VMs | | a `vm-` name |
| subtest | a named part of a VM test, which can run alone | | `with subtest(...)` |
| example machine | a whole machine built only from core's outputs, as a machine repository would | | `example-nixos`, `example-laptop`, `example-darwin` |
| stand-in | something standing in for a real program or device in a check | fake | |
| shot | a picture a VM test takes of one state of the screen | photograph | `screendump`, `shots-changed` |
| decision record | a document saying why the design is what it is | ADR | `docs/decisions/` |

## Still to Settle

Words that wait on one choice, and move into a table above once it's made.
None waits now: Joel chose VM and VPN (2026-10-26).

[design]: design.md
