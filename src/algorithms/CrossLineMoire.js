/**
 * Cross-Line Moiré Synthesis
 *
 * Layer 1 is a fixed vertical grating.  Layer 2 is an angled grating whose
 * phase is subtracted by the image, so the interference fringes formed where
 * the two sets of lines cross encode the source image as variable density.
 *
 * Math:
 *   φ₁(x,y)  = (2π/P) · x                                  — vertical
 *   φ₂(x,y)  = (2π/P)(x·cosα + y·sinα) − k·2π·(1 − I(x,y)) — angled + modulated
 *
 * Pipeline: Gaussian blur → phase fields → phase-aware Marching Squares →
 * segment chaining → proximity sort → Paper.js paths.
 */
import paper from 'paper';
import { chainSegments, sortByProximity } from './ChainUtils.js';

const TWO_PI = 2 * Math.PI;

// ─────────────────────────────────────────────────────────────────────────────
// Gaussian blur — separable 1-D passes over a Float32 intensity field
// ─────────────────────────────────────────────────────────────────────────────
function gaussianBlur(src, w, h, radius) {
  if (radius < 0.5) return src;

  const sigma  = radius / 2.5;
  const kHalf  = Math.ceil(sigma * 3);
  const kSize  = 2 * kHalf + 1;
  const kernel = new Float32Array(kSize);
  let ksum = 0;
  for (let i = 0; i < kSize; i++) {
    const d = i - kHalf;
    kernel[i] = Math.exp(-(d * d) / (2 * sigma * sigma));
    ksum += kernel[i];
  }
  for (let i = 0; i < kSize; i++) kernel[i] /= ksum;

  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = 0; k < kSize; k++) {
        acc += src[y * w + Math.max(0, Math.min(w - 1, x + k - kHalf))] * kernel[k];
      }
      tmp[y * w + x] = acc;
    }
  }

  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = 0; k < kSize; k++) {
        acc += tmp[Math.max(0, Math.min(h - 1, y + k - kHalf)) * w + x] * kernel[k];
      }
      out[y * w + x] = acc;
    }
  }

  return out;
}

// Bilinear sample from a Float32 field
function sampleF(field, w, h, x, y) {
  const x0 = Math.floor(Math.max(0, Math.min(w - 2, x)));
  const y0 = Math.floor(Math.max(0, Math.min(h - 2, y)));
  const fx = x - x0, fy = y - y0;
  const get = (xi, yi) => field[yi * w + xi];
  return get(x0, y0) * (1-fx)*(1-fy) + get(x0+1, y0) * fx*(1-fy)
       + get(x0, y0+1) * (1-fx)*fy   + get(x0+1, y0+1) * fx*fy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase-field Marching Squares
// ─────────────────────────────────────────────────────────────────────────────
function extractPhaseContours(phaseField, cols, rows, cellPx) {
  const rawSegs = [];

  function edgeCrossings(phiA, phiB, ax, ay, bx, by, crossings) {
    const nA = Math.floor(phiA / TWO_PI);
    const nB = Math.floor(phiB / TWO_PI);
    if (nA === nB) return;
    const lo = Math.min(nA, nB) + 1;
    const hi = Math.max(nA, nB);
    for (let n = lo; n <= hi; n++) {
      const t = (n * TWO_PI - phiA) / (phiB - phiA);
      if (t >= 0 && t <= 1) {
        crossings.push({ x: ax + t * (bx - ax), y: ay + t * (by - ay), n });
      }
    }
  }

  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const phiTL = phaseField[gy * cols + gx];
      const phiTR = phaseField[gy * cols + gx + 1];
      const phiBR = phaseField[(gy+1) * cols + gx + 1];
      const phiBL = phaseField[(gy+1) * cols + gx];

      const x0 = gx * cellPx, y0 = gy * cellPx;
      const x1 = x0 + cellPx,  y1 = y0 + cellPx;

      const crossings = [];
      edgeCrossings(phiTL, phiTR, x0, y0, x1, y0, crossings);
      edgeCrossings(phiTR, phiBR, x1, y0, x1, y1, crossings);
      edgeCrossings(phiBR, phiBL, x1, y1, x0, y1, crossings);
      edgeCrossings(phiBL, phiTL, x0, y1, x0, y0, crossings);

      if (crossings.length === 2) {
        rawSegs.push({ x1: crossings[0].x, y1: crossings[0].y,
                       x2: crossings[1].x, y2: crossings[1].y });
      } else if (crossings.length >= 4) {
        const byN = new Map();
        for (const c of crossings) {
          if (!byN.has(c.n)) byN.set(c.n, []);
          byN.get(c.n).push(c);
        }
        for (const pts of byN.values()) {
          if (pts.length >= 2) {
            rawSegs.push({ x1: pts[0].x, y1: pts[0].y,
                           x2: pts[1].x, y2: pts[1].y });
          }
        }
      }
    }
  }

  return rawSegs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {paper.Project} project
 * @param {ImageData}     imageData         — grayscale continuous-tone data
 * @param {number}        pitch             — line pitch P in pixels (4–40)
 * @param {number}        fringeDensity     — image phase multiplier k (0.1–3)
 * @param {number}        blurRadius        — Gaussian pre-blur radius (0–20 px)
 * @param {string|number} intersectionAngle — Layer 2 angle in degrees: 30|45|60|75
 */
