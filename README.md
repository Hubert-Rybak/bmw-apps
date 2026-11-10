# bmw-apps

Apps for BMW iDrive 7 head units (MGU), installed through the
[MGU Store](https://github.com/robertnisipeanu/mgu-store). So far there is one: **YouTube**.

> [!WARNING]
> **Not yet run on a car.** Everything here was built and tested on a PC: the app in the kit's stubbed head
> unit, the player with real video files, YouTube's answers read live. What only a car can show is listed
> under [What is not known yet](#what-is-not-known-yet). Unofficial: not made by, or affiliated with, BMW,
> Google or YouTube. You change your own head unit at your own risk.

## YouTube

Search YouTube and watch a video on the centre screen while the car is parked.

| Package | What it is |
|---|---|
| `hrybak_youtube` (app) | The pages: Home, Search, Playing. It talks to YouTube and downloads the video through the Store's internet uplink. |
| `hrybak-ytplay` (tool, "YouTube player") | Decodes what the app downloads (H.264 or VP9 picture, AAC or Opus sound) and hands the picture to the Store's Renderer. It has no network access. |

- **Home**: your recent searches and the videos you watched, each from where it stopped.
- **Search**: an on-screen keyboard with YouTube's suggestions beside it; results in a grid that loads on as
  you scroll.
- **Playing**: the video, its position (tap the bar to jump), pause, 10 s back and on, related videos.
- By touch, and with the iDrive controller where the head unit has the controller gate
  (idrive7-apps' "Controller gate" tool): turn to move, press to select, push left to go back.
- **The picture shows only while the car stands** (setting *Picture only while parked*, on by default; above
  3 km/h the picture goes off, and a video without sound pauses).
- Titles in Latin scripts (accents included), Greek and Cyrillic are drawn as written; other scripts show a
  `?`, emoji are left out.
- Settings: picture size (360p to 1080p, 720p by default), 60 frames a second, search language and region,
  whether watched videos and searches are remembered, colour theme.

### Install

You need an iDrive 7 head unit with the [MGU Store](https://github.com/robertnisipeanu/mgu-store) installed,
with its Renderer and its internet uplink (Store → Settings → Wi-Fi, or a tethered phone).

1. In the Store: Settings → **Add source** → `Hubert-Rybak/bmw-apps`, and pick a branch.
2. Install **YouTube**. The Store installs **YouTube player** and the **Renderer** with it. The app is built
   on the head unit, which takes a moment.
3. Restart the head unit when the Store asks.

### Sound

**Experimental, and off until you turn it on.** At the time of writing no public project has shown which
of the head unit's sound devices reaches the speakers from a program of its own; the notes of the
[bube](https://github.com/Drake1804/bube-releases/blob/main/docs/AUDIO_CARPLAY.md) project describe what is
known. The player can write to any ALSA device of the unit, so the app lets you find out:

On the Playing page tap **Sound off**. The page lists the unit's sound devices, leaving out the car's own
voices (phone, warnings, parking beeps, microphones). Tap one: it plays a quiet 2.5 s tone. If you hear it,
that device is the one, and the video starts again with its sound. If not, try the next, or **Sound off**.
*Sound level* in the settings starts at Quiet, because a device past the car's volume control may ignore the
volume knob.

Do this parked. A device can take the sound without anything connecting it to the speakers (silence, no
error), and holding a device the car wants for itself may disturb CarPlay or restart the head unit: nobody
knows yet.

### What is not known yet

| | |
|---|---|
| **Whether YouTube serves the video to the car** | YouTube has no public way to hand a video to a player of its own, so the app asks as YouTube's own apps do (`apps/hrybak_youtube/youtube.js`, `CLIENTS`). Read from a data centre, YouTube answered two of the three clients with file addresses and the third with "sign in to confirm you're not a bot"; the addresses are bound to the address that asked, and that test machine left through two different ones, so no file could be downloaded there. On a car's single connection it may work as it is, or need another client description. The app tries each in turn, checks that the file really downloads, and says what YouTube answered when none does. |
| **Sound** | See above. |
| **Speed** | The picture is decoded in software. 720p at 30 frames a second should be within the unit's CPU; the Playing page says "the unit cannot keep up" when pictures are being left out, and 360p / 480p are in the settings. |
| **The screen on a real HMI** | The app is built on idrive7-apps' kit, whose apps run on cars; the additions here (pictures, video) follow the Renderer's published protocol and its source, and have not been drawn by a real Renderer yet. |
| **Live streams, age-restricted videos, sign-in** | Not supported. |

When YouTube changes something, a search or a video fails with a message saying what was refused; the
fix is usually a new version number or client in `youtube.js`.

## Development

Nothing is needed on a PC but Node.js, Python 3 and ffmpeg (for the test videos); the apps are built on the
head unit by the Store (`mgu-repo.json`), with BMW's SDK taken from the unit itself. No SDK or firmware file
is in this repository, and none may be added.

```sh
native/ytplay/build.sh host                                  # the player for this machine (FFmpeg dev packages)
python3 kit/tools/build.py --preview-only hrybak_youtube     # stage the app without the SDK -> dist/
node native/ytplay/test/run.js                               # the player: playing, seeking, sound, failures
node test/test_youtube.js                                    # YouTube and network modules, and the whole chain
node test/test_app.js --shots shots                          # the app in a stubbed head unit; pages as PNGs
node test/test_runtime.js                                    # a full build, started as the head unit starts it
```

The tests use `test/mock_youtube.js`, a stand-in for YouTube that serves local files, so they need no
internet and download nothing from YouTube (`node test/mock_youtube.js <media folder>` runs it alone; the
`HRYBAK_YT_API`, `HRYBAK_YT_SUGGEST` and `HRYBAK_YT_THUMBS` variables point the app at it). The same tests
pass under Node 8.16.2, the head unit's.

`native/ytplay/build.sh` (no argument) builds the player for the head unit: FFmpeg n7.1.5 from source and
the player, linked for glibc 2.27 with zig as the C compiler. The result is committed as
`tools/hrybak-ytplay/hrybak-ytplay`, which is what the Store installs.

```
apps/hrybak_youtube/   the app: main.js (state and actions), ui.js (pages), youtube.js, net.js,
                       player.js (the tool's client), thumbs.js, store.js, app.json
native/ytplay/         the player's source, build and tests; README.md has its protocol
tools/hrybak-ytplay/   what the Store installs as the tool: the binary, its unit and licences
kit/                   the app kit from idrive7-apps, with the changes listed in kit/CHANGES.md
test/                  the stand-in for YouTube and the tests that use it
mgu-repo.json          what the Store reads
```

## Licences

This repository's own code is MIT (`LICENSE`). `kit/` is the app kit of
[idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) by cauliflowermossgrape, MIT
(`kit/LICENSE`). The text atlases `kit/runtime/fonts/ui.json` and `uib.json` are rendered from Inter, SIL Open
Font License 1.1 (`kit/runtime/fonts/OFL-Inter.txt`). The player binary contains FFmpeg, LGPL-2.1-or-later
(`tools/hrybak-ytplay/LICENSE.ffmpeg`); its source and build are under `native/ytplay`. YouTube is a
trademark of Google LLC.
