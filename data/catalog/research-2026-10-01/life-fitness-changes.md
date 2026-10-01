# Life Fitness — changes 2026-10-01

Output: `life-fitness.csv` (61 seed rows + 18 new = 79 rows).

Sources: Life Fitness US catalog pages (lifefitness.com/en-us), Life Fitness Australia catalog (lifefitness.com.au, product JSON on /commercial/strength/selectorised), and Life Fitness's own tech-support document library (lftechsupport.com) parts-manual PDFs plus its "PM ST Strength Models English.xls" model list. All are manufacturer-hosted, so confidence is `manufacturer_page`.

## Changed seed rows

| Line | Name (unchanged) | Code | What changed | Source |
|---|---|---|---|---|
| Insignia Series | Insignia Series Abdominal | SS-AB | code SS-AB from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-abdominal |
| Insignia Series | Insignia Series Abdominal Advanced | SS-ABD | code SS-ABD from LF US product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-abdominal-advanced |
| Insignia Series | Insignia Series Back Extension | SS-BE | code SS-BE from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-back-extension |
| Insignia Series | Insignia Series Torso Rotation | SS-TR | code SS-TR from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-torso-rotation |
| Insignia Series | Insignia Series Arc Leg Press | SS-LP | code SS-LP from LF US product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-arc-leg-press |
| Insignia Series | Insignia Series Glute Bridge | SS-GLB | code SS-GLB from LF US product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-glute-bridge |
| Insignia Series | Insignia Series Glute | SS-GL | code SS-GL from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-glute |
| Insignia Series | Insignia Series Hip Abduction | SS-HAB | code SS-HAB from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-hip-abduction |
| Insignia Series | Insignia Series Hip Abductor / Adductor | SS-HAA | code SS-HAA from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-hip-abductor-adductor |
| Insignia Series | Insignia Series Sit / Stand Hip Abductor | SS-SHB | code SS-SHB from LF US product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-sit-stand-hip-abductor |
| Insignia Series | Insignia Series Hip Adduction | SS-HAD | code SS-HAD from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-hip-adduction |
| Insignia Series | Insignia Series Leg Curl | SS-LC | code SS-LC from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-leg-curl |
| Insignia Series | Insignia Series Leg Extension | SS-LE | code SS-LE from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-leg-extension |
| Insignia Series | Insignia Series Seated Leg Curl | SS-SLC | code SS-SLC from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-seated-leg-curl |
| Insignia Series | Insignia Series Calf Extension | SS-CE | code SS-CE from LF US product page; stack_lb 335 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-calf-extension |
| Insignia Series | Insignia Series Chest Press | SS-CP | code SS-CP from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-chest-press |
| Insignia Series | Insignia Series Dual Axis Chest Press | SS-CPX | code SS-CPX from LF US product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-dual-axis-chest-press |
| Insignia Series | Insignia Series Shoulder Press | SS-SP | code SS-SP from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-shoulder-press |
| Insignia Series | Insignia Series Pectoral Fly | SS-PEC | code SS-PEC from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-pectoral-fly |
| Insignia Series | Insignia Series Pectoral Fly/Rear Deltoid | SS-FLY | code SS-FLY from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-pectoral-fly-rear-deltoid |
| Insignia Series | Insignia Series Assist Dip Chin | SS-ADC | code SS-ADC from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-assist-dip-chin |
| Insignia Series | Insignia Series Triceps Extension | SS-TE | code SS-TE from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-triceps-extension |
| Insignia Series | Insignia Series Triceps Press | SS-TP | code SS-TP from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-triceps-press |
| Insignia Series | Insignia Series Lateral Raise | SS-LR | code SS-LR from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-lateral-raise |
| Insignia Series | Insignia Series Biceps Curl - Dependent | SS-BCD | code SS-BCD from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-biceps-curl-dependent |
| Insignia Series | Insignia Series Biceps Curl | SS-BC | code SS-BC from LF US product page; stack_lb 170 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-biceps-curl |
| Insignia Series | Insignia Series Pulldown | SS-PD | code SS-PD from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-pulldown |
| Insignia Series | Insignia Series Dual Axis Pulldown | SS-PDX | code SS-PDX from LF US product page | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-dual-axis-pulldown |
| Insignia Series | Insignia Series Row | SS-RW | code SS-RW from LF US product page; stack_lb 260 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/insignia-series-row |
| Axiom Series | Axiom Series Leg Press | OP-LP | code OP-LP from LF US product page; stack_lb 262.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-leg-press |
| Axiom Series | Axiom Series Chest Press | OP-CP | code OP-CP from LF US product page; stack_lb 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-chest-press |
| Axiom Series | Axiom Series Dual Adjustable Pulley | OP-DAP | code OP-DAP from LF US product page; stack_lb 165 | https://www.lifefitness.com/en-us/catalog/strength-training/storage-racks/life-fitness-dual-adjustable-puley-4-1 |
| Axiom Series | Axiom Series Shoulder Press | OP-SP | code OP-SP from LF US product page; stack_lb 172.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-shoulder-press |
| Axiom Series | Axiom Series Lat Pulldown | OP-PD | code OP-PD from LF US product page; stack_lb 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-lat-pulldown |
| Axiom Series | Axiom Series Biceps Curl | OP-BC | code OP-BC from LF US product page; stack_lb 172.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-biceps-curl |
| Axiom Series | Axiom Series Triceps Extension | OP-TE | code OP-TE from LF US product page; stack_lb 142.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-triceps-extension |
| Axiom Series | Axiom Series Seated Row | OP-RW | code OP-RW from LF US product page; stack_lb 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-seated-row |
| Axiom Series | Axiom Series Leg Curl | OP-LC | code OP-LC from LF US product page; stack_lb 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-leg-curl |
| Axiom Series | Axiom Series Leg Extension | OP-LE | code OP-LE from LF US product page; stack_lb 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-leg-extension |
| Axiom Series | Axiom Series Abdominal | OP-AB | code OP-AB from LF US product page; stack_lb 142.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-abdominal |
| Axiom Series | Axiom Series Smith Rack | OP-SM | code OP-SM from LF US product page; starting resistance 45 lb/20 kg | https://www.lifefitness.com/en-us/catalog/strength-training/storage-racks/axiom-series-smith-rack |
| Signature Series (legacy) | Signature Series Chest Press | FZCP | code FZCP; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627000&name=DLFE-91053.pdf |
| Signature Series (legacy) | Signature Series Shoulder Press | FZSP | code FZSP; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627026&name=DLFE-91073.pdf |
| Signature Series (legacy) | Signature Series Pectoral Fly/Rear Deltoid | FZFRD | code FZFRD; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=2328377&name=DLFE-91055.pdf |
| Signature Series (legacy) | Signature Series Lat Pulldown | FZPD | code FZPD; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627022&name=DLFE-91063.pdf |
| Signature Series (legacy) | Signature Series Row | FZRW | code FZRW; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627023&name=DLFE-91064.pdf |
| Signature Series (legacy) | Signature Series Biceps Curl | FZBC | code FZBC; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1626997&name=DLFE-91051.pdf |
| Signature Series (legacy) | Signature Series Triceps Extension | — | unresolved (kept inferred) | — |
| Signature Series (legacy) | Signature Series Triceps Press | FZTP | code FZTP; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627029&name=DLFE-92509.pdf |
| Signature Series (legacy) | Signature Series Lateral Raise | FZLR | code FZLR; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627010&name=DLFE-91059.pdf |
| Signature Series (legacy) | Signature Series Leg Extension | FZLE | code FZLE; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627011&name=DLFE-91061.pdf |
| Signature Series (legacy) | Signature Series Seated Leg Curl | FZSLC | code FZSLC; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627024&name=DLFE-91065.pdf |
| Signature Series (legacy) | Signature Series Leg Press | FZSLP | code FZSLP; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627025&name=DLFE-123155.pdf |
| Signature Series (legacy) | Signature Series Calf Extension | FZCE | code FZCE; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1626999&name=DLFE-91052.pdf |
| Signature Series (legacy) | Signature Series Hip Abductor/Adductor | — | unresolved (kept inferred) | — |
| Signature Series (legacy) | Signature Series Glute | FZGL | code FZGL; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627006&name=DLFE-120256.pdf |
| Signature Series (legacy) | Signature Series Abdominal | FZAB | code FZAB; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1626991&name=DLFE-99234.pdf |
| Signature Series (legacy) | Signature Series Back Extension | FZBE | code FZBE; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1626995&name=DLFE-91049.pdf |
| Signature Series (legacy) | Signature Series Torso Rotation | FZTR | code FZTR; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627028&name=DLFE-91074.pdf |
| Signature Series (legacy) | Signature Series Assist Dip Chin | FZADC | code FZADC; inferred -> manufacturer_page (LF tech-support parts manual) | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1945562&name=DLFE-91048.pdf |
| Signature Series (legacy) | Signature Series Dual Adjustable Pulley | CMDAP | code CMDAP; stack_lb 390; inferred -> manufacturer_page | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/life-fitness-dual-adjustable-pulley |

