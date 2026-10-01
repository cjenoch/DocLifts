# Matrix catalog changes (2026-10-01)

Output: `out/matrix.csv`, 147 rows (83 seed rows, all kept in seed order, + 64 new rows at the end).

| metric | before | after |
|---|---|---|
| rows | 83 | 147 |
| codeless | 0 | 0 |
| inferred | 15 | 5 |
| line_only | 0 | 0 |
| with_start | 0 | 30 |
| with_stack | 9 | 56 |
| no_region | 1 | 0 |

## Changed and added rows

| seed code | code now | name (seed) | what changed | fields | source |
|---|---|---|---|---|---|
| MG-PL12 | MG-PL12 | Magnum Vertical Bench Press | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl12-vertical-bench-press |
| MG-PL13 | MG-PL13 | Magnum Supine Bench Press | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl13-supine-bench-press |
| MG-PL14 | MG-PL14 | Magnum Incline Bench Press | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl14-incline-bench-press |
| MG-PL15 | MG-PL15 | Magnum Vertical Decline Bench Press | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl15-vertical-decline-bench-press |
| MG-PL21 | MG-PL21 | Magnum Seated Lateral Raise | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl21-seated-lateral-raise |
| MG-PL22 | MG-PL22 | Magnum Decline Pec Fly | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl22-decline-pec-fly |
| MG-PL23 | MG-PL23 | Magnum Shoulder Press | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl23-shoulder-press |
| MG-PL34 | MG-PL34 | Magnum Seated Row | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl34-seated-row |
| MG-PL35 | MG-PL35 | Magnum T-bar Row | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl35-tbar-row |
| MG-PL36 | MG-PL36 | Magnum Incline Lever Row | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl36-lever-row |
| MG-PL37 | MG-PL37 | Magnum High Row | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl37-high-row |
| MG-PL38 | MG-PL38 | Magnum Low Row | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl38-low-row |
| MG-PL41 | MG-PL41 | Magnum Elevated Biceps Curl | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl41-elevated-biceps-curl |
| MG-PL50 | MG-PL50 | Magnum Ab Crunch Bench | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl50-ab-crunch-bench |
| MG-PL62 | MG-PL62 | Magnum Smith Machine | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl62-smith-machine |
| MG-PL70 | MG-PL70 | Magnum 45-degree Leg Press | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl70-45-degree-leg-press |
| MG-PL71 | MG-PL71 | Magnum Hack Squat | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl71-hack-squat |
| MG-PL72 | MG-PL72 | Magnum Kneeling Leg Curl | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl72-kneeling-leg-curl |
| MG-PL73 | MG-PL73 | Magnum Reclining Leg Extension | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl73-reclining-leg-extension |
| MG-PL75 | MG-PL75 | Magnum Standing Hip Abductor | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl75-standing-hip-abductor |
| MG-PL76 | MG-PL76 | Magnum Standing Calf | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl76-standing-calf |
| MG-PL77 | MG-PL77 | Magnum Seated Calf | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl77-seated-calf |
| MG-PL78 | MG-PL78 | Magnum Glute Trainer | starting resistance from Matrix product data; source -> model page | starting_resistance_lb, starting_resistance_kg, starting_resistance_basis, stack_note, source | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl78-glute-trainer |
| G7-S79 | G7-S79 | Ultra (unlisted model in manual index) | name/body_region filled: G7-S79 is the Ultra Hip Thrust per Matrix product data | name, laterality, body_region, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g7-s79-hip-thrust |
| VS-S33 | VS-S33 | Versa Diverging Lat Pulldown | inferred -> confirmed (Matrix manufacturer product data) | confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/vs-s33-diverging-lat-pulldown |
| VS-S34 | VS-S34 | Versa Diverging Seated Row | inferred -> confirmed (Matrix manufacturer product data) | confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/vs-s34-diverging-seated-row |
| VS-S42 | VS-S42 | Versa Triceps Press / Seated Dip | inferred -> confirmed (Matrix manufacturer product data) | name, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/vs-s42-triceps-press |
| VS-S70 | VS-S70 | Versa Leg Press | inferred -> confirmed (Matrix manufacturer product data) | name, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/vs-s70-leg-press-calf-press |
| VS-S71 | VS-S71 | Versa Leg Extension | inferred -> confirmed (Matrix manufacturer product data) | confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/vs-s71-leg-extension |
| VS-S73 | VS-S73 | Versa Prone Leg Curl | unresolved; note added | notes | (none) |
| VS-S74 | VS-S74 | Versa Hip Adductor | inferred -> confirmed; name corrected (combo machine) | name, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/vs-s74-hip-abductor-adductor |
| VS-S75 | VS-S75 | Versa Hip Abductor | unresolved; note added | notes | (none) |
| VS-S77 | VS-S77 | Versa Calf | unresolved; note added | notes | (none) |
| VS-S21 | VS-S21 | Versa Lateral Raise | unresolved; note added | notes | (none) |
| G3-S10 | G3-S10 | Aura Chest Press | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s10-chest-press |
| G3-S12 | G3-S12 | Aura Pec Fly | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s12-pectoral-fly |
| G3-S13 | G3-S13 | Aura Converging Chest Press | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s13-converging-chest-press |
| G3-S22 | G3-S22 | Aura Rear Delt / Fly | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s22-rear-delt-fly |
| G3-S23 | G3-S23 | Aura Converging Shoulder Press | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s23-converging-shoulder-press |
| G3-S30 | G3-S30 | Aura Lat Pull | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s30-lat-pulldown |
| G3-S31 | G3-S31 | Aura Seated Row | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s31-seated-row |
| G3-S33 | G3-S33 | Aura Diverging Lat Pull | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s33-diverging-lat-pulldown |
| G3-S34 | G3-S34 | Aura Diverging Seated Row | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s34-diverging-seated-row |
| G3-S55 | G3-S55 | Aura Rotary Torso | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s55-rotary-torso |
| G3-S60 | G3-S60 | Aura Dip/Chin Assist | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer | confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s60-dip-chin-assist |
| G3-S70 | G3-S70 | Aura Leg Press | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s70-leg-press |
| G3-S71 | G3-S71 | Aura Leg Extension | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s71-leg-extension |
| G3-S72 | G3-S72 | Aura Seated Leg Curl | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s72-seated-leg-curl |
| G3-S73 | G3-S73 | Aura Prone Leg Curl | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s73-prone-leg-curl |
| G3-S74 | G3-S74 | Aura Hip Adductor | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s74-hip-adductor |
| G3-S75 | G3-S75 | Aura Hip Abductor | confirmed on Matrix product data; reseller -> manufacturer_page; stack from manufacturer; stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s75-hip-abductor |
| G3-S77 | G3-S77 | Aura Calf | inferred -> confirmed (Matrix manufacturer product data); stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s77-calf-press |
| G3-S40 | G3-S40 | Aura Biceps Curl | inferred -> confirmed (Matrix manufacturer product data); stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s40-arm-curl |
| G3-S42 | G3-S42 | Aura Seated Dip | inferred -> confirmed (Matrix manufacturer product data); stack_lb added | name, stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s42-triceps-press |
| G3-S52 | G3-S52 | Aura Back Extension | inferred -> confirmed (Matrix manufacturer product data); stack_lb added | stack_lb, stack_note, confidence, notes, source | https://us.matrixfitness.com/eng/strength/single-station/g3-s52-back-extension |
| G3-S53 | G3-S53 | Aura Abdominal | unresolved; note added | notes | (none) |
| (new) | G3-S20 | Aura Shoulder Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g3-s20-shoulder-press |
| (new) | G3-S21 | Aura Lateral Raise | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g3-s21-lateral-raise |
| (new) | G3-S45 | Aura Triceps Extension | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g3-s45-triceps-extension |
| (new) | G3-S50 | Aura Abdominal | added | new row | https://world.matrixfitness.com/eng/strength/single-station/g3-s50-abdominal |
| (new) | G3-S51 | Aura Abdominal Crunch | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g3-s51-abdominal-crunch |
| (new) | G3-S76 | Aura Rotary Hip | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g3-s76-rotary-hip |
| (new) | G3-MS20 | Aura Adjustable Cable Crossover | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g3-ms20-adjustable-cable-crossover |
| (new) | G3-MS24 | Aura Adjustable Pulley | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/adjustable-pulley |
| (new) | G3-MS51 | Aura Lat Pulldown (multi-station module) | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/lat-pulldown |
| (new) | G3-MS52 | Aura Triceps Pressdown (multi-station module) | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/triceps-pressdown |
| (new) | G3-MS53 | Aura Low Row (multi-station module) | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/low-row |
| (new) | G3-MS40 | Aura 4-Stack Multi-Station | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g3-ms40p-4-stack |
| (new) | G3-MS50 | Aura 5-Stack Multi-Station | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g3-ms50p-5-stack |
| (new) | G3-MS80 | Aura 8-Stack Multi-Station | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g3-ms80p-8-stack |
| (new) | G3-MSFT300 | Aura Functional Trainer | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g3-msft3-functional-trainer |
| (new) | G3-MSFT400 | Aura Functional Trainer | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g3-msft3-functional-trainer |
| (new) | G7-S41 | Ultra Dependent Arm Curl | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g7-s41-dependent-arm-curl |
| (new) | G7-S45 | Ultra Triceps Extension | added | new row | https://us.matrixfitness.com/eng/strength/single-station/g7-s45-triceps-extension |
| (new) | VS-S131 | Versa Multi Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s131-multi-press |
| (new) | VS-S331 | Versa Lat Pulldown / Seated Row | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s331-lat-pulldown-seated-row |
| (new) | VS-S401 | Versa Bicep / Tricep | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s401-bicep-tricep |
| (new) | VS-S531 | Versa Ab / Low Back | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s531-abdominal-back-extension |
| (new) | VS-S601 | Versa Chin / Dip Assist | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s601-chin-dip-assist |
| (new) | VS-S711 | Versa Leg Extension / Leg Curl | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s711-leg-extension-seated-leg-curl |
| (new) | VS-S78 | Versa Glute | added | new row | https://us.matrixfitness.com/eng/strength/single-station/vs-s78-glute |
| (new) | VS-VFT | Versa Functional Trainer | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/vs-vft-functional-trainer-30 |
| (new) | MD-S70 | Versa MD Leg Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/md-s70-leg-press |
| (new) | MD-S711 | Versa MD Leg Extension / Leg Curl | added | new row | https://us.matrixfitness.com/eng/strength/single-station/md-s711-leg-extension-leg-curl |
| (new) | MD-AP | Versa MD Adjustable Pulley | added | new row | https://us.matrixfitness.com/eng/strength/single-station/md-ap-adjustable-pulley |
| (new) | GO-S13 | Go Series Chest Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s13-chest-press |
| (new) | GO-S23 | Go Series Shoulder Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s23-shoulder-press |
| (new) | GO-S33 | Go Series Lat Pulldown | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s33-lat-pulldown |
| (new) | GO-S34 | Go Series Seated Row | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s34-seated-row |
| (new) | GO-S40 | Go Series Biceps Curl | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s40-biceps-curl |
| (new) | GO-S42 | Go Series Seated Triceps Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s42-seated-triceps-press |
| (new) | GO-S53 | Go Series Abdominal | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s53-abdominal |
| (new) | GO-S70 | Go Series Leg Press | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s70-leg-press |
| (new) | GO-S71 | Go Series Leg Extension | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s71-leg-extension |
| (new) | GO-S72 | Go Series Seated Leg Curl | added | new row | https://us.matrixfitness.com/eng/strength/single-station/go-s72-seated-leg-curl |
| (new) | GO-FT3 | Go Series Functional Trainer | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/go-ft-functional-trainer |
| (new) | GO-FT4 | Go Series Functional Trainer | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/go-ft-functional-trainer |
| (new) | MG-PL79 | Magnum Squat / Lunge | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl79-squat-lunge |
| (new) | MG-PL80 | Magnum Pendulum Squat | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl80-pendulum-squat |
| (new) | MG-PL81 | Magnum Belt Squat | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl81-belt-squat |
| (new) | MG-PL82 | Magnum Standing Hip Thrust | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-pl82-standing-hip-thrust |
| (new) | MG-405 | Magnum Reverse Back Extension | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/mg-405-reverse-back-extension |
| (new) | MG-921 | Magnum Lat Pulldown | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/mg-921-lat-pulldown |
| (new) | MG-926 | Magnum Low Row | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/mg-926-low-row |
| (new) | MG-946 | Magnum Lat Pulldown / Low Row | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/mg-946-lat-pulldown-low-row |
| (new) | MG-923 | Magnum Adjustable Pulley | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/mg-923-adjustable-pulley |
| (new) | MG-924 | Magnum Adjustable Crossover | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/mg-924-adjustable-crossover |
| (new) | MG-942 | Magnum Triceps Pushdown | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/mg-942-triceps-pushdown |
| (new) | VY-400 | Xult Perfect Squat | added | new row | https://world.matrixfitness.com/eng/strength/plate-loaded/vy-400-03-perfect-squat |
| (new) | VY-401 | Xult Leg Extension | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/vy-401-leg-extension |
| (new) | VY-402 | Xult Prone Leg Curl | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/vy-402-prone-leg-curl |
| (new) | VY-431 | Xult Biceps Curl | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/vy-431-biceps-curl |
| (new) | VY-432 | Xult Triceps Extension | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/vy-432-triceps-extension |
| (new) | VY-M49 | Xult Angled Smith Machine | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/vy-m49-02-angled-smith-machine |
| (new) | G1-FW161 | Xult Smith Machine | added | new row | https://us.matrixfitness.com/eng/strength/plate-loaded/g1-fw161-smith-machine-varsity |
| (new) | G1-MG30 | Xult 3-Stack Multi-Gym | added | new row | https://us.matrixfitness.com/eng/strength/multi-station/g1-mg30-3-stack-multi-gym |
| (new) | G1-MS20 | G1 Adjustable Cable Crossover | added | new row | https://world.matrixfitness.com/eng/strength/multi-station/g1-ms20-adjustable-cable-crossover |
| (new) | G1-MS40 | G1 4-Stack Multi-Station | added | new row | https://world.matrixfitness.com/eng/strength/multi-station/g1-ms40-4-stack |
| (new) | G1-MS50 | G1 5-Stack Multi-Station | added | new row | https://world.matrixfitness.com/eng/strength/multi-station/g1-ms50-5-stack |
| (new) | G1-MS80 | G1 8-Stack Multi-Station | added | new row | https://world.matrixfitness.com/eng/strength/multi-station/g1-ms80-8-stack |

