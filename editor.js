import React from "https://esm.sh/react@18.2.0";
import { createRoot } from "https://esm.sh/react-dom@18.2.0/client";


const { useState, useRef, useCallback, useEffect, createElement: h } = React;
const initialLocations = [];
const initialConnections = [];

const GRID = 10;
const snap = (v) => Math.round(v / GRID) * GRID;
const MIN_SIZE = GRID * 2; // kleinste breedte/hoogte die een kamer mag krijgen

// Een "circle" kan na het vergroten/verkleinen ook een ovaal zijn, dus hij
// heeft een aparte horizontale en verticale straal. Oudere cirkels met
// alleen `radius` vallen terug op die ene straal.
function radiiOf(loc) {
  return [loc.radiusX ?? loc.radius, loc.radiusY ?? loc.radius];
}

function boundsOf(loc) {
  if (loc.shape === "polygon") {
    // Echte geometrische centroid (zwaartepunt) van de polygon, i.p.v. het
    // midden van de bounding box — bij grillige/concave vormen (zoals een
    // pijl of L-vorm) kan het bounding-box-midden namelijk buiten de vorm
    // zelf vallen. De centroid-formule houdt rekening met de daadwerkelijke
    // oppervlakte en blijft vrijwel altijd binnen de vorm.
    const pts = loc.points;
    let area = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      const cross = x0 * y1 - x1 * y0;
      area += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    area *= 0.5;

    if (Math.abs(area) < 1e-6) {
      // Degeneratie-fallback (bv. alle punten op één lijn): gewoon het
      // gemiddelde van de punten nemen.
      const avgX = pts.reduce((sum, [px]) => sum + px, 0) / pts.length;
      const avgY = pts.reduce((sum, [, py]) => sum + py, 0) / pts.length;
      return { centerX: loc.x + avgX, centerY: loc.y + avgY };
    }

    cx /= 6 * area;
    cy /= 6 * area;
    return { centerX: loc.x + cx, centerY: loc.y + cy };
  }
  if (loc.shape === "circle") {
    return { centerX: loc.x, centerY: loc.y };
  }
  return { centerX: loc.x + loc.width / 2, centerY: loc.y + loc.height / 2 };
}

// --- Kamernamen passend maken ---------------------------------------------
// Het label moet binnen de vorm blijven. Is de naam breder dan de kamer, dan
// gaat hij eerst over meerdere regels (zoveel als er in de hoogte passen),
// en te lange woorden worden afgebroken met een "-". Pas als de kamer vol
// is, wordt de letter kleiner. Past het zelfs op de kleinste grootte niet,
// dan wordt de naam afgekort met "…" (de volledige naam staat dan in de tooltip).
const LABEL_FONT_FAMILY = "sans-serif";
const LABEL_MAX_FONT = 9;
const LABEL_MIN_FONT = 5;
const LABEL_FONT_STEP = 0.5;
const LABEL_LINE_HEIGHT = 1.2; // regelhoogte als factor van de lettergrootte
const LABEL_MAX_LINES = 12; // bovengrens, zodat het zoeken bij enorme kamers snel blijft
const LABEL_PADDING = 3; // minimale ruimte tussen tekst en de rand van de vorm

// Hoogte van de kamer, om te bepalen hoeveel regels er maximaal in passen.
function heightOf(loc) {
  if (loc.shape === "circle") return 2 * radiiOf(loc)[1];
  if (loc.shape === "polygon") {
    const ys = loc.points.map(([, py]) => py);
    return Math.max(...ys) - Math.min(...ys);
  }
  return loc.height;
}

// Tekstbreedte meten via een (onzichtbaar) canvas. Breedte schaalt lineair
// met de lettergrootte, dus we meten elke tekst één keer en rekenen om.
let measureCtx = null;
const textWidthCache = new Map();
function textWidth(text, fontSize) {
  if (!textWidthCache.has(text)) {
    if (textWidthCache.size > 1000) textWidthCache.clear();
    measureCtx ??= document.createElement("canvas").getContext("2d");
    measureCtx.font = `${LABEL_MAX_FONT}px ${LABEL_FONT_FAMILY}`;
    textWidthCache.set(text, measureCtx.measureText(text).width);
  }
  return (textWidthCache.get(text) * fontSize) / LABEL_MAX_FONT;
}

// Hoeveel ruimte er op hoogte y naar links én rechts is vanaf cx, binnen de
// vorm (de kleinste van de twee, want het label staat gecentreerd). 0 als y
// buiten de vorm valt.
function halfWidthAt(loc, cx, y) {
  if (loc.shape === "circle") {
    const [rx, ry] = radiiOf(loc);
    const dy = (y - loc.y) / ry;
    if (Math.abs(dy) >= 1) return 0;
    const half = rx * Math.sqrt(1 - dy * dy);
    return Math.max(0, Math.min(cx - (loc.x - half), loc.x + half - cx));
  }

  const pts = loc.shape === "rect"
    ? [[loc.x, loc.y], [loc.x + loc.width, loc.y], [loc.x + loc.width, loc.y + loc.height], [loc.x, loc.y + loc.height]]
    : loc.points.map(([px, py]) => [loc.x + px, loc.y + py]);

  // Snijpunten van de horizontale lijn op hoogte y met alle randen; tussen
  // elk paar opeenvolgende snijpunten zit je binnen de vorm.
  const xs = [];
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
      xs.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
  }
  xs.sort((a, b) => a - b);
  for (let i = 0; i + 1 < xs.length; i += 2) {
    if (xs[i] <= cx && cx <= xs[i + 1]) {
      return Math.min(cx - xs[i], xs[i + 1] - cx);
    }
  }
  return 0;
}

// Past `text` op een regel met middelpunt (cx, y)? We kijken naar zowel de
// boven- als onderkant van de regel, zodat schuine/ronde randen ook kloppen.
function lineFits(loc, cx, y, fontSize, text) {
  const halfLine = (LABEL_LINE_HEIGHT * fontSize) / 2;
  const half = Math.min(halfWidthAt(loc, cx, y - halfLine), halfWidthAt(loc, cx, y + halfLine));
  return textWidth(text, fontSize) <= 2 * (half - LABEL_PADDING);
}

// Verdeelt de woorden over precies `lineCount` regels (gecentreerd rond cy),
// zoveel mogelijk woorden per regel. Past een woord in z'n eentje niet op de
// regel, dan breken we het af op het langste stuk dat (met "-") wel past en
// gaat de rest naar de volgende regel. Geeft null terug als het niet past.
function wrapIntoLines(loc, cx, cy, fontSize, words, lineCount) {
  const lineHeight = LABEL_LINE_HEIGHT * fontSize;
  const firstY = cy - ((lineCount - 1) * lineHeight) / 2;
  const queue = [...words];
  const lines = [];
  for (let i = 0; i < lineCount && queue.length > 0; i++) {
    const y = firstY + i * lineHeight;
    let text = queue.shift();
    if (!lineFits(loc, cx, y, fontSize, text)) {
      let cut = text.length - 1;
      while (cut > 0 && !lineFits(loc, cx, y, fontSize, `${text.slice(0, cut)}-`)) cut--;
      if (cut === 0) return null; // zelfs één letter past niet op deze regel
      queue.unshift(text.slice(cut));
      text = `${text.slice(0, cut)}-`;
    } else {
      while (queue.length > 0 && lineFits(loc, cx, y, fontSize, `${text} ${queue[0]}`)) {
        text += ` ${queue.shift()}`;
      }
    }
    lines.push({ text, y });
  }
  return queue.length === 0 && lines.length === lineCount ? lines : null;
}

