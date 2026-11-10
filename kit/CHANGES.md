# Changes to the kit in this repository

Against idrive7-apps `f5e4b8d` (see `README.md`). Files not listed are byte for byte upstream's.

| File | Change |
|---|---|
| `runtime/record.js` | Pictures and video for mgu-render's own protocol: `setPicture` / `dropPicture`, `setVideo` / `dropVideo`, `Recorder.picture(id, x, y, w, h, r)` (op 18 as `x y w h r id`) and `Recorder.video(...)` (op 19). They replace `Recorder.image` (upstream's pixel images, op 18 as `id ver x y w h`), which no app here uses; the software playback draws pictures and skips video. |
| `runtime/renderd.js` | Uploads pictures (message 10) and names video frame files (13, 14) on mgu-render/1 connections; reads the `pixmaps` and `video` capabilities from X_READY. |
| `runtime/display.js` | `media()` and `cv.media`: whether the frame being drawn can show pictures and video. |
| `runtime/mgu.js`, `tools/hu-stub.js` | `ctx.media`: the app's calls for the above. |
| `runtime/fonts.js` | A family marked `"wide"` is used for any script instead of being rerouted to a per-script atlas; `covers()`. |
| `runtime/fonts/ui.json`, `uib.json`, `OFL-Inter.txt` | New: Inter Regular and SemiBold with accented Latin, Greek and Cyrillic (`tools/bake_wide.py`), for text that comes from outside the app. |
| `tools/build.py` | `app.json` `"internet": true` becomes `"mguInternet": true` in `package.json` (the Store's uplink); `"credits": [title, link]` names the app's own project in the settings' last row, beside the kit's. |
| `tools/bake_wide.py` | New: bakes the two atlases above. |
