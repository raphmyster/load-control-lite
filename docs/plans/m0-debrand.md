# M0: De-brand

Goal: the app works as before, but every trace of the original operator is gone (PRD section 3).

The original single file stays outside this repo (`../Load-Control-Lite-Branded.html`) and is never committed.
The list of operator terms also lives outside the repo (`../debrand-terms.txt`), because it names the operator.

## Tasks

1. **Split the single file** into `index.html`, `css/app.css`, `js/config.js` (forms, limits, layout coordinates), `js/brand.js` (operator name and mark), `js/draw.js` (blank forms drawn in SVG) and `js/app.js` (the app logic, otherwise unchanged). Plain ES modules, no build step.
2. **Operator:** "Northbound Air", one config value, a generated north-arrow mark and a neutral slate/teal palette.
3. **Forms:** keep PC-12, 1900D 19-seat, 1900D 12-seat combi and Dash 8-300. Drop the 1900D 15-seat and 17-seat forms. Draw each blank form in SVG on the same coordinate grid as the original paper forms, so the data overlay positions stay valid. Every printed limit is read from the config, so the drawn form and the limit check can't disagree.
4. **Limits:** replace the copied limits with illustrative ones, labelled as illustrative on screen and on the printed form.
5. **Content:** fictional sample flight, registration and stops; "Demo form v1" in place of form versions; "Load Control Lite · Demo, not for operational use" footer and a demo label in the top bar.
6. **Storage keys:** new `lcl.` prefix so flights saved by the original app aren't loaded.

## Verification

- `scripts/check-debrand.sh ../debrand-terms.txt` passes (no operator terms, no large embedded files).
- In the browser: the sample flight loads; each of the four forms renders; auto-place, drag tags, quick entry and the over-limit print block work; print preview shows the drawn form on one sheet.
