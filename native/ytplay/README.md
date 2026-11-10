# hrybak-ytplay

The YouTube app's player: a small C program on FFmpeg that decodes what the app downloads and writes the
pictures where the Store's Renderer reads them. It runs as the service `hrybak-ytplay.service`
(`tools/hrybak-ytplay`), has no network access, and gives up root before it reads a byte from anyone.

```
app (Node 8, has internet)                         hrybak-ytplay (uid 3931)                      Renderer
--------------------------                         ------------------------                      --------
player.js  -- control: JSON lines ------------->   main.c     one app at a time
           <-- "need video from byte N" --------   source.c   the media's bytes, asked for by offset
           -- data: one connection per file --->   player.c   demux, decode, keep picture and sound together
net.js     ranged HTTPS downloads                  frames.c   /dev/shm/mgu-video-hrybak-ytplay  ---->  op 19
                                                   audio.c    the unit's libasound (dlopen)
thumbs.js  -- "decode" + JPEG ----------------->   thumb.c    thumbnail -> RGBA
```

## Build and test

```sh
native/ytplay/build.sh host      # for this machine, against the system's FFmpeg development packages
node native/ytplay/test/run.js   # 15 tests with the app's own client and local videos
native/ytplay/build.sh           # for the head unit -> tools/hrybak-ytplay/hrybak-ytplay
```

The head-unit build needs git, make, nasm and `pip install ziglang==0.13.0`. It fetches FFmpeg n7.1.5,
configures it with only what the player uses (MP4 and WebM in; H.264, VP9, AAC, Opus, MP3, JPEG and WebP
decoders; no network, no programs; LGPL), and links everything for glibc 2.27 and the unit's loader
`/lib/ld-linux-x86-64.so.2`; the script checks the result needs nothing else. To run that binary on a PC:
`node native/ytplay/test/run.js --bin tools/hrybak-ytplay/hrybak-ytplay --loader /lib64/ld-linux-x86-64.so.2`.

## On the head unit

| | |
|---|---|
| Socket | `/run/hrybak-ytplay/ctl.sock`, root, group `tm_oap_app`, 0660: the apps' group may connect |
| Frame file | `/dev/shm/mgu-video-hrybak-ytplay`, root's (the Renderer takes a frame file from the app's uid, root or nobody), written through the descriptor opened as root |
| User | Root until the first connection is accepted (or 2 minutes after the start), then uid and gid 3931 (no account), keeping only the groups that own `/dev/snd`, `/run/smartx` and the sound plugin's shared memory, for the experimental sound |
| Crashes | Core limit 1 byte (no dump reaches the head unit's crash handler); the Store lists the program and the unit with the crash handler and recmgr (`component.json`) |

Options: `--socket PATH`, `--frames /dev/shm/mgu-video-NAME`, `--group NAME`, `--uid N` (0: stay as started),
`--threads N` (decoder threads; default the CPU's, at most 4).

## Protocol

Every connection to the socket starts with one JSON line. `{"op":"hello"}` makes it the control connection
(a new one replaces the one before, and ends its playback); `{"op":"data", ...}` makes it a data connection.
Protocol version 1; one flat JSON object per line, UTF-8, at most 4096 bytes.

### Control: app to player

| Line | |
|---|---|
| `{"op":"open","sid":N,"muxed":0\|1,"audio":0\|1,"vsize":B,"asize":B,"start":S,"device":"name","gain":dB}` | Play. `muxed`: one file holds picture and sound (stream `video`); else the sound is the separate stream `audio`. `audio`: there is sound to play. `vsize` / `asize`: file sizes, -1 unknown. `device`: ALSA device, empty for no sound (the sound file is then never asked for). `gain`: 0 to -60 dB. Ends the playback before. |
| `{"op":"pause","paused":0\|1}` | |
| `{"op":"seek","t":S}` | To second S: the picture there is shown at once, also while paused. |
| `{"op":"gain","db":dB}` | |
| `{"op":"close","sid":N}` | |
| `{"op":"status"}` | A `state` line now. |
| `{"op":"devices"}` | The unit's sound devices. |
| `{"op":"tone","device":"name","db":dB,"ms":N}` | A 440 Hz tone on a device. |
| `{"op":"decode","id":N,"w":W,"h":H,"len":L}` then L bytes | A JPEG or WebP file to RGBA pixels, scaled to fill W x H (centre crop). At most 4 MiB in, 1024 px a side out. |

### Control: player to app

| Line | |
|---|---|
| `{"ev":"hello","proto":1,"version":"0.1.0","video":"/dev/shm/mgu-video-...","alsa":true}` | `video`: the frame file to name to the Renderer. |
| `{"ev":"need","sid":N,"stream":"video"\|"audio","off":B,"req":R}` | Send this stream from byte B on, on a new data connection that quotes R. |
| `{"ev":"state","sid":N,"state":"opening"\|"buffering"\|"playing"\|"paused"\|"ended"\|"error","pos":S,"dur":S,"w":W,"h":H,"fps":F,"audio":"device or empty","err":"why","shown":N,"dropped":N}` | On every change, and twice a second. `err`: with `error`, why nothing plays; otherwise why there is no sound. `dropped`: pictures left out because they came too late. |
| `{"ev":"devices","alsa":true,"list":["name", ...]}` | ALSA's own list, and `smartx:<name>` for each device of the unit's stream plugin that has been opened by anyone (`/run/smartx/<name>_p.lock`). |
| `{"ev":"tone","device":"name","ok":true,"frames":N,"buffer":N,"err":""}` | |
| `{"ev":"picture","id":N,"ok":true,"w":W,"h":H,"len":L}` then L bytes | Or `"ok":false,"err":"why"`. |

### Data

`{"op":"data","sid":N,"stream":"video","req":R,"off":B,"size":TOTAL}` and then the file's bytes from B on,
until the file's end or until the player closes the connection (it seeks elsewhere, or stops). A connection
that ends early is asked for again from where it stopped, five times in a row at most; one that brings
nothing for 30 s fails the playback. `size`: the whole file's, -1 unknown (it then ends where its connection
does).

## How it plays

- One thread per file reads packets into a queue per track; one thread per track decodes. The picture's
  thread shows each picture when the clock reaches its time, and leaves out pictures that come more than
  80 ms late (never more than half a second without one); far behind, the decoder skips pictures nothing
  depends on until it has caught up.
- The clock is the sound device's when sound plays (what was written minus what the device still holds),
  else the system's. It stands while paused and while the picture's queue has run dry before the end
  (`buffering`), until twelve packets are there again.
- A seek goes to the key frame before the target; the pictures up to the target are decoded and not shown.
- Sound is converted to 16-bit stereo at 48 kHz. The device is opened without ALSA's own converter first
  (the unit's stream devices refuse it). A device that takes nothing for 3 s is given up with the reason in
  `err`, and the picture plays on by the system clock.
- Pictures are written as the Renderer's protocol says (mgu-render `PROTOCOL.md`, "Video"): three slots,
  I420, BT.709 for 720 lines and more unless the stream says otherwise. Pictures that are not 8-bit 4:2:0
  are converted.
