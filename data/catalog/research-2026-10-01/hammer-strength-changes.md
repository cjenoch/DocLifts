# Hammer Strength changes (2026-10-01)

Input: seed-2026-09-30.csv, 64 Hammer Strength rows. Output: `hammer-strength.csv`, 86 rows (64 seed rows kept, 22 added). Every code, name and number below was read from a page fetched in this session (2026-10-01). Product codes come from the "Product Code" row of each lifefitness.com spec table.

## Owner decision (recorded as instructed)

Mid-task correction from the owner, relayed by the coordinator: the 8 `inferred` MTS rows citing the Life Fitness URL are correct. Hammer Strength is sold through Life Fitness, so lifefitness.com pages count as manufacturer pages for Hammer Strength. Do not blank or replace those sources. Applied as follows: all 12 MTS rows keep `source` = https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/motion-technology-selectorised. That listing page names every MTS model but shows **no codes or stack sizes**, so each row's `notes` also gives the LF product page where the code and stack were confirmed. The 8 inferred MTS rows were raised to `manufacturer_page`. I treated lifefitness.com.au (Life Fitness Australia) and support.lifefitness.com as Life Fitness pages too.

## Changed and added rows

| seed code | new code | name | what changed | source / confirming URL |
|---|---|---|---|---|
| (none) | PL-4W | Plate Loaded 4-Way Neck | model_code (empty) -> PL-4W; starting resistance (empty) -> 2/0.9/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/4-way-neck |
| (none) | PL-TBR-01 | Plate Loaded T-Bar Row | model_code (empty) -> PL-TBR-01; starting resistance (empty) -> 40/18/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/hammer-strength-plate-loaded-t-bar-row |
| IL-BP | IL-BP | Iso-Lateral Bench Press | starting resistance (empty) -> 7/3.2/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-bench-press |
| (none) | PL-AB | Plate Loaded Abdominal / Oblique Crunch | model_code (empty) -> PL-AB; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-abdominal-oblique-crunch |
| (none) | PL-GRIP | Plate Loaded Gripper | model_code (empty) -> PL-GRIP; starting resistance (empty) -> 14/6.3/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-gripper |
| (none) | IL-CB | Iso-Lateral Chest / Back | model_code (empty) -> IL-CB; starting resistance (empty) -> 7/3/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-chest-back |
| IL-DY | IL-DRW | Iso-Lateral D.Y. Row | model_code IL-DY -> IL-DRW; starting resistance (empty) -> 3/1.4/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-d-y-row |
| IL-DCP | IL-DCP | Iso-Lateral Decline Chest Press | starting resistance (empty) -> 6/3/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/iso-lateral-decline-chest-press |
| IL-FLP | IL-PD | Iso-Lateral Front Lat Pulldown | model_code IL-FLP -> IL-PD; starting resistance 1/0.5/total -> 1/0.5/per_arm; confidence reseller_or_manual -> manufacturer_page; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-front-lat-pulldown |
| IL-HR | IL-HR | Iso-Lateral High Row | starting resistance (empty) -> 2/0.9/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-high-row |
| IL-HBP | IL-HBP | Iso-Lateral Horizontal Bench Press | starting resistance 18/8.2/total -> 18/8.2/per_arm; confidence reseller_or_manual -> manufacturer_page; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-horizontal-bench-press |
| IL-IP (IL-IPV vertical grip) | IL-IP | Iso-Lateral Incline Press | model_code IL-IP (IL-IPV vertical grip) -> IL-IP; starting resistance 8/3.6/total -> 8/3.6/per_arm; confidence reseller_or_manual -> manufacturer_page; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-incline-press |
| IL-LR | IL-LR | Iso-Lateral Low Row | starting resistance (empty) -> 8/3.6/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-low-row |
| IL-ROW | IL-ROW | Iso-Lateral Row | source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-row |
| IL-SP | IL-SP | Iso-Lateral Shoulder Press | confidence reseller_or_manual -> manufacturer_page; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-shoulder-press |
| IL-FMP | IL-FMP | Iso-Lateral Super Incline Press | source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-super-incline-press |
| IL-WC | IL-WC | Iso-Lateral Wide Chest | starting resistance (empty) -> 2/0.9/; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-wide-chest |
| IL-WP | IL-WPD | Iso-Lateral Wide Pulldown | model_code IL-WP -> IL-WPD; starting resistance (empty) -> 2/0.9/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-wide-pulldown |
| (none) | PL-LR | Plate Loaded Lateral Raise | model_code (empty) -> PL-LR; starting resistance (empty) -> 1/0.5/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-lateral-raise |
| (none) | PL-PO | Plate Loaded Pullover | model_code (empty) -> PL-PO; starting resistance (empty) -> 18/8.2/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-pullover |
| (none) | PL-BI | Plate Loaded Seated Biceps | model_code (empty) -> PL-BI; starting resistance (empty) -> 4/2/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-seated-biceps |
| (none) | PL-DIP | Plate Loaded Seated Dip | model_code (empty) -> PL-DIP; starting resistance (empty) -> 4/2/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-seated-dip |
| (none) | PL-SH | Plate Loaded Seated / Standing Shrug | model_code (empty) -> PL-SH; starting resistance (empty) -> 25/11/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-seated-standing-shrug |
| PL-FLY | PL-FLY | Plate Loaded Super Fly | source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/super-fly |
| (none) | IL-TBR | Iso-Lateral T-Bar Row | model_code (empty) -> IL-TBR; starting resistance (empty) -> 23/10/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/iso-lateral-t-bar-row |
| (none) | PL-GHRH | Plate Loaded Glute Ham / Reverse Hyper | model_code (empty) -> PL-GHRH; starting resistance (empty) -> 6.5/3/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/glute-ham-reverse-hyper-combo |
| (none) | PL-GLD | Plate Loaded Glute Drive | model_code (empty) -> PL-GLD; starting resistance (empty) -> 45/20/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/hammer-strength-plate-loaded-glute-drive |
| (none) | PL-BSQ | Plate Loaded Belt Squat | model_code (empty) -> PL-BSQ; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/hammer-strength-plate-loaded-belt-squat |
| IL-KLC | IL-KLC | Iso-Lateral Kneeling Leg Curl | starting resistance (empty) -> 8/3.6/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-kneeling-leg-curl |
| IL-LC | IL-LC | Iso-Lateral Leg Curl | starting resistance (empty) -> 2/0.9/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-iso-lateral-leg-curl |
| (none) | PL-HSQ2 | Plate Loaded Hack Squat | model_code (empty) -> PL-HSQ2; starting resistance (empty) -> 125/57/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/hack-squat |
| HSLLP | HSLLP | Plate Loaded Linear Leg Press | confidence reseller_or_manual -> manufacturer_page; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-linear-leg-press |
| (none) | PL-CALF | Plate Loaded Seated Calf Raise | model_code (empty) -> PL-CALF; starting resistance (empty) -> 60/27/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-seated-calf-raise |
| (none) | PL-TIB | Plate Loaded Tibia Dorsi-Flexion | model_code (empty) -> PL-TIB; starting resistance (empty) -> 3/1.4/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-tibia-dorsi-flexion |
| (none) | PL-ANH | Plate Loaded Assisted Nordic Ham | model_code (empty) -> PL-ANH; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/assisted-nordic-ham |
| IL-LE | IL-LE | Iso-Lateral Leg Extension | starting resistance (empty) -> 4/1.8/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/iso-lateral-leg-extension |
| (none) | PL-XSQ | Plate Loaded Pendulum-X Squat | model_code (empty) -> PL-XSQ; starting resistance (empty) -> 81/37/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/pendulum-x-squat |
| (none) | PL-SSP | Plate Loaded Super Squat Press | model_code (empty) -> PL-SSP; starting resistance (empty) -> 65/29/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/super-squat-press |
| (none) | PL-RVSQ | Plate Loaded Reverse V-Squat | model_code (empty) -> PL-RVSQ; starting resistance (empty) -> 75/34/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/reverse-v-squat |
| (none) | GB-J | Ground Base Jammer | model_code (empty) -> GB-J; starting resistance (empty) -> 8/3.6/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/ground-base-jammer |
| (none) | GB-CT | Ground Base Combo Twist | model_code (empty) -> GB-CT; starting resistance (empty) -> 8/3.6/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/ground-base-combo-twist |
| (none) | GB-SHP | Ground Base Squat / High Pull | model_code (empty) -> GB-SHP; starting resistance (empty) -> 12/5/per_arm; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-squat-high-pull |
| (none) | GB-MSQ | Ground Base Multi-Squat | model_code (empty) -> GB-MSQ; starting resistance (empty) -> 45/20/total; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/ground-base-multi-squat |
| PL-VSQ | PL-VSQ | Plate Loaded V-Squat | source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-v-squat |
| MTSAB | MTSAB | MTS Abdominal Crunch | stack_lb (empty) -> 150; confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-abdominal-crunch |
| MTSBC | MTSBC | MTS Iso-Lateral Biceps Curl | stack_lb 150 -> 100; confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-biceps-curl |
| MTSCP | MTSCP | MTS Iso-Lateral Chest Press |  | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-chest-press |
| MTSDP | MTSDP | MTS Iso-Lateral Decline Press | confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-decline-press |
| MTSFP | MTSFP | MTS Iso-Lateral Front Pulldown |  | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-front-pulldown |
| MTSHR | MTSHR | MTS Iso-Lateral High Row | confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-high-row |
| MTSIP | MTSIP | MTS Iso-Lateral Incline Press |  | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-incline-press |
| MTSRW | MTSRW | MTS Iso-Lateral Row |  | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-row |
| MTSSP | MTSSP | MTS Iso-Lateral Shoulder Press | confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/mts-iso-lateral-shoulder-press |
| MTSTE | MTSTE | MTS Iso-Lateral Triceps Extension | stack_lb 150 -> 100; confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/mts-iso-lateral-triceps-extension |
| MTSLE | MTSLE | MTS Iso-Lateral Leg Extension | confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-iso-lateral-leg-extension |
| MTSKLC | MTSKC | MTS Iso-Lateral Kneeling Leg Curl | model_code MTSKLC -> MTSKC; confidence inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-mts-kneeling-leg-curl |
| (none) | HS-HAD | Hammer Strength Select Hip Adduction | model_code (empty) -> HS-HAD; stack_lb (empty) -> 295; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-hip-adduction |
| (none) | HS-SP | Hammer Strength Select Shoulder Press | model_code (empty) -> HS-SP; stack_lb (empty) -> 200; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-shoulder-press |
| (none) | HS-HG | Hammer Strength Select Hip and Glute | model_code (empty) -> HS-HG; stack_lb (empty) -> 295; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-hip-and-glute |
| (none) | HS-SLP | Hammer Strength Select Seated Leg Press | model_code (empty) -> HS-SLP; stack_lb (empty) -> 390; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-seated-leg-press |
| (none) | HS-BE | Hammer Strength Select Back Extension | model_code (empty) -> HS-BE; stack_lb (empty) -> 295; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-back-extension |
| (none) | HS-SC | Hammer Strength Select Standing Calf | model_code (empty) -> HS-SC; stack_lb (empty) -> 390; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-standing-calf |
| (none) | HS-AB | Hammer Strength Select Abdominal Crunch | model_code (empty) -> HS-AB; stack_lb (empty) -> 200; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-abdominal-crunch |
| (none) | HS-FLY | Hammer Strength Select Pectoral Fly/Rear Deltoid | model_code (empty) -> HS-FLY; stack_lb (empty) -> 295; source -> product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-pectoral-fly-rear-deltoid |
| (none) | IL-IPV | Iso-Lateral Incline Press (Vertical Handle) | ADDED | https://support.lifefitness.com/hc/en-us/articles/360037405913-Hammer-Strength-ISO-Lateral-Incline-Press-Differences |
| (none) | HS-ADC | Hammer Strength Select Assist Dip Chin | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-assist-dip-chin |
| (none) | HS-BC | Hammer Strength Select Biceps Curl | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-biceps-curl |
| (none) | HS-CP | Hammer Strength Select Chest Press | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-chest-press |
| (none) | HS-HAB | Hammer Strength Select Hip Abduction | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-hip-abduction |
| (none) | HS-HC | Hammer Strength Select Horizontal Calf | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-horizontal-calf |
| (none) | HS-LR | Hammer Strength Select Lateral Raise | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-lateral-raise |
| (none) | HS-PD | Hammer Strength Select Lat Pulldown | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-lat-pulldown |
| (none) | HS-LC | Hammer Strength Select Leg Curl | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-leg-curl |
| (none) | HS-LE | Hammer Strength Select Leg Extension | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-leg-extension |
| (none) | HS-RW | Hammer Strength Select Seated Row | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-seated-row |
| (none) | HS-FPD | Hammer Strength Select Fixed Pulldown | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-fixed-pulldown |
| (none) | HS-PEC | Hammer Strength Select Pectoral Fly | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-pectoral-fly |
| (none) | HS-SLC | Hammer Strength Select Seated Leg Curl | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-seated-leg-curl |
| (none) | HS-TE | Hammer Strength Select Triceps Extension | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-triceps-extension |
| (none) | IL-LP | Iso-Lateral Leg Press | ADDED | https://www.lifefitness.com.au/commercial/iso-lateral-leg-press-illp-hot-deal |
| (none) | PL-LE | Plate Loaded Leg Extension | ADDED | https://www.lifefitness.com.au/commercial/hammer-strength-plate-loaded-leg-extension-pl-le-hot-deal |
| (none) | GB-SL | Ground Base Squat Lunge | ADDED | https://www.lifefitness.com.au/commercial/hammer-strength-plate-loaded-squat-lunge-gb-sl-hot-deal |
| (none) | HSSMV | Plate-Loaded Vertical Smith Machine | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/plate-loaded/plate-loaded-vertical-smith-machine |
| (none) | HSSM | Smith Machine | ADDED | https://www.lifefitness.com.au/commercial/smith-machine-hssm |
| (none) | HDU-DPR | Pulldown / Row | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/hammer-strength-pulldown-row |
| (none) | HDU-CCOR | HS Dual Adjustable Pulley | ADDED | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/hammer-strength-dual-adjustable-pulley |

