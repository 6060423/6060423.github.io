import React from "https://esm.sh/react@18.2.0";
import { createRoot } from "https://esm.sh/react-dom@18.2.0/client";


const { useState, useRef, useCallback, useEffect, createElement: h } = React;
const initialLocations = [];
const initialConnections = [];

const GRID = 10;
const snap = (v) => Math.round(v / GRID) * GRID;

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
    return [
      { mid: [loc.x, loc.y - loc.radius] },
      { mid: [loc.x + loc.radius, loc.y] },
      { mid: [loc.x, loc.y + loc.radius] },
      { mid: [loc.x - loc.radius, loc.y] },
    ];
  }
  return [];
}

function MapEditorPOC() {
  const [kamer, setKamer] = useState("");
  const [locations, setLocations] = useState(initialLocations);
  const [connections, setConnections] = useState(initialConnections);
  const [selectedId, setSelectedId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [drawMode, setDrawMode] = useState(false);
  const [drawPoints, setDrawPoints] = useState([]); // array van [x, y], absolute SVG-coördinaten
  const [pendingEdge, setPendingEdge] = useState(null); // { locId, edgeIndex } — eerste wand die je hebt aangeklikt
  const svgRef = useRef(null);

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

  const handlePointerMove = (e) => {
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

  const handlePointerUp = () => setDragging(null);
  const selected = locations.find((l) => l.id === selectedId);

  // Live preview terwijl je tekent: lijn tussen de al geplaatste punten,
  // en een cirkeltje op elk punt (het eerste punt iets groter/anders
  // gekleurd, zodat je ziet waar je moet klikken om de vorm te sluiten).
  const drawPreviewLine = drawPoints.length >= 2
    ? h("polyline", {
        points: drawPoints.map(([px, py]) => `${px},${py}`).join(" "),
        fill: "none", stroke: "#ee5c22", strokeWidth: "2", strokeDasharray: "4 4",
      })
    : null;

  const drawPreviewDots = drawPoints.map(([px, py], i) =>
    h("circle", {
      key: `drawpoint_${i}`,
      cx: px, cy: py, r: i === 0 ? 6 : 4,
      fill: i === 0 ? "#ee2222" : "#ee6d22",
      stroke: "#000000", strokeWidth: "1.5",
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
  const SQUARE_SIZE = 80;
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
  useEffect(() => {
    const onKeyDown = (e) => {
      if (drawMode) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelectedRoom();
      }
      if (e.key === "Escape" && pendingEdge) {
        setPendingEdge(null);
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
  // (hitArea) maakt dat makkelijker te raken dan de dunne zichtbare lijn.
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
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: "transparent", strokeWidth: "14",
        style: { cursor: "pointer" },
        onPointerDown: (e) => {
          e.stopPropagation();
          deleteConnection(conn.id);
        },
      }),
      h("line", {
        key: conn.id,
        x1: a[0], y1: a[1], x2: b[0], y2: b[1],
        stroke: "#57534e", strokeWidth: "3", strokeDasharray: "2 6", strokeLinecap: "round",
        style: { pointerEvents: "none" },
      }),
    ];
  });


  const roomEls = locations.map((loc) => {
    const isSelected = loc.id === selectedId;
    // Achtergrond blijft altijd wit, ook bij selectie — alleen de rand
    // (stroke) verandert nog van kleur om te laten zien dat iets
    // geselecteerd is.
    const fill = "#ffffff";
    const stroke = isSelected ? "#ea580c" : "#57534e";
    const strokeWidth = isSelected ? 2 : 1.5;
    const { centerX, centerY } = boundsOf(loc);

    let shapeEl;
    if (loc.shape === "polygon") {
      shapeEl = h("polygon", {
        points: loc.points.map(([px, py]) => `${loc.x + px},${loc.y + py}`).join(" "),
        fill, stroke, strokeWidth, strokeLinejoin: "round",
      });
    } else if (loc.shape === "circle") {
      shapeEl = h("circle", { cx: loc.x, cy: loc.y, r: loc.radius, fill, stroke, strokeWidth });
    } else {
      shapeEl = h("rect", { x: loc.x, y: loc.y, width: loc.width, height: loc.height, rx: 4, fill, stroke, strokeWidth });
    }

    const label = h("text", {
      x: centerX, y: centerY, textAnchor: "middle", dominantBaseline: "middle",
      fill: "orange", fontSize: "9", style: { pointerEvents: "none" },
    }, loc.name);

    return h("g", {
      key: loc.id,
      onPointerDown: (e) => handlePointerDown(e, loc),
      style: { cursor: dragging?.id === loc.id ? "grabbing" : "grab" },
    }, shapeEl, label);
  });

  // Eén "+"-knopje per wand van elke kamer. Niet zichtbaar tijdens het
  // tekenen. De wand die als eerste is aangeklikt (pendingEdge) licht op
  // in een andere kleur, zodat je ziet dat hij op zijn "partner" wacht.
  const edgeButtonEls = [];
  if (!drawMode) {
    locations.forEach((loc) => {
      edgesOf(loc).forEach((edge, edgeIndex) => {
        const isPending = pendingEdge && pendingEdge.locId === loc.id && pendingEdge.edgeIndex === edgeIndex;
        const [mx, my] = edge.mid;

        edgeButtonEls.push(
          h("g", {
            key: `edgebtn_${loc.id}_${edgeIndex}`,
            onPointerDown: (e) => handleEdgeClick(loc.id, edgeIndex, e),
            style: { cursor: "pointer" },
          },
            h("circle", {
              cx: mx, cy: my, r: 6,
              fill: isPending ? "#0e7490" : "#1c1917",
              stroke: isPending ? "#22d3ee" : "#57534e",
              strokeWidth: "1.5",
            }),
            h("text", {
              x: mx, y: my, textAnchor: "middle", dominantBaseline: "middle",
              fill: isPending ? "#e0f7fa" : "#a8a29e", fontSize: "9",
              style: { pointerEvents: "none" },
            }, "+")
          )
        );
      });
    });
  }

  return h("div", { className: "w-full h-full min-h-[520px] bg-stone-950 flex flex-col font-sans" },
    h("div", { className: "px-4 py-3 border-b border-stone-800 flex items-center justify-end gap-2" },
      selected && !drawMode
        ? h("button", {
            onClick: deleteSelectedRoom,
            className: "text-xs px-2 py-1 rounded border border-red-800 text-red-300 hover:bg-red-950",
          }, "Verwijder kamer")
        : null,
      drawMode
        ? h("button", {
            onClick: cancelDrawing,
            className: "text-xs px-2 py-1 rounded border border-cyan-700 text-cyan-300 hover:bg-cyan-950",
          }, "Annuleer tekenen")
        : h("button", {
            onClick: () => setDrawMode(true),
            className: "text-xs px-2 py-1 rounded border border-stone-600 text-stone-300 hover:bg-stone-800",
          }, "+ Kamer tekenen"),
      !drawMode
        ? h("button", {
            onClick: addSquareRoom,
            className: "text-xs px-2 py-1 rounded border border-stone-600 text-stone-300 hover:bg-stone-800",
          }, "+ Vierkant")
        : null
    ),
    h("div", { className: "px-4 py-2 border-b border-stone-800 text-xs text-stone-500" },
      drawMode
        ? `Tekenen: klik om punten neer te zetten (${drawPoints.length} geplaatst) · klik bij het startpunt om te sluiten (min. 3 punten)`
        : pendingEdge
          ? "Klik nu op een wand van een andere kamer om te verbinden · Escape om te annuleren"
          : selected
            ? `Selected: ${selected.name} — x:${selected.x} y:${selected.y} · Delete/Backspace om te verwijderen`
            : "Click empty space to deselect · drag a room to move it"
    ),
    h("svg", {
      ref: svgRef,
      className: "flex-1 w-full touch-none select-none",
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
      drawPreviewLine,
      ...drawPreviewDots
    )
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(h(MapEditorPOC));
}
