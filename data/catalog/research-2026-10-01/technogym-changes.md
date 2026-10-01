# Technogym: changes 2026-10-01

Output: `out/technogym.csv`, with all 62 seed rows (60 kept, 2 `line_only` rows replaced) and 53 new rows, so 113 rows in total.

**How the sources were read.** technogym.com sends HTTP 403 to every fetch (WebFetch and curl), on every locale, its product pages and its marketing-support PDFs. So the Technogym pages were read as Wayback Machine snapshots (`web.archive.org/web/<ts>/<technogym url>`). The snapshot is what the `source` cites. Codes come from each page's JSON-LD `sku`/`mpn` and URL. Names come from H1/JSON-LD, and stacks from the "Standard weight stack" spec. On the 2022 en-IE snapshots, which have no JSON-LD, the code is the one in the canonical product URL, and the name is the H1 on that page. For two Selection 900 rows (Glute Press, Standing Calf), no product page was archived, so the code comes from the image path on Technogym's own CDN (`.../product/MN4P/selection-900-glute-press-MN4-plp.jpg`). That CDN URL is the source, and it returns 200.

`stack_lb` is the **standard** stack in lb as Technogym prints it. Technogym's lb figures are not kg×2.2 (for example "100 kg | 200 lbs"). The optional Plus stack is in `stack_note`. No page gave a starting resistance, so none was filled.

## Counts

| | rows | codeless | inferred | line_only | with starting resistance | with stack_lb | no body_region |
|---|---|---|---|---|---|---|---|
| before | 62 | 51 | 0 | 3 | 0 | 0 | 3 |
| after | 113 | 3 | 0 | 1 | 0 | 61 | 1 |

## Changed and added rows

