# kit

The app kit of [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps) by cauliflowermossgrape
(MIT, `LICENSE` in this folder), copied from its commit `f5e4b8daa6c930f83a93fd6d6a158ab08c00c748`: the runtime an
app is built on (`runtime/`), the build that turns `apps/<id>/app.json` + `main.js` into a package on the head
unit (`tools/build.py`), and the PC preview (`tools/preview.js`, `tools/hu-stub.js`).

Only what this repository's apps use was copied: no vehicle-data helpers, no gauge fonts for other apps, no
translations, no renderer, no emulator. The upstream repository has all of those, and its README documents the
kit.

Changes made here are listed in `CHANGES.md`.
