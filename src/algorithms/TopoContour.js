/**
 * Topographical Heightmap Contouring
 *
 * Treats the input image as a 3-D height field and extracts smooth topographic
 * iso-contours, exactly as a terrain map would.
 *
 * Math:
 *   I(x,y)   — smoothed, normalised image intensity  [0 dark … 1 white]
 *   P(x,y)   = f · (x·cosα + y·sinα)   — tilted carrier plane
 *              where f = lineDensity / imageWidth   (lines per pixel)
 *   S(x,y)   = P(x,y) + k · I(x,y)     — combined surface
 *   Contours extracted where S ≡ integer  (equivalent to matplotlib contour
 *   with levels=[0,1,2,…,Smax])
 *
 * The carrier plane guarantees a rich field of lines everywhere, even in
 * completely flat (constant-colour) regions of the image.  The image height
 * term k·I bunches contours together in bright areas (peaks) and spreads them
 * in dark areas (valleys), encoding local luminance as contour density.
 *
 * Pipeline:
 *   1. Greyscale + Gaussian blur
 *   2. Evaluate S on a sub-pixel grid
 *   3. Integer-level Marching Squares  →  raw edge segments
 *   4. Hash-map chain builder          →  continuous polylines
 *   5. Greedy proximity sort           →  minimal pen travel
 *   6. Emit Paper.js paths
 */
import paper from 'paper';
import { chainSegments, sortByProximity } from './ChainUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Separable Gaussian blur on a Float32 intensity field
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
  const g  = (xi, yi) => field[yi * w + xi];
  return g(x0, y0)   * (1-fx)*(1-fy)
       + g(x0+1, y0) * fx    *(1-fy)
       + g(x0, y0+1) * (1-fx)*fy
       + g(x0+1,y0+1)* fx    *fy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Integer-level Marching Squares
//
// Finds every grid edge where floor(S) changes and linearly interpolates the
// exact crossing position.  Handles multiple crossings per edge (steep slopes).
// ─────────────────────────────────────────────────────────────────────────────
function extractContours(sField, cols, rows, cellPx) {
  const rawSegs = [];

  function edgeCrossings(sA, sB, ax, ay, bx, by, out) {
    const nA = Math.floor(sA);
    const nB = Math.floor(sB);
    if (nA === nB) return;
    const lo = Math.min(nA, nB) + 1;
    const hi = Math.max(nA, nB);
    for (let n = lo; n <= hi; n++) {
      const t = (n - sA) / (sB - sA);
      if (t >= 0 && t <= 1) {
        out.push({ x: ax + t * (bx - ax), y: ay + t * (by - ay), n });
      }
    }
  }

  for (let gy = 0; gy < rows - 1; gy++) {
    for (let gx = 0; gx < cols - 1; gx++) {
      const sTL = sField[ gy      * cols +  gx     ];
      const sTR = sField[ gy      * cols + (gx + 1)];
      const sBR = sField[(gy + 1) * cols + (gx + 1)];
      const sBL = sField[(gy + 1) * cols +  gx     ];

      const x0 = gx * cellPx, y0 = gy * cellPx;
      const x1 = x0 + cellPx, y1 = y0 + cellPx;

      const crossings = [];
      edgeCrossings(sTL, sTR, x0, y0, x1, y0, crossings); // top
      edgeCrossings(sTR, sBR, x1, y0, x1, y1, crossings); // right
      edgeCrossings(sBR, sBL, x1, y1, x0, y1, crossings); // bottom
      edgeCrossings(sBL, sTL, x0, y1, x0, y0, crossings); // left

      if (crossings.length === 2) {
        rawSegs.push({ x1: crossings[0].x, y1: crossings[0].y,
                       x2: crossings[1].x, y2: crossings[1].y });
      } else if (crossings.length >= 4) {
        // Saddle / multi-crossing: pair segments sharing the same integer level
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
 * @param {ImageData}     imageData     — grayscale continuous-tone data
 * @param {number}        lineDensity   — carrier lines across the canvas width (10–200)
 * @param {number}        contourHeight — image height multiplier k (0–30)
 * @param {number}        blurRadius    — Gaussian pre-blur radius in pixels (0–20)
 * @param {string|number} topoAngle     — carrier plane tilt in degrees: 0|30|45|60|75
 */
export function generateTopoContour(
  project,
  imageData,
  lineDensity   = 60,
  contourHeight = 5,
  blurRadius    = 4,
  topoAngle     = '45',
) {
  if (!imageData) return;

  const w     = imageData.width;
  const h     = imageData.height;
  const { data } = imageData;
  const layer = project.activeLayer;

  const alpha = (parseFloat(topoAngle) || 0) * (Math.PI / 180);
  const cosA  = Math.cos(alpha);
  const sinA  = Math.sin(alpha);

  // f = lines per pixel along the carrier direction
  // Normalising by the projected canvas extent keeps lineDensity intuitive
  // at any angle: lineDensity ≈ visible lines when looking along the carrier.
  const extent = Math.abs(w * cosA) + Math.abs(h * sinA); // canvas diagonal projection
  const f      = lineDensity / extent;

  // ── 1. Extract greyscale intensity [0 dark … 1 white] ────────────────────
  const rawIntensity = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    rawIntensity[i] =
      (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
  }

  // ── 2. Gaussian blur — critical for smooth contour curves ─────────────────
  const intensity = gaussianBlur(rawIntensity, w, h, blurRadius);

  // ── 3. Build S(x,y) = P(x,y) + k·I(x,y) on a fine grid ──────────────────
  // Step size: ~5 cells per carrier line spacing for accurate tracing,
  // but never coarser than 4 px (preserves image-driven curvature detail).
  const lineSpacingPx = extent / lineDensity;
  const step          = Math.max(1, Math.min(Math.floor(lineSpacingPx / 5), 4));
  const cols          = Math.floor(w / step) + 1;
  const rows          = Math.floor(h / step) + 1;

  const sField = new Float32Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const px = Math.min(gx * step, w - 1);
      const py = Math.min(gy * step, h - 1);

      const carrier = f * (px * cosA + py * sinA);          // tilted plane
      const imgTerm = contourHeight * sampleF(intensity, w, h, px, py);

      sField[gy * cols + gx] = carrier + imgTerm;
    }
  }

  // ── 4. Extract iso-contours at every integer level of S ──────────────────
  const rawSegs = extractContours(sField, cols, rows, step);

  // ── 5. Chain raw segments into continuous polylines ───────────────────────
  const chains = chainSegments(rawSegs);

  // ── 6. Sort paths for minimal pen travel ─────────────────────────────────
  const sorted = sortByProximity(chains);

  // ── 7. Emit Paper.js paths ────────────────────────────────────────────────
  for (const chain of sorted) {
    if (chain.length < 3) continue;
    const path = new paper.Path();
    path.strokeColor = new paper.Color('cyan');
    path.strokeWidth = 1;
    path.fillColor   = null;
    for (const pt of chain) path.add(new paper.Point(pt.x, pt.y));
    path.smooth({ type: 'continuous' });
    layer.addChild(path);
  }
}
