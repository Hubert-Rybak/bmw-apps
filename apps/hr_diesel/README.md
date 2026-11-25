# Diesel

The diesel particulate filter (DPF) and the rest of a B47 / B57's exhaust after-treatment, on the centre screen,
read from the engine unit (DDE, diagnostic address `0x12`) and the AdBlue unit (SCR, `0x0B`) over the head unit's own
diagnostic link. **Reading goes through `kit/runtime/readonly-diag.js`**, which lets only reading requests (`22`, and
OBD `01` / `09`) leave the head unit; this app reads with `22` (ReadDataByIdentifier) only. The one exception is
**Request regeneration** (below): a single write, sent only after the driver confirms it, through its own link
(`force.js`) that can send nothing else.

> **Status: experimental.** The identifiers and their scalings come from the engine units' SGBDs (the public
> [EDIABAS reference](https://emdzej.github.io/ediabasx-docs-sgbd/)), each checked field by field against the SGBD's
> own tables. **Tested on a car:** a G05 xDrive40d (2021, B57 mild hybrid, DDE 8.3 `0F267C`, AdBlue unit SCR04):
> every value answered and decoded as expected, and a regeneration requested from the app ran. DDE 7 and DDE 9 are
> not tried on a car yet. The *Details* tab shows every value with its identifier and the reply's bytes: a photo of
> it (or Settings > QR log) is what's needed to confirm them on another engine unit.

## Pages

| Tab | Shows |
|---|---|
| **DPF** | The soot against the regeneration point (the mark labelled; the bar amber while it burns), the measured soot and the soot model; tiles for the heat before the filter (with the oxidation catalyst's), the pressure drop across it (these two with their last 2 minutes) and the ash (with the filter life left). A card: **FILTER OK** (the soot load in % of the regeneration point, the distance and driving time since the last one, the next one from the average interval), **REGENERATION DUE** (asked for by the engine, at or well past the point, and what lets it run: 20-30 min at a steady 60 km/h or more) or **REGENERATING** (*Keep driving, don't switch the engine off*, the soot burnt so far, how long and how far it has run); along its bottom the EGR valves OPEN / CLOSED. |
| **Regenerations** | Each regeneration the app logged, the one running first: start, the distance before it, how long it took, the distance, soot before and after, peak heat, done / stopped early / running. Until the first, the engine unit's own last five (the odometer at each, the distances between them). Totals: the engine unit's count of successful ones, the average distance between them, how many of the logged ones stopped early, and the soot over the last 1,000 km (600 mi) as a sawtooth. |
| **AdBlue** | **ADBLUE OK** / **REFILL SOON** (2,400 km of range or less) / **REFILL NOW** (1,000 km or less) with the range as the big number and the level (the AdBlue unit's tank); NOx before the SCR catalyst (and after it), the share it removes now (only with the catalyst warm and enough NOx to tell), the catalyst's heat (and before it); the stored average conversion and the AdBlue quality. A car without AdBlue says so. |
| **Engine** | Each EGR valve, high and low pressure: **OPEN** / **CLOSED** (or NOT FITTED), the gas through it drawn as thick as it is open, the opening and the engine unit's target; the share of exhaust gas in the intake air and the air mass per stroke against its target (the valves close while the filter regenerates). Rail pressure and boost against their targets; the injectors' quantity corrections, each under its cylinder, amber beyond ±1 mg/stroke (meaningful at warm idle). |
| **Details** | Every value read: its name, identifier, value and the reply's bytes, or why it has none (*reading...*, *not on this car*, *no answer*, *refused now*). |

The state shows in the header too: DPF REGEN on the other pages while one runs, and the link's state (DEMO, LIVE,
UNVERIFIED for an engine unit read with another's layouts, NO ANSWER, CAR PARKED, NOT A DIESEL). In Chinese
(Simplified and Traditional) and Korean builds the app's texts are translated (`kit/runtime/locales`).

Settings: km or miles, °C or °F, theme, layout, renderer, demo.

## Regenerations

**Running or not.** The SGBDs have no value table for the regeneration flags, and the EDIABAS job that combines them
(`STATUS_REGENERATION_CSF`) uses a dynamically defined identifier (service `2C`), which a read-only app may not use.
So the app decides by, in this order:

1. **The engine unit's flag**: the operating mode's regeneration bit (`467E` `CoEOM_stOpModeAct`, bit 1, DDE 7 and 8:
   the bit BimmerLink reads), else the after-treatment status (DDE 8.3 only, `5372`, the shape of OBD PID 8B: bit 0 =
   regenerating). Together with the heat until it has been seen both at 0 and at 1, then alone (a flag stuck at either
   is no flag).
2. **The heat** before the filter (`44EF`, else the sensor value `4502`): 500 °C or more for 30 s, with the soot at
   least half way to the regeneration point, starts one; under 420 °C for 30 s ends it. A regeneration runs at about
   600 °C; one by the heat that burnt no soot (towing, a long climb at full load) isn't logged.

A pause of less than 3 minutes (a stop at the lights, the engine unit holding it) goes on as the same regeneration, and
so does one the app was restarted in the middle of. Durations add up the time between reads while the engine runs: the
head unit sets its wall clock late and corrects it, by hours, so clock differences would lie.

**Done or stopped.** A regeneration is *done* when the distance since the last successful one (`44BF`) starts again
from 0, which is BMW's own marker of a successful regeneration; if that hasn't happened after 3 minutes of engine
running since its end (with that distance read: the next drive's first read decides when the engine was switched off
in the meantime), it counts as *stopped early*. A reset the app saw without having seen the regeneration run (it
wasn't running, or it was too short to tell) is logged as done, without its duration.

**The regeneration point** (the mark on the soot bar) is, in this order: the soot against the engine unit's own load
(DDE 8.3, `5371`: 0 % after a regeneration, 100 % = due), its average soot at a regeneration's start (`4B52`), the
median of the starts the app has logged, or 24 g (typical for a B47 / B57; shown as *typical*). It isn't learnt during
a regeneration (the load % stays up while the soot burns, so soot / load would follow the soot down), and while one
runs, until it is done or stopped, the bar keeps the point it started at, so the soot visibly falls away from it.

**Due:** the load at 100 %, the engine unit's regeneration request (`44BB` at 4-6, as BimmerLink reads it), or one
requested from the app that hasn't started yet (it is marked as requested in the log once it runs).

## Request regeneration

The bar's **Request regeneration** button opens a sheet on the DPF page with what a regeneration needs: the engine warm (coolant over 75 °C), fuel not on reserve, no exhaust or sensor faults stored, then
20-30 min at a steady 60 km/h or more without switching the engine off. **Send request** then sends one write to the
engine unit (in the Standard layout, where the head unit draws the buttons: the bar's button pressed again), exactly
as BimmerLink 2.38 sends it (its DPF screen's *Request DPF Regeneration*):

| Engine unit | Request (`2E`, WriteDataByIdentifier, to `0x12`) |
|---|---|
| DDE 8.3 (`D83BX7C0` indexes) | `2E 5F B4` + 95 bytes: zeros, `4E 20` at bytes 46-47 |
| DDE 7 / DDE 9 | `2E 5F B4 04 06 05` + 94 bytes: zeros, `4E 20` at bytes 48-49 |

`5FB4` is the SGBD's *CSF service library* (`ABGLEICH_CSF_PROG`, table `CSF_WERTE`); `4E 20` sets **QFL**, the fuel
burnt since the last regeneration, to 200.00 l, so the engine unit counts a regeneration as due and runs it once the
driving allows (the DDE 7 / 9 block's `06 05` names the value: service case 6, EEPROM, value 05, QFL). The answer
`6E 5F B4` means accepted; a refusal is shown with its reason. Nothing is sent while one runs, while the engine unit
blocks regenerations (`44C2` = 1), for an engine unit whose family the app doesn't know or without a live engine unit
(the sheet says why); after an accepted request there is none for 10 minutes. In the demo nothing is sent.
Tried on a car with DDE 8.3 (the G05 above): accepted, and the regeneration ran. The DDE 7 / 9 block is not tried
on a car yet; the bytes are BimmerLink's, the reading of them is the SGBD's.

**In the background** (`app.json` `autostart`): while the engine runs (rpm from the car's signal, not a request) the
filter's values are read every 20 s, every 5 s during a regeneration; nothing at all once the car is locked and left
(`VehicleCondition`), so the car can sleep. The log (`data/diesel.json`: the last 30 regenerations and the soot over the
last 1,000 km) is written every minute and at each regeneration's start and end. An app installed by hand
(`deploy-car.sh`) isn't started with the head unit: it then follows regenerations from its first opening on.

## What it reads

The engine unit tells its SGBD by its SGBD index (`22 F1 50`):

| Family | SGBD | Indexes | Layouts |
|---|---|---|---|
| DDE 8.3 | `D83BX7C0` (G-series B47 / B57) | `0F1FE8` `0F1FF0` `0F1FF4` `0F1FF8` `0F2670` `0F2674` `0F2678` `0F267C` | as in the SGBD |
| DDE 7 | `D75BX7A0`, `D70BX7A0` (F-series B47 / N47 / N57) | `0F1F70` `0F1F80` `0F1F90` `0F1FA0` | the filter's the same; EGR and injectors their own; no `53xx` / `4B5x` |
| DDE 9 | `D94BX7A0` (the newest DDE) | `0F2C80` | no public SGBD: read like DDE 8.3, marked **UNVERIFIED** |

An engine unit whose index isn't here is read like DDE 8.3 (UNVERIFIED) when the car's engine type says diesel or it
answers soot and the distance since the last regeneration plausibly; one of BMW's petrol engine units (by its index) is
left alone, and an unknown one only when it refuses both as unknown (NRC 31, 11 or 12).

| Value | DDE 8.3 | DDE 7 | Scaling |
|---|---|---|---|
| Soot (the regeneration coordinator's) | `44BE` | `44BE` | u16 × 0.01525902 g |
| Soot measured (pressure drop) / model | `44B9` / `44C1` | same | u16 × 0.01 g |
| Ash | `44BD` | same | u16 × 0.01525902 g |
| Pressure drop across the filter | `44ED` | same | u16 × 0.04577707 − 1000 hPa |
| Before the filter (corrected / sensor), before the oxidation catalyst | `44EF` / `4502`, `44F2` | same | u16 × 0.03128099 − 50 °C |
| Distance / engine time / fuel since the last successful regeneration | `44BF` / `44B7` / `44BC` | same | u32 m / u32 s / u16 × 0.01 l |
| Successful regenerations, average distance between | `44B8`, `44C7` | same | u16, u16 km |
| Odometer at the last five successful ones | `44D1`-`44D5` | same | u32 m |
| Filter life left | `4C78` | same | u16 × 10 km |
| Regeneration request / lock / interrupted (BimmerLink's reading: 4-6 / 1 / 1) | `44BB` / `44C2` / `44C0` | same | raw |
| Operating mode (bit 1: regeneration) | `467E` | same | u32 |
| After-treatment status (PID 8B: bit 0 regenerating, bit 1 active) | `5372` | — | u8 |
| Load against the regeneration point | `5371` | — | (u16 − 32767) × 100 / 255 % |
| Average soot at a regeneration's start / end | `4B52` / `4B53` | — | u16 × 0.01 − 327.67 g |
| AdBlue range, NOx before / after the SCR, SCR catalyst, before it, average conversion | `4692`, `450A` / `4508`, `532E`, `5308`, `4DF7` | same | km × 0.15259022, ppm × 0.03204395 − 100, °C × 0.03128099 − 50, × 0.001 |
| AdBlue quality; in the tank as the DDE receives it | `469C`; `4693` | —; `4693` | u8 × 0.2 %; u16 × 0.5 g (unverified: the level's fallback) |
| EGR high pressure: position / target | `4D8C` / `4D8A` | `4C97` / `4C93` | DDE 8: u16 × 0.01220703 − 399.98779297 %; DDE 7: u16 × 0.004578 − 100 % |
| EGR low pressure: position / target | `4D3B` / `4D39` | `4C73` / — | as above (DDE 7 has only a duty cycle as target) |
| EGR rate, air mass per stroke / target | `4D88`, `47DD` / `4872` | same | × 0.01 %, × 0.03891051 / × 0.03051804 mg |
| Rail pressure / target | `4748` / `4715` | same | × 0.04577707 bar |
| Boost / target (absolute), ambient | `4841` / `42C8`, `4CF0` | same | × 0.15259022 / × 0.09155413 / × 0.03051804 hPa |
| Injector quantity corrections 1-6 | `5570`-`5575` | same | DDE 8: × 0.01 − 327.67; DDE 7: × 0.003052 − 100 mg/stroke |

The AdBlue unit: tank level `E439` (SCR04, index `0F2940`) or `D4D1` (SCR03, `0F22B0`), u16 × 0.00097656 l.

The injector corrections are in firing order (the SGBDs: *"Zylinderspezifische FBC-Ausgleichsmenge für Zylinder N
(in Zündfolge)"*): the Engine page puts each under its cylinder, B47 1-3-4-2, B57 1-5-3-6-2-4 (six once the fifth or
sixth slot has read anything but 0).

**Pacing:** one request at a time, 120 ms apart; each identifier is first read alone, and once its reply length is
known, it goes with the others of its unit that are due or nearly due, up to 8 in one request. Live values every 1-2 s while their page is shown (5 s on Regenerations), the rest every 30 s. A refusal
(`7F 22 31`) carries no identifier and every app on the head unit gets every reply, so an identifier counts as *not on
this car* only after three refusals of its own single reads (and is asked again after a while).

## Not in it

- Resetting the filter's adaptation after a replacement, or any other write than the regeneration request.
- The DPF's fault codes: use the Fault Scanner.
- A petrol particulate filter (B48 / B58 OPF): Live Data and Service read its soot.

## Tests

`node tests/test_hr_diesel.js` (Node 8 compatible): the identifier table against BMW's SGBD index, the scalings, the
reader against a stand-in engine unit, the regeneration request's bytes and gates, the regeneration tracker, the demo
and every page drawn.