| kind | product_line | model_code | name | what changed | source |
|---|---|---|---|---|---|
| changed | Selection 900 | MNFP | Selection 900 Chest Press | model_code MNFP, stack_lb 200 | https://web.archive.org/web/20250830080614/https://www.technogym.com/en-US/product/selection-900-chest-press_MNFP.html |
| changed | Selection 900 | MNTP | Selection 900 Pectoral | model_code MNTP, stack_lb 200 | https://web.archive.org/web/20260102134349/https://www.technogym.com/en-INT/product/selection-900-pectoral_MNTP.html |
| changed | Selection 900 | MNEP | Selection 900 Shoulder Press | model_code MNEP | https://web.archive.org/web/20220128172725/https://www.technogym.com/en-IE/product/selection-900-shoulder-press_MNEP.html |
| changed | Selection 900 | MNKP | Selection 900 Delts Machine | stack_lb 200 | https://web.archive.org/web/20260520132614/https://www.technogym.com/en-GB/product/selection-900-delts-machine_MNKP.html |
| changed | Selection 900 | MNXP | Selection 900 Reverse Fly | model_code MNXP | https://web.archive.org/web/20220128030443/https://www.technogym.com/en-IE/product/selection-900-reverse-fly_MNXP.html |
| changed | Selection 900 | MNGP | Selection 900 Vertical Traction | model_code MNGP, stack_lb 200 | https://web.archive.org/web/20250824045559/https://www.technogym.com/en-US/product/selection-900-vertical-traction_MNGP.html |
| changed | Selection 900 | MNHP | Selection 900 Low Row | model_code MNHP, stack_lb 190 | https://web.archive.org/web/20260622221901/https://www.technogym.com/en-GB/product/selection-900-low-row_MNHP.html |
| changed | Selection 900 | MN1P | Selection 900 Upper Back | model_code MN1P, stack_lb 130 | https://web.archive.org/web/20250824090426/https://www.technogym.com/en-US/product/selection-900-upper-back_MN1P.html |
| changed | Selection 900 | MNRP | Selection 900 Arm Curl | model_code MNRP | https://web.archive.org/web/20220128031715/https://www.technogym.com/en-IE/product/selection-900-arm-curl_MNRP.html |
| changed | Selection 900 | MNBP | Selection 900 Abdominal Crunch | model_code MNBP, stack_lb 130 | https://web.archive.org/web/20250805234234/https://www.technogym.com/en-US/product/selection-900-abdominal-crunch_MNBP.html |
| changed | Selection 900 | MNZP | Selection 900 Total Abdominal | model_code MNZP, stack_lb 190 | https://web.archive.org/web/20260123202421/https://www.technogym.com/en-GB/product/selection-900-total-abdominal_MNZP.html |
| changed | Selection 900 | MNYP | Selection 900 Rotary Torso | model_code MNYP | https://web.archive.org/web/20220128174256/https://www.technogym.com/en-IE/product/selection-900-rotary-torso_MNYP.html |
| changed | Selection 900 | MNCP | Selection 900 Lower Back | model_code MNCP, stack_lb 130 | https://web.archive.org/web/20260521234830/https://www.technogym.com/en-GB/product/selection-900-lower-back_MNCP.html |
| changed | Selection 900 | MNAP | Selection 900 Leg Press | model_code MNAP | https://web.archive.org/web/20220128021659/https://www.technogym.com/en-IE/product/selection-900-leg-press_MNAP.html |
| changed | Selection 900 | MNJP | Selection 900 Leg Extension | model_code MNJP, stack_lb 190 | https://web.archive.org/web/20251226140129/https://www.technogym.com/en-US/product/selection-900-leg-extension_MNJP.html |
| changed | Selection 900 | MNIP | Selection 900 Leg Curl | model_code MNIP, stack_lb 190 | https://web.archive.org/web/20250824025445/https://www.technogym.com/en-US/product/selection-900-leg-curl_MNIP.html |
| changed | Selection 900 | MNUP | Selection 900 Prone Leg Curl | model_code MNUP | https://web.archive.org/web/20220128165456/https://www.technogym.com/en-IE/product/selection-900-prone-leg-curl_MNUP.html |
| changed | Selection 900 | MNPP | Selection 900 Abductor | model_code MNPP, stack_lb 140 | https://web.archive.org/web/20250805234355/https://www.technogym.com/en-US/product/selection-900-abductor_MNPP.html |
| changed | Selection 900 | MNQP | Selection 900 Adductor | stack_lb 140 | https://web.archive.org/web/20250805234441/https://www.technogym.com/en-TH/product/selection-900-adductor_MNQP.html |
| changed | Selection 900 | MN4P | Selection 900 Glute Press | model_code MN4P from Technogym CDN image path | https://webapi-prod.technogym.com/dw/image/v2/BFLQ_PRD/on/demandware.static/-/Sites-tg-catalog-master/default/dw40bf8b55/product/MN4P/selection-900-glute-press-MN4-plp.jpg |
| changed | Selection 900 | MN5P | Selection 900 Standing Calf | model_code MN5P from Technogym CDN image path | https://webapi-prod.technogym.com/dw/image/v2/BFLQ_PRD/on/demandware.static/-/Sites-tg-catalog-master/default/dw8ba75ae4/product/MN5P/selection-900-standing-calf-MN5-plp.jpg |
| changed | Selection 700 (compact) | MNFC | Selection 700 Chest Press | model_code MNFC | https://web.archive.org/web/20220128040841/https://www.technogym.com/en-IE/product/selection-700-chest-press_MNFC.html |
| changed | Selection 700 (compact) | MNNC | Selection 700 Dual Pectoral / Reverse Fly | model_code MNNC | https://web.archive.org/web/20220128034520/https://www.technogym.com/en-IE/product/selection-700-dual-pectoral-reverse-fly_MNNC.html |
| changed | Selection 700 (compact) | MNEC | Selection 700 Shoulder Press | model_code MNEC | https://web.archive.org/web/20220128153855/https://www.technogym.com/en-IE/product/selection-700-shoulder-press_MNEC.html |
| changed | Selection 700 (compact) | MNKC | Selection 700 Delts Machine | model_code MNKC | https://web.archive.org/web/20220128025558/https://www.technogym.com/en-IE/product/selection-700-delts-machine_MNKC.html |
| changed | Selection 700 (compact) | MNLC | Selection 700 Lat Machine | model_code MNLC, stack_lb 198 | https://web.archive.org/web/20250815194942/https://www.technogym.com/en-CA/product/selection-700-lat-machine_MNLC.html |
| changed | Selection 700 (compact) | MNGC | Selection 700 Vertical Traction | model_code MNGC | https://web.archive.org/web/20220128031120/https://www.technogym.com/en-IE/product/selection-700-vertical-traction_MNGC.html |
| changed | Selection 700 (compact) | MNHC | Selection 700 Low Row | model_code MNHC | https://web.archive.org/web/20230407230819/https://www.technogym.com/en-US/product/selection-700-low-row_MNHC.html |
| changed | Selection 700 (compact) | MNMC | Selection 700 Dual Leg Curl / Extension | model_code MNMC, stack_lb 130 | https://web.archive.org/web/20250817124406/https://www.technogym.com/en-INT/product/selection-700-dual-leg-curl-extension_MNMC.html |
| changed | Selection 700 (compact) | MNJC | Selection 700 Leg Extension | model_code MNJC | https://web.archive.org/web/20220128022745/https://www.technogym.com/en-IE/product/selection-700-leg-extension_MNJC.html |
| changed | Selection 700 (compact) | MNIC | Selection 700 Leg Curl | model_code MNIC, stack_lb 176 | https://web.archive.org/web/20241115211325/https://www.technogym.com/en-AU/product/selection-700-leg-curl_MNIC.html |
| changed | Selection 700 (compact) | MNAC | Selection 700 Leg Press | model_code MNAC, stack_lb 418 | https://web.archive.org/web/20250605210331/https://www.technogym.com/en-US/product/selection-700-leg-press_MNAC.html |
| changed | Selection 700 (compact) | MNOC | Selection 700 Dual Abductor / Adductor | model_code MNOC, stack_lb 110 | https://web.archive.org/web/20250816093948/https://www.technogym.com/en-US/product/selection-700-dual-abductor-adductor_MNOC.html |
| changed | Selection 700 (compact) | MNDC | Selection 700 Multi Hip | model_code MNDC | https://web.archive.org/web/20220128035325/https://www.technogym.com/en-IE/product/selection-700-multi-hip_MNDC.html |
| changed | Selection 700 (compact) | MNBC | Selection 700 Abdominal Crunch | model_code MNBC, stack_lb 132 | https://web.archive.org/web/20250805234202/https://www.technogym.com/en-US/product/selection-700-abdominal-crunch_MNBC.html |
| changed | Selection 700 (compact) | MNCC | Selection 700 Lower Back | model_code MNCC, stack_lb 130 | https://web.archive.org/web/20250825063547/https://www.technogym.com/en-US/product/selection-700-lower-back_MNCC.html |
| changed | Pure Strength (plate loaded) | MG3000 | Pure Strength Row | model_code MG3000 | https://web.archive.org/web/20250805233618/https://www.technogym.com/en-US/product/pure-row_MG3000-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG2500 | Pure Strength Low Row | model_code MG2500 | https://web.archive.org/web/20250805233806/https://www.technogym.com/en-US/product/pure-low-row_MG2500-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG2000 | Pure Strength Pulldown | model_code MG2000 | https://web.archive.org/web/20250805234159/https://www.technogym.com/en-US/product/pure-pulldown_MG2000-NBGJV0.html |
| changed | Pure Strength (plate loaded) | PG12 | Pure Strength T-Bar Row | model_code PG12 | https://web.archive.org/web/20251220201643/https://www.technogym.com/en-US/product/t-bar-row-pure-strength_PG12.html |
| changed | Pure Strength (plate loaded) | MG6000 | Pure Strength Biceps | model_code MG6000 | https://web.archive.org/web/20250805233847/https://www.technogym.com/en-US/product/pure-biceps_MG6000-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG5500 | Pure Strength Seated Dip | model_code MG5500 | https://web.archive.org/web/20260521234003/https://www.technogym.com/en-GB/product/pure-strength-seated-dip_MG5500-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG7500 | Pure Strength Linear Leg Press | model_code MG7500 | https://web.archive.org/web/20250805233658/https://www.technogym.com/en-US/product/pure-linear-leg-press_MG7500-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG86 | Pure Strength Belt Squat | model_code MG86 | https://web.archive.org/web/20250805234410/https://www.technogym.com/en-US/product/pure-belt-squat_MG86.html |
| changed | Pure Strength (plate loaded) | MG87 | Pure Strength Deadlift | model_code MG87 | https://web.archive.org/web/20250805234327/https://www.technogym.com/en-US/product/pure-deadlift_MG87.html |
| changed | Pure Strength (plate loaded) | MG8000 | Pure Strength Hip Thrust | model_code MG8000 | https://web.archive.org/web/20250805234100/https://www.technogym.com/en-US/product/pure-hip-thrust_MG8000-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG9500 | Pure Strength Standing Abductor | model_code MG9500 | https://web.archive.org/web/20250805234216/https://www.technogym.com/en-US/product/pure-standing-abductor_MG9500-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG7000 | Pure Strength Standing Leg Curl | model_code MG7000 | https://web.archive.org/web/20250805233455/https://www.technogym.com/en-US/product/pure-standing-leg-curl_MG7000-NBGJV0.html |
| changed | Pure Strength (plate loaded) | MG4500 | Pure Strength Calf | model_code MG4500 | https://web.archive.org/web/20250805233732/https://www.technogym.com/en-US/product/pure-calf_MG4500-NBGJV0.html |
| replaced | Other lines |  | Artis Strength (premium selectorized, Unity console) | line_only row replaced by 19 Artis model rows | https://usedtechnogym.com/strength |
| added | Artis | MK18EH | Artis Abductor | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114123631/https://www.technogym.com/en-TH/product/artis-abductor_MK18EH.html |
| added | Artis | MK17EH | Artis Adductor | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114130455/https://www.technogym.com/en-VN/product/artis-adductor_MK17EH.html |
| added | Artis | MK92EH | Artis Arm Curl | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114124520/https://www.technogym.com/en-US/product/artis-arm-curl_MK92EH.html |
| added | Artis | MK45EH | Artis Arm Extension | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114130655/https://www.technogym.com/en-ZA/product/artis-arm-extension_MK45EH.html |
| added | Artis | MK70EH | Artis Chest Press | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114124731/https://www.technogym.com/en-US/product/artis-chest-press_MK70EH.html |
| added | Artis | MK12EH | Artis Lat Machine | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114125509/https://www.technogym.com/en-US/product/artis-lat-machine_MK12EH.html |
| added | Artis | MK90EH | Artis Leg Curl | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114123821/https://www.technogym.com/en-US/product/artis-leg-curl_MK90EH.html |
| added | Artis | MK91EH | Artis Leg Extension | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114123441/https://www.technogym.com/en-US/product/artis-leg-extension_MK91EH.html |
| added | Artis | MK80EH | Artis Low Row | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114125130/https://www.technogym.com/en-VN/product/artis-low-row_MK80EH.html |
| added | Artis | MK58EH | Artis Lower Back | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114130245/https://www.technogym.com/en-ZA/product/artis-lower-back_MK58EH.html |
| added | Artis | MK67EH | Artis Multi Hip | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114130057/https://www.technogym.com/en-ZA/product/artis-multi-hip_MK67EH.html |
| added | Artis | MK13EH | Artis Pectoral | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114124029/https://www.technogym.com/en-US/product/artis-pectoral_MK13EH.html |
| added | Artis | MK46EH | Artis Rear Delt Row | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114125715/https://www.technogym.com/en-VN/product/artis-rear-delt-row_MK46EH.html |
| added | Artis | MK50EH | Artis Rotary Torso | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114124210/https://www.technogym.com/en-TH/product/artis-rotary-torso_MK50EH.html |
| added | Artis | MK69EH | Artis Shoulder Press | Artis model enumerated from Technogym page | https://web.archive.org/web/20251219022321/https://www.technogym.com/en-ZA/product/artis-shoulder-press_MK69EH.html |
| added | Artis | MK16EH | Artis Squat | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114124338/https://www.technogym.com/en-ZA/product/artis-squat_MK16EH.html |
| added | Artis | MK83EH | Artis Total Abdominal | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114125905/https://www.technogym.com/en-VN/product/artis-total-abdominal_MK83EH.html |
| added | Artis | MK71EH | Artis Vertical Traction | Artis model enumerated from Technogym page | https://web.archive.org/web/20260114125324/https://www.technogym.com/en-ZA/product/artis-vertical-traction_MK71EH.html |
| added | Artis |  | Artis Leg Press | Artis model enumerated from Technogym page (code left empty) | https://web.archive.org/web/20250805233510/https://www.technogym.com/en-TH/product/artis-leg-press_MK51EH.html |
| replaced | Other lines |  | Element+ (entry commercial selectorized) | line_only row replaced by 22 Element+ model rows | https://usedtechnogym.com/strength |
| added | Element+ | MB65 | Element+ Abdominal Crunch | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034236/http://www.technogym.com/int/abdominal-crunch-element.html |
| added | Element+ | MB10 | Element+ Abductor | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034242/http://www.technogym.com/int/abductor-element.html |
| added | Element+ | MB05 | Element+ Adductor | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160430041758/http://www.technogym.com/int/adductor-element.html |
| added | Element+ | MB55 | Element+ Arm Curl | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034246/http://www.technogym.com/int/arm-curl-element.html |
| added | Element+ | MB60 | Element+ Arm Extension | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034251/http://www.technogym.com/int/arm-extension-element.html |
| added | Element+ | MB20 | Element+ Chest Press | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034256/http://www.technogym.com/int/chest-press-element.html |
| added | Element+ | MB75 | Element+ Glute | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160430040752/http://www.technogym.com/int/glute-element.html |
| added | Element+ | MB40 | Element+ Lat Machine | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160513142427/http://www.technogym.com/int/lat-machine-element-19.html |
| added | Element+ | MB35 | Element+ Leg Curl | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034348/http://www.technogym.com/int/leg-curl-element.html |
| added | Element+ | MB30 | Element+ Leg Extension | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034354/http://www.technogym.com/int/leg-extension-element.html |
| added | Element+ | MB50 | Element+ Leg Press | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034359/http://www.technogym.com/int/leg-press-element.html |
| added | Element+ | MB45 | Element+ Lower Back | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034414/http://www.technogym.com/int/lower-back-element.html |
| added | Element+ | MB95 | Element+ Low Row | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034405/http://www.technogym.com/int/low-row-element.html |
| added | Element+ | MB70 | Element+ Pectoral | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160430041830/http://www.technogym.com/int/pectoral-machine-element.html |
| added | Element+ | MB15 | Element+ Shoulder Press | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034518/http://www.technogym.com/int/shoulder-press-element.html |
| added | Element+ | MB25 | Element+ Vertical Traction | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160212034521/http://www.technogym.com/int/vertical-traction-element.html |
| added | Element+ | CB20 | Element+ Chest Press Inclusive | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160628055829/http://www.technogym.com/int/chest-press-element-inclusive.html |
| added | Element+ | CB35 | Element+ Leg Curl Inclusive | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160817151151/http://www.technogym.com/int/leg-curl-element-inclusive.html |
| added | Element+ | CB30 | Element+ Leg Extension Inclusive | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160628053319/http://www.technogym.com/int/leg-extension-element-inclusive.html |
| added | Element+ | CB50 | Element+ Leg Press Inclusive | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20170611081038/http://www.technogym.com/int/leg-press-element-inclusive.html |
| added | Element+ | CB95 | Element+ Low Row Inclusive | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160628053328/http://www.technogym.com/int/low-row-element-inclusive.html |
| added | Element+ | CB15 | Element+ Shoulder Press Inclusive | Element+ model enumerated from 2016 Technogym page | https://web.archive.org/web/20160628052301/http://www.technogym.com/int/shoulder-press-element-inclusive.html |
| added | Selection 900 | MNDP | Selection 900 Multi Hip | model on Technogym site, missing from seed | https://web.archive.org/web/20220128162019/https://www.technogym.com/en-IE/product/selection-900-multi-hip_MNDP.html |
| added | Selection 900 | MNVP | Selection 900 Pulldown | model on Technogym site, missing from seed | https://web.archive.org/web/20220128035357/https://www.technogym.com/en-IE/product/selection-900-pulldown_MNVP.html |
| added | Pure Strength (plate loaded) | MG1000 | Pure Strength Wide Chest Press | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233142/https://www.technogym.com/en-US/product/pure-wide-chest-press_MG1000-NBGJV0.html |
| added | Pure Strength (plate loaded) | MG1500 | Pure Strength Incline Chest Press | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233100/https://www.technogym.com/en-US/product/pure-incline-chest-press_MG1500-NBGJV0.html |
| added | Pure Strength (plate loaded) | MG3500 | Pure Strength Shoulder Press | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233218/https://www.technogym.com/en-US/product/pure-shoulder-press_MG3500-NBGJV0.html |
| added | Pure Strength (plate loaded) | MG6500 | Pure Strength Leg Extension | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233414/https://www.technogym.com/en-US/product/pure-leg-extension_MG6500-NBGJV0.html |
| added | Pure Strength (plate loaded) | MG8500 | Pure Strength Hack Squat | model on Technogym site, missing from seed | https://web.archive.org/web/20251209014213/https://www.technogym.com/en-US/product/pure-strength-hack-squat_MG8500-NBGJV0.html |
| added | Cable stations | MB43 | Dual Adjustable Pulley Performance | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233831/https://www.technogym.com/en-INT/product/dual-adjustable-pulley-performance_MB43.html |
| added | Cable stations | MB44 | Dual Adjustable Pulley Fitness | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233110/https://www.technogym.com/en-GB/product/dual-adjustable-pulley-fitness_MB44.html |
| added | Element+ | MB91 | Kneeling Easy Chin Dip | model on Technogym site, missing from seed | https://web.archive.org/web/20250805234141/https://www.technogym.com/en-US/product/kneeling-easy-chin-dip_MB91.html |
| added | Kinesis | MD05 | Kinesis Personal | model on Technogym site, missing from seed | https://web.archive.org/web/20250722204853/https://www.technogym.com/en-GB/product/kinesis-personal_MD05.html |
| added | Kinesis | M5800 | Kinesis One | model on Technogym site, missing from seed | https://web.archive.org/web/20250805233014/https://www.technogym.com/en-US/product/kinesis-one_M5800.html |

