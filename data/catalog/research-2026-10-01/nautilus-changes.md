# Nautilus catalog changes (2026-10-01)

Output: `out/nautilus.csv`, 96 rows (43 seed rows, all kept in seed order, + 53 new rows at the end).

| metric | before | after |
|---|---|---|
| rows | 43 | 96 |
| codeless | 20 | 4 |
| inferred | 16 | 3 |
| line_only | 0 | 0 |
| with_start | 0 | 1 |
| with_stack | 4 | 66 |
| no_region | 0 | 0 |

## Changed and added rows

| seed code | code now | name (seed) | what changed | fields | source |
|---|---|---|---|---|---|
| IPVP5 | IPVP5 | Inspiration Chest Press | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | source | https://www.corehandf.com/products/nautilus-inspiration-chest-press |
| IPSP5 | IPSP5 | Inspiration Shoulder Press | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | source | https://www.corehandf.com/products/nautilus-inspiration-shoulder-press |
| IPPD5 | IPPD5 | Inspiration Lat Pull Down | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_lb, stack_note, source | https://www.corehandf.com/products/nautilus-inspiration-lat-pull-down |
| IPVR5 | IPVR5 | Inspiration Vertical Row | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_lb, stack_note, source | https://www.corehandf.com/products/nautilus-inspiration-vertical-row |
| IPBA5 | IPBA5 | Inspiration Bilateral Arm Curl | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_lb, stack_note, source | https://www.corehandf.com/products/nautilus-inspiration-bilateral-arm-curl |
| IPAC5 | IPAC5 | Inspiration Abdominal Crunch | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_lb, stack_note, source | https://www.corehandf.com/products/nautilus-inspiration-abdominal-crunch |
| IPLP5 | IPLP5 | Inspiration Leg Press | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_note | https://www.corehandf.com/products/nautilus-inspiration-leg-press |
| IPLE5 | IPLE5 | Inspiration Leg Extension | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_note, source | https://www.corehandf.com/products/nautilus-inspiration-leg-extension |
| IPAA5 | IPAA5 | Inspiration Abduction / Adduction | source changed to the model's own manufacturer page (seed cited the leg press page for all rows); stack from that page where stated | stack_note, source | https://www.corehandf.com/products/nautilus-inspiration-abduction-adduction |
| IPLC5 | IPLC5 | Inspiration Seated Leg Curl | inferred -> confirmed (code shown on manufacturer page) | stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-leg-curl |
| IPPF5 | IPPF5 | Inspiration Pec Fly / Rear Delt | inferred -> confirmed (code shown on manufacturer page) | stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-pec-fly-rear-deltoid |
| IPLR5 | IPDR5 | Inspiration Lateral Raise | inferred code IPLR5 was wrong; corrected to IPDR5 from manufacturer page | model_code, name, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-deltoid-raise |
| IPPO5 | IPPO5 | Inspiration Pullover | inferred -> confirmed (code shown on manufacturer page) | stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-pull-over |
| IPTD5 | IPTD5 | Inspiration Tricep Dip | inferred -> confirmed (code shown on manufacturer page) | stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-tricep-dip |
| IPTE5 | IPTE5 | Inspiration Triceps Extension | inferred -> confirmed (code shown on manufacturer page) | stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-triceps-extension |
| IPLB5 | IPBE5 | Inspiration Lower Back | inferred code IPLB5 was wrong; corrected to IPBE5 from manufacturer page | model_code, name, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-back-extension |
| IPRT5 | IPRT5 | Inspiration Rotary Torso | inferred -> confirmed (code shown on manufacturer page) | stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/inspiration-rotary-torso |
| IPGL5 | IPGM5 | Inspiration Glute Press | inferred code IPGL5 was wrong; corrected to IPGM5 from manufacturer page | model_code, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-glute-press |
| IPCA5 | IPCA5 | Inspiration Calf | unresolved; note added | notes | (none) |
| IPDAP5 | NP-D9302 | Inspiration Dual Adjustable Pulley | inferred code IPDAP5 was wrong; corrected to NP-D9302 from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-inspiration-dual-adjustable-pulley |
| (none) | 9NA-S4301 | Impact Chest Press | code filled (9NA-S4301) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-chest-press |
| (none) | 9NA-S4307 | Impact Shoulder Press | code filled (9NA-S4307) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-shoulder-press |
| (none) | 9NA-S4304 | Impact Deltoid Fly | code filled (9NA-S4304) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-deltoid-fly |
| (none) | 9NA-S3305 | Impact Lat Pull Down | code filled (9NA-S3305) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-lat-pull-down |
| (none) | 9NA-S3306 | Impact Low Row | code filled (9NA-S3306) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-low-row |
| (none) | 9NA-S3302 | Impact Low Back Machine | code filled (9NA-S3302) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-low-back |
| (none) | 9NA-S1305 | Impact Leg Press | code filled (9NA-S1305) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-seated-leg-press |
| (none) | 9NA-S1312 | Impact Leg Extension | code filled (9NA-S1312) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-leg-extension |
| (none) | 9NA-S1301 | Impact Leg Curl | code filled (9NA-S1301) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-leg-curl |
| (none) | 9NA-S6301 | Impact Abdominal | code filled (9NA-S6301) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-impact-abdominal |
| 9NL-D2002 | 9NL-D2002 | Instinct Dual Adjustable Pulley | source -> manufacturer page; confidence raised | stack_note, confidence, source | https://www.corehandf.com/products/nautilus-instinct-dual-adjustable-pulley |
| (none) | 9NL-S3320 | Instinct Vertical Row | code filled (9NL-S3320) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-instinct-vertical-row |
| (none) | 9NL-S5100 | Instinct Biceps Curl | code filled (9NL-S5100) from authorized dealer page; not on current manufacturer page | model_code, stack_lb, stack_note, notes, source | https://fitdir.com/nautilus-instinct-biceps-curl/ |
| (none) | 9NL-D2120 | Instinct Dual Multi-Press | code filled (9NL-D2120) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-instinct-dual-multi-press |
| (none) | 9NL-D6330 | Instinct Dual Abdominal / Lower Back | code filled (9NL-D6330) from manufacturer page | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/nautilus-instinct-dual-abdominal-lower-back |
| (none) | 9NN-M8008-60AAS | Instinct 3-Stack Multi-Station | code filled from manufacturer page SKU | model_code, stack_lb, stack_note, confidence, notes, source | https://www.corehandf.com/products/3-stack-multi-station |
| 9NP-L2002 | 9NP-L2002 | Leverage Chest Press | source -> manufacturer page; confidence raised | confidence, notes, source | https://www.corehandf.com/products/nautilus-leverage-chest-press |
| 9NP-L2003 | 9NP-L2003 | Leverage Incline Press | source -> manufacturer page; confidence raised | confidence, notes, source | https://www.corehandf.com/products/nautilus-leverage-incline-press |
| (none) | 9NP-L4002 | Leverage Shoulder Press | code filled (9NP-L4002) from manufacturer page; inferred -> manufacturer_page | model_code, confidence, notes, source | https://www.corehandf.com/products/nautilus-leverage-shoulder-press |
| (none) | 9NP-L3004 | Leverage Row | code filled (9NP-L3004) from manufacturer page + owner's manual; inferred -> manufacturer_page | model_code, confidence, notes, source | https://www.corehandf.com/products/nautilus-leverage-low-row |
| (none) | 9NP-L3003 | Leverage Lat Pulldown | code filled (9NP-L3003) from manufacturer page; laterality bilateral -> independent (page: "independent arm design") | model_code, laterality, confidence, notes, source | https://www.corehandf.com/products/nautilus-leverage-lat-pull-down |
| (none) |  | Leverage Squat | unresolved; note added | notes | (none) |
| (none) |  | Leverage Leg Press | unresolved; note added | notes | (none) |
| (new) | IPBC5 | Inspiration Biceps Curl | added | new row | https://www.corehandf.com/products/nautilus-inspiration-biceps-curl |
| (new) | 9NA-S1313 | Impact Seated Leg Curl | added | new row | https://www.corehandf.com/products/nautilus-impact-seated-leg-curl |
| (new) | 9NA-S1311 | Impact Kneeling Leg Curl | added | new row | https://www.corehandf.com/products/nautilus-impact-kneeling-leg-curl |
| (new) | 9NA-S1308 | Impact Adductor | added | new row | https://www.corehandf.com/products/nautilus-impact-adductor |
| (new) | 9NA-S1307 | Impact Abductor | added | new row | https://www.corehandf.com/products/nautilus-impact-abductor |
| (new) | 9NA-S1309 | Impact Standing Calf | added | new row | https://www.corehandf.com/products/nautilus-impact-standing-calf |
| (new) | 9NA-S2301 | Impact Incline Press | added | new row | https://www.corehandf.com/products/nautilus-impact-incline-press |
| (new) | 9NA-S3303 | Impact Fixed Lat Pull Down | added | new row | https://www.corehandf.com/products/nautilus-impact-fixed-lat-pull-down |
| (new) | 9NA-S3301 | Impact Vertical Row | added | new row | https://www.corehandf.com/products/nautilus-impact-vertical-row |
| (new) | 9NA-S4302 | Impact Deltoid Raise | added | new row | https://www.corehandf.com/products/nautilus-impact-deltoid-raise |
| (new) | 9NA-S5301 | Impact Biceps Curl | added | new row | https://www.corehandf.com/products/nautilus-impact-biceps-curl |
| (new) | 9NA-S5302 | Impact Triceps Extension | added | new row | https://www.corehandf.com/products/nautilus-impact-triceps-extension |
| (new) | 9NA-S5303 | Impact Dip Machine | added | new row | https://www.corehandf.com/products/nautilus-impact-dip-machine |
| (new) | 9NA-S6334 | Impact Chin Dip Assist | added | new row | https://www.corehandf.com/products/nautilus-impact-chin-dip-assist |
| (new) | 9NL-S1010 | Instinct Leg Extension | added | new row | https://www.corehandf.com/products/nautilus-instinct-leg-extension |
| (new) | 9NL-S1011 | Instinct Leg Curl | added | new row | https://www.corehandf.com/products/nautilus-instinct-leg-curl |
| (new) | 9NL-D1014 | Instinct Dual Leg Extension / Leg Curl | added | new row | https://www.corehandf.com/products/nautilus-instinct-dual-leg-extension-leg-curl |
| (new) | 9NL-D1013 | Instinct Dual Leg Press / Calf Raise | added | new row | https://www.corehandf.com/products/nautilus-instinct-dual-leg-press-calf-raise |
| (new) | 9NL-D1015 | Instinct Dual Inner / Outer Thigh | added | new row | https://www.corehandf.com/products/nautilus-instinct-dual-inner-outer-thigh |
| (new) | 9NL-S1012 | Instinct Glute Press | added | new row | https://www.corehandf.com/products/nautilus-instinct-glute-press |
| (new) | 9NL-S2100 | Instinct Chest Press | added | new row | https://www.corehandf.com/products/nautilus-instinct-chest-press |
| (new) | 9NL-D3340 | Instinct Dual Lat Pull Down / Vertical Row | added | new row | https://www.corehandf.com/products/nautilus-instinct-dual-lat-pull-down-vertical-row |
| (new) | 9NL-S3310 | Instinct Lat Pull Down | added | new row | https://www.corehandf.com/products/nautilus-instinct-lat-pull-down |
| (new) | 9NL-S4100 | Instinct Shoulder Press | added | new row | https://www.corehandf.com/products/nautilus-instinct-shoulder-press |
| (new) | 9NL-D2110 | Instinct Dual Pectoral Fly / Rear Deltoid | added | new row | https://www.corehandf.com/products/nautilus-instinct-dual-pectoral-fly-rear-deltoid |
| (new) | 9NL-D5120 | Instinct Dual Biceps Curl / Triceps Extension | added | new row | https://www.corehandf.com/products/nautilus-instinct-dual-biceps-curl-triceps-extension |
| (new) | 9NL-S6300 | Instinct Rotary Torso | added | new row | https://www.corehandf.com/products/nautilus-instinct-rotary-torso |
| (new) | 9NP-L2004 | Leverage Decline Press | added | new row | https://www.corehandf.com/products/nautilus-leverage-decline-press |
| (new) | 9NP-L3005 | Leverage High Row | added | new row | https://www.corehandf.com/products/nautilus-leverage-high-row |
| (new) | 9NP-L5002 | Leverage Biceps Curl | added | new row | https://www.corehandf.com/products/nautilus-leverage-biceps-curl |
| (new) | 9NP-L5003 | Leverage Abdominal Crunch | added | new row | https://www.corehandf.com/products/nautilus-leverage-abdominal-crunch |
| (new) | 9NP-L3006 | Leverage Deadlift Shrug | added | new row | https://www.corehandf.com/products/nautilus-leverage-deadlift-shrug |
| (new) | NP-L3140 | Leverage Incline Lever Row | added | new row | https://www.corehandf.com/products/nautilus-plate-loaded-incline-lever-row |
| (new) | NP-L1141 | Angled Leg Press | added | new row | https://www.corehandf.com/products/nautilus-plate-loaded-angled-leg-press |
| (new) | NP-L1145 | Leverage Angled Leg Press Pro | added | new row | https://www.corehandf.com/products/angled-leg-press-pro |
| (new) | NP-L1130 | Leverage Hack Squat | added | new row | https://www.corehandf.com/products/nautilus-plate-loaded-hack-squat |
| (new) | NP-L1110 | Leverage Tilt Seat Calf | added | new row | https://www.corehandf.com/products/nautilus-plate-loaded-tilt-seat-calf |
| (new) | NP-L1131 | Leverage Glute Drive | added | new row | https://www.corehandf.com/products/nautilus-plate-loaded-glute-drive |
| (new) | 9NP-L1142 | Leverage Power Squat | added | new row | https://www.corehandf.com/products/power-squat-1 |
| (new) | 9NP-L1143 | Leverage Pendulum Squat | added | new row | https://www.corehandf.com/products/pendulum-squat-1 |
| (new) | 9NP3-L3007 | Leverage Leg Extension | added | new row | https://www.corehandf.com/products/leg-extension |
| (new) | 9NP3-L3008 | Leverage Lying Leg Curl | added | new row | https://www.corehandf.com/products/lying-leg-curl-1 |
| (new) | 9NP3-L5004 | Leverage Tricep Dip | added | new row | https://www.corehandf.com/products/tricep-dip |
| (new) | 9NP3-L5005 | Leverage Biceps Curl (9NP3) | added | new row | https://www.corehandf.com/products/biceps-curl |
| (new) | (none) | Leverage Standing Calf | added | new row | https://www.corehandf.com/products/standing-calf |
| (new) | (none) | Leverage Belt Squat | added | new row | https://www.corehandf.com/products/nautilus-belt-squat |
| (new) | HSPL3 | HumanSport Pull Lift | added | new row | https://www.corehandf.com/products/nautilus-humansport-pull-lift |
| (new) | HSTL3 | HumanSport Total Legs | added | new row | https://www.corehandf.com/products/nautilus-humansport-total-legs |
| (new) | HSAC3 | HumanSport Arm Crunch | added | new row | https://www.corehandf.com/products/nautilus-humansport-arm-crunch |
| (new) | HSFT3 | HumanSport Freedom Trainer | added | new row | https://www.corehandf.com/products/nautilus-humansport-freedom-trainer |
| (new) | HSLP3 | HumanSport Lat Pulley | added | new row | https://www.corehandf.com/products/nautilus-humansport-lat-pulley |
| (new) | HSSC3 | HumanSport Shoulder Chest | added | new row | https://www.corehandf.com/products/nautilus-humansport-shoulder-chest |
| (new) | HSTD3 | HumanSport Total Delts | added | new row | https://www.corehandf.com/products/nautilus-humansport-total-delts |

