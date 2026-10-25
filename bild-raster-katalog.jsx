import React, { useState, useEffect, useRef } from 'react';
import { Upload, Save, Trash2, Puzzle, ImageOff, Loader2, Search } from 'lucide-react';

const STORAGE_KEY = 'bild-raster-katalog-projekt';
const MAX_DIM = 1400;
const MAX_FIELDS = 20000;

// ---- Abgleich: Teil im ganzen Bild suchen (maskierte normierte Korrelation, Maßstab + beliebige Drehung) ----
// Das Teil (mit Transparenz als Maske) wird in drei Stufen (grob → mittel → fein) über das Bild geschoben.
// Verglichen wird die Helligkeitsstruktur (ZNCC, unempfindlich gegen Helligkeit/Kontrast), am Ende zusätzlich
// je Farbkanal. Das Ergebnis ist die genaue Lage (Position, Drehung) und das Rasterfeld darunter.
const TOP_N = 3; // so viele Rasterfelder werden als mögliche Treffer angezeigt
const COARSE_BODY = 10, MID_BODY = 20, FINE_BODY = 40; // Größe des Teilkörpers (px) je Stufe
const COARSE_STEP = 6; // Winkelschritt der groben Suche (°)
const COARSE_SCALES = [0.82, 1, 1.22]; // Maßstäbe relativ zur Schätzung (Teilkörper ≈ ein Rasterfeld)
const COARSE_STRIDE = 2; // Positionsraster der groben Suche
const DETAIL_STD = 20; // Teil gilt als zu einfarbig, wenn der Farbunterschied im Teil (siehe pieceDetail) unter diesem Wert liegt
const PEAKS = 40; // so viele Kandidaten werden verfeinert
const MIN_STD = 3; // Helligkeitsstreuung, unter der Teil/Bildausschnitt als einfarbig gilt

const tileName = (row, col) => 'Z' + (row + 1) + ' / S' + (col + 1);

// Teilkörper ohne Zapfen: Spalten/Zeilen mit deutlich weniger deckenden Pixeln als der Rest sind Zapfen
function bodyBox(el) {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(el, 0, 0, S, S);
  const d = cx.getImageData(0, 0, S, S).data;
  const col = new Int32Array(S), row = new Int32Array(S);
  let opaque = 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    if (d[(y * S + x) * 4 + 3] >= 128) { col[x]++; row[y]++; opaque++; }
  }
  if (opaque > S * S * 0.97) return null; // kein Freisteller (keine Transparenz)
  let maxC = 0, maxR = 0;
  for (let i = 0; i < S; i++) { if (col[i] > maxC) maxC = col[i]; if (row[i] > maxR) maxR = row[i]; }
  let x0 = 0, x1 = S - 1, y0 = 0, y1 = S - 1;
  while (x0 < S - 1 && col[x0] < maxC * 0.6) x0++;
  while (x1 > x0 && col[x1] < maxC * 0.6) x1--;
  while (y0 < S - 1 && row[y0] < maxR * 0.6) y0++;
  while (y1 > y0 && row[y1] < maxR * 0.6) y1--;
  if (x1 - x0 < S * 0.3 || y1 - y0 < S * 0.3) return null;
  return { x: x0 / S * el.width, y: y0 / S * el.height, w: (x1 - x0 + 1) / S * el.width, h: (y1 - y0 + 1) / S * el.height };
}

// Farbunterschied im freigestellten Teil: robuste Streuung (Abstand zwischen dem 10. und 90. Perzentil, auf Standardabweichung
// umgerechnet) je Farbkanal im Teilinneren, größter Kanal zählt. Randpixel (Kante, Schatten, Hintergrundreste) sind ausgespart,
// einzelne Ausreißer (Glanzpunkte) zählen kaum. Klein = einfarbige Fläche, die sich nicht zuverlässig im Bild finden lässt.
function pieceDetail(el) {
  const k = 96 / Math.max(el.width, el.height);
  const W = Math.max(8, Math.round(el.width * k)), H = Math.max(8, Math.round(el.height * k));
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(el, 0, 0, W, H);
  const d = cx.getImageData(0, 0, W, H).data;
  const R = 4;
  const solid = (x, y) => x >= 0 && y >= 0 && x < W && y < H && d[(y * W + x) * 4 + 3] >= 250;
  const inner = (x, y) => solid(x, y) && solid(x - R, y) && solid(x + R, y) && solid(x, y - R) && solid(x, y + R);
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let n = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inner(x, y)) continue;
      const i = (y * W + x) * 4;
      n++;
      for (let c = 0; c < 3; c++) hist[c][d[i + c]]++;
    }
  }
  if (n < 30) return { std: 0, n };
  const pct = (h, p) => { let acc = 0; const t = p * n; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= t) return v; } return 255; };
  let std = 0;
  for (let c = 0; c < 3; c++) std = Math.max(std, (pct(hist[c], 0.9) - pct(hist[c], 0.1)) / 2.563);
  return { std, n };
}

const yieldUI = () => new Promise((r) => setTimeout(r, 0));

// Bild als Farbebenen (R, G, B) mit Faktor f verkleinert und mit Randfortsetzung (pad)
function makePlanes(imgEl, f, pad) {
  const w = Math.max(1, Math.round(imgEl.width / f)), h = Math.max(1, Math.round(imgEl.height / f));
  const Wp = w + 2 * pad, Hp = h + 2 * pad;
  const cv = document.createElement('canvas');
  cv.width = Wp;
  cv.height = Hp;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(imgEl, 0, 0, imgEl.width, imgEl.height, pad, pad, w, h);
  if (pad > 0) {
    cx.drawImage(cv, pad, pad, 1, h, 0, pad, pad, h);
    cx.drawImage(cv, pad + w - 1, pad, 1, h, pad + w, pad, pad, h);
    cx.drawImage(cv, 0, pad, Wp, 1, 0, 0, Wp, pad);
    cx.drawImage(cv, 0, pad + h - 1, Wp, 1, 0, pad + h, Wp, pad);
  }
  const d = cx.getImageData(0, 0, Wp, Hp).data;
  const n = Wp * Hp;
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) { R[i] = d[p]; G[i] = d[p + 1]; B[i] = d[p + 2]; }
  return { w, h, Wp, Hp, pad, f, P: [R, G, B] };
}