## Could not resolve

- `VS-S73` Versa Prone Leg Curl: not in Matrix product data for any region. Left inferred.
- `VS-S75` Versa Hip Abductor: not in Matrix data. Versa's abduction/adduction is the single combo VS-S74, so this row is probably not a real model. Left inferred.
- `VS-S77` Versa Calf: not in Matrix data. Calf work is on VS-S70 Leg Press / Calf Press, so this is probably not a real model. Left inferred.
- `VS-S21` Versa Lateral Raise: not in Matrix data. Left inferred.
- `G3-S53` Aura Abdominal: not in Matrix data. Aura uses G3-S50 Abdominal and G3-S51 Abdominal Crunch (both added). The merger may want to retire G3-S53 in favor of G3-S50.
- Magnum independent-arm machines (PL12/13/14/15/23/34/37/38): Matrix states "Starting Resistance" without saying whether it is total or per arm. Numbers are filled but `starting_resistance_basis` is left empty. The merger must decide. MG-PL33 says N/A.
- Multi-stations with several stacks (G3-MS20/40/50/80, G1-MS20/40/50/80, G1-MG30): stack sizes not put in stack_lb (multiple stacks); see Matrix pages.
- G7 "B"/"BH" Base-trim variants (G7-S13B … G7-S79B/BH) exist as separate Matrix products. Per the seed convention they are recorded in notes rather than as rows. The merger may want rows for them because the placard will show the B code.

## Sources tried that failed, and notes on sources

- Matrix catalog/product pages are a JS app (no server-rendered data). Codes, names, status, stacks and starting resistance were read from Matrix's own API: https://us.matrixfitness.com/api/matrixfitness/products (pdb_id, series, page slug) + https://us.matrixfitness.com/api/graphql getProductInfo (name, modelNumber, webVisibleProductAttributes). Each row's `source` is the model's product page URL built from that API's nav id.