export function generateCrossLineMoire(
  project,
  imageData,
  pitch             = 12,
  fringeDensity     = 0.8,
  blurRadius        = 4,
  intersectionAngle = '45',
) {
  if (!imageData) return;

  const w = imageData.width;
  const h = imageData.height;
  const { data } = imageData;
  const layer = project.activeLayer;
  const P = Math.max(4, pitch);

  const alpha = (parseFloat(intersectionAngle) || 45) * (Math.PI / 180);
  const cosA  = Math.cos(alpha);
  const sinA  = Math.sin(alpha);

  // ── 1. Intensity field ────────────────────────────────────────────────────
  const rawIntensity = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    rawIntensity[i] =
      (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }

  // ── 2. Gaussian blur ──────────────────────────────────────────────────────
  const intensity = gaussianBlur(rawIntensity, w, h, blurRadius);

  // ── 3. Phase fields ───────────────────────────────────────────────────────
  const step = Math.max(1, Math.floor(P / 5));
  const cols = Math.floor(w / step) + 1;
  const rows = Math.floor(h / step) + 1;

  const phi1Field = new Float32Array(cols * rows);
  const phi2Field = new Float32Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const px = Math.min(gx * step, w - 1);
      const py = Math.min(gy * step, h - 1);

      // Layer 1: vertical reference — φ₁ = (2π/P)·x
      const phi1 = (TWO_PI / P) * px;

      // Layer 2: angled carrier — φ₂_base = (2π/P)(x·cosα + y·sinα)
      const phi2base = (TWO_PI / P) * (px * cosA + py * sinA);

      const I    = sampleF(intensity, w, h, px, py);
      const phiM = fringeDensity * TWO_PI * (1 - I);

      phi1Field[gy * cols + gx] = phi1 + (TWO_PI * 10000);
      phi2Field[gy * cols + gx] = phi2base - phiM + (TWO_PI * 10000);
    }
  }

  // ── 4–6. Contours → chains → sort ────────────────────────────────────────
  const sorted1 = sortByProximity(chainSegments(extractPhaseContours(phi1Field, cols, rows, step)));
  const sorted2 = sortByProximity(chainSegments(extractPhaseContours(phi2Field, cols, rows, step)));

  // ── 7. Emit Paper.js paths ────────────────────────────────────────────────
  function emitChains(chains, color) {
    for (const chain of chains) {
      if (chain.length < 3) continue;
      const path = new paper.Path();
      path.strokeColor = new paper.Color(color);
      path.strokeWidth = 1;
      path.fillColor   = null;
      for (const pt of chain) path.add(new paper.Point(pt.x, pt.y));
      path.smooth({ type: 'continuous' });
      layer.addChild(path);
    }
  }

  emitChains(sorted1, 'cyan');
  emitChains(sorted2, 'magenta');
}
