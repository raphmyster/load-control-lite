/* =====================================================================
   OPERATOR AND FORMS
   Everything specific to an operator lives here. The operator is fictional
   and every limit is illustrative: none comes from a real aircraft or
   a real airline's paperwork.
   ===================================================================== */
export const OPERATOR = { name: 'Northbound Air', app: 'Load Control Lite' };
export const FORM_VERSION = 'Demo form v1';
export const DEMO_LABEL = 'Demo, not for operational use';
export const LIMITS_NOTE = 'Illustrative limits, not from any real aircraft';

/* Zones run left to right as drawn on the form. `w` is the column's relative
   width on the printed strip. Limits in lb. `loadOrder` lists placeable zones
   from deepest (filled first, with the last stop's freight) to nearest the door.
   Adding a type is a new entry here plus its drawing coordinates in FORM_POS. */
export const FORMS = {
  PC12: {
    type: 'PC-12', name: 'PC-12 · any configuration', banner: 'ANY CONFIGURATION',
    layout: 'strip', orientation: 'landscape',
    zones: [
      { id: 'DOOR', label: 'DOOR', na: true, boxed: true, w: 1.05 },
      { id: 'B', label: 'B', w: 0.7 },
      { id: 'D', label: 'D', w: 1.15 },
      { id: 'G', label: 'G', w: 1.3 },
      { id: 'H', label: 'H', w: 1.3 },
      { id: 'J', label: 'J', door: true, w: 1.4 },
      { id: 'STD', label: 'STD CARGO', max: 350, tail: true, w: 2.65 },
    ],
    groups: [{ id: 'cabin', label: 'CABIN AREA (B–J)', short: 'Cabin area (B–J)', zones: ['B', 'D', 'G', 'H', 'J'], max: 3200, span: true }],
    loadOrder: ['J', 'STD', 'H', 'G', 'D', 'B'], shared: true,
  },
  B1900D19: {
    type: '1900D', name: '1900D · 19 seat', banner: '19-SEAT CONFIGURATION ONLY',
    layout: 'strip', orientation: 'landscape',
    zones: [
      { id: 'CLOSET', label: 'CLOSET', na: true, boxed: true, w: 1.1 },
      { id: 'CABIN', unavailable: 'CABIN NOT AVAILABLE FOR CARGO (19 SEATS)', w: 3.25 },
      { id: 'FWD', label: 'FWD', max: 950, door: true, w: 2.8 },
      { id: 'AFT', label: 'AFT', max: 550, tail: true, w: 2.75 },
    ],
    groups: [],
    loadOrder: ['AFT', 'FWD'],
  },
  // Rows 1-6 are seats that take cargo. Auto-place leaves them alone.
  B1900D12: {
    type: '1900D', name: '1900D · 12 seat combi', banner: '12-SEAT COMBI ONLY',
    layout: 'strip', orientation: 'landscape',
    zones: [
      { id: 'CLOSET', label: 'CLOSET', na: true, boxed: true, w: 1.1 },
      ...[1, 2, 3, 4, 5, 6].map(r => ({ id: 'R' + r, label: 'ROW ' + r, max: 250, seat: true, w: 0.3 })),
      { id: 'C', label: 'C', max: 1700, w: 3.4 },
      { id: 'FWD', label: 'FWD', max: 650, door: true, w: 2.05 },
      { id: 'AFT', label: 'AFT', max: 550, tail: true, w: 1.45 },
    ],
    groups: [],
    loadOrder: ['AFT', 'C', 'FWD'],
  },
  DH8300: {
    type: 'Dash 8-300', name: 'Dash 8-300',
    layout: 'dh8', orientation: 'portrait', split: true,
    zones: [
      { id: 'Z3', label: 'ZONE 3', max: 320 },
      { id: 'Z1A', label: 'ZONE 1A', max: 800 },
      { id: 'Z1B', label: 'ZONE 1B', max: 950, door: true },
      { id: 'Z2A', label: 'ZONE 2A', max: 450 },
      { id: 'Z2B', label: 'ZONE 2B', max: 520 },
      { id: 'BINF', label: 'FWD STOWAGE BIN', max: 1000 },
      { id: 'BINA', label: 'AFT STOWAGE BIN', max: 1000 },
    ],
    groups: [
      { id: 'z1', label: 'TOTAL COMBINED IN ZONE 1A AND 1B', short: 'Zone 1 (1A+1B)', zones: ['Z1A', 'Z1B'], max: 1700 },
      { id: 'z2', label: 'TOTAL COMBINED IN ZONE 2A AND 2B', short: 'Zone 2 (2A+2B)', zones: ['Z2A', 'Z2B'], max: 900 },
      { id: 'all', label: 'TOTAL COMBINED IN ZONES 1, 2 AND 3', short: 'Zones 1+2+3', zones: ['Z3', 'Z1A', 'Z1B', 'Z2A', 'Z2B'], max: 2400 },
    ],
    loadOrder: ['Z2A', 'Z2B', 'Z1A', 'Z3', 'Z1B', 'BINA', 'BINF'],
  },
};