// Bepaalt lettergrootte en regels voor het label van een kamer: zo groot
// mogelijk, met zoveel regels als er in de hoogte van de kamer passen.
function layoutLabel(loc, cx, cy) {
  const name = loc.name.trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { fontSize: LABEL_MAX_FONT, lines: [] };

  const roomHeight = heightOf(loc) - 2 * LABEL_PADDING;
  for (let fontSize = LABEL_MAX_FONT; fontSize >= LABEL_MIN_FONT; fontSize -= LABEL_FONT_STEP) {
    const maxLines = Math.min(LABEL_MAX_LINES, Math.floor(roomHeight / (LABEL_LINE_HEIGHT * fontSize)));
    for (let lineCount = 1; lineCount <= maxLines; lineCount++) {
      const lines = wrapIntoLines(loc, cx, cy, fontSize, words, lineCount);
      if (lines) return { fontSize, lines };
    }
  }

  // Past nergens: op de kleinste grootte afkorten tot het wel past.
  let text = name;
  while (text.length > 0 && !lineFits(loc, cx, cy, LABEL_MIN_FONT, `${text.trimEnd()}…`)) {
    text = text.slice(0, -1);
  }
  return {
    fontSize: LABEL_MIN_FONT,
    lines: text.length > 0 ? [{ text: `${text.trimEnd()}…`, y: cy }] : [],
  };
}

// Geeft de losse rechte randen (wanden) van een kamer terug, elk met het
// midden van die rand — dat is waar het "+"-knopje komt te staan.
// Voor circles bestaan er geen rechte lijnen, dus die krijgen in plaats
// daarvan 4 vaste aansluitpunten op de rand (boven/rechts/onder/links).
function edgesOf(loc) {
  if (loc.shape === "rect") {
    const corners = [
      [loc.x, loc.y],
      [loc.x + loc.width, loc.y],
      [loc.x + loc.width, loc.y + loc.height],
      [loc.x, loc.y + loc.height],
    ];
    return corners.map((p1, i) => {
      const p2 = corners[(i + 1) % corners.length];
      return { mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
    });
  }
  if (loc.shape === "polygon") {
    const abs = loc.points.map(([px, py]) => [loc.x + px, loc.y + py]);
    return abs.map((p1, i) => {
      const p2 = abs[(i + 1) % abs.length];
      return { mid: [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2] };
    });
  }
  if (loc.shape === "circle") {
    const [rx, ry] = radiiOf(loc);
    return [
      { mid: [loc.x, loc.y - ry] },
      { mid: [loc.x + rx, loc.y] },
      { mid: [loc.x, loc.y + ry] },
      { mid: [loc.x - rx, loc.y] },
    ];
  }
  return [];
}

// Geeft de resize-hendels van een kamer terug, elk met een id (welke hendel
// het is) en een absolute positie. Rechthoeken en cirkels krijgen hendels
// op de hoeken (van hun bounding box) — de randmiddens zijn al bezet door de
// "+"-knopjes om kamers te verbinden. Polygons krijgen een hendel op elk
// hoekpunt, zodat je de vorm zelf kunt vervormen.
function resizeHandlesOf(loc) {
  if (loc.shape === "rect") {
    return [
      { id: "nw", pos: [loc.x, loc.y] },
      { id: "ne", pos: [loc.x + loc.width, loc.y] },
      { id: "se", pos: [loc.x + loc.width, loc.y + loc.height] },
      { id: "sw", pos: [loc.x, loc.y + loc.height] },
    ];
  }
  if (loc.shape === "circle") {
    const [rx, ry] = radiiOf(loc);
    return [
      { id: "nw", pos: [loc.x - rx, loc.y - ry] },
      { id: "ne", pos: [loc.x + rx, loc.y - ry] },
      { id: "se", pos: [loc.x + rx, loc.y + ry] },
      { id: "sw", pos: [loc.x - rx, loc.y + ry] },
    ];
  }
  if (loc.shape === "polygon") {
    return loc.points.map(([px, py], i) => ({ id: i, pos: [loc.x + px, loc.y + py] }));
  }
  return [];
}

// Berekent de nieuwe kamer terwijl je een hendel versleept. `start` is de
// kamer zoals hij was bij het begin van het slepen, (x, y) is de huidige
// muispositie in SVG-coördinaten. Met keepRatio (Shift ingedrukt) blijft
// een rechthoek een vierkant en een ovaal een cirkel.
function resizeLocation(start, handle, x, y, keepRatio) {
  if (start.shape === "rect") {
    // De hoek tegenover de hendel blijft op zijn plek staan.
    const right = start.x + start.width;
    const bottom = start.y + start.height;
    const fixedX = handle.includes("w") ? right : start.x;
    const fixedY = handle.includes("n") ? bottom : start.y;
    let width = Math.max(MIN_SIZE, handle.includes("w") ? fixedX - snap(x) : snap(x) - fixedX);
    let height = Math.max(MIN_SIZE, handle.includes("n") ? fixedY - snap(y) : snap(y) - fixedY);
    if (keepRatio) {
      width = height = Math.max(width, height);
    }
    return {
      ...start,
      x: handle.includes("w") ? fixedX - width : fixedX,
      y: handle.includes("n") ? fixedY - height : fixedY,
      width,
      height,
    };
  }
  if (start.shape === "circle") {
    // Het middelpunt blijft staan; de afstand tot de muis bepaalt de stralen.
    let radiusX = Math.max(MIN_SIZE / 2, snap(Math.abs(x - start.x)));
    let radiusY = Math.max(MIN_SIZE / 2, snap(Math.abs(y - start.y)));
    if (keepRatio) {
      radiusX = radiusY = Math.max(radiusX, radiusY);
    }
    const { radius, ...rest } = start;
    return { ...rest, radiusX, radiusY };
  }
  if (start.shape === "polygon") {
    // Eén hoekpunt verplaatsen, en daarna de punten opnieuw relatief maken
    // t.o.v. de linkerbovenhoek van de bounding box (net als finishDrawing).
    const abs = start.points.map(([px, py], i) =>
      i === handle ? [snap(x), snap(y)] : [start.x + px, start.y + py]
    );
    const originX = Math.min(...abs.map((p) => p[0]));
    const originY = Math.min(...abs.map((p) => p[1]));
    return {
      ...start,
      x: originX,
      y: originY,
      points: abs.map(([px, py]) => [px - originX, py - originY]),
    };
  }
  return start;
}

// Ligt punt (x, y) binnen de kamer? Rechthoek en ovaal rekenen we direct
// uit, voor polygons gebruiken we ray casting (tel hoe vaak een lijn naar
// rechts de randen kruist: oneven = binnen).
function containsPoint(loc, x, y) {
  if (loc.shape === "rect") {
    return x >= loc.x && x <= loc.x + loc.width && y >= loc.y && y <= loc.y + loc.height;
  }
  if (loc.shape === "circle") {
    const [rx, ry] = radiiOf(loc);
    const dx = (x - loc.x) / rx;
    const dy = (y - loc.y) / ry;
    return dx * dx + dy * dy <= 1;
  }
  if (loc.shape === "polygon") {
    const pts = loc.points.map(([px, py]) => [loc.x + px, loc.y + py]);
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }
  return false;
}

// De bovenste kamer (laatst getekend) op punt (x, y), of undefined.
function roomAt(locations, x, y) {
  return locations.findLast((loc) => containsPoint(loc, x, y));
}

// --- Items in kamers ---------------------------------------------------------
// Voorlopig krijgt elk item hetzelfde placeholder-plaatje (in de kleur van
// zijn categorie) met de naam eronder. Later kunnen hier echte iconen komen.
const ITEM_DRAG_TYPE = "application/x-map-item";
const ITEM_SIZE = 18; // breedte/hoogte van een item op de map
const ITEM_SNAP = GRID / 2;
const snapItem = (v) => Math.round(v / ITEM_SNAP) * ITEM_SNAP;

const ITEM_CATEGORIES = {
  loot: { label: "Buit", color: "#ca8a04" },
  monster: { label: "Monsters", color: "#dc2626" },
  trap: { label: "Valstrikken", color: "#7c3aed" },
  object: { label: "Inrichting", color: "#57534e" },
};

const ITEM_TYPES = [
  { type: "chest", label: "Schatkist", category: "loot" },
  { type: "gold", label: "Goudstapel", category: "loot" },
  { type: "potion", label: "Toverdrank", category: "loot" },
  { type: "goblin", label: "Goblin", category: "monster" },
  { type: "skeleton", label: "Skelet", category: "monster" },
  { type: "orc", label: "Ork", category: "monster" },
  { type: "spider", label: "Reuzenspin", category: "monster" },
  { type: "spike_trap", label: "Spiesvalstrik", category: "trap" },
  { type: "pit_trap", label: "Valkuil", category: "trap" },
  { type: "arrow_trap", label: "Pijlvalstrik", category: "trap" },
  { type: "bear_trap", label: "Berenklem", category: "trap" },
  { type: "torch", label: "Fakkel", category: "object" },
  { type: "barrel", label: "Ton", category: "object" },
  { type: "altar", label: "Altaar", category: "object" },
];
// Eigen items: de gebruiker maakt zelf een item met naam en kleur. Deze worden
// lokaal in de browser bewaard (localStorage), zodat ze bij een volgend bezoek
// weer in het paneel staan. Elk eigen item: { type: "custom_…", label, color, category: "custom" }.
const CUSTOM_ITEMS_KEY = "mapEditor.customItems";
const CUSTOM_DEFAULT_COLOR = "#0891b2";

function loadCustomItemTypes() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_ITEMS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => t && typeof t.type === "string" && t.type.startsWith("custom_") && typeof t.label === "string")
      .map((t) => ({
        type: t.type,
        label: t.label.slice(0, 30),
        color: /^#[0-9a-f]{6}$/i.test(t.color) ? t.color : CUSTOM_DEFAULT_COLOR,
        category: "custom",
      }));
  } catch {
    return []; // geen toegang tot localStorage of kapotte data: gewoon leeg beginnen
  }
}