## Could not resolve

- `IPCA5` Inspiration Calf (inferred): the manufacturer's 20-model Inspiration collection has no calf machine; code and name unconfirmed. Left inferred, note added.
- Leverage Squat (codeless, inferred): ambiguous. Manufacturer plate-loaded line has Power Squat 9NP-L1142, Pendulum Squat 9NP-L1143, Hack Squat NP-L1130 and Belt Squat (all added as rows). Left inferred, note added.
- Leverage Leg Press (codeless, inferred, laterality independent): no independent-arm Leverage leg press found; the Leverage collection has Angled Leg Press NP-L1141 and Angled Leg Press Pro NP-L1145 (added as rows). Left inferred, note added.
- Leverage starting resistance: dealer copies (fitdir.com and others) quote per-arm starting resistance per model (e.g. Low Row 18 lb / 8 kg, Chest Press 18 lb, Incline 15 lb, Decline 12 lb, Lat Pull Down 5 lb, Biceps 12 lb, Ab Crunch 28 lb, Deadlift Shrug 25 lb), but the same page also has a generic "15 lbs per arm" spec block, and the manufacturer pages and the owner's manual don't state it. Not filled; values put in notes for the merger.
- Leverage Standing Calf and Leverage Belt Squat were added without codes because the manufacturer pages show no SKU. A dealer lists the belt squat as NP-L1132 (not fetched/confirmed).
- Code-prefix variants: the manufacturer pages show `9NP-L…`, but the owner's manual shows `NP-L3004`, and dealer SKUs add finish suffixes (`-60BZS`). Angled Leg Press, Hack Squat, Tilt Seat Calf and Glute Drive show `NP-L…` on the manufacturer site and `9NP-L…` at dealers. The placard decides.

## Sources tried that failed, and notes on sources

- https://progymsupply.com/p/nautilus-leverage-low-row/ (403)
- https://akfit.com/products/leverage-row (429)
- https://www.fitnesssuperstore.com/... Leverage Low Row / Instinct Biceps Curl pages (empty body via curl)
- https://ddbarbell.com/products/nautilus-plate-loaded-belt-squat (429): belt squat code NP-L1132 unconfirmed
- Owner's manual PDF 620-8418-NP-L3004-LevRowOM.pdf fetched OK, but it states no starting resistance