## Code corrections the merger should note

- `IL-DY` -> `IL-DRW` (Iso-Lateral D.Y. Row). The LF US and lifefitness.com.au pages both show IL-DRW. No page with IL-DY was found.
- `IL-FLP` -> `IL-PD` (Iso-Lateral Front Lat Pulldown). The seed cited "reseller spec" with no URL. LF US and AU both show IL-PD.
- `IL-WP` -> `IL-WPD` (Iso-Lateral Wide Pulldown). LF US and AU both show IL-WPD.
- `MTSKLC` -> `MTSKC` (MTS Kneeling Leg Curl). LF US and AU both show MTSKC.
- `IL-IP (IL-IPV vertical grip)` was split. The original row now has `IL-IP`, the code the LF US product page shows. A new `IL-IPV` row is sourced from the LF support article. That article also names `IL-IPH` (horizontal handles). I recorded IL-IPH only in notes, not as its own row. **Merger decides** whether IL-IP and IL-IPH should be separate rows.
- Starting-resistance basis corrected from `total` to `per_arm` on IL-PD (ex IL-FLP), IL-HBP and IL-IP, because the LF pages label these "Starting Resistance (per arm)".
- MTS stack corrections: MTSBC and MTSTE are 2 x 100 lb on LF (the seed had 150). MTSAB is a single 150 lb stack (the seed was empty).
- Select Abdominal Crunch: US page shows `HS-AB`, but lifefitness.com.au shows `HS-ABC`. The row keeps HS-AB and the variant is in notes.