## For the merger to decide

- **Artis code mapping conflict.** Technogym's own Artis product pages carry two different code-to-name mappings. The snapshots from 2023 to Aug 2025 show, for example, `artis-pectoral_MK70EH`, `artis-leg-extension_MK50EH` and `artis-low-row_MK58EH`. The snapshots from Dec 2025 to Jan 2026, which also carry stack specs, show `artis-chest-press_MK70EH`, `artis-rotary-torso_MK50EH` and `artis-lower-back_MK58EH`. I used the **newer** mapping because it is self-consistent (no code used twice) and agrees with independent evidence: renewfit.com refurbished listings name "Chest press MK70 Unity Mini" and "Rotary torso MK50", and the Biostrength pages (Artis-derived) use MM70 Chest Press, MM58 Lower Back and MM83 Total Abdominal. If a placard ever shows the old pairing, the merger should revisit this.
- **Artis code format.** The page SKU is `MK70EH` and renewfit writes `MK70`. I recorded the page SKU. The `EH` may be a configuration suffix, so the base is in the notes.
- **Element+ code format.** The 2016 pages carry full SKUs such as `MB200N0-ANV0GGGP`. The same pages' image filenames, and the current Technogym SKUs for sibling products (`MB43`, `MB44`, `MB91`), use the 4-character base. I recorded the base (`MB20`). The full SKU is in the notes. Element+ (and the Inclusive CB versions) are from 2016 pages, so the line may be discontinued, although the machines are still in gyms.
- **Pure Strength code format.** Pages show `MG3000-NBGJV0`. I recorded `MG3000`, following the seed's existing `MG0500`. Belt Squat and Deadlift are `MG86`/`MG87` (2 digits), and T-Bar Row is `PG12` (the bench family prefix). The seed note "codes are MG.. (4-digit)" is therefore not universal.
- **New product lines added:** `Artis`, `Element+`, `Cable stations` (Dual Adjustable Pulley MB43/MB44), `Kinesis` (Kinesis Personal MD05, Kinesis One M5800, `cable_stack`). Kneeling Easy Chin Dip MB91 is an assisted chin/dip machine with a counterweight stack. Drop any of these if they fall outside scope.
- **Laterality** of the new Selection, Artis, Element+ rows and of Pure Leg Extension and Hack Squat is not stated on the pages. I used `bilateral`, the seed's convention, and said so in the notes. The Pure Wide Chest, Incline Chest and Shoulder Press pages state "independent movement arms".
- Seed rows that already had codes (MN3P, MNLP, MNSP, MNWP, MG0500, MG9000, MG5000, MG4000, MG4600) were confirmed by the fetched pages or CDN paths. They were left unchanged unless a stack was added (MNKP, MNQP).

