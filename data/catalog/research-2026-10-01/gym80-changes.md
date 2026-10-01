# gym80 catalog changes (2026-10-01)

Output: `out/gym80.csv`, 155 rows (128 seed rows, all kept in seed order, + 27 new rows at the end).

| metric | before | after |
|---|---|---|
| rows | 128 | 155 |
| codeless | 0 | 0 |
| inferred | 0 | 0 |
| line_only | 0 | 0 |
| with_start | 0 | 0 |
| with_stack | 0 | 0 |
| no_region | 2 | 0 |

## Changed and added rows

| seed code | code now | name (seed) | what changed | fields | source |
|---|---|---|---|---|---|
| 5002 | 5002 | Innovation Glutes | body_region filled (glutes) from manufacturer page; source -> model page (seed source gym80.us now a maintenance page) | body_region, notes, source | https://gym80.de/en/product/5002/ |
| 5004 | 5004 | Innovation Curler | body_region filled (arms: biceps curl machine); laterality bilateral -> independent ("two independently supported training arms"); source -> model page | laterality, body_region, notes, source | https://gym80.de/en/product/5004/ |
| (new) | 5001 | Innovation Leg Press | added | new row | https://gym80.de/en/product/5001/ |
| (new) | 5003 | Innovation Rowing Machine | added | new row | https://gym80.de/en/product/5003/ |
| (new) | 5006 | Innovation Multi Extension Machine | added | new row | https://gym80.de/en/product/5006/ |
| (new) | 4401 | FTM Deadlift Machine | added | new row | https://gym80.de/en/product/4401/ |
| (new) | 4402 | FTM Shoulder & Chest Press | added | new row | https://gym80.de/en/product/4402/ |
| (new) | 4403 | FTM Push & Pull Machine | added | new row | https://gym80.de/en/product/4403/ |
| (new) | 4416 | Bootymizer | added | new row | https://gym80.de/en/product/4416/ |
| (new) | 5011 | Abduction and Adduction Combo | added | new row | https://gym80.de/en/product/5011/ |
| (new) | 5012 | Abdominal and Back Combo | added | new row | https://gym80.de/en/product/5012/ |
| (new) | 5013 | Leg Curl and Leg Extension Combo | added | new row | https://gym80.de/en/product/5013/ |
| (new) | 5014 | Butterfly and Butterfly Reverse Combo | added | new row | https://gym80.de/en/product/5014/ |
| (new) | 5015 | Shoulder and Lat Pull Combo | added | new row | https://gym80.de/en/product/5015/ |
| (new) | 5101 | Cable Art No. 1 - Shoulder & Back+ | added | new row | https://gym80.de/en/product/5101/ |
| (new) | 5102 | Cable Art No. 2 - Latissimus & Trapezius+ | added | new row | https://gym80.de/en/product/5102/ |
| (new) | 5103 | Cable Art No. 3 - Chest & Shoulder+ | added | new row | https://gym80.de/en/product/5103/ |
| (new) | 5104 | Cable Art No. 4 - Biceps & Triceps+ | added | new row | https://gym80.de/en/product/5104/ |
| (new) | 5105 | Cable Art No. 5 - Upper Body | added | new row | https://gym80.de/en/product/5105/ |
| (new) | 5106 | Cable Art No. 6 - Legs | added | new row | https://gym80.de/en/product/5106/ |
| (new) | 4042 | Adjustable V-Station | added | new row | https://gym80.de/en/product/4042/ |
| (new) | 4044 | 5-Station Tower | added | new row | https://gym80.de/en/product/4044/ |
| (new) | 4117 | 5 Station Tower | added | new row | https://gym80.de/en/product/4117/ |
| (new) | 4170 | 8-Station Tower | added | new row | https://gym80.de/en/product/4170/ |
| (new) | 4116 | Lat Pull Station | added | new row | https://gym80.de/en/product/4116/ |
| (new) | 4125 | Pulley Explosive | added | new row | https://gym80.de/en/product/4125/ |
| (new) | 4900 | Incline Row Combo | added | new row | https://gym80.de/en/product/4900/ |
| (new) | 5201 | Multi-Power Station | added | new row | https://gym80.de/en/product/5201/ |
| (new) | 5242 | Multi-Power Station privategym | added | new row | https://gym80.de/en/product/5242/ |

## Could not resolve

- gym80 lists stacks only in kg, so stack_lb was not filled. Std/optional stack sizes are in notes.
- Not added (no resistance machine or out of scope): 4093 Basic Seated Scott Curl, 4019 Basic Standing Scott Curl, 4046 Basic Abdominal Flexor, 4347 Sissy Squat, 80A000xx accessories.

## Sources tried that failed, and notes on sources

- https://gym80.us/hfa-2026-san-diego-gym80-equipment-demos-mixer/ (seed source) now returns a "site under maintenance" page. The two rows were re-sourced to gym80.de model pages.