/* Forms with split: true record Bags and Cargo separately in each zone.
   Change these two lists if the manifest columns should map differently. */
export const SPLIT_KINDS = [
  { id: 'bag', label: 'Bags', from: ['bag'] },
  { id: 'cargo', label: 'Cargo', from: ['cargo', 'post', 'fast'] },
];
export const WHOLE_KIND = [{ id: 'all', label: '', from: ['cargo', 'post', 'fast', 'bag'] }];
export const FREIGHT_KEYS = [['cargo', 'Cargo'], ['post', 'Post'], ['fast', 'Fast-Tracks'], ['bag', 'Baggage']];

/* Airports offered in the manifest's destination pick list (real, public IATA codes).
   A code that isn't here can still be typed; the load check flags it. */
export const AIRPORTS = [
  // Canada
  ['YYZ', 'Toronto Pearson'], ['YTZ', 'Toronto City'], ['YOW', 'Ottawa'], ['YHM', 'Hamilton'], ['YXU', 'London ON'],
  ['YQG', 'Windsor'], ['YSB', 'Sudbury'], ['YAM', 'Sault Ste. Marie'], ['YTS', 'Timmins'], ['YQT', 'Thunder Bay'],
  ['YUL', 'Montréal Trudeau'], ['YHU', 'Montréal Metropolitan'], ['YQB', 'Québec City'],
  ['YHZ', 'Halifax'], ['YQM', 'Moncton'], ['YFC', 'Fredericton'], ['YYG', 'Charlottetown'], ['YYT', "St. John's"], ['YDF', 'Deer Lake'],
  ['YWG', 'Winnipeg'], ['YXE', 'Saskatoon'], ['YYC', 'Calgary'], ['YEG', 'Edmonton'], ['YVR', 'Vancouver'], ['YYJ', 'Victoria'], ['YLW', 'Kelowna'],
  // United States
  ['BOS', 'Boston'], ['LGA', 'New York LaGuardia'], ['EWR', 'Newark'], ['IAD', 'Washington Dulles'], ['ORD', "Chicago O'Hare"],
  ['MCO', 'Orlando'], ['TPA', 'Tampa'], ['FLL', 'Fort Lauderdale'], ['MIA', 'Miami'], ['PBI', 'West Palm Beach'], ['RSW', 'Fort Myers'],
  ['AUS', 'Austin'], ['PHX', 'Phoenix'], ['LAS', 'Las Vegas'], ['LAX', 'Los Angeles'], ['SFO', 'San Francisco'], ['PSP', 'Palm Springs'],
  // Mexico and the Caribbean
  ['CUN', 'Cancún'], ['PVR', 'Puerto Vallarta'], ['SJD', 'Los Cabos'], ['NAS', 'Nassau'], ['GCM', 'Grand Cayman'], ['PLS', 'Providenciales'],
  ['MBJ', 'Montego Bay'], ['AUA', 'Aruba'], ['LIR', 'Liberia CR'], ['SJO', 'San José CR'],
].map(([code, city]) => ({ code, city }));

/* ------------------------------ form geometry ------------------------------
   Coordinates for drawing each blank form (draw.js) and placing the flight's data
   on it (app.js), in the form's own units. `box` is the part shown (x, y, width, height).
   Strip forms: `head` holds the header row's y lines and cell x ranges, `steps` the
   y lines of the plan/adjust/confirm rows, `cols` and `spans` each zone's x range,
   `lmBox` the loadmaster sign-off box. */