function saveCustomItemTypes(types) {
  try {
    localStorage.setItem(CUSTOM_ITEMS_KEY, JSON.stringify(types));
  } catch {
    // opslaan lukt niet (bv. privévenster); de items blijven wel deze sessie bestaan
  }
}

// Zoekt een itemtype op, zowel de vaste als de eigen items.
const itemTypeOf = (type, customTypes = []) =>
  ITEM_TYPES.find((t) => t.type === type) ?? customTypes.find((t) => t.type === type);
const itemColorOf = (type, customTypes = []) => {
  const t = itemTypeOf(type, customTypes);
  return t?.color ?? ITEM_CATEGORIES[t?.category]?.color ?? "#57534e";
};

// Placeholder-plaatje in een 24x24 viewBox: gestippeld vlak met een kruis.
function placeholderGlyph(color) {
  return h("g", null,
    h("rect", {
      x: 2, y: 2, width: 20, height: 20, rx: 3,
      fill: color, fillOpacity: 0.12, stroke: color, strokeWidth: 1.5, strokeDasharray: "3 2",
    }),
    h("path", { d: "M7 7L17 17M17 7L7 17", stroke: color, strokeWidth: 1.2, strokeOpacity: 0.6 })
  );
}

// --- Scheldwoordenfilter voor kamernamen -------------------------------------
// Drie soorten woorden, om te voorkomen dat onschuldige woorden geblokkeerd
// worden (zoals "hoera" of "catering"):
//  - anywhere: geblokkeerd waar ze ook in een woord staan ("kankerkamer")
//  - prefix:   geblokkeerd aan het begin van een woord ("kutkamer")
//  - whole:    alleen als los woord, eventueel met een meervoud/verkleinwoord ("hoeren")
// Voor het vergelijken gaat alles naar kleine letters zonder accenten,
// worden cijfers/tekens als letters gelezen ("k4nk3r") en worden herhaalde
// letters samengevoegd ("fuuuuck"), ook in de lijsten zelf.
const collapseRepeats = (text) => text.replace(/(.)\1+/g, "$1");

const PROFANITY = {
  anywhere: [
    "fuck", "kanker", "klootzak", "godverdomme", "godver", "tyfus", "motherf",
    "asshole", "bitch", "nigger", "nigga", "kankerlijer", "teringlijer",
  ],
  prefix: ["klote", "tering", "kut", "slet", "tief"],
  whole: [
    "hoer", "lul", "pik", "flikker", "mongool", "neuk", "neuken", "shit", "cunt",
    "dick", "ass", "bastard", "whore", "slut", "piss", "wanker", "twat", "fag", "faggot", "retard",
  ],
};
const PROFANITY_LISTS = Object.fromEntries(
  Object.entries(PROFANITY).map(([kind, words]) => [kind, words.map(collapseRepeats)])
);
const PROFANITY_SUFFIXES = ["", "s", "en", "e", "er", "ers", "je", "jes", "tje", "tjes", "y"];
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s" };

function containsProfanity(text) {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // accenten weg: "é" → "e"
    .replace(/[0134578@$]/g, (c) => LEET[c])
    .split(/[^a-z]+/)
    .filter(Boolean);

  // Losse letters achter elkaar samenvoegen, zodat "f u c k" ook gevonden wordt.
  const tokens = [];
  let letters = "";
  for (const word of words) {
    if (word.length === 1) {
      letters += word;
      continue;
    }
    if (letters) tokens.push(letters);
    letters = "";
    tokens.push(word);
  }
  if (letters) tokens.push(letters);

  return tokens.map(collapseRepeats).some((word) =>
    PROFANITY_LISTS.anywhere.some((bad) => word.includes(bad))
    || PROFANITY_LISTS.prefix.some((bad) => word.startsWith(bad))
    || PROFANITY_LISTS.whole.some((bad) => word.startsWith(bad) && PROFANITY_SUFFIXES.includes(word.slice(bad.length)))
  );
}

