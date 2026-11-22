# North Bay Sewer Mapper

A single-page web app that infers a draft **storm and sanitary sewer model for North Bay, Ontario** from public data and exports it to **EPA SWMM** (.inp), with a probability attached to every inferred pipe.

**Open it:** the GitHub Pages site for this repo, or download `index.html` and open it in Chrome, Edge, Firefox or Safari. It needs an internet connection. In-app previews (for example inside the Claude app) block outside map tiles and data, so it won't work there.

## What it does

- **Auto tab:** pulls OpenStreetMap streets, buildings, water and sewage facilities, plus bare-earth elevation for the view. Sources are tried in order: Ontario lidar DTM, then NRCan HRDEM, then coarse terrain tiles. From these it:
  - places manholes at intersections and bends, and at least every 110 m;
  - finds roadside ditches from lidar cross-sections and models those streets as open channels;
  - routes gravity flow to creek and lake outfalls, the treatment plant, pumping stations or the edge of the study area;
  - sizes pipes with City of North Bay design criteria: rational method with the City's IDF curves for storm, and 450 L/cap/d with Harmon peaking and I/I allowances for sanitary;
  - sets inverts and draws subcatchments (lidar surface drainage to the streets, with imperviousness from building footprints).
- **Exposed-street mosaic:** scans Esri Wayback imagery versions for road surfaces dug up during construction. It stitches the most-exposed date for each tile into one map and lists the streets it found.
- **Review queue and calibration:** pipes come up most-uncertain and most-important first (keys Y / F / N). Pipes you check feed a *measured* accuracy table. Calibration applies the measured depth and size bias, then re-infers, keeping checked pipes and routing around rejected streets.
- **Exports:** storm and sanitary .inp files (NAD83 / UTM 17N, L/s), ensemble zips that sample the uncertainty, a per-pipe uncertainty CSV, and the project as GeoJSON.
- **Manual tools:** drawing overlay with 3-point matching for City plan & profile PDFs, imagery date comparison, lidar analysis (flow paths, low spots, catchments), street-level links, and editing.

Accuracy depends on the attribute. Pipe existence and flow direction on graded streets are usually well determined. Pipe sizes and invert depths are priors until they are checked against City drawings. This is a planning aid, not a substitute for locates (Ontario One Call).

## Development

Source is in `src/`: `head.html` (markup and CSS), `core.js` (geodesy, checks, SWMM writer, DEM analysis), `infer.js` (inference engine), and `app1.js`, `app2.js` and `auto.js` (UI). `./build.sh` concatenates them into `index.html`.

Tests:

```sh
node test/core.test.js                      # geodesy, design storm, checks, .inp
node test/gen_osm.js > test/osm.json        # synthetic town
node test/infer.test.js                     # inference on the synthetic town
python3 test/e2e.py                         # headless Chrome, mocked services (needs playwright + Pillow)
```
