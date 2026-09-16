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

function MapEditorPOC() {
  const [kamer, setKamer] = useState("");
  const [locations, setLocations] = useState(initialLocations);
  const [connections, setConnections] = useState(initialConnections);
  const [selectedId, setSelectedId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [drawMode, setDrawMode] = useState(false);
  const [drawPoints, setDrawPoints] = useState([]); // array van [x, y], absolute SVG-coördinaten
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
        fill: "none", stroke: "#22d3ee", strokeWidth: "2", strokeDasharray: "4 4",
      })
    : null;

  const drawPreviewDots = drawPoints.map(([px, py], i) =>
    h("circle", {
      key: `drawpoint_${i}`,
      cx: px, cy: py, r: i === 0 ? 6 : 4,
      fill: i === 0 ? "#22d3ee" : "#0e7490",
      stroke: "#083344", strokeWidth: "1.5",
    })
  );

  // Klik ergens leeg op de svg: normaal deselecteert dit, maar in teken-modus
  // zet dit een nieuw punt neer (gesnapt aan de grid).
  const handleCanvasPointerDown = (e) => {
    if (!drawMode) {
      setSelectedId(null);
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

  // Verwijdert de geselecteerde kamer, en ook alle connections die naar
  // (of vanaf) die kamer verwezen — anders blijft er een "dode" lijn hangen
  // die verwijst naar een kamer die niet meer bestaat.
  const deleteSelectedRoom = () => {
    if (!selectedId) return;
    setLocations((prev) => prev.filter((loc) => loc.id !== selectedId));
    setConnections((prev) => prev.filter((conn) => conn.from !== selectedId && conn.to !== selectedId));
    setSelectedId(null);
  };

  // Delete/Backspace verwijdert de geselecteerde kamer, behalve tijdens het
  // tekenen (dan zou dat verwarrend zijn met het annuleren van punten).
  useEffect(() => {
    const onKeyDown = (e) => {
      if (drawMode) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        deleteSelectedRoom();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawMode, selectedId]);

  // Connections als <line> elementen
  const connectionEls = connections.map((conn) => {
    const from = locations.find((l) => l.id === conn.from);
    const to = locations.find((l) => l.id === conn.to);
    if (!from || !to) return null;
    const a = boundsOf(from);
    const b = boundsOf(to);
    return h("line", {
      key: conn.id,
      x1: a.centerX, y1: a.centerY, x2: b.centerX, y2: b.centerY,
      stroke: "#57534e", strokeWidth: "3", strokeDasharray: "2 6", strokeLinecap: "round",
    });
  });


  const roomEls = locations.map((loc) => {
    const isSelected = loc.id === selectedId;
    const fill = isSelected ? "#7c2d12" : "#1c1917";
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
      fill: "red", fontSize: "9", style: { pointerEvents: "none" },
    }, loc.name);

    return h("g", {
      key: loc.id,
      onPointerDown: (e) => handlePointerDown(e, loc),
      style: { cursor: dragging?.id === loc.id ? "grabbing" : "grab" },
    }, shapeEl, label);
  });

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
          }, "+ Kamer tekenen")
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
      drawPreviewLine,
      ...drawPreviewDots
    ),
    h("div", { className: "px-4 py-2 border-t border-stone-800 text-xs text-stone-500" },
      drawMode
        ? `Tekenen: klik om punten neer te zetten (${drawPoints.length} geplaatst) · klik bij het startpunt om te sluiten (min. 3 punten)`
        : selected
          ? `Selected: ${selected.name} — x:${selected.x} y:${selected.y} · Delete/Backspace om te verwijderen`
          : "Click empty space to deselect · drag a room to move it"
    )
  );
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(h(MapEditorPOC));
}