// --- map opslaan/openen als .json -----------------------------------------
const MAP_FILE_FORMAT = "map-editor";
const MAP_FILE_VERSION = 1;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Controleert een ingelezen mapbestand en gooit alles weg wat niet klopt,
// zodat een kapot of aangepast bestand de editor niet kan laten crashen.
function parseMapFile(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.locations)) {
    throw new Error("dit is geen mapbestand");
  }
  if (data.format !== undefined && data.format !== MAP_FILE_FORMAT) {
    throw new Error("onbekend bestandsformaat");
  }

  const locations = data.locations.filter((loc) => {
    if (!loc || typeof loc.id !== "string" || !isNum(loc.x) || !isNum(loc.y)) return false;
    if (loc.shape === "rect") return isNum(loc.width) && isNum(loc.height);
    if (loc.shape === "circle") return isNum(loc.radiusX ?? loc.radius) && isNum(loc.radiusY ?? loc.radius);
    if (loc.shape === "polygon") {
      return Array.isArray(loc.points) && loc.points.length >= 3 &&
        loc.points.every((p) => Array.isArray(p) && isNum(p[0]) && isNum(p[1]));
    }
    return false;
  }).map((loc) => {
    const name = typeof loc.name === "string" ? loc.name.slice(0, 60) : "";
    return { ...loc, name: name.trim() === "" || containsProfanity(name) ? "Naamloze kamer" : name };
  });
  const roomIds = new Set(locations.map((l) => l.id));

  const customTypes = (Array.isArray(data.customTypes) ? data.customTypes : [])
    .filter((t) => t && typeof t.type === "string" && t.type.startsWith("custom_") &&
      typeof t.label === "string" && t.label.trim() !== "" && !containsProfanity(t.label) &&
      typeof t.color === "string" && /^#[0-9a-f]{6}$/i.test(t.color))
    .map((t) => ({ type: t.type, label: t.label.slice(0, 30), color: t.color, category: "custom" }));
  const knownTypes = new Set([...ITEM_TYPES.map((t) => t.type), ...customTypes.map((t) => t.type), ...loadCustomItemTypes().map((t) => t.type)]);

  const connections = (Array.isArray(data.connections) ? data.connections : []).filter((c) =>
    c && typeof c.id === "string" && roomIds.has(c.from) && roomIds.has(c.to) &&
    Number.isInteger(c.fromEdge) && Number.isInteger(c.toEdge)
  );

  const items = (Array.isArray(data.items) ? data.items : []).filter((it) =>
    it && typeof it.id === "string" && knownTypes.has(it.type) && roomIds.has(it.roomId) &&
    isNum(it.x) && isNum(it.y)
  );

  return { locations, connections, items, customTypes };
}