// Vorlage: das Teil mit Maßstab scale (Bildpixel je Teilpixel) und Drehung angle (°), bei Auflösungsfaktor f.
// Nur deckende Pixel zählen (Maske); je Farbkanal mittelwertfrei, damit die Korrelation ein Skalarprodukt ist.
function makeTemplate(pieceEl, scale, angle, f, erode) {
  const pw = pieceEl.width, ph = pieceEl.height;
  const k = scale / f;
  const D = Math.ceil(Math.hypot(pw, ph) * k) + 4;
  const cv = document.createElement('canvas');
  cv.width = D;
  cv.height = D;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.translate(D / 2, D / 2);
  cx.rotate(angle * Math.PI / 180);
  cx.scale(k, k);
  cx.drawImage(pieceEl, -pw / 2, -ph / 2);
  const d = cx.getImageData(0, 0, D, D).data;
  const solid = new Uint8Array(D * D);
  for (let i = 0; i < D * D; i++) solid[i] = d[i * 4 + 3] >= 250 ? 1 : 0;
  const idx = [];
  for (let y = 0; y < D; y++) {
    for (let x = 0; x < D; x++) {
      const i = y * D + x;
      if (!solid[i]) continue;
      if (erode && (x === 0 || y === 0 || x === D - 1 || y === D - 1 || !solid[i - 1] || !solid[i + 1] || !solid[i - D] || !solid[i + D])) continue;
      idx.push(i);
    }
  }
  const n = idx.length;
  if (n < 12) return null;
  const c0 = D >> 1;
  const dx = new Int16Array(n), dy = new Int16Array(n);
  const v = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const sum = [0, 0, 0];
  for (let m = 0; m < n; m++) {
    const i = idx[m];
    dx[m] = (i % D) - c0;
    dy[m] = ((i / D) | 0) - c0;
    for (let c = 0; c < 3; c++) { v[c][m] = d[i * 4 + c]; sum[c] += v[c][m]; }
  }
  const norm = [0, 0, 0];
  let maxStd = 0;
  for (let c = 0; c < 3; c++) {
    const mean = sum[c] / n;
    let q = 0;
    for (let m = 0; m < n; m++) { v[c][m] -= mean; q += v[c][m] * v[c][m]; }
    norm[c] = q;
    maxStd = Math.max(maxStd, Math.sqrt(q / n));
  }
  if (maxStd < MIN_STD) return null; // Teil zu einfarbig für einen Strukturvergleich
  return { n, dx, dy, v, norm, off: null, offW: -1 };
}

function bindOffsets(t, Wp) {
  if (t.offW === Wp) return;
  t.off = new Int32Array(t.n);
  for (let i = 0; i < t.n; i++) t.off[i] = t.dy[i] * Wp + t.dx[i];
  t.offW = Wp;
}

// Korrelation (ZNCC) der Vorlage mit dem Bildausschnitt um Ebenenindex p: Mittel über die Farbkanäle mit Struktur
function znccAt(P, t, p) {
  const off = t.off, n = t.n;
  let sum = 0, cnt = 0;
  for (let c = 0; c < 3; c++) {
    if (t.norm[c] < n * 2.25) continue; // Kanal ohne Struktur (Streuung < 1,5)
    const I = P[c], tv = t.v[c];
    let sI = 0, sII = 0, sIT = 0;
    for (let k = 0; k < n; k++) {
      const x = I[p + off[k]];
      sI += x; sII += x * x; sIT += tv[k] * x;
    }
    const varI = sII - sI * sI / n;
    sum += varI < n * 2.25 ? 0 : sIT / Math.sqrt(varI * t.norm[c]);
    cnt++;
  }
  return cnt ? sum / cnt : 0;
}

// Eine Verfeinerungsstufe: um die Lage (x, y in Bildpixeln, Drehung a, Maßstab s) in kleinen Schritten suchen
function refinePose(pieceEl, pl, pose, angles, scales, radius, erode) {
  const f = pl.f, Wp = pl.Wp;
  const cx = Math.round(pose.x / f + pl.pad - 0.5), cy = Math.round(pose.y / f + pl.pad - 0.5);
  let best = null;
  for (const da of angles) {
    for (const ds of scales) {
      const a = pose.a + da, s = pose.s * ds;
      const t = makeTemplate(pieceEl, s, a, f, erode);
      if (!t) continue;
      bindOffsets(t, Wp);
      for (let yy = Math.max(pl.pad, cy - radius); yy <= Math.min(pl.pad + pl.h - 1, cy + radius); yy++) {
        for (let xx = Math.max(pl.pad, cx - radius); xx <= Math.min(pl.pad + pl.w - 1, cx + radius); xx++) {
          const sc = znccAt(pl.P, t, yy * Wp + xx);
          if (!best || sc > best.score) best = { score: sc, x: (xx - pl.pad + 0.5) * f, y: (yy - pl.pad + 0.5) * f, a, s, t, p: yy * Wp + xx };
        }
      }
    }
  }
  return best;
}

