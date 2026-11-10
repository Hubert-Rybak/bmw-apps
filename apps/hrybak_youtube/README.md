# YouTube

Search YouTube and watch a video on the centre screen of an iDrive 7 head unit while the car is parked.
Unofficial: not made by, or affiliated with, BMW, Google or YouTube.

> [!WARNING]
> **Not yet run on a car.** Built and tested on a PC: the app in the kit's stubbed head unit, the player with
> real video files, YouTube's answers read live. See [What is not known yet](#what-is-not-known-yet).

| Package | What it is |
|---|---|
| `hrybak_youtube` (app, this folder) | The pages: Home, Search, Playing. It talks to YouTube and downloads the video through the Store's internet uplink. |
| `hrybak-ytplay` (tool, "YouTube player": [`native/ytplay`](../../native/ytplay), [`tools/hrybak-ytplay`](../../tools/hrybak-ytplay)) | Decodes what the app downloads (H.264 or VP9 picture, AAC or Opus sound) and hands the picture to the Store's Renderer. It has no network access. |

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

Installing: the repository's [README](../../README.md#install). The Store installs **YouTube player** and
the **Renderer** with the app.

## Sound

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

## What is not known yet

| | |
|---|---|
| **Whether YouTube serves the video to the car** | YouTube has no public way to hand a video to a player of its own, so the app asks as YouTube's own apps do (`youtube.js`, `CLIENTS`). Read from a data centre, YouTube answered two of the three clients with file addresses and the third with "sign in to confirm you're not a bot"; the addresses are bound to the address that asked, and that test machine left through two different ones, so no file could be downloaded there. On a car's single connection it may work as it is, or need another client description. The app tries each in turn, checks that the file really downloads, and says what YouTube answered when none does. |
| **Sound** | See above. |
| **Speed** | The picture is decoded in software. 720p at 30 frames a second should be within the unit's CPU; the Playing page says "the unit cannot keep up" when pictures are being left out, and 360p / 480p are in the settings. |
| **The screen on a real HMI** | The app is built on idrive7-apps' kit, whose apps run on cars; the additions made for it (pictures, video: `kit/CHANGES.md`) follow the Renderer's published protocol and its source, and have not been drawn by a real Renderer yet. |
| **Live streams, age-restricted videos, sign-in** | Not supported. |

When YouTube changes something, a search or a video fails with a message saying what was refused; the
fix is usually a new version number or client in `youtube.js`.

## How it is built

```
main.js      the app's state and what its buttons do; wires everything below to the kit
ui.js        the three pages, drawn on the kit's canvas; everything pressable is a kit target
youtube.js   search, suggestions, related videos, and where a video's files are (the client table)
net.js       HTTPS through the uplink's DNS servers; a file read in byte ranges
player.js    the player tool's client: tells it what to play and hands it the bytes it asks for
thumbs.js    thumbnails: downloaded, decoded by the tool, kept as renderer pictures
store.js     watched videos, searches and the sound device, in the app's data folder
app.json     the kit's description of the app: screens, settings, signals, "internet": true
```

A video goes: `youtube.js` asks YouTube where its files are → `net.js` downloads them in ranges →
`player.js` passes the bytes to `hrybak-ytplay` over its socket → the tool decodes and writes each picture
to `/dev/shm/mgu-video-hrybak-ytplay` → the Renderer draws it where `ui.js` put the video
([`native/ytplay/README.md`](../../native/ytplay/README.md) has the tool's protocol).

## Tests

In [`test/hrybak_youtube`](../../test/hrybak_youtube), run by `sh test/run.sh` with everything else:

| | |
|---|---|
| `test_youtube.js` | `youtube.js` and `net.js` against `mock_youtube.js`, a stand-in for YouTube that serves local files: search, suggestions, related, picking files, falling back between clients, ranged downloads, names resolved through the uplink's lease, and a video played through the real player. |
| `test_app.js` | The staged app in the kit's stubbed head unit, pressed as a finger would press it: search, results, play, pause, seek, sound set-up, related, history, refusals. `--shots <folder>` saves each page as a PNG. |
| `test_runtime.js` | A full build with a stand-in SDK, started through the kit's own start-up: tile, first frame, a bar button, shutdown. |

No test asks YouTube anything. To try the app's modules against the stand-in by hand:
`node test/hrybak_youtube/mock_youtube.js <media folder>` and the `HRYBAK_YT_API`, `HRYBAK_YT_SUGGEST` and
`HRYBAK_YT_THUMBS` variables (`youtube.js`).