## Added rows

| Line | Name | Code | Why | Source |
|---|---|---|---|---|
| Axiom Series | Axiom Series Abdominal / Back Extension | OP-ABBA | compact/low tower line; stack 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-abdominal-back-extension |
| Axiom Series | Axiom Series Biceps/Triceps | OP-BT | compact/low tower line; stack 172.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-biceps-triceps |
| Axiom Series | Axiom Series Lat Pulldown/Low Row | OP-LR | compact/low tower line; stack 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-lat-pulldown-low-row |
| Axiom Series | Axiom Series Leg Extension / Leg Curl | OP-LCE | compact/low tower line; stack 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-leg-extension-leg-curl |
| Axiom Series | Axiom Series Seated Leg Curl / Extension | OP-SLCE | compact/low tower line; stack 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-seated-leg-curl-extension |
| Axiom Series | Axiom Series Multi-Press | OP-MP | compact/low tower line; stack 202.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-multi-press |
| Axiom Series | Axiom Series Pectoral Fly/Rear Deltoid | OP-FLY | compact/low tower line; stack 262.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-pectoral-fly-rear-deltoid |
| Axiom Series | Axiom Series Hip Abductor Adductor | OP-HAA | compact/low tower line; stack 142.5 | https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/axiom-series-hip-abductor-adductor |
| Signature Series (legacy) | Signature Series Pectoral Fly | FZPEC | legacy single-station line (FZ codes), discontinued; stack — | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627021&name=DLFE-91062.pdf |
| Signature Series (legacy) | Signature Series Leg Curl | FZLC | legacy single-station line (FZ codes), discontinued; stack — | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1886847&name=DLFE-91060.pdf |
| Signature Series (legacy) | Signature Series Hip Abduction | FZHAB | legacy single-station line (FZ codes), discontinued; stack — | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627008&name=DLFE-91057.pdf |
| Signature Series (legacy) | Signature Series Hip Adduction | FZHAD | legacy single-station line (FZ codes), discontinued; stack — | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627009&name=DLFE-91058.pdf |
| Signature Series (legacy) | Signature Series Fly | FZFLY | legacy single-station line (FZ codes), discontinued; stack — | https://www.lftechsupport.com/c/document_library/get_file?p_l_id=1691375&folderId=1627005&name=DLFE-122702.pdf |
| Signature Series (legacy) | Signature Series Chest Press (Cable Motion) | CMCP | Cable Motion line; stack 190 | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/signature-series-chest-press |
| Signature Series (legacy) | Signature Series Shoulder Press (Cable Motion) | CMSP | Cable Motion line; stack 150 | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/signature-series-shoulder-press |
| Signature Series (legacy) | Signature Series Pulldown (Cable Motion) | CMPD | Cable Motion line; stack 220 | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/signature-series-pulldown |
| Signature Series (legacy) | Signature Series Row (Cable Motion) | CMRW | Cable Motion line; stack 220 | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/signature-series-row |
| Cable Machines | Adjustable Cable Crossover | LCM-CC | current LF cable crossover; stack — | https://www.lifefitness.com/en-us/catalog/strength-training/cable-machines-functional-trainers/adjustable-cable-crossover |