// Teil im Bild suchen. Ergebnis: { cells: [{name,row,col,score,x,y,angle}], pose: {x,y,angle,w,h} } (Bildpixel)
async function locateCore(pieceEl, imgEl, rows, cols, onProgress) {
  const cellW = imgEl.width / cols, cellH = imgEl.height / rows, cellMin = Math.min(cellW, cellH);
  const pw = pieceEl.width, ph = pieceEl.height;
  const body = bodyBox(pieceEl) || { x: 0, y: 0, w: pw, h: ph };
  // Annahme: der Teilkörper (ohne Zapfen) entspricht etwa einem Rasterfeld
  const s0 = Math.sqrt((cellW / body.w) * (cellH / body.h));
  const bodyOff = { x: body.x + body.w / 2 - pw / 2, y: body.y + body.h / 2 - ph / 2 }; // Körpermitte relativ zur Teilmitte
  const half = 0.5 * Math.hypot(pw, ph) * s0 * 1.4; // größte Halbdiagonale in Bildpixeln
  const fC = Math.max(1, cellMin / COARSE_BODY), fM = Math.max(1, cellMin / MID_BODY), fF = Math.max(1, cellMin / FINE_BODY);
  const pad = (f) => Math.ceil(half / f) + 3;

  // --- Stufe 1: grob, alle Positionen, Maßstäbe und Drehungen ---
  const plC = makePlanes(imgEl, fC, pad(fC));
  const mw = Math.ceil(plC.w / COARSE_STRIDE), mh = Math.ceil(plC.h / COARSE_STRIDE);
  const bestSc = new Float32Array(mw * mh).fill(-1), bestA = new Float32Array(mw * mh), bestS = new Float32Array(mw * mh);
  const nAng = Math.ceil(360 / COARSE_STEP), total = nAng * COARSE_SCALES.length;
  let done = 0;
  for (const sf of COARSE_SCALES) {
    for (let ai = 0; ai < nAng; ai++, done++) {
      const a = ai * COARSE_STEP;
      const t = makeTemplate(pieceEl, s0 * sf, a, fC, false);
      if (t) {
        bindOffsets(t, plC.Wp);
        for (let my = 0; my < mh; my++) {
          const row = (plC.pad + my * COARSE_STRIDE) * plC.Wp + plC.pad;
          for (let mx = 0; mx < mw; mx++) {
            const sc = znccAt(plC.P, t, row + mx * COARSE_STRIDE);
            const i = my * mw + mx;
            if (sc > bestSc[i]) { bestSc[i] = sc; bestA[i] = a; bestS[i] = s0 * sf; }
          }
        }
      }
      if (ai % 6 === 5) { if (onProgress) onProgress(done / total * 0.8); await yieldUI(); }
    }
  }
  // Kandidaten: beste Positionen, nicht zu nah beieinander
  const order = Array.from(bestSc.keys()).filter((i) => bestSc[i] > 0).sort((p, q) => bestSc[q] - bestSc[p]);
  const minDist = Math.max(2, 0.6 * cellMin / (fC * COARSE_STRIDE));
  const cand = [];
  for (const i of order) {
    const mx = i % mw, my = (i / mw) | 0;
    if (cand.every((c) => Math.hypot(c.mx - mx, c.my - my) >= minDist)) {
      cand.push({ mx, my, x: (mx * COARSE_STRIDE + 0.5) * fC, y: (my * COARSE_STRIDE + 0.5) * fC, a: bestA[i], s: bestS[i] });
      if (cand.length >= PEAKS) break;
    }
  }

  // --- Stufe 2 und 3: mittel und fein verfeinern ---
  const plM = makePlanes(imgEl, fM, pad(fM));
  const plF = makePlanes(imgEl, fF, pad(fF));
  const rM = Math.ceil(fC * (COARSE_STRIDE / 2 + 1) / fM), rF = Math.ceil(fM * 1.5 / fF) + 1;
  const found = [];
  for (let ci = 0; ci < cand.length; ci++) {
    const c = cand[ci];
    const m = refinePose(pieceEl, plM, c, [-6, -3, 0, 3, 6], [0.93, 1, 1.07], rM, false);
    if (m) {
      const f = refinePose(pieceEl, plF, { x: m.x, y: m.y, a: m.a, s: m.s }, [-2, -1, 0, 1, 2], [0.97, 1, 1.03], rF, true);
      if (f) {
        found.push({ x: f.x, y: f.y, a: f.a, s: f.s, score: Math.max(0, Math.min(1, f.score)) });
      }
    }
    if (ci % 5 === 4) { if (onProgress) onProgress(0.8 + 0.2 * ci / cand.length); await yieldUI(); }
  }
  found.sort((p, q) => q.score - p.score);

  // Rasterfeld je Fund: unter der Körpermitte des Teils; je Feld zählt der beste Fund
  const cells = new Map();
  for (const r of found) {
    const rad = r.a * Math.PI / 180, ox = bodyOff.x * r.s, oy = bodyOff.y * r.s;
    const bx = r.x + ox * Math.cos(rad) - oy * Math.sin(rad), by = r.y + ox * Math.sin(rad) + oy * Math.cos(rad);
    const col = Math.max(0, Math.min(cols - 1, Math.floor(bx / cellW))), row = Math.max(0, Math.min(rows - 1, Math.floor(by / cellH)));
    const name = tileName(row, col);
    if (!cells.has(name)) cells.set(name, { name, row, col, score: r.score, x: r.x, y: r.y, angle: r.a });
  }
  const best = found[0];
  return {
    cells: Array.from(cells.values()).slice(0, TOP_N),
    pose: best ? { x: best.x, y: best.y, angle: best.a, w: pw * best.s, h: ph * best.s } : null,
  };
}

// Einstieg: erst den Farbunterschied prüfen (zu einfarbige Teile lassen sich nicht finden), dann suchen.
async function locatePiece(pieceEl, imgEl, rows, cols, onProgress) {
  const det = pieceDetail(pieceEl);
  if (det.std < DETAIL_STD) {
    return {
      cells: [], pose: null, detail: det.std,
      error: 'Keine Suche möglich: Das Teil hat zu wenig Farbunterschied (fast einfarbig; gemessen ' + Math.round(det.std) + ', nötig mindestens ' + DETAIL_STD + '). Bitte ein anderes Teil wählen oder das Foto besser ausleuchten.',
    };
  }
  const res = await locateCore(pieceEl, imgEl, rows, cols, onProgress);
  return { ...res, detail: det.std };
}
// ---- Ende Abgleich ----

// Bild eines Container-Elements (das ausgeschnittene Stück) als kleine Vorschau
function tileThumb(gridEl, row, col, rows, cols) {
  const cellW = gridEl.width / cols, cellH = gridEl.height / rows;
  const k = 96 / Math.max(cellW, cellH);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(cellW * k));
  cv.height = Math.max(1, Math.round(cellH * k));
  cv.getContext('2d').drawImage(gridEl, col * cellW, row * cellH, cellW, cellH, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', 0.85);
}
const loadImage = (src) => new Promise((resolve, reject) => {
  const im = new window.Image();
  im.onload = () => resolve(im);
  im.onerror = reject;
  im.src = src;
});

