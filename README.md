# bmw-apps

Apps for BMW iDrive 7 head units (MGU), installed through the
[MGU Store](https://github.com/robertnisipeanu/mgu-store).

> [!WARNING]
> Unofficial: not made by, or affiliated with, BMW. You change your own head unit at your own risk. Each
> app's README says what has and has not been tried on a car.

## The apps

| App | Package | What it does |
|---|---|---|
| [YouTube](apps/hrybak_youtube/README.md) | `hrybak_youtube`, with the tool `hrybak-ytplay` | Search YouTube and watch a video on the centre screen while parked. **Not yet run on a car**; sound is experimental. |

## Install

You need an iDrive 7 head unit with the [MGU Store](https://github.com/robertnisipeanu/mgu-store) installed,
with its Renderer, and for apps that go online its internet uplink (Store → Settings → Wi-Fi, or a tethered
phone).

1. In the Store: Settings → **Add source** → `Hubert-Rybak/bmw-apps`, and pick a branch.
2. Install an app. The Store installs the tools it needs with it; apps are built on the head unit, which
   takes a moment.
3. Restart the head unit when the Store asks.

## Layout

```
apps/<id>/        one folder per app, named by its id: app.json, main.js, its other modules, icon.png, README.md
native/<tool>/    a native tool's source, build script, tests and protocol
tools/<tool>/     what the Store installs as that tool: the built program, component.json, unit, licences
test/<id>/        an app's tests; test/run.sh runs every test in the repository
kit/              the app kit from idrive7-apps (runtime, build, PC preview); kit/CHANGES.md lists what differs
mgu-repo.json     what the Store reads: every app under apps/, and the tools
AGENTS.md         how to work in this repository
```

A new app is a new folder under `apps/`: the Store finds it by itself (`mgu-repo.json` lists `apps/*`).
A tool it needs gets a folder under `native/` and `tools/`, an entry in `mgu-repo.json`, and a line in
`requires`.

## Development

Node.js, Python 3 and ffmpeg (for the test videos) are all a PC needs; the apps are built on the head unit
by the Store, with BMW's SDK taken from the unit itself. No SDK or firmware file is in this repository, and
none may be added.

```sh
sh test/run.sh                   # builds the tools for this machine, stages the apps, runs every test
NODE=/path/to/node-8 sh test/run.sh      # the same under the head unit's Node (8.16.2)
```

Or one at a time:

```sh
native/ytplay/build.sh host                                  # a tool for this machine
python3 kit/tools/build.py --preview-only hrybak_youtube     # an app staged without the SDK -> dist/
node test/hrybak_youtube/test_app.js --shots shots           # one test; here with the pages as PNGs
```

Each app's README describes its own tests. `AGENTS.md` has the rules for changes: what the head unit runs,
what must never be committed, versions, and how the tool binaries are rebuilt.

## Licences

This repository's own code is MIT (`LICENSE`). `kit/` is the app kit of
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) by cauliflowermossgrape, MIT
(`kit/LICENSE`). The text atlases `kit/runtime/fonts/ui.json` and `uib.json` are rendered from Inter, SIL Open
Font License 1.1 (`kit/runtime/fonts/OFL-Inter.txt`). The YouTube player binary contains FFmpeg,
LGPL-2.1-or-later (`tools/hrybak-ytplay/LICENSE.ffmpeg`); its source and build are under `native/ytplay`.
YouTube is a trademark of Google LLC.