## Not resolved

- **Signature Series Triceps Extension** (inferred, kept). LF's Signature single-station list (tech-support model list .xls and FZ parts manuals) has no triceps extension: it lists only FZTP Triceps Press. This row may not exist as a Signature model. The merger should decide whether to keep it.
- **Signature Series Hip Abductor/Adductor** (inferred, kept). Signature had separate FZHAB Hip Abduction and FZHAD Hip Adduction (both added as rows) and no combined unit in the FZ list. The seed row may stand for one of those two.
- Signature Series stack sizes are not filled. The FZ parts manuals list several stack labels per machine (190/280/310/390 lb options), so no single standard stack can be stated.
- Insignia SS-ABD, SS-LP, SS-CPX, SS-PDX, SS-GLB and SS-SHB: neither LF site states a weight stack (only machine weight "with C stack"). Stack is left empty.
- The Axiom OP-DAP starting resistance is not filled. The page gives an "effective user resistance 2-80 lbs (2-40 kg)" range but does not say whether that is per side, so it is only quoted in stack_note.

## Notes for the merger

- **Axiom code variants:** the US site shows `OP-xx` (e.g. OP-CP). LF Australia shows `PH-OPxx` (e.g. PH-OPCP) for the same machines. OP-DAP, OP-SM and OP-FS appear the same on both sites. The CSV uses the US codes and notes the AU form. A placard may show either.
- **Insignia SS-ABD:** the US page prints "SS ABD" (a typo). AU prints SS-ABD, and that is the code recorded.
- **Insignia stacks:** stack_lb is the US *standard* stack. A heavy stack option is noted in stack_note, and the AU site quotes the heavy stack as "Weight Stack".
- **Signature name clash:** LF uses the name "Signature Series Chest Press/Shoulder Press/Pulldown/Row" for both the FZ single-station machines (seed rows → FZCP/FZSP/FZPD/FZRW) and the Cable Motion machines (CMCP/CMSP/CMPD/CMRW, added as rows suffixed "(Cable Motion)"). The seed rows were assigned the FZ codes because their descriptions (single station, converging press) fit that line. The placard decides.
- **Signature Dual Adjustable Pulley** → CMDAP. This is a Cable Motion machine that LF still sells, now titled "Life Fitness Dual Adjustable Pulley". The row stays in the legacy product_line to keep its identity.
- **Signature Pectoral Fly/Rear Deltoid** → FZFRD. A separate FZFLY ("Single Station Fly") also exists, added as its own row. LF does not explain how FZFLY relates to FZPEC and FZFRD.
- **Axiom Smith Rack** (OP-SM) is plate-loaded with a 45 lb starting bar, but the seed loading_type says `selectorized`. It is left unchanged and flagged here.
- **New `Cable Machines` product_line** row: LCM-CC Adjustable Cable Crossover, the current LF model. Drop it if out of scope.
- **Not added:** Axiom Flexibility Trainer OP-FS (stretching frame, no stack); the "Signature Series Dual Adjustable Pulley w Console" (DAPCONSOLE, a console accessory variant); Signature Plate Loaded (SPL\* codes in LF tech support, a plate-loaded line that could be enumerated later); older LF lines (Optima, Pro2, Circuit) that are absent from the current catalog.

