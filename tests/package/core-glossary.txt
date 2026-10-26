# Glossary

What every thing on Joel's machines and in their tooling is called, used the
same way in code, directories, docs, on screen and in what agents say. [The
design][design] says how things look and behave; this says what they're
called. A word that isn't here yet hasn't been settled, and a word under
[Still to Settle](#still-to-settle) waits on one choice.

The words are kept in bounded contexts, one section each. Inside a context,
each concept has one term, and the term is what's written, what's shown and
what Joel types: there are no synonyms, so an old name finds nothing and a
term is learned once. A word may mean its own thing in another context, and
the launcher's place, with its crumbs, says which: Network › Address is the
machine's, Agents › Sessions › Language › Address is a session's.

Each table has the same columns:

- **Word**: the term, as it's written in prose, shown on screen and typed.
- **Means**: what it is, in a few plain words.
- **Not**: names it replaces. They're never written, shown or found for
  anything, in any context.
- **In code**: how code spells it, where code has to spell it otherwise, such
  as a program's name for a module or NixOS's own option.

The-glossary-names-each-thing-once holds every table to that: no word names two
things in one context, and no replaced name is written for anything.
No-name-says-a-replaced-word holds core's own names to it: no check's name
and no `jitsusama.*` option's says a replaced name, but the ones
`tests/names.py` lists as another sense of the word or as a rename still
waiting on its owner, and that list only shrinks.

## The Context Map

Seven contexts are the launcher's places, in its order on the home screen
after Now: Agents, Programs, Desktop, Machine, Network, Disk and Keyboards.
Three are never places: Security, which the others lean on, and the Library
and Checks, which are core.nix's own.

- **Desktop shows every context.** Each launcher place belongs to one; Now is a
  view onto the others' rows, each kept in its own place.
- **Agents uses Machine's queue**: a session's heavy work waits there, shown on
  the session as what it's waiting on.
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
| Journey | a quest's dated log of what happened | | `quest journal` |
| session | a pi working for Joel on a quest, in a window of its own | | `agents` in the launcher |
| orchestrator | a session whose quest holds other quests: it hands out their work and gathers what waits on Joel | steward | `orchestrator: true` |
| orchestration | an orchestrator and every session on a quest below it | | `#orchestration/<address>` |
| talk | Joel's words to an orchestrator or a session, typed in its field from outside its window | steer | `steer/<ADDRESS>/` |
| pause | Joel stopping a session after its turn, from outside its window, until he resumes it, talks to it or types in it | | presence `paused` |
| resume | Joel letting a paused session carry on where it left off | | |
| waiting on | what a session can't go on without: Joel, an answer, or its turn in the queue | | |
| Working on | the line a session tells its peers about its work | Works on | `worksOn` |
| peer | another session on the same machine, reached over the mesh | instance, swarm | |
| mesh | how sessions on one machine message each other | | `mesh_send` |
| address | a peer's own group on the mesh, six letters | | |
| group | a set of peers a mesh message goes to, such as an orchestration's | | `#quest/<id>` |
| question | a mesh message asking peers for an answer | mesh question | `intent: question` |
| unanswered question | a question no peer has answered in five minutes | stuck question | |
| turn | a mesh message that starts a peer's turn at once, the mesh's loudest attention level | | |
| glance | a mesh message given to a peer as one line, since it's another peer's own business | | |
| hold | a peer asking every other to put something off, such as a switch, until it says it's over | | `intent: hold` |
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
| background command | a command a session runs without waiting on it | | the `jobs` tool |
| fleet | subagents run at once on one piece of work | fan-out, batch | the `subagent` tool |
| subagent | a pi a session starts to do part of its work | helper, sub-agent, worker, lane | `runs` in the launcher |
| council | reviewing models each reading one change on their own | | `review_ask council` |
| judge | the model that consolidates a council's findings | | |
| finding | something a review raised | | |
| change | work put up for review | PR, pull request, proposal | |
| AI spend | what agents have cost | cost, usage, tokens, bill, budget | spend-watch |
| Claude plan | Joel's Claude subscription, whose allowances stop turns when spent | subscription | `claude-plan` |
| allowance | how much of a Claude plan one window allows: five hours, or a week | limit | `5h`, `wk` |
| person | the human a session works for | user, human, operator | |
| status line | the line under a session saying how it stands | status bar | |

## Programs

What Joel runs, and the terminal he types commands into. A program can be
opened, opened below, given a new window and quit; a call is the calling
program's.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| program | something Joel runs, with or without a window | app, application | the `applications` provider |
| shell | zsh, which Joel types commands into in a terminal | | zsh |
| prompt | the line the shell writes before each command | | |

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
| This window | the launcher's first row in Desktop: the window Joel is in | | |
| wallpaper | the picture behind every window | painting | |
| notice | a card at the top right saying what a program said | notification | `Notifications.qml`, `org.freedesktop.Notifications` |
| Do not disturb | the setting that holds notices back while it's on | dnd, quiet | `session:quiet` |
| question | a centred box asking Joel something, such as a password or a yes | | `Polkit.qml`, `Askpass.qml` |
| mark | one drawn symbol, such as each one in the margin | glyph, icon | `glyphs.nix` |
| margin | the row of marks at the top of the screen saying what's true now | corner | `Margin.qml`, `overview.pieces` |
| meter | a level shown while it changes, such as the volume | overlay | `Meter.qml` |
| launcher | the window on Super+Space that finds programs, windows, actions and answers | palette, command palette | `Launcher.qml` |
| place | a list the launcher opens, belonging to one context, such as Agents or Network | category, collection | |
| row | one thing in a place | | |
| crumbs | where Joel is in the launcher, from home | | |
| field | where Joel types, at the top of every place | | |
| back | going up one place, to the row he was on | | the ← key |
| action | what a row can do: the same set for every row of its kind | verb | |
| foot | the launcher's bottom line: the time, the battery and what the keys do | | `foot` |
| Now | the launcher's view of what's on and waiting, on Super+O | What's on | `WhatsOn.qml` |
| Waiting on you | everything waiting on Joel, each with its minutes, at the top of Now | | |
| lag | how long the desktop takes to answer a key or a click | slow, jank, stutter | `lag-watch` |
| clipboard | what was copied last, and what was copied before it | | |
| capture | taking a picture or a recording of the screen | | |
| screenshot | a picture Joel takes of the screen | screen shot | |
| Today | the time, the date and the weather, as one row | | |
| here | where the weather is when no town is typed: where the laptop is, else the town set, else the time zone's city | | the `whereabouts` program; the weather provider's `place` |

## Machine

The computer and its parts, its power and its sleep. A device can be
connected, used and forgotten; a setting can be set, raised and lowered; the
machine can sleep, lock, log out, reboot and power off.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| machine | one computer | host, computer | `nixosConfigurations.laptop`; `hostName`, which NixOS requires |
| firmware | the program in the machine's chip that starts it, and its settings | BIOS, UEFI | |
| processor | what runs every program | CPU | |
| memory | what programs run in while the machine is on | RAM | |
| swap | memory set aside out of the way, compressed first, then in the swap file | swapfile | zram |
| memory pressure | how long programs are waiting for memory | | PSI |
| job | work Joel or an agent starts, run below the desktop so it gives way to it | | `jobs.slice` |
| kind of work | what a job is, which says how much the machine favours it: what Joel waits on at a terminal, timed work or agents' work | job class | the slices `jobs-awaited`, `jobs-timed` and `jobs-work` |
| queue | heavy work, such as builds and VM tests, waiting its turn on the machine | machine queue | |
| slice | a share of the machine's processor, memory and disk that a group of programs runs in | | a systemd `.slice` |
| power profile | how hard the processor and firmware run: performance, balanced or power saver | thermal mode, platform profile | power-profiles-daemon |
| charger | the power cable, and what it's plugged into | mains | AC |
| Keep awake | the setting that keeps the machine from sleeping or locking while it's on | Caffeinate | |
| sleep | the machine paused with its memory kept, until it wakes | suspend | `systemctl suspend`, s2idle |
| wake | coming back from sleep | | |
| log out | ending the desktop, back to the greeter | sign out | `session:` |
| reboot | starting the machine again | restart | |
| power off | turning the machine off | shut down | |
| lid | the laptop's lid, whose closing puts it to sleep away from a desk | | `lid-docked` |
| docked | the laptop at a desk with a monitor plugged in, kept awake with its lid shut | on a dock, at a desk | |
| Bluetooth | the radio that reaches headphones, keyboards and mice | | BlueZ |
| camera board | the part in the lid holding the built-in camera, which Dell fits in more than one kind | camera module | `jitsusama.dellXps14.cameraModule` |
| image processor | the part turning the built-in camera's raw picture into an image | ISP, IPU | |
| IR camera | the infrared camera beside the built-in camera, for signing in by face | | `ir-camera`, Howdy |
| desk light | the light on the monitor, lit while a camera is in use | | Litra |
| console | the text screen the machine starts on, and the ones past Ctrl+Alt+F2 | | kmscon |
| splash | the picture shown while the machine starts and stops | boot screen | Plymouth |
| device check | the program that tells Joel a device stopped working | | `device-check`, smartd |
| virtual machine | a computer run as a program on this one | | libvirt, QEMU |
| container | a program run apart from the machine, with its own files | | Podman |

## Network

How the machine reaches out. A network can be connected, signed in to and
forgotten; Wi-Fi's radio can be turned off.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| connection | the network link out of the machine | line, uplink | |
| speed | how fast the connection carries data now, each way | network speed, connection speed, bandwidth | `traffic` |
| address | an address the machine has on a network | network address, IP | `networks` |
| Wi-Fi | the network without a cable | WLAN, wireless | `wifid`, `wifi` |
| sign-in page | the page a network shows before it lets the machine out, as a hotel's does | captive portal, network sign-in page | `wifid-sign-in` |
| tunnel | a VPN's link through the network | | `jitsusama.shaper.tunnels` |
| firewall | what keeps others' connections out | | nftables |
| shaper | the program that keeps the network's queue on the machine, sorted by slice, so a call stays quick | | `shaper`, CAKE |

## Disk

The disk, its filesystems, and the guard that keeps them from filling. A
filesystem can say what's filling it, be cleared now, and keep or stop keeping
a folder.

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

## Keyboards

The keyboards plugged in, their keys, layers and light. A keyboard can switch
layer and set its light; its keys and shortcuts are listed inside it.

| Word | Means | Not | In code |
| ---- | ----- | --- | ------- |
| keyboard | one keyboard, built in or plugged in | | |
| key | one key on a keyboard | | |
| layer | what a keyboard's keys do, one set of several, which a key switches between | Keys and layers | the ErgoDox's layers, `Layer.qml` |
| map | the keyboard's layout, shown on screen | | `KeyboardMap.qml` |
| light | the keyboard's own light | backlight | |
| shortcut | keys pressed together that do one thing | binding, bind | niri's `binds` |

## Security

What proves it's Joel or his agents, and keeps the disk sealed. Never a
launcher place: each of its things shows where it's used.

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
| colour | what a colour means in the theme, such as the accent | colour role | `jitsusama.theme.roles`, to be renamed |
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
| VM test | a check that boots machines in virtual machines | | a `vm-` name |
| subtest | a named part of a VM test, which can run alone | | `with subtest(...)` |
| example machine | a whole machine built only from core's outputs, as a machine repository would | | `example-nixos`, `example-laptop`, `example-darwin` |
| stand-in | something standing in for a real program or device in a check | fake | |
| shot | a picture a VM test takes of one state of the screen | photograph | `screendump`, `shots-changed` |
| decision record | a document saying why the design is what it is | ADR | `docs/decisions/` |

## Still to Settle

Words that wait on one choice, and move into a table above once it's made.

- **virtual machine or VM**, in Machine: VM is what Joel types.
- **tunnel or VPN**, in Network: VPN is what Joel types.

[design]: design.md
