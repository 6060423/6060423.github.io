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
// Het label moet binnen de vorm blijven. We zoeken daarom de grootste
// lettergrootte waarbij de naam past, eventueel verdeeld over meerdere
// regels. Past het zelfs op de kleinste grootte niet, dan wordt de naam
// afgekort met "…" (de volledige naam staat dan in de tooltip).
const LABEL_FONT_FAMILY = "sans-serif";
const LABEL_MAX_FONT = 9;
const LABEL_MIN_FONT = 5;
const LABEL_FONT_STEP = 0.5;
const LABEL_LINE_HEIGHT = 1.2; // regelhoogte als factor van de lettergrootte
const LABEL_MAX_LINES = 3;
const LABEL_PADDING = 3; // minimale ruimte tussen tekst en de rand van de vorm

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
// zoveel mogelijk woorden per regel. Geeft null terug als het niet past.
function wrapIntoLines(loc, cx, cy, fontSize, words, lineCount) {
  const lineHeight = LABEL_LINE_HEIGHT * fontSize;
  const firstY = cy - ((lineCount - 1) * lineHeight) / 2;
  const lines = [];
  let w = 0;
  for (let i = 0; i < lineCount && w < words.length; i++) {
    const y = firstY + i * lineHeight;
    let text = words[w];
    if (!lineFits(loc, cx, y, fontSize, text)) return null;
    w++;
    while (w < words.length && lineFits(loc, cx, y, fontSize, `${text} ${words[w]}`)) {
      text += ` ${words[w]}`;
      w++;
    }
    lines.push({ text, y });
  }
  return w === words.length && lines.length === lineCount ? lines : null;
}

// Bepaalt lettergrootte en regels voor het label van een kamer.
function layoutLabel(loc, cx, cy) {
  const name = loc.name.trim();
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { fontSize: LABEL_MAX_FONT, lines: [] };

  for (let fontSize = LABEL_MAX_FONT; fontSize >= LABEL_MIN_FONT; fontSize -= LABEL_FONT_STEP) {
    for (let lineCount = 1; lineCount <= Math.min(LABEL_MAX_LINES, words.length); lineCount++) {
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

function MapEditorPOC() {
  const [kamer, setKamer] = useState("");
  const [locations, setLocations] = useState(initialLocations);
  const [connections, setConnections] = useState(initialConnections);
  const [selectedId, setSelectedId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [resizing, setResizing] = useState(null); // { id, handle, start } — hendel die je nu versleept
  const [drawMode, setDrawMode] = useState(false);
  const [drawPoints, setDrawPoints] = useState([]); // array van [x, y], absolute SVG-coördinaten
  const [pendingEdge, setPendingEdge] = useState(null); // { locId, edgeIndex } — eerste wand die je hebt aangeklikt
  const svgRef = useRef(null);
  const nameInputRef = useRef(null);

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

  const handlePointerDown = (e, loc) => {
    e.stopPropagation();
    setSelectedId(loc.id);
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    setDragging({ id: loc.id, offsetX: x - loc.x, offsetY: y - loc.y });
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
    if (!dragging) return;
    const { x, y } = toSvgPoint(e.clientX, e.clientY);
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id === dragging.id
          ? { ...loc, x: snap(x - dragging.offsetX), y: snap(y - dragging.offsetY) }
          : loc
      )
    );
  };

  const handlePointerUp = () => {
    setDragging(null);
    setResizing(null);
  };
  const selected = locations.find((l) => l.id === selectedId);

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
  // die verwijst naar een kamer die niet meer bestaat.
  const deleteSelectedRoom = () => {
    if (!selectedId) return;
    setLocations((prev) => prev.filter((loc) => loc.id !== selectedId));
    setConnections((prev) => prev.filter((conn) => conn.from !== selectedId && conn.to !== selectedId));
    setSelectedId(null);
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
  // de kaart blijft staan. Dit gebeurt voor álle kamers, omdat het veld bij
  // het wisselen van selectie al bij de nieuwe kamer hoort.
  const renameSelectedRoom = (name) => {
    setLocations((prev) =>
      prev.map((loc) => (loc.id === selectedId ? { ...loc, name } : loc))
    );
  };

  const finishRenaming = () => {
    setLocations((prev) =>
      prev.some((loc) => loc.name.trim() === "")
        ? prev.map((loc) => (loc.name.trim() === "" ? { ...loc, name: "Naamloze kamer" } : loc))
        : prev
    );
  };

  useEffect(finishRenaming, [selectedId]);

  const moveSelectedRoom = (dx, dy) => {
    setLocations((prev) =>
      prev.map((loc) =>
        loc.id === selectedId ? { ...loc, x: loc.x + dx * GRID, y: loc.y + dy * GRID } : loc
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
  }, [drawMode, selectedId, pendingEdge]);

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
    const shapeClassName = `room-shape${isSelected ? " is-selected" : ""}`;
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
              className: "editor-name-input",
              value: selected.name,
              maxLength: 60,
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
        : null
    ),
    h("div", { className: "editor-status" },
      drawMode
        ? `Tekenen: klik om punten neer te zetten (${drawPoints.length} geplaatst) · klik bij het startpunt om te sluiten (min. 3 punten)`
        : pendingEdge
          ? "Klik nu op een wand van een andere kamer om te verbinden · Escape om te annuleren"
          : selected
            ? `Geselecteerd: ${selected.name} — x:${selected.x} y:${selected.y} · dubbelklik om te hernoemen · sleep een hendel om te vergroten/verkleinen (Shift = verhouding behouden) · pijltjestoetsen om te verplaatsen · Delete/Backspace om te verwijderen`
            : "Klik op een lege plek om te deselecteren · sleep een kamer om hem te verplaatsen"
    ),
    h("svg", {
      ref: svgRef,
      className: "editor-svg",
      viewBox: "0 0 700 500",
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerUp,
      onPointerDown: handleCanvasPointerDown,
    },
      h("defs", null,
        h("pattern", { id: "grid", width: GRID, height: GRID, patternUnits: "userSpaceOnUse" },
          h("path", { d: `M ${GRID} 0 L 0 0 0 ${GRID}`, fill: "none", stroke: "#292524", strokeWidth: "1" })
        )
      ),
      h("rect", { width: "1000", height: "1000", fill: "url(#grid)" }),
      ...connectionEls,
      ...roomEls,
      ...edgeButtonEls,
      ...resizeHandleEls,
      drawPreviewLine,
      ...drawPreviewDots
    )
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(h(MapEditorPOC));
}