## Hammer Strength URLs found (not edited; for the Hammer Strength owner)

LF Australia product JSON on https://www.lifefitness.com.au/commercial/strength/selectorised (each item has a "Product Code" and "Weight Stack"):

- Hammer Strength Select Abdominal Crunch (HS-ABC) — stack 200 lbs (95 kg) — https://www.lifefitness.com.au/commercial/abdominal-crunch-hs-abc
- Hammer Strength MTS Abdominal Crunch (MTSAB) — stack 150 lbs (68 kg) — https://www.lifefitness.com.au/commercial/abdominal-crunch-mtab
- Hammer Strength Select Assist Dip Chin (HS-ADC) — stack 175 lbs (82 kg) — https://www.lifefitness.com.au/commercial/assist-dip-chin-hs-adc
- Hammer Strength Select Back Extension (HS-BE) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/back-extension-hs-be
- Hammer Strength Select Bicep Curl (HS-BC) — stack 200 lbs (95 kg) — https://www.lifefitness.com.au/commercial/biceps-curls-hs-bc
- Hammer Strength Select Chest Press (HS-CP) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/chest-press-hs-cp
- Hammer Strength Select Fixed Pulldown (HS-FPD) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/fixed-pulldown-hs-fpd
- Hammer Strength Select Hip Abduction (HS-HAB) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/hip-abduction-hs-hab
- Hammer Strength Select Hip Adduction (HS-HAD) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/hip-adduction-hs-had
- Hammer Strength Select Hip and Glute (HS-HG) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/hip-and-glute-hs-hg
- Hammer Strength Select Horizontal Calf (HS-HC) — stack 370 lbs (185 kg) — https://www.lifefitness.com.au/commercial/horizontal-calf-hs-hc
- Hammer Strength MTS Iso-Lateral Biceps Curl (MTSBC) — stack 2 x 100 lbs (2 x 50 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-bicep-curl-mtbc
- Hammer Strength MTS Iso-Lateral Chest Press (MTSCP) — stack 2 x 150 lb (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-chest-press-mtcp
- Hammer Strength MTS Iso-Lateral Decline Press (MTSDP) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-decline-press-mtdp
- Hammer Strength MTS Iso-Lateral Front Pulldown (MTSFP) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-front-pulldown-mtfp
- Hammer Strength MTS Iso-Lateral High Row (MTSHR) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-high-row-mthr
- Hammer Strength MTS Iso-Lateral Incline Press (MTSIP) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-incline-press-mtip
- Hammer Strength MTS Iso-Lateral Kneeling Leg Curl (MTSKC) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-kneeling-leg-curl-mtskc
- Hammer Strength MTS Iso-Lateral Leg Extension (MTSLE) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-leg-extension-mtle
- Hammer Strength MTS Iso-Lateral Row (MTSRW) — stack 2 x 150 lbs ( 2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-row-mtrw
- Hammer Strength MTS Iso-Lateral Shoulder Press (MTSSP) — stack 2 x 150 lbs (2 x 68 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-shoulder-press-mtsp
- Hammer Strength MTS Iso-Lateral Triceps Extension (MTSTE) — stack 2 x 100 lbs (2 x 50 kg) — https://www.lifefitness.com.au/commercial/iso-lateral-tricep-extension-mtte
- Hammer Strength Select Lat Pulldown (HS-PD) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/lat-pulldown-hs-lp
- Hammer Strength Select Lateral Raise (HS-LR) — stack 200 lbs (95 kg) — https://www.lifefitness.com.au/commercial/lateral-raise-hs-lr
- Hammer Strength Select Leg Curl (HS-LC) — stack 200 lbs (95 kg) — https://www.lifefitness.com.au/commercial/leg-curl-hs-lc
- Hammer Strength Select Leg Extension (HS-LE) — stack 295 lbs (134 kg) — https://www.lifefitness.com.au/commercial/leg-extension-hs-le
- Hammer Strength Select Pectoral Fly (HS-PEC) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/pectoral-fly-hs-pec
- Hammer Strength Select Pectoral Fly/Rear Deltoid (HS-FLY) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/pectoral-flyrear-deltoid-hs-fly
- Hammer Strength Select Seated Leg Curl (HS-SLC) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/seated-leg-curl-hs-slc
- Hammer Strength Select Seated Leg Press (HS-SLP) — stack 390 lbs (195 kg) — https://www.lifefitness.com.au/commercial/seated-leg-press-hs-slp
- Hammer Strength Select Seated Row (HS-RW) — stack 295 lbs (138 kg) — https://www.lifefitness.com.au/commercial/seated-row-hs-sr
- Hammer Strength Select Shoulder Press (HS-SP) — stack 200 lbs (95 kg) — https://www.lifefitness.com.au/commercial/shoulder-press-hs-sp
- Hammer Strength Select Standing Calf (HS-SC) — stack 390 lbs (195 kg) — https://www.lifefitness.com.au/commercial/standing-calf-hs-sc
- Hammer Strength Select Triceps Extension (HS-TE) — stack 200 lbs (95 kg) — https://www.lifefitness.com.au/commercial/tricep-extension-hs-te

The LF US selectorized pages follow the pattern https://www.lifefitness.com/en-us/catalog/strength-training/selectorized/hammer-strength-select-* and .../hammer-strength-mts-* (e.g. hammer-strength-select-chest-press). They were not fetched individually.

## Sources tried that failed or gave nothing

- https://www.lifefitness.com/en-us/catalog/strength-training/insignia-series → 404.
- US guesses .../selectorized/life-fitness/signature-series-{shoulder-press,lat-pulldown,pulldown,triceps-extension,dual-adjustable-pulley} → 404. The Signature (Cable Motion) pages live under /cable-machines-functional-trainers/ instead.
- .../selectorized/axiom-series-smith-machine → 404 (the right slug is axiom-series-smith-rack).
- lftechsupport search for "fzte", "signature - triceps extension" and "fzdap" → no Signature triceps extension or FZ DAP.
- The LF US listing pages render client-side, so only some product links appear in static HTML. Products were found from the related-product links on product pages.
- WebFetch of one lftechsupport PDF returned HTTP 500 once. A retry with curl worked.