function MapEditorPOC() {
  const [kamer, setKamer] = useState("");
  const [locations, setLocations] = useState(initialLocations);
  const [connections, setConnections] = useState(initialConnections);
  const [items, setItems] = useState([]); // { id, type, roomId, x, y } — x/y is het midden, absoluut
  const [customTypes, setCustomTypes] = useState(loadCustomItemTypes);
  const [customName, setCustomName] = useState("");
  const [customColor, setCustomColor] = useState(CUSTOM_DEFAULT_COLOR);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [draggingItem, setDraggingItem] = useState(null); // { id, offsetX, offsetY, startX, startY }
  const [dropTargetId, setDropTargetId] = useState(null); // kamer waar een item nu boven hangt
  const [hint, setHint] = useState(null); // korte melding in de statusbalk
  const [dragging, setDragging] = useState(null);
  const [resizing, setResizing] = useState(null); // { id, handle, start } — hendel die je nu versleept
  const [drawMode, setDrawMode] = useState(false);
  const [drawPoints, setDrawPoints] = useState([]); // array van [x, y], absolute SVG-coördinaten
  const [pendingEdge, setPendingEdge] = useState(null); // { locId, edgeIndex } — eerste wand die je hebt aangeklikt
  const svgRef = useRef(null);
  const nameInputRef = useRef(null);
  const nameBeforeEditRef = useRef(null); // { id, name } — naam bij het begin van het bewerken
  const fileInputRef = useRef(null); // verborgen <input type="file"> voor "map openen"

  const CLOSE_DISTANCE = 16; // klik binnen dit aantal px van het startpunt = vorm sluiten
  let nextRoomNumber = locations.length + 1;

  const toSvgPoint = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const screenCTM = svg.getScreenCTM();
    return pt.matrixTransform(screenCTM.inverse());
  }, []);

  // Bij het slepen van een kamer onthouden we ook waar de kamer en zijn
  // items begonnen, zodat de items precies even ver meeschuiven.
  const handlePointerDown = (e, loc) => {
    e.stopPropagation();
    setSelectedId(loc.id);
    setSelectedItemId(null);
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    const itemStarts = Object.fromEntries(
      items.filter((it) => it.roomId === loc.id).map((it) => [it.id, [it.x, it.y]])
    );
    setDragging({ id: loc.id, offsetX: x - loc.x, offsetY: y - loc.y, roomX: loc.x, roomY: loc.y, itemStarts });
  };

  const handleItemPointerDown = (e, item) => {
    if (drawMode) return; // klik gaat door naar de canvas om een punt te zetten
    e.stopPropagation();
    setSelectedItemId(item.id);
    setSelectedId(null);
    setPendingEdge(null);
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    setDraggingItem({ id: item.id, offsetX: x - item.x, offsetY: y - item.y, startX: item.x, startY: item.y });
  };

  const showHint = (text) => {
    setHint(text);
    setTimeout(() => setHint((current) => (current === text ? null : current)), 2500);
  };

  const handleResizeStart = (e, loc, handle) => {
    e.stopPropagation();
    setResizing({ id: loc.id, handle, start: loc });
  };

  const handlePointerMove = (e) => {
    if (resizing) {
      const { x, y } = toSvgPoint(e.clientX, e.clientY);
      const resized = resizeLocation(resizing.start, resizing.handle, x, y, e.shiftKey);
      setLocations((prev) => prev.map((loc) => (loc.id === resizing.id ? resized : loc)));
      return;
    }
    if (draggingItem) {
      const { x, y } = toSvgPoint(e.clientX, e.clientY);
      const itemX = snapItem(x - draggingItem.offsetX);
      const itemY = snapItem(y - draggingItem.offsetY);
      setItems((prev) => prev.map((it) => (it.id === draggingItem.id ? { ...it, x: itemX, y: itemY } : it)));
      setDropTargetId(roomAt(locations, itemX, itemY)?.id ?? null);
      return;
    }
    if (!dragging) return;
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    const newX = snap(x - dragging.offsetX);
    const newY = snap(y - dragging.offsetY);
    const dx = newX - dragging.roomX;
    const dy = newY - dragging.roomY;
    setLocations((prev) =>
      prev.map((loc) => (loc.id === dragging.id ? { ...loc, x: newX, y: newY } : loc))
    );
    setItems((prev) =>
      prev.map((it) => {
        const start = dragging.itemStarts[it.id];
        return start ? { ...it, x: start[0] + dx, y: start[1] + dy } : it;
      })
    );
  };

  // Een item loslaten buiten elke kamer zet hem terug waar hij vandaan kwam;
  // loslaten in een (andere) kamer maakt hem onderdeel van die kamer.
  const finishItemDrag = () => {
    const item = items.find((it) => it.id === draggingItem.id);
    const room = item && roomAt(locations, item.x, item.y);
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== draggingItem.id) return it;
        return room ? { ...it, roomId: room.id } : { ...it, x: draggingItem.startX, y: draggingItem.startY };
      })
    );
    if (item && !room) showHint("Items kunnen alleen in een kamer staan");
    setDraggingItem(null);
    setDropTargetId(null);
  };

  const handlePointerUp = () => {
    if (draggingItem) finishItemDrag();
    setDragging(null);
    setResizing(null);
  };

  // Slepen vanuit het itempaneel (HTML5 drag & drop). Tijdens het slepen
  // licht de kamer onder de muis op; loslaten buiten een kamer doet niks.
  const handleDragOver = (e) => {
    if (!e.dataTransfer.types.includes(ITEM_DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    const targetId = roomAt(locations, x, y)?.id ?? null;
    if (targetId !== dropTargetId) setDropTargetId(targetId);
  };

  const handleDragLeave = (e) => {
    if (!svgRef.current.contains(e.relatedTarget)) setDropTargetId(null);
  };

  const handleDrop = (e) => {
    const type = e.dataTransfer.getData(ITEM_DRAG_TYPE);
    setDropTargetId(null);
    if (!itemTypeOf(type, customTypes)) return;
    e.preventDefault();
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    const room = roomAt(locations, x, y);
    if (!room) {
      showHint("Sleep het item in een kamer");
      return;
    }
    const newItem = { id: `item_${Date.now()}`, type, roomId: room.id, x: snapItem(x), y: snapItem(y) };
    setItems((prev) => [...prev, newItem]);
    setSelectedItemId(newItem.id);
    setSelectedId(null);
  };
  // Een eigen item aanmaken en meteen lokaal opslaan.
  const customNameTrimmed = customName.trim();
  const customNameIsBlocked = containsProfanity(customNameTrimmed);
  const addCustomType = () => {
    if (!customNameTrimmed) {
      showHint("Geef je eigen item eerst een naam");
      return;
    }
    if (customNameIsBlocked) {
      showHint("Deze naam bevat een ongepast woord");
      return;
    }
    const newType = { type: `custom_${Date.now()}`, label: customNameTrimmed, color: customColor, category: "custom" };
    setCustomTypes((prev) => {
      const next = [...prev, newType];
      saveCustomItemTypes(next);
      return next;
    });
    setCustomName("");
    showHint(`"${newType.label}" opgeslagen · sleep het naar een kamer`);
  };

  // Een eigen item uit het paneel (en dus uit de opslag) verwijderen. Staat
  // hij al op de map, dan vragen we eerst of die ook weg mogen.
  const deleteCustomType = (type) => {
    const def = customTypes.find((t) => t.type === type);
    const placed = items.filter((it) => it.type === type).length;
    if (placed > 0 && !window.confirm(`"${def?.label}" staat ${placed}x op de map. Die worden ook verwijderd. Doorgaan?`)) return;
    setCustomTypes((prev) => {
      const next = prev.filter((t) => t.type !== type);
      saveCustomItemTypes(next);
      return next;
    });
    if (placed > 0) {
      setItems((prev) => prev.filter((it) => it.type !== type));
      if (items.some((it) => it.id === selectedItemId && it.type === type)) setSelectedItemId(null);
    }
  };

  const selected = locations.find((l) => l.id === selectedId);
  const selectedItem = items.find((it) => it.id === selectedItemId);

  // Live preview terwijl je tekent: lijn tussen de al geplaatste punten,
  // en een cirkeltje op elk punt (het eerste punt iets groter/anders
  // gekleurd, zodat je ziet waar je moet klikken om de vorm te sluiten).
  const drawPreviewLine = drawPoints.length >= 2
    ? h("polyline", {
        className: "draw-preview-line",
        points: drawPoints.map(([px, py]) => `${px},${py}`).join(" "),
      })
    : null;

  const drawPreviewDots = drawPoints.map(([px, py], i) =>
    h("circle", {
      key: `drawpoint_${i}`,
      className: `draw-dot${i === 0 ? " is-first" : ""}`,
      cx: px, cy: py, r: i === 0 ? 6 : 4,
    })
  );

  // Klik ergens leeg op de svg: normaal deselecteert dit (en annuleert een
  // eventuele lopende wand-verbinding), maar in teken-modus zet dit een
  // nieuw punt neer (gesnapt aan de grid).
  const handleCanvasPointerDown = (e) => {
    if (!drawMode) {
      setSelectedId(null);
      setSelectedItemId(null);
      setPendingEdge(null);
      return;
    }
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    const snapped = [snap(x), snap(y)];

    // Klik je dicht genoeg bij het startpunt, en heb je al minstens 3
    // punten? Dan sluiten we de vorm af tot een nieuwe polygon-kamer.
    if (drawPoints.length >= 3) {
      const [startX, startY] = drawPoints[0];
      const dist = Math.hypot(snapped[0] - startX, snapped[1] - startY);
      if (dist <= CLOSE_DISTANCE) {
        finishDrawing();
        return;
      }
    }

    setDrawPoints((prev) => [...prev, snapped]);
  };

  // Zet de verzamelde punten om naar een polygon-Location (relatief t.o.v.
  // de linkerbovenhoek van de bounding box, net als de andere polygons)
  // en voegt hem toe aan de kamers.
  const finishDrawing = () => {
    if (drawPoints.length < 3) return;
    const xs = drawPoints.map((p) => p[0]);
    const ys = drawPoints.map((p) => p[1]);
    const originX = Math.min(...xs);
    const originY = Math.min(...ys);
    const relativePoints = drawPoints.map(([px, py]) => [px - originX, py - originY]);

    const newRoom = {
      id: `loc_${Date.now()}`,
      name: `Kamer ${nextRoomNumber}`,
      shape: "polygon",
      x: originX,
      y: originY,
      points: relativePoints,
    };

    setLocations((prev) => [...prev, newRoom]);
    setDrawPoints([]);
    setDrawMode(false);
  };

  const cancelDrawing = () => {
    setDrawPoints([]);
    setDrawMode(false);
  };

  // Zet in één klik een perfect vierkant neer — geen teken-modus nodig.
  // Elk nieuw vierkant krijgt een licht andere positie (op basis van hoeveel
  // kamers er al zijn), zodat ze niet allemaal precies op elkaar landen.
  const SQUARE_SIZE = 80; // veelvoud van GRID, zodat 'ie meteen mooi aansluit
  const addSquareRoom = () => {
    const offset = (locations.length % 6) * (SQUARE_SIZE + GRID);
    const newRoom = {
      id: `loc_${Date.now()}`,
      name: `Kamer ${nextRoomNumber}`,
      shape: "rect",
      x: snap(40 + offset),
      y: snap(40),
      width: SQUARE_SIZE,
      height: SQUARE_SIZE,
    };
    setLocations((prev) => [...prev, newRoom]);
  };

  // Zet in één klik een cirkel neer, net als addSquareRoom. Let op: bij een
  // circle zijn x/y het middelpunt (niet de linkerbovenhoek). De cirkels
  // komen op een rij onder de vierkanten, zodat ze daar niet op landen.
  const CIRCLE_RADIUS = SQUARE_SIZE / 2;
  const addCircleRoom = () => {
    const offset = (locations.length % 6) * (CIRCLE_RADIUS * 2 + GRID);
    const newRoom = {
      id: `loc_${Date.now()}`,
      name: `Kamer ${nextRoomNumber}`,
      shape: "circle",
      x: snap(40 + CIRCLE_RADIUS + offset),
      y: snap(40 + SQUARE_SIZE + 2 * GRID + CIRCLE_RADIUS),
      radiusX: CIRCLE_RADIUS,
      radiusY: CIRCLE_RADIUS,
    };
    setLocations((prev) => [...prev, newRoom]);
  };

  // Verwijdert de geselecteerde kamer, en ook alle connections die naar
  // (of vanaf) die kamer verwezen — anders blijft er een "dode" lijn hangen
  // die verwijst naar een kamer die niet meer bestaat. De items in de kamer
  // gaan ook weg.
  const deleteSelectedRoom = () => {
    if (!selectedId) return;
    setLocations((prev) => prev.filter((loc) => loc.id !== selectedId));
    setConnections((prev) => prev.filter((conn) => conn.from !== selectedId && conn.to !== selectedId));
    setItems((prev) => prev.filter((it) => it.roomId !== selectedId));
    setSelectedId(null);
  };

  // Slaat de hele map op als .json-bestand (download). De eigen items die
  // op de map gebruikt worden gaan mee, zodat de map ook in een andere
  // browser (zonder die eigen items in localStorage) goed te openen is.
  const saveMapToFile = () => {
    const usedTypes = new Set(items.map((it) => it.type));
    const data = {
      format: MAP_FILE_FORMAT,
      version: MAP_FILE_VERSION,
      locations,
      connections,
      items,
      customTypes: customTypes.filter((t) => usedTypes.has(t.type)),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "map.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showHint("Map opgeslagen als map.json");
  };

  // Leest een eerder opgeslagen .json-bestand in en vervangt de huidige map.
  const loadMapFromFile = async (file) => {
    if (!file) return;
    if (locations.length > 0 && !window.confirm("De huidige map wordt vervangen. Doorgaan?")) return;
    let parsed;
    try {
      parsed = parseMapFile(JSON.parse(await file.text()));
    } catch (err) {
      showHint(`Kan ${file.name} niet openen: ${err.message}`);
      return;
    }
    setLocations(parsed.locations);
    setConnections(parsed.connections);
    setItems(parsed.items);
    setCustomTypes((prev) => {
      const known = new Set(prev.map((t) => t.type));
      const next = [...prev, ...parsed.customTypes.filter((t) => !known.has(t.type))];
      saveCustomItemTypes(next);
      return next;
    });
    setSelectedId(null);
    setSelectedItemId(null);
    setPendingEdge(null);
    setDrawMode(false);
    setDrawPoints([]);
    showHint(`map geladen uit ${file.name}`);
  };

  const deleteSelectedItem = () => {
    if (!selectedItemId) return;
    setItems((prev) => prev.filter((it) => it.id !== selectedItemId));
    setSelectedItemId(null);
  };

  // Delete/Backspace verwijdert de geselecteerde kamer, Escape annuleert
  // een lopende wand-verbinding. Beide niet tijdens het tekenen.
  const ARROW_DELTAS = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };

  // Hernoemt de geselecteerde kamer. Tijdens het typen mag de naam even leeg
  // zijn; pas bij het verlaten van het veld (of als je een andere kamer
  // selecteert) vullen we lege namen aan, zodat er geen kamer zonder label op
  // de map blijft staan. Een naam met een scheldwoord wordt dan ook
  // geblokkeerd: de kamer krijgt de naam van vóór het bewerken terug. Dit
  // gebeurt voor álle kamers, omdat het veld bij het wisselen van selectie
  // al bij de nieuwe kamer hoort.
  const renameSelectedRoom = (name) => {
    setLocations((prev) =>
      prev.map((loc) => (loc.id === selectedId ? { ...loc, name } : loc))
    );
  };

  const finishRenaming = () => {
    const before = nameBeforeEditRef.current;
    nameBeforeEditRef.current = null;
    const fixedName = (loc) => {
      if (loc.name.trim() === "") return "Naamloze kamer";
      if (!containsProfanity(loc.name)) return loc.name;
      const canRestore = before?.id === loc.id && before.name.trim() !== "" && !containsProfanity(before.name);
      return canRestore ? before.name : "Naamloze kamer";
    };
    if (locations.some((loc) => containsProfanity(loc.name))) {
      showHint("Ongepaste kamernaam geblokkeerd, de vorige naam is teruggezet");
    }
    setLocations((prev) =>
      prev.some((loc) => fixedName(loc) !== loc.name)
        ? prev.map((loc) => ({ ...loc, name: fixedName(loc) }))
        : prev
    );
  };

  const nameIsBlocked = selected != null && containsProfanity(selected.name);

  useEffect(finishRenaming, [selectedId]);

  const moveSelectedRoom = (dx, dy) => {
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id === selectedId ? { ...loc, x: loc.x + dx * GRID, y: loc.y + dy * GRID } : loc
      )
    );
    setItems((prev) =>
      prev.map((it) =>
        it.roomId === selectedId ? { ...it, x: it.x + dx * GRID, y: it.y + dy * GRID } : it
      )
    );
  };

  // Delete/Backspace verwijdert de geselecteerde kamer, Escape annuleert
  // een lopende wand-verbinding, en de pijltjestoetsen verplaatsen de
  // geselecteerde kamer per GRID-stap. Niks van dit alles tijdens het
  // tekenen.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (drawMode) return;
      // Typ je in een tekstveld (zoals de kamernaam), dan zijn Backspace en
      // de pijltjes voor het veld zelf — niet om de kamer te verwijderen/verplaatsen.
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedItemId) {
        e.preventDefault();
        deleteSelectedItem();
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelectedRoom();
      }
      if (e.key === "Escape" && pendingEdge) {
        setPendingEdge(null);
      }
      if (ARROW_DELTAS[e.key] && selectedId) {
        e.preventDefault(); // anders scrollt de pagina zelf mee
        const [dx, dy] = ARROW_DELTAS[e.key];
        moveSelectedRoom(dx, dy);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawMode, selectedId, selectedItemId, pendingEdge]);

  // Klik op een wand-knopje: eerste klik onthoudt welke wand je hebt
  // gekozen (pendingEdge); een tweede klik op een wand van een ándere
  // kamer maakt de connection; klik je nogmaals dezelfde wand aan, dan
  // annuleer je 'm weer.
  const handleEdgeClick = (locId, edgeIndex, e) => {
    e.stopPropagation();

    if (!pendingEdge) {
      setPendingEdge({ locId, edgeIndex });
      return;
    }

    if (pendingEdge.locId === locId && pendingEdge.edgeIndex === edgeIndex) {
      setPendingEdge(null); // dezelfde wand nogmaals aangeklikt: annuleren
      return;
    }

    if (pendingEdge.locId === locId) {
      // andere wand van dezelfde kamer: geen verbinding met jezelf,
      // gewoon de nieuwe wand als startpunt nemen
      setPendingEdge({ locId, edgeIndex });
      return;
    }

    setConnections((prev) => [
      ...prev,
      {
        id: `conn_${Date.now()}`,
        from: pendingEdge.locId,
        fromEdge: pendingEdge.edgeIndex,
        to: locId,
        toEdge: edgeIndex,
      },
    ]);
    setPendingEdge(null);
  };

  // Connections als <line> elementen — het midden van de gekozen wand aan
  // elke kant, opnieuw berekend op basis van de huidige positie van de
  // kamer (zodat de lijn meebeweegt als je een kamer verschuift). Klik op
  // de lijn om 'm te verwijderen — de onzichtbare, bredere lijn erachter
  // (connection-hit) maakt dat makkelijker te raken dan de dunne
  // zichtbare lijn.
  const deleteConnection = (connId) => {
    setConnections((prev) => prev.filter((conn) => conn.id !== connId));
  };

  const connectionEls = connections.flatMap((conn) => {
    const from = locations.find((l) => l.id === conn.from);
    const to = locations.find((l) => l.id === conn.to);
    if (!from || !to) return [];
    const fromEdges = edgesOf(from);
    const toEdges = edgesOf(to);
    const a = fromEdges[conn.fromEdge]?.mid;
    const b = toEdges[conn.toEdge]?.mid;
    if (!a || !b) return [];
    return [
      h("line", {
        key: `${conn.id}_hit`,
        className: "connection-hit",
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        onPointerDown: (e) => {
          e.stopPropagation();
          deleteConnection(conn.id);
        },
      }),
      h("line", {
        key: conn.id,
        className: "connection-line",
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
      }),
    ];
  });


  const roomEls = locations.map((loc) => {
    const isSelected = loc.id === selectedId;
    const shapeClassName = `room-shape${isSelected ? " is-selected" : ""}${loc.id === dropTargetId ? " is-drop-target" : ""}`;
    const { centerX, centerY } = boundsOf(loc);

    let shapeEl;
    if (loc.shape === "polygon") {
      shapeEl = h("polygon", {
        className: shapeClassName,
        points: loc.points.map(([px, py]) => `${loc.x + px},${loc.y + py}`).join(" "),
      });
    } else if (loc.shape === "circle") {
      const [rx, ry] = radiiOf(loc);
      shapeEl = h("ellipse", { className: shapeClassName, cx: loc.x, cy: loc.y, rx, ry });
    } else {
      shapeEl = h("rect", { className: shapeClassName, x: loc.x, y: loc.y, width: loc.width, height: loc.height, rx: 4 });
    }

    // Lettergrootte via `style` i.p.v. een attribuut: CSS gaat namelijk
    // boven SVG-presentatieattributen.
    const labelLayout = layoutLabel(loc, centerX, centerY);
    const label = h("text", {
      className: "room-label",
      textAnchor: "middle",
      style: { fontSize: `${labelLayout.fontSize}px`, fontFamily: LABEL_FONT_FAMILY },
    }, ...labelLayout.lines.map((line, i) =>
      h("tspan", { key: i, x: centerX, y: line.y, dominantBaseline: "middle" }, line.text)
    ));

    // Dubbelklik op een kamer = meteen de naam bewerken. De <title> geeft
    // een tooltip met de volledige naam (handig als hij afgekort is).
    return h("g", {
      key: loc.id,
      className: `room-group${dragging?.id === loc.id ? " is-dragging" : ""}`,
      onPointerDown: (e) => handlePointerDown(e, loc),
      onDoubleClick: () => nameInputRef.current?.select(),
    }, h("title", null, loc.name), shapeEl, label);
  });

  // Items op de map: het placeholder-plaatje (een geneste <svg> zodat we
  // dezelfde 24x24 glyph als in het paneel kunnen gebruiken) met de naam eronder.
  const itemEls = items.map((item) => {
    const label = itemTypeOf(item.type, customTypes)?.label ?? item.type;
    const half = ITEM_SIZE / 2;
    const classes = `map-item${item.id === selectedItemId ? " is-selected" : ""}${draggingItem?.id === item.id ? " is-dragging" : ""}`;
    return h("g", {
      key: item.id,
      className: classes,
      onPointerDown: (e) => handleItemPointerDown(e, item),
    },
      h("title", null, label),
      h("rect", { className: "map-item-outline", x: item.x - half - 2, y: item.y - half - 2, width: ITEM_SIZE + 4, height: ITEM_SIZE + 4, rx: 3 }),
      h("svg", { x: item.x - half, y: item.y - half, width: ITEM_SIZE, height: ITEM_SIZE, viewBox: "0 0 24 24" },
        placeholderGlyph(itemColorOf(item.type, customTypes))
      ),
      h("text", { className: "map-item-label", x: item.x, y: item.y + half + 5, textAnchor: "middle" }, label)
    );
  });

  // Eén sleepbaar item in het paneel. Eigen items krijgen een ×-knopje.
  const paletteItemEl = (t, onDelete) =>
    h("div", {
      key: t.type,
      className: "editor-palette-item",
      draggable: true,
      title: `Sleep ${t.label} naar een kamer`,
      onDragStart: (e) => {
        e.dataTransfer.setData(ITEM_DRAG_TYPE, t.type);
        e.dataTransfer.effectAllowed = "copy";
      },
    },
      h("svg", { viewBox: "0 0 24 24", width: 32, height: 32 }, placeholderGlyph(itemColorOf(t.type, customTypes))),
      h("span", null, t.label),
      onDelete
        ? h("button", {
            type: "button",
            className: "editor-palette-item-delete",
            title: `${t.label} verwijderen`,
            draggable: false,
            onClick: (e) => {
              e.stopPropagation();
              onDelete();
            },
          }, "×")
        : null
    );

  // Formulier om een eigen item te maken, met de opgeslagen eigen items eronder.
  const customGroupEl = h("div", { key: "custom", className: "editor-palette-group" },
    h("div", { className: "editor-palette-heading" }, "Eigen items"),
    h("form", {
      className: "editor-custom-form",
      onSubmit: (e) => {
        e.preventDefault();
        addCustomType();
      },
    },
      h("input", {
        type: "text",
        className: `editor-name-input editor-custom-name${customNameIsBlocked ? " is-invalid" : ""}`,
        placeholder: "Naam, bv. Standbeeld",
        value: customName,
        maxLength: 30,
        onChange: (e) => setCustomName(e.target.value),
      }),
      h("div", { className: "editor-custom-row" },
        h("input", {
          type: "color",
          className: "editor-custom-color",
          title: "Kies een kleur",
          value: customColor,
          onChange: (e) => setCustomColor(e.target.value),
        }),
        h("button", { type: "submit", className: "editor-btn", disabled: !customNameTrimmed || customNameIsBlocked }, "+ Maak item")
      )
    ),
    customTypes.length > 0
      ? h("div", { className: "editor-palette-items" },
          ...customTypes.map((t) => paletteItemEl(t, () => deleteCustomType(t.type)))
        )
      : h("div", { className: "editor-palette-empty" }, "Nog geen eigen items. Ze worden in deze browser bewaard.")
  );

  // Het paneel met items om de map op te slepen, gegroepeerd per categorie.
  const paletteEl = h("div", { className: "editor-palette" },
    customGroupEl,
    ...Object.entries(ITEM_CATEGORIES).map(([category, { label }]) =>
      h("div", { key: category, className: "editor-palette-group" },
        h("div", { className: "editor-palette-heading" }, label),
        h("div", { className: "editor-palette-items" },
          ...ITEM_TYPES.filter((t) => t.category === category).map((t) => paletteItemEl(t))
        )
      )
    )
  );

  // Eén "+"-knopje per wand van elke kamer. Niet zichtbaar tijdens het
  // tekenen. De wand die als eerste is aangeklikt (pendingEdge) licht op
  // in een andere kleur, zodat je ziet dat hij op zijn "partner" wacht.
  const edgeButtonEls = [];
  if (!drawMode && selected != null) {
    locations.forEach((loc) => {
      edgesOf(loc).forEach((edge, edgeIndex) => {
        const isPending = pendingEdge && pendingEdge.locId === loc.id && pendingEdge.edgeIndex === edgeIndex;
        const [mx, my] = edge.mid;
        const pendingClass = isPending ? " is-pending" : "";

        edgeButtonEls.push(
          h("g", {
            key: `edgebtn_${loc.id}_${edgeIndex}`,
            className: `edge-btn${pendingClass}`,
            onPointerDown: (e) => handleEdgeClick(loc.id, edgeIndex, e),
          },
            h("circle", { className: `edge-dot${pendingClass}`, cx: mx, cy: my, r: 4 }),
            h("text", {
              className: `edge-label${pendingClass}`,
              x: mx, y: my, textAnchor: "middle", dominantBaseline: "middle",
            }, "+")
          )
        );
      });
    });
  }

  // Resize-hendels, alleen voor de geselecteerde kamer en niet tijdens het
  // tekenen. Ze staan bovenop de rest, zodat je ze altijd kunt pakken.
  const resizeHandleEls = !drawMode && selected
    ? resizeHandlesOf(selected).map(({ id, pos: [hx, hy] }) =>
        h("rect", {
          key: `resize_${selected.id}_${id}`,
          className: `resize-handle resize-handle-${selected.shape === "polygon" ? "vertex" : id}`,
          x: hx - 4, y: hy - 4, width: 8, height: 8,
          onPointerDown: (e) => handleResizeStart(e, selected, id),
        })
      )
    : [];

  return h("div", { className: "editor-root" },
    h("div", { className: "editor-toolbar" },
      selected && !drawMode
        ? h("label", { className: "editor-name-field" },
            "Naam:",
            h("input", {
              ref: nameInputRef,
              type: "text",
              className: `editor-name-input${nameIsBlocked ? " is-invalid" : ""}`,
              value: selected.name,
              maxLength: 60,
              onFocus: () => {
                nameBeforeEditRef.current = { id: selected.id, name: selected.name };
              },
              onChange: (e) => renameSelectedRoom(e.target.value),
              onBlur: finishRenaming,
              onKeyDown: (e) => {
                if (e.key === "Enter" || e.key === "Escape") e.currentTarget.blur();
              },
            })
          )
        : null,
      selected && !drawMode
        ? h("button", {
            onClick: deleteSelectedRoom,
            className: "editor-btn editor-btn-delete",
          }, "Verwijder kamer")
        : null,
      selectedItem && !drawMode
        ? h("button", {
            onClick: deleteSelectedItem,
            className: "editor-btn editor-btn-delete",
          }, "Verwijder item")
        : null,
      drawMode
        ? h("button", {
            onClick: cancelDrawing,
            className: "editor-btn editor-btn-cancel",
          }, "Annuleer tekenen")
        : h("button", {
            onClick: () => setDrawMode(true),
            className: "editor-btn",
          }, "+ Kamer tekenen"),
      !drawMode
        ? h("button", {
            onClick: addSquareRoom,
            className: "editor-btn",
          }, "+ Vierkant")
        : null,
      !drawMode
        ? h("button", {
            onClick: addCircleRoom,
            className: "editor-btn",
          }, "+ Cirkel")
        : null,
      !drawMode
        ? h("button", {
            onClick: saveMapToFile,
            className: "editor-btn",
            title: "Download de map als .json-bestand",
          }, "map opslaan")
        : null,
      !drawMode
        ? h("button", {
            onClick: () => fileInputRef.current?.click(),
            className: "editor-btn",
            title: "Open een eerder opgeslagen .json-bestand",
          }, "map openen")
        : null,
      h("input", {
        ref: fileInputRef,
        type: "file",
        accept: ".json,application/json",
        style: { display: "none" },
        onChange: (e) => {
          loadMapFromFile(e.target.files?.[0]);
          e.target.value = ""; // zodat hetzelfde bestand nog eens gekozen kan worden
        },
      })
    ),
    h("div", { className: "editor-status" },
      hint
        ? hint
        : nameIsBlocked && !drawMode
        ? "Deze naam bevat een ongepast woord en wordt niet opgeslagen"
        : drawMode
        ? `Tekenen: klik om punten neer te zetten (${drawPoints.length} geplaatst) · klik bij het startpunt om te sluiten (min. 3 punten)`
        : pendingEdge
          ? "Klik nu op een wand van een andere kamer om te verbinden · Escape om te annuleren"
          : selectedItem
            ? `Item: ${itemTypeOf(selectedItem.type, customTypes)?.label} in ${locations.find((l) => l.id === selectedItem.roomId)?.name ?? "?"} · sleep om te verplaatsen (ook naar een andere kamer) · Delete/Backspace om te verwijderen`
          : selected
            ? `Geselecteerd: ${selected.name} — x:${selected.x} y:${selected.y} · dubbelklik om te hernoemen · sleep een hendel om te vergroten/verkleinen (Shift = verhouding behouden) · pijltjestoetsen om te verplaatsen · Delete/Backspace om te verwijderen`
            : "Klik op een lege plek om te deselecteren · sleep een kamer om hem te verplaatsen · sleep items uit het paneel links een kamer in"
    ),
    h("div", { className: "editor-body" },
    paletteEl,
    h("svg", {
      ref: svgRef,
      className: "editor-svg",
      viewBox: "0 0 700 500",
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerUp,
      onPointerDown: handleCanvasPointerDown,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
      h("defs", null,
        h("pattern", { id: "grid", width: GRID, height: GRID, patternUnits: "userSpaceOnUse" },
          h("path", { d: `M ${GRID} 0 L 0 0 0 ${GRID}`, fill: "none", stroke: "#292524", strokeWidth: "1" })
        )
      ),
      h("rect", { width: "1000", height: "1000", fill: "url(#grid)" }),
      ...connectionEls,
      ...roomEls,
      ...itemEls,
      ...edgeButtonEls,
      ...resizeHandleEls,
      drawPreviewLine,
      ...drawPreviewDots
    )
    )
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(h(MapEditorPOC));
}