export const FORM_POS = {
  PC12: {
    w: 1280, h: 971, box: [0, 0, 1200, 900],
    frame: [8, 8, 1195, 775],
    head: { y: [8, 56, 100], logo: [8, 198], title: [198, 355], date: [355, 512], reg: [512, 653], special: [653, 1195] },
    banner: [100, 145], labelCol: 145, sumCol: [1104, 1195], steps: [145, 380, 552, 775],
    date: [433, 42], reg: [583, 42], flight: [583, 90],
    dots: { hr: [1062, 31], aog: [1171, 31], crew: [1062, 77], na: [1171, 77] },
    cols: { B: [253, 324], D: [324, 437], G: [437, 567], H: [567, 696], J: [696, 837], STD: [837, 1104] },
    spans: { DOOR: [145, 253] },
    sect: [152, 184], floor: 262, plan: [279, 350], lim: [355, 380],
    planned: [1149, 332], lm: [468, 834], lmBox: [160, 780, 978, 892], door: [768, 236],
  },
  B1900D19: {
    w: 1280, h: 987, box: [18, 12, 1242, 936],
    frame: [24, 16, 1254, 820],
    head: { y: [16, 67, 118], logo: [24, 222], title: [222, 385], date: [385, 547], reg: [547, 693], special: [693, 1254] },
    banner: [118, 162], labelCol: 166, sumCol: [1160, 1254], steps: [162, 407, 587, 820],
    date: [466, 54], reg: [620, 54], flight: [620, 105],
    dots: { hr: [1117, 43], aog: [1229, 43], crew: [1117, 92], na: [1229, 92] },
    cols: { CLOSET: [166, 279], FWD: [604, 883], AFT: [883, 1160] },
    spans: { CABIN: [279, 604] },
    sect: [168, 202], floor: 270, plan: [300, 377], lim: [382, 407],
    planned: [1207, 355], lm: [500, 882], lmBox: [182, 823, 1030, 940], door: [740, 258],
  },
  // rows 1-6 are narrow; their tags share the seat section, one slice per row
  B1900D12: {
    w: 1280, h: 977, box: [6, 4, 1256, 944],
    frame: [12, 10, 1258, 822],
    head: { y: [10, 60, 110], logo: [12, 213], title: [213, 377], date: [377, 541], reg: [541, 689], special: [689, 1258] },
    banner: [110, 155], labelCol: 155, sumCol: [1160, 1258], steps: [155, 404, 586, 822],
    date: [459, 46], reg: [615, 46], flight: [615, 94],
    dots: { hr: [1118, 35], aog: [1232, 35], crew: [1118, 84], na: [1233, 84] },
    cols: { CLOSET: [155, 267], R1: [267, 303], R2: [303, 336], R3: [336, 369], R4: [369, 401], R5: [401, 435], R6: [435, 462], C: [462, 807], FWD: [807, 1015], AFT: [1015, 1160] },
    spans: {},
    sect: [165, 200], floor: 268, plan: [306, 376], lim: [379, 404],
    planned: [1207, 345], lm: [493, 873], lmBox: [172, 825, 1031, 944], door: [908, 251],
  },
  DH8300: {
    w: 1013, h: 1280, box: [18, 74, 956, 1130], headSize: 17,
    frame: [24, 82, 966, 1195],
    head: { y: [82, 135, 188], logo: [24, 235], title: [235, 338], date: [338, 443], reg: [443, 548], special: [548, 966] },
    dotLabels: 'right',
    date: [392, 114], reg: [496, 114], flight: [496, 164],
    dots: { hr: [577, 122], aog: [896, 121], na: [762, 166], crew: [838, 166] },
    zones: {
      Z1A: { bag: [325, 356], cargo: [424, 356], total: [509, 356], tags: [216, 222, 250, 120], max: [474, 246, 96, 20], drop: [208, 208, 374, 262] },
      Z1B: { bag: [322, 554], cargo: [421, 554], total: [504, 554], tags: [216, 574, 255, 92], max: [486, 632, 80, 42], drop: [208, 472, 374, 238] },
      Z2A: { bag: [716, 426], cargo: [811, 426], total: [897, 426], tags: [648, 298, 195, 110], max: [848, 324, 96, 20], right: true, drop: [590, 208, 370, 264] },
      Z2B: { bag: [716, 551], cargo: [811, 551], total: [897, 551], tags: [648, 568, 195, 80], max: [848, 611, 96, 20], right: true, drop: [590, 478, 370, 232] },
      Z3: { bag: [136, 632], cargo: [139, 657], total: [137, 682], tags: [40, 528, 155, 84], max: [66, 478, 96, 20], drop: [35, 522, 168, 188] },
      BINF: { bag: [475, 957], cargo: [475, 1007], total: [475, 1057], tags: [240, 925, 140, 135], max: [110, 1099, 300, 18], end: true, drop: [26, 920, 468, 196] },
      BINA: { bag: [945, 957], cargo: [945, 1007], total: [945, 1057], tags: [712, 925, 140, 135], max: [585, 1099, 300, 18], end: true, drop: [498, 920, 468, 196] },
    },
    groups: { z1: [336, 746, 108, 20], z2: [720, 745, 98, 20], all: [60, 274, 108, 20] },
    totals: { z3: [129, 848], z1: [391, 848], z2: [705, 848], all: [887, 848] },
    notes: [34, 1128, 920, 64], door: [240, 652],
  },
};
