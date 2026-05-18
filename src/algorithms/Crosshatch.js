/**
 * Crosshatch — Clean Binary Mask Halfhatch
 *
 * Restores the original O(n) pixel-walker for performance, but replaces raw
 * per-pixel brightness sampling with a pre-computed median-filtered binary
 * mask. The median filter smooths texture noise before thresholding, so each
 * hatch line responds to the large-scale tonal zone rather than individual
 * pixel values — producing long, uninterrupted strokes instead of jittery
 * fragments.
 *
 * Pipeline per pass:
 *   1. Median-filtered grayscale (computed once, shared across all passes)
 *   2. Hard-threshold → binary mask for this tonal zone
 *   3. Pixel-walker traces continuous segments along mask-on pixels
 *   4. Zig-zag direction alternation for travel-path efficiency
 */
import paper from 'paper';

/**
 * @param {paper.Project} project
 * @param {ImageData}     imageData   Continuous-tone grayscale data.
 * @param {number}        density     Line density 20–200, default 80.
 */
export function generateCrosshatch(project, imageData, density, params = {}) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const step = Math.max(2, Math.floor(1280 / Math.max(1, density)));

  // ── Pre-compute median-filtered grayscale (one pass, shared by all thresholds) ──
  // 3×3 median suppresses texture noise so thresholding produces clean,
  // stable shadow zones rather than speckled regions.
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  const filtered = _median3x3(gray, w, h);

  // ── Tonal passes ──────────────────────────────────────────────────────────
  // Thresholds mirror the original four-level crosshatch density zones.
  // Each pass builds its own binary mask and walks it independently.
  const PASSES = [
    { threshold: 200, dX: 1,  dY:  0 }, // horizontal  — light shadows
    { threshold: 150, dX: 0,  dY:  1 }, // vertical    — mid shadows
    { threshold: 100, dX: 1,  dY:  1 }, // diagonal \  — dark shadows
    { threshold:  50, dX: 1,  dY: -1 }, // diagonal /  — deepest shadows
  ];

  const { hatchH = true, hatchV = true, hatchD1 = true, hatchD2 = true } = params;
  const activeFlags = [hatchH, hatchV, hatchD1, hatchD2];
  for (const [i, { threshold, dX, dY }] of PASSES.entries()) {
    if (!activeFlags[i]) continue;
    // Binary mask: 1 = shadow pixel for this pass, 0 = skip.
    const mask = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (filtered[p] < threshold) mask[p] = 1;
    }

    // ── Scanline launch points ──────────────────────────────────────────────
    // Horizontal / vertical: launch from x=0 or y=0 edge.
    // Diagonals: launch from both the top edge and the left edge so every
    // diagonal crossing the canvas is covered.
    const starts = _buildStarts(w, h, step, dX, dY);

    let alt = false;
    for (const [sx, sy] of starts) {
      _traceLine(sx, sy, dX, dY, mask, w, h, alt, layer);
      alt = !alt;
    }
  }
}

// ── Pixel walker ──────────────────────────────────────────────────────────────
// Identical logic to the original traceHatchLine, but samples `mask` instead
// of raw pixel brightness, so it reacts to the clean median-filtered zones.

function _traceLine(startX, startY, dX, dY, mask, w, h, reverse, layer) {
  const maxSteps = w + h;
  const segments = [];
  let current = null;

  for (let i = 0; i < maxSteps; i++) {
    const x = startX + i * dX;
    const y = startY + i * dY;

    if (x < 0 || x >= w || y < 0 || y >= h) {
      if (current) { current.simplify(); segments.push(current); }
      break;
    }

    const inShadow = mask[Math.floor(y) * w + Math.floor(x)] === 1;

    if (inShadow) {
      if (!current) {
        current = new paper.Path();
        current.strokeColor = new paper.Color(0, 0, 0);
        current.strokeWidth = 1;
        current.fillColor = null;
      }
      current.add(new paper.Point(x, y));
    } else {
      if (current) {
        if (current.segments.length > 1) {
          current.simplify();
          segments.push(current);
        } else {
          current.remove();
        }
        current = null;
      }
    }
  }

  // Zig-zag: reverse segment order and direction for alternating lines
  // so the pen lifts as little as possible between strokes.
  if (reverse) {
    segments.reverse();
    segments.forEach(p => p.reverse());
  }
  segments.forEach(p => layer.addChild(p));
}

// ── Start-point generator ─────────────────────────────────────────────────────

function _buildStarts(w, h, step, dX, dY) {
  const starts = [];

  if (dX === 1 && dY === 0) {
    // Horizontal
    for (let y = 0; y < h; y += step) starts.push([0, y]);

  } else if (dX === 0 && dY === 1) {
    // Vertical
    for (let x = 0; x < w; x += step) starts.push([x, 0]);

  } else if (dX === 1 && dY === 1) {
    // Diagonal \ : launch from top edge + left edge
    for (let x = 0; x < w; x += step) starts.push([x, 0]);
    for (let y = step; y < h; y += step) starts.push([0, y]);

  } else if (dX === 1 && dY === -1) {
    // Diagonal / : launch from bottom edge + left edge
    for (let x = 0; x < w; x += step) starts.push([x, h - 1]);
    for (let y = h - 1 - step; y >= 0; y -= step) starts.push([0, y]);
  }

  return starts;
}

// ── 3×3 Median filter ─────────────────────────────────────────────────────────
// Insertion sort on 9 values — faster than Array.sort for a fixed-size kernel.

function _median3x3(gray, w, h) {
  const out = new Float32Array(w * h);
  const nb = new Float32Array(9);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.min(Math.max(x + dx, 0), w - 1);
          const ny = Math.min(Math.max(y + dy, 0), h - 1);
          nb[k++] = gray[ny * w + nx];
        }
      }
      for (let i = 1; i < 9; i++) {
        const v = nb[i]; let j = i - 1;
        while (j >= 0 && nb[j] > v) { nb[j + 1] = nb[j]; j--; }
        nb[j + 1] = v;
      }
      out[y * w + x] = nb[4];
    }
  }
  return out;
}