## Merger must decide

- `HSSMV` (Plate-Loaded Vertical Smith Machine; LF US lists it under plate-loaded with 8 weight horns) and `HSSM` (Smith Machine, lifefitness.com.au). Both are smith machines and may fall outside scope.
- `IL-LP`, `PL-LE`, `GB-SL` come only from lifefitness.com.au clearance ("hot deal") pages and are not on the current LF US list. They are real Hammer Strength codes with spec tables.
- `HDU-DPR` and `HDU-CCOR` are Hammer Strength-branded cable-stack machines in the LF cable category. They use a new product_line, `Cable (HD)`.
- IL-IP vs IL-IPH (above).

## Not resolved

- PL-AB: LF gives starting resistance as "25 lb (11 kg) + 10% of user weight". Not entered as a number.
- PL-BSQ: starting resistance depends on the anchor (76 to 62 lb). Not entered.
- PL-ANH, IL-IPV: no starting resistance stated.
- IL-WC: LF gives 2 lb (0.9 kg) without saying total or per arm. Numbers entered, basis left empty.
- HDU-CCOR: "Weight Stacks: 400 lbs (181 kg)" does not say whether that is per stack or total. stack_lb left empty.
- MTS and Select pages give no starting resistance.
- PL-LE laterality is not stated, so it was left empty. HS-ADC (Assist Dip Chin) body_region left empty.

## Sources tried that failed

- https://support.lifefitness.com/hc/en-us/articles/360037405913-Hammer-Strength-ISO-Lateral-Incline-Press-Differences returned HTTP 403 (curl and WebFetch). I read the same article through the Zendesk JSON API at https://support.lifefitness.com/api/v2/help_center/en-us/articles/360037405913.json (200).
- https://bestgymequipment.co.uk/products/hammer-strength-iso-lateral-incline-press-plate-loaded-vertical returned HTTP 429.
- https://fitnessthings.com/product/iso-lateral-incline-press-vertical/ returned HTTP 404.
- https://www.lifefitness.com.au/commercial/hammer-strength returned HTTP 404 (I used the sitemap instead).
- The LF listing pages (plate-loaded/hammer-strength, motion-technology-selectorised) show no codes. All codes came from individual product pages.
- en-gb and en-eu LF catalog pages listed no Hammer Strength machines beyond the US list.