export default function PuzzleApp() {
  const [imageSrc, setImageSrc] = useState(null);
  const [imgDims, setImgDims] = useState({ w: 0, h: 0 });
  const [xCount, setXCount] = useState(40); // Zeilen
  const [yCount, setYCount] = useState(50); // Spalten
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [activeCell, setActiveCell] = useState(null); // {row,col}
  const [pieceSrc, setPieceSrc] = useState(null);
  const [matches, setMatches] = useState([]); // [{name,row,col,score}] – die TOP_N besten Felder, absteigend
  const [searching, setSearching] = useState(false);
  const [searchInfo, setSearchInfo] = useState('');
  const [searchErr, setSearchErr] = useState(false); // searchInfo ist eine Fehlermeldung
  const [pose, setPose] = useState(null); // genaue Lage des Teils im Bild (Bruchteile der Bildgröße)
  const [pieceBusy, setPieceBusy] = useState(false); // Teil wird gerade freigestellt

  const fileInputRef = useRef(null);
  const pieceInputRef = useRef(null);
  const imageWrapperRef = useRef(null);
  const highlightRef = useRef(null);
  const scrollRef = useRef(null);
  const poseRef = useRef(null);
  const focusPoseRef = useRef(false); // nach der Suche auf die gefundene Lage zoomen/scrollen
  const scrollOnSelectRef = useRef(false); // nach Klick auf die Liste das Feld in den sichtbaren Bereich scrollen
  const [zoom, setZoom] = useState(1);
  const [wrapSize, setWrapSize] = useState({ w: 0, h: 0 });
  const searchRunRef = useRef(0); // erhöht sich bei jeder Änderung, die ein laufendes Suchergebnis ungültig macht

  useEffect(() => {
    (async () => {
      try {
        const result = await window.storage.get(STORAGE_KEY, false);
        if (result && result.value) {
          const data = JSON.parse(result.value);
          setImageSrc(data.imageSrc || null);
          setImgDims(data.imgDims || { w: 0, h: 0 });
          setXCount(data.xCount || 40);
          setYCount(data.yCount || 50);
          setGenerated(Boolean(data.imageSrc));
          setPieceSrc(data.pieceSrc || null);
        }
      } catch (e) {
        // kein gespeichertes Projekt vorhanden
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const total = xCount * yCount;

  // Größe des Bildes beobachten (ändert sich mit Zoom/Fenster); davon hängt ab, ob Rangnummern in die Felder passen
  useEffect(() => {
    const node = imageWrapperRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => setWrapSize({ w: node.clientWidth, h: node.clientHeight }));
    ro.observe(node);
    return () => ro.disconnect();
  }, [generated, loading]);

  // Zoom: Bildmitte beibehalten
  function changeZoom(delta) {
    const steps = [1, 1.5, 2, 3, 4];
    const i = Math.max(0, Math.min(steps.length - 1, steps.indexOf(zoom) + delta));
    const sc = scrollRef.current;
    const cx = sc ? (sc.scrollLeft + sc.clientWidth / 2) / sc.scrollWidth : 0;
    const cy = sc ? (sc.scrollTop + sc.clientHeight / 2) / sc.scrollHeight : 0;
    setZoom(steps[i]);
    requestAnimationFrame(() => {
      if (!sc) return;
      sc.scrollLeft = cx * sc.scrollWidth - sc.clientWidth / 2;
      sc.scrollTop = cy * sc.scrollHeight - sc.clientHeight / 2;
    });
  }

  // Nach der Suche: 400 % Vergrößerung, die gefundene Lage in der Mitte des Ausschnitts
  useEffect(() => {
    if (focusPoseRef.current && pose && zoom === 4 && poseRef.current && scrollRef.current) {
      const pr = poseRef.current.getBoundingClientRect(), sr = scrollRef.current.getBoundingClientRect();
      scrollRef.current.scrollLeft += pr.left + pr.width / 2 - (sr.left + sr.width / 2);
      scrollRef.current.scrollTop += pr.top + pr.height / 2 - (sr.top + sr.height / 2);
      focusPoseRef.current = false;
    }
  }, [pose, zoom]);

  useEffect(() => {
    if (scrollOnSelectRef.current && activeCell && highlightRef.current) {
      highlightRef.current.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    }
    scrollOnSelectRef.current = false;
  }, [activeCell]);

  function handleFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new window.Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        setImageSrc(canvas.toDataURL('image/jpeg', 0.85));
        setImgDims({ w, h });
        setGenerated(false);
        setStatusMsg('');
        setActiveCell(null);
        setMatches([]);
    setPose(null);
        setSearchInfo('');
        searchRunRef.current++;
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  // Freistellen: Der Hintergrund wird von den Bildrändern aus per Flood-Fill entfernt (folgt auch
  // weichen Verläufen/Schatten). Übrig bleibt die größte zusammenhängende Fläche (Löcher gefüllt),
  // die Kante wird geglättet und als echte Transparenz (Alpha) ausgegeben.
  function removeBackground(srcEl) {
    const WORK = MAX_DIM; // volle (bereits verkleinerte) Auflösung, keine zusätzliche Verkleinerung
    const scale = Math.min(1, WORK / Math.max(srcEl.width, srcEl.height));
    const cw = Math.max(1, Math.round(srcEl.width * scale));
    const ch = Math.max(1, Math.round(srcEl.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(srcEl, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    const N = cw * ch;
    const fail = { canvas, cropped: false };
    if (cw < 8 || ch < 8) return fail;

    // 1) Hintergrundfarbe = Median des Randstreifens (robust, auch wenn das Teil den Rand berührt)
    const border = Math.max(2, Math.round(Math.min(cw, ch) * 0.03));
    const eachBorder = (fn) => {
      for (let y = 0; y < ch; y++) {
        if (y < border || y >= ch - border) {
          for (let x = 0; x < cw; x++) fn(y * cw + x);
        } else {
          for (let x = 0; x < border; x++) fn(y * cw + x);
          for (let x = cw - border; x < cw; x++) fn(y * cw + x);
        }
      }
    };
    const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    let cnt = 0;
    eachBorder((i) => {
      const p = i * 4;
      hist[0][data[p]]++; hist[1][data[p + 1]]++; hist[2][data[p + 2]]++;
      cnt++;
    });
    const median = (h) => {
      let acc = 0;
      for (let v = 0; v < 256; v++) { acc += h[v]; if (acc * 2 >= cnt) return v; }
      return 255;
    };
    const bgR = median(hist[0]), bgG = median(hist[1]), bgB = median(hist[2]);

    // 2) Farbabstand jedes Pixels zum Hintergrund; Toleranz passt sich der Streuung am Rand an
    const dist = new Float32Array(N);
    for (let i = 0, p = 0; i < N; i++, p += 4) {
      const dr = data[p] - bgR, dg = data[p + 1] - bgG, db = data[p + 2] - bgB;
      dist[i] = Math.sqrt(dr * dr + dg * dg + db * db);
    }
    let dsum = 0, dn = 0;
    eachBorder((i) => { if (dist[i] < 60) { dsum += dist[i]; dn++; } });
    const sigma = dn ? dsum / dn : 0;
    const tLow = Math.min(48, Math.max(18, sigma * 2 + 12)); // sicher Hintergrund
    const tMid = tLow * 2.2; // Hintergrund nur, wenn der Übergang zum Nachbarpixel weich ist
    const STEP2 = 7 * 7;
    // Schatten: ähnliche Farbtönung wie der Hintergrund, nur dunkler; Übergänge zum Nachbarpixel
    // sind weich (Schattenverlauf), am Teilrand dagegen hart – dort stoppt die Ausbreitung
    const bgLen = Math.sqrt(bgR * bgR + bgG * bgG + bgB * bgB) || 1;
    const bgUR = bgR / bgLen, bgUG = bgG / bgLen, bgUB = bgB / bgLen;
    const SHADOW_STEP2 = 22 * 22;

    // 3) Flood-Fill vom Bildrand: nur mit dem Rand verbundener Hintergrund wird entfernt
    const isBg = new Uint8Array(N);
    const queue = new Int32Array(N);
    const runFlood = (useShadow) => {
      isBg.fill(0);
      let qh = 0, qt = 0;
      const seed = (i) => { if (!isBg[i] && dist[i] <= tLow) { isBg[i] = 1; queue[qt++] = i; } };
      for (let x = 0; x < cw; x++) { seed(x); seed((ch - 1) * cw + x); }
      for (let y = 0; y < ch; y++) { seed(y * cw); seed(y * cw + cw - 1); }
      const grow = (ni, p) => {
        if (isBg[ni]) return;
        const d = dist[ni];
        let ok = d <= tLow;
        if (!ok) {
          const q = ni * 4;
          const a = data[q] - data[p], b = data[q + 1] - data[p + 1], c = data[q + 2] - data[p + 2];
          const step2 = a * a + b * b + c * c;
          if (d <= tMid && step2 <= STEP2) {
            ok = true; // weicher Verlauf
          } else if (useShadow && step2 <= SHADOW_STEP2) {
            const r = data[q], g = data[q + 1], bl = data[q + 2];
            const len = Math.sqrt(r * r + g * g + bl * bl) || 1;
            const pr = data[p], pg = data[p + 1], pb = data[p + 2];
            const plen = Math.sqrt(pr * pr + pg * pg + pb * pb) || 1;
            const ratio = len / bgLen;
            // Schatten werden zum Kern hin nur dunkler; ein hellerer Nachbar ist schon das Teil
            if (ratio >= 0.18 && ratio <= 1.1 && len <= plen + 8) {
              const noise = 4 / len; // Farbtonrauschen wächst bei dunklen Pixeln
              const hr = r / len - bgUR, hg = g / len - bgUG, hb = bl / len - bgUB;
              const hueG = 0.12 + noise;
              if (hr * hr + hg * hg + hb * hb <= hueG * hueG) {
                const nr = r / len - pr / plen, ng = g / len - pg / plen, nb = bl / len - pb / plen;
                const hueN = 0.03 + 4 / Math.min(len, plen);
                ok = nr * nr + ng * ng + nb * nb <= hueN * hueN; // Schatten (Farbton bleibt, nur dunkler)
              }
            }
          }
        }
        if (ok) { isBg[ni] = 1; queue[qt++] = ni; }
      };
      let qr = 0;
      while (qr < qt) {
        const i = queue[qr++];
        const x = i % cw;
        const p = i * 4;
        if (x > 0) grow(i - 1, p);
        if (x < cw - 1) grow(i + 1, p);
        if (i >= cw) grow(i - cw, p);
        if (i < N - cw) grow(i + cw, p);
      }
      let fg = 0;
      for (let i = 0; i < N; i++) if (!isBg[i]) fg++;
      return fg;
    };
    // erst ohne Schattenregel (sicher), dann mit; frisst die Schattenregel zu viel, gilt das sichere Ergebnis
    const fgBase = runFlood(false);
    if (fgBase < N * 0.02 || fgBase > N * 0.98) return fail; // kein klarer Hintergrund erkannt
    const baseBg = isBg.slice();
    const fgShadow = runFlood(true);
    if (fgShadow < fgBase * 0.75 || fgShadow < N * 0.02) isBg.set(baseBg);

    // 4) Nur die größte zusammenhängende Vordergrundfläche behalten (entfernt Flecken/Rauschen);
    //    eingeschlossene Bereiche bleiben dadurch automatisch gefüllt
    const flood = (start, visited) => {
      let h = 0, t = 0;
      queue[t++] = start; visited[start] = 1;
      while (h < t) {
        const i = queue[h++];
        const x = i % cw;
        if (x > 0 && !isBg[i - 1] && !visited[i - 1]) { visited[i - 1] = 1; queue[t++] = i - 1; }
        if (x < cw - 1 && !isBg[i + 1] && !visited[i + 1]) { visited[i + 1] = 1; queue[t++] = i + 1; }
        if (i >= cw && !isBg[i - cw] && !visited[i - cw]) { visited[i - cw] = 1; queue[t++] = i - cw; }
        if (i < N - cw && !isBg[i + cw] && !visited[i + cw]) { visited[i + cw] = 1; queue[t++] = i + cw; }
      }
      return t;
    };
    const seen = new Uint8Array(N);
    let bestSeed = -1, bestSize = 0;
    for (let i = 0; i < N; i++) {
      if (!isBg[i] && !seen[i]) {
        const size = flood(i, seen);
        if (size > bestSize) { bestSize = size; bestSeed = i; }
      }
    }
    if (bestSeed < 0 || bestSize < N * 0.01) return fail;
    const keep = new Uint8Array(N);
    flood(bestSeed, keep);

    // 5) Kante glätten (Box-Blur auf der Maske) und als weiche Alpha-Kante ausgeben
    const r = Math.max(1, Math.round(Math.min(cw, ch) * 0.002));
    const win = 2 * r + 1;
    const m0 = new Float32Array(N);
    for (let i = 0; i < N; i++) m0[i] = keep[i];
    const m1 = new Float32Array(N);
    for (let y = 0; y < ch; y++) {
      const row = y * cw;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += m0[row + Math.min(cw - 1, Math.max(0, k))];
      for (let x = 0; x < cw; x++) {
        m1[row + x] = acc / win;
        acc += m0[row + Math.min(cw - 1, x + r + 1)] - m0[row + Math.max(0, x - r)];
      }
    }
    // vertikaler Durchgang zeilenweise (cache-freundlich): ein Akkumulator pro Spalte
    const colAcc = new Float32Array(cw);
    for (let k = -r; k <= r; k++) {
      const row = Math.min(ch - 1, Math.max(0, k)) * cw;
      for (let x = 0; x < cw; x++) colAcc[x] += m1[row + x];
    }
    for (let y = 0; y < ch; y++) {
      const row = y * cw;
      for (let x = 0; x < cw; x++) m0[row + x] = colAcc[x] / win;
      const addRow = Math.min(ch - 1, y + r + 1) * cw, subRow = Math.max(0, y - r) * cw;
      for (let x = 0; x < cw; x++) colAcc[x] += m1[addRow + x] - m1[subRow + x];
    }
    const alpha = new Uint8Array(N);
    let minX = cw, minY = ch, maxX = -1, maxY = -1;
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const i = y * cw + x;
        const v = m0[i];
        let a;
        if (v <= 0.35) {
          a = 0;
        } else if (v >= 0.85) {
          a = 255;
        } else {
          const t = (v - 0.35) / 0.5; // Kante leicht nach innen, damit kein Hintergrundsaum bleibt
          a = Math.round(t * t * (3 - 2 * t) * 255);
        }
        alpha[i] = a;
        if (a > 10) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return fail;

    // 6) Auf das Teil zuschneiden; Originalfarben bleiben erhalten, nur Alpha wird gesetzt
    const pad = 2;
    const bx0 = Math.max(0, minX - pad), by0 = Math.max(0, minY - pad);
    const bx1 = Math.min(cw - 1, maxX + pad), by1 = Math.min(ch - 1, maxY + pad);
    const cropW = bx1 - bx0 + 1, cropH = by1 - by0 + 1;
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropW;
    cropCanvas.height = cropH;
    const cctx = cropCanvas.getContext('2d');
    const out = cctx.createImageData(cropW, cropH);
    const od = out.data;
    for (let y = 0; y < cropH; y++) {
      for (let x = 0; x < cropW; x++) {
        const si = (by0 + y) * cw + (bx0 + x);
        const sp = si * 4, op = (y * cropW + x) * 4;
        od[op] = data[sp]; od[op + 1] = data[sp + 1]; od[op + 2] = data[sp + 2]; od[op + 3] = alpha[si];
      }
    }
    cctx.putImageData(out, 0, 0);
    return { canvas: cropCanvas, cropped: true };
  }

  function handlePieceFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      // Sofort anzeigen, damit das Teil auch sichtbar ist, falls die Verkleinerung unten fehlschlägt.
      setPieceSrc(ev.target.result);
      setMatches([]);
    setPose(null);
      setSearchInfo('');
      searchRunRef.current++;
      setPieceBusy(true);
      const img = new window.Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = Math.min(MAX_DIM / w, MAX_DIM / h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        try {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);

          let result = null;
          try {
            result = removeBackground(canvas);
          } catch (bgErr) {
            result = null;
          }

          setPieceSrc(
            result && result.cropped
              ? result.canvas.toDataURL('image/png')
              : canvas.toDataURL('image/jpeg', 0.85)
          );
        } catch (err) {
          // Rohbild bleibt sichtbar, nur die Verarbeitung ist fehlgeschlagen.
        }
        setPieceBusy(false);
      };
      img.onerror = () => {
        setPieceBusy(false);
        setStatusMsg('Teil-Bild konnte nicht gelesen werden.');
        setTimeout(() => setStatusMsg(''), 3000);
      };
      img.src = ev.target.result;
    };
    reader.onerror = () => {
      setPieceBusy(false);
      setStatusMsg('Datei konnte nicht gelesen werden.');
      setTimeout(() => setStatusMsg(''), 3000);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }

  function showGrid() {
    if (!imageSrc || xCount < 1 || yCount < 1) return;
    if (total > MAX_FIELDS) {
      alert(`Bitte höchstens ${MAX_FIELDS} Felder wählen (X × Y).`);
      return;
    }
    setGenerated(true);
    setActiveCell(null);
    setMatches([]);
    setPose(null);
    setSearchInfo('');
    searchRunRef.current++;
    setStatusMsg('');
  }

  // Das Teil wird im ganzen Bild gesucht (nicht nur auf Rasterfeldern): maskierte Korrelation über Maßstab und
  // beliebige Drehung, grob → fein. Ergebnis ist die genaue Lage (orange gestrichelt) und die TOP_N Rasterfelder
  // darunter (benannt nach den Koordinaten, z. B. "Z3 / S5"), absteigend nach Übereinstimmung.
  async function handleSearch() {
    if (searching || !generated || !imageSrc || !pieceSrc || pieceBusy) return;
    const run = ++searchRunRef.current;
    const rows = xCount, cols = yCount;
    setMatches([]);
    setPose(null);
    setActiveCell(null);
    setStatusMsg('');
    setSearching(true);
    setSearchErr(false);
    setSearchInfo('Suche läuft… 0 %');
    try {
      const [pieceEl, gridEl] = await Promise.all([loadImage(pieceSrc), loadImage(imageSrc)]);
      const res = await locatePiece(pieceEl, gridEl, rows, cols, (p) => {
        if (run === searchRunRef.current) setSearchInfo(`Suche läuft… ${Math.round(p * 100)} %`);
      });
      if (run !== searchRunRef.current) return; // Bild, Raster oder Teil wurde währenddessen geändert
      if (res.error) {
        setSearchErr(true);
        setSearchInfo(res.error);
        return;
      }
      if (!res.cells.length) {
        setSearchErr(true);
        setSearchInfo('Das Teil konnte im Bild nicht gefunden werden (zu einfarbig?).');
        return;
      }
      const top = res.cells.map((r) => ({ ...r, img: tileThumb(gridEl, r.row, r.col, rows, cols) }));
      const P = res.pose;
      focusPoseRef.current = true;
      setZoom(4);
      setMatches(top);
      setPose({ cx: P.x / gridEl.width, cy: P.y / gridEl.height, w: P.w / gridEl.width, h: P.h / gridEl.height, angle: P.angle });
      setSearchInfo(
        `Bestes Feld: ${top[0].name} (${Math.round(top[0].score * 100)} %) · Drehung ${Math.round(((P.angle % 360) + 360) % 360)}° · Farbunterschied ${Math.round(res.detail)}`
      );
    } catch (err) {
      if (run === searchRunRef.current) setSearchInfo('Suche fehlgeschlagen.');
    } finally {
      setSearching(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setStatusMsg('');
    try {
      const payload = JSON.stringify({ imageSrc, imgDims, xCount, yCount, pieceSrc });
      const result = await window.storage.set(STORAGE_KEY, payload, false);
      setStatusMsg(result ? 'Gesichert.' : 'Sichern fehlgeschlagen.');
    } catch (e) {
      setStatusMsg('Sichern fehlgeschlagen.');
    } finally {
      setSaving(false);
      setTimeout(() => setStatusMsg(''), 3000);
    }
  }

  async function handleDelete() {
    const ok = window.confirm('Wirklich alles löschen? Bild und Raster werden entfernt. Das kann nicht rückgängig gemacht werden.');
    if (!ok) return;
    try {
      await window.storage.delete(STORAGE_KEY, false);
    } catch (e) {}
    setImageSrc(null);
    setImgDims({ w: 0, h: 0 });
    setXCount(40);
    setYCount(50);
    setGenerated(false);
    setActiveCell(null);
    setPieceSrc(null);
    setPieceBusy(false);
    setMatches([]);
    setPose(null);
    setSearchInfo('');
    searchRunRef.current++;
    setStatusMsg('Gelöscht.');
    setTimeout(() => setStatusMsg(''), 3000);
  }

  function handleImageClick(e) {
    const rect = imageWrapperRef.current.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    const col = Math.min(yCount - 1, Math.max(0, Math.floor(relX * yCount)));
    const row = Math.min(xCount - 1, Math.max(0, Math.floor(relY * xCount)));
    setActiveCell({ row, col });
  }

  const dotGrid = {
    backgroundImage:
      'radial-gradient(circle, #a78bfa 1.6px, transparent 1.6px), ' +
      'radial-gradient(circle, #fbbf24 1.6px, transparent 1.6px), ' +
      'radial-gradient(circle, #34d399 1.6px, transparent 1.6px), ' +
      'radial-gradient(circle, #fb7185 1.6px, transparent 1.6px)',
    backgroundSize: '56px 56px, 56px 56px, 56px 56px, 56px 56px',
    backgroundPosition: '0 0, 28px 14px, 14px 38px, 42px 46px',
  };

  const overlayStyle = {
    backgroundImage:
      'linear-gradient(to right, rgba(124,58,237,0.5) 1px, transparent 1px),' +
      'linear-gradient(to bottom, rgba(124,58,237,0.5) 1px, transparent 1px)',
    backgroundSize: `${100 / yCount}% 100%, 100% ${100 / xCount}%`,
  };

  const highlightStyle = activeCell
    ? {
        left: `${(activeCell.col / yCount) * 100}%`,
        top: `${(activeCell.row / xCount) * 100}%`,
        width: `${100 / yCount}%`,
        height: `${100 / xCount}%`,
      }
    : null;

  function matchStyle(m) {
    return {
      left: `${(m.col / yCount) * 100}%`,
      top: `${(m.row / xCount) * 100}%`,
      width: `${100 / yCount}%`,
      height: `${100 / xCount}%`,
      boxSizing: 'border-box',
      border: '2px solid #ca8a04',
      background: 'rgba(250,204,21,0.55)',
      boxShadow: '0 0 0 1px rgba(255,255,255,0.7)',
    };
  }

  const cellPx = { w: wrapSize.w / yCount, h: wrapSize.h / xCount };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-violet-400 bg-violet-50">
        <Loader2 className="animate-spin mr-2" size={18} />
        Projekt wird geladen...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-violet-50" style={dotGrid}>
      <div className="max-w-5xl mx-auto px-5 py-8 space-y-6">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight flex items-center gap-2.5">
            <Puzzle size={30} strokeWidth={2.25} className="text-violet-600 shrink-0" />
            <span className="bg-gradient-to-r from-amber-500 via-rose-500 to-violet-600 bg-clip-text text-transparent">
              Puzzle-App
            </span>
          </h1>
          <p className="text-sm text-slate-500 mt-1.5 max-w-md">
            Bild hochladen und ein Raster aus Zeilen &amp; Spalten darüberlegen.
          </p>
        </div>

        {/* Bild-Upload */}
        <section className="bg-white border border-violet-100 rounded-xl shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-start gap-3.5">
            <div className="flex-1 min-w-[200px] flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  onClick={() => fileInputRef.current && fileInputRef.current.click()}
                  className="w-[168px] shrink-0 flex items-center justify-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700 transition"
                >
                  <Upload size={16} />
                  Bild wählen
                </button>
                <input type="file" accept="image/*" ref={fileInputRef} onChange={handleFile} className="hidden" />
                {imageSrc && (
                  <span className="text-sm text-slate-500 font-mono">
                    {imgDims.w} × {imgDims.h} px
                  </span>
                )}
              </div>
              {imageSrc ? (
                <img
                  src={imageSrc}
                  alt="Vorschau des hochgeladenen Bildes"
                  className="w-full h-[220px] rounded-lg border border-violet-100 object-contain"
                />
              ) : (
                <div className="w-full h-[220px] flex items-center justify-center gap-2 text-violet-300 border-2 border-dashed border-violet-200 rounded-lg text-sm">
                  <ImageOff size={17} />
                  Noch kein Bild ausgewählt
                </div>
              )}
            </div>
            <div className="flex-1 min-w-[200px] flex flex-col gap-2.5">
              <button
                onClick={() => pieceInputRef.current && pieceInputRef.current.click()}
                className="w-[168px] flex items-center justify-center gap-2 px-4 py-2 bg-violet-600 text-white rounded-lg text-sm font-medium hover:bg-violet-700 transition"
              >
                <Puzzle size={16} />
                Teil wählen
              </button>
              <input type="file" accept="image/*" ref={pieceInputRef} onChange={handlePieceFile} className="hidden" />
              {pieceSrc ? (
                <img
                  src={pieceSrc}
                  alt="Vorschau des Puzzleteils"
                  className="w-full h-[220px] rounded-lg border border-violet-100 object-contain bg-violet-50"
                />
              ) : (
                <div className="w-full h-[220px] flex items-center justify-center gap-1.5 text-violet-300 border-2 border-dashed border-violet-200 rounded-lg text-sm text-center px-2">
                  <Puzzle size={15} />
                  Kein Teil ausgewählt
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Raster-Konfiguration */}
        <section className="bg-white border border-violet-100 rounded-xl shadow-sm p-4">
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col text-sm text-slate-600 gap-1">
              Zeilen (X)
              <input
                type="number"
                min={1}
                max={500}
                value={xCount}
                onChange={(e) => setXCount(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-24 border border-violet-200 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-400"
              />
            </label>
            <span className="text-violet-300 pb-2 text-lg">×</span>
            <label className="flex flex-col text-sm text-slate-600 gap-1">
              Spalten (Y)
              <input
                type="number"
                min={1}
                max={500}
                value={yCount}
                onChange={(e) => setYCount(Math.max(1, parseInt(e.target.value) || 1))}
                className="w-24 border border-violet-200 rounded-lg px-2 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-400"
              />
            </label>
            <div className="text-sm text-slate-600 pb-2">
              = <span className="font-mono font-semibold text-violet-700">{total}</span> Felder
            </div>
            <button
              onClick={showGrid}
              disabled={!imageSrc}
              className="flex items-center gap-2 px-4 py-2 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition ml-auto"
            >
              <Puzzle size={16} />
              Raster anzeigen
            </button>
            <button
              onClick={handleSearch}
              disabled={!generated || !pieceSrc || searching || pieceBusy}
              className="flex items-center gap-2 px-4 py-2 bg-teal-500 text-white rounded-lg text-sm font-medium hover:bg-teal-600 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {searching ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
              Suchen
            </button>
          </div>
        </section>

        {/* Bild mit Raster-Overlay */}
        {generated && (
          <section
            className="bg-white border border-violet-100 rounded-xl shadow-sm overflow-hidden"
            style={{ width: 'min(1600px, calc(100vw - 40px))', position: 'relative', left: '50%', transform: 'translateX(-50%)' }}
          >
            <div className="p-3 flex flex-wrap items-center gap-3 border-b border-violet-100 bg-violet-50">
              {activeCell && (
                <span className="text-sm font-mono text-slate-600">
                  Ausgewählt: Z{activeCell.row + 1} / S{activeCell.col + 1}
                </span>
              )}
              {searchInfo && !activeCell && (
                <span className={searchErr ? 'text-sm font-semibold text-red-600' : 'text-sm font-mono text-yellow-800'}>{searchInfo}</span>
              )}
              <div className="ml-auto flex items-center gap-1.5">
                <button
                  onClick={() => changeZoom(-1)}
                  disabled={zoom <= 1}
                  title="Verkleinern"
                  className="px-2.5 py-1 text-sm border border-violet-200 rounded-lg bg-white hover:bg-violet-50 disabled:opacity-40 transition"
                >
                  −
                </button>
                <span className="text-sm font-mono text-slate-600 w-12 text-center">{Math.round(zoom * 100)} %</span>
                <button
                  onClick={() => changeZoom(1)}
                  disabled={zoom >= 4}
                  title="Vergrößern"
                  className="px-2.5 py-1 text-sm border border-violet-200 rounded-lg bg-white hover:bg-violet-50 disabled:opacity-40 transition"
                >
                  +
                </button>
              </div>
              {activeCell && (
                <button
                  onClick={() => setActiveCell(null)}
                  className="px-3 py-1.5 text-sm border border-violet-200 rounded-lg bg-white hover:bg-violet-50 transition"
                >
                  Auswahl löschen ✕
                </button>
              )}
            </div>

            <div ref={scrollRef} className="overflow-auto" style={{ maxHeight: '75vh' }}>
            <div className="p-4" style={{ width: `${zoom * 100}%` }}>
              <div className="flex gap-3.5">
                <div
                  ref={imageWrapperRef}
                  onClick={handleImageClick}
                  className="relative flex-1 rounded-lg overflow-hidden border border-violet-100 cursor-crosshair"
                  style={{ lineHeight: 0 }}
                >
                  <img src={imageSrc} alt="Bild mit Raster" className="w-full block select-none" />
                  <div className="absolute inset-0 pointer-events-none" style={overlayStyle} />
                  {activeCell && (
                    <div
                      ref={highlightRef}
                      className="absolute pointer-events-none transition-all"
                      style={{
                        ...highlightStyle,
                        border: '2.5px solid #f59e0b',
                        background: 'rgba(245,158,11,0.18)',
                        boxShadow: '0 0 0 2px rgba(255,255,255,0.65)',
                      }}
                    />
                  )}
                  {pose && (
                    <div
                      ref={poseRef}
                      className="absolute pointer-events-none"
                      style={{
                        left: `${pose.cx * 100}%`,
                        top: `${pose.cy * 100}%`,
                        width: `${pose.w * 100}%`,
                        height: `${pose.h * 100}%`,
                        transform: `translate(-50%, -50%) rotate(${pose.angle}deg)`,
                        border: '2px dashed #ea580c',
                        boxShadow: '0 0 0 1px rgba(255,255,255,0.85)',
                        boxSizing: 'border-box',
                        zIndex: 3,
                      }}
                    />
                  )}
                  {matches.map((m, i) => (
                    <div
                      key={i}
                      className="absolute pointer-events-none flex items-center justify-center"
                      style={matchStyle(m)}
                    >
                      {cellPx.w >= 22 && cellPx.h >= 16 && (
                        <span
                          style={{
                            fontSize: 11, fontWeight: 700, color: '#422006', lineHeight: 1,
                            textShadow: '0 0 3px rgba(255,255,255,0.9)',
                          }}
                        >
                          {i + 1}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
            </div>
              {matches.length > 0 && (
                <div className="px-4 py-3 border-t border-violet-100" style={{ background: '#fffdf3' }}>
                  <div className="text-sm font-bold text-slate-600 mb-2">
                    Die {matches.length} wahrscheinlichsten Felder (absteigend nach Übereinstimmung)
                  </div>
                  <ol className="grid gap-1 m-0 p-0 list-none" style={{ maxWidth: 900 }}>
                    {matches.map((m, i) => {
                      const p = Math.round(m.score * 100);
                      return (
                        <li
                          key={m.name}
                          onClick={() => { scrollOnSelectRef.current = true; setActiveCell({ row: m.row, col: m.col }); }}
                          title="Feld im Raster anzeigen"
                          className="grid items-center gap-2.5 px-2 py-1 rounded-lg cursor-pointer hover:bg-yellow-100 text-sm"
                          style={{ gridTemplateColumns: '26px 76px 92px 1fr 52px' }}
                        >
                          <span className="w-[22px] h-[22px] rounded-full bg-yellow-400 text-yellow-950 font-bold text-xs flex items-center justify-center">
                            {i + 1}
                          </span>
                          <img
                            src={m.img}
                            alt={m.name}
                            className="block rounded-md border border-violet-100 bg-white"
                            style={{ width: 76, height: 58, objectFit: 'contain' }}
                          />
                          <span className="font-mono text-slate-600 whitespace-nowrap">{m.name}</span>
                          <span className="h-2 rounded bg-slate-100 overflow-hidden">
                            <span className="block h-full rounded bg-yellow-500" style={{ width: `${p}%` }} />
                          </span>
                          <span className="font-mono font-bold text-right text-yellow-950">{p} %</span>
                        </li>
                      );
                    })}
                  </ol>
                </div>
              )}
          </section>
        )}

        {/* Aktionsleiste unten */}
        <section className="border-t-4 border-amber-400 pt-4 flex items-center gap-3 rounded-t">
          <button
            onClick={handleSave}
            disabled={!generated || saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-lg text-sm font-semibold hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition shadow-sm"
          >
            {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            Sichern
          </button>
          <button
            onClick={handleDelete}
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-rose-600 border border-rose-200 rounded-lg text-sm font-semibold hover:bg-rose-50 transition"
          >
            <Trash2 size={16} />
            Löschen
          </button>
          {statusMsg && <span className="text-sm text-slate-500">{statusMsg}</span>}
        </section>
      </div>
    </div>
  );
}