## Could not resolve

- **Selection 900 Hip Thrust**: code left empty. Search engines index `technogym.com/en-US/product/selection-900-hip-thrust_MN2P.html`, but it returns 403 and has no Wayback copy. Technogym's CDN image is at `.../product/MNP2/selection-900-hip-thrust-MN2-plp.jpg`, a directory `MNP2` that disagrees with `MN2P`. The candidates are MN2P (more likely, fits the MN?P pattern) and MNP2. The placard decides.
- **Artis Leg Press**: code left empty. Only an Aug-2025 page (`artis-leg-press_MK51EH`) was found, and that period's Artis mapping is unreliable (see above). MK51EH is a candidate.
- **Biostrength**: left `line_only`, as the README asks (motorized). The pages seen were MM70 Chest Press, MM58 Lower Back and MM83 Total Abdominal, for when a loading_type exists.
- No starting resistance found: Technogym pages state stack sizes only.
- Stack sizes are missing for rows whose only page was a 2022 en-IE snapshot (no spec table), for Element+ Leg Press and Vertical Traction, and for all Pure Strength rows (plate-loaded; the pages give "maximum load useable" only).

## Sources tried that failed

- `https://www.technogym.com/en-US/category/selection-900/`, the `/en-US/product/...` pages, and the en-IN, en-MY and en-INT locales all returned 403. The same was true of the marketing-support `DirectFileDownload.php` PDFs.
- `webapi-prod.technogym.com` serves CDN images, but not product pages (404).
- `innovativefit.com/pdfs/900/Brochure - Technogym Selection.pdf` is a 2008 brochure with no article codes.
- No Wayback snapshot exists of the product pages for S900 Hip Thrust, Glute Press, Standing Calf or Multi Flight. The CDN images were archived.
