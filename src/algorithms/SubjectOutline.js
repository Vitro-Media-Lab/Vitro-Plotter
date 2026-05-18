/**
 * SubjectOutline — XDoG Edge Detection + Edge Chaining
 *
 * Converts an ImageData into single-stroke plotter-ready vector outlines
 * without Marching Squares. Two steps:
 *
 *   1. applyXDoG      — raster filter producing a 1-px-wide binary edge map
 *   2. chainEdgesToPaths — pixel walker converting that map into paper.Path objects
 *
 * ── Why XDoG instead of plain DoG ──────────────────────────────────────────
 * A plain Difference of Gaussians produces blurry, multi-pixel-wide blobs.
 * XDoG (Winnemöller et al. 2012) adds a tau parameter that boosts edge contrast
 * before thresholding, yielding thin, coherent lines ideal for pen plotters.
 *
 * ── Why Zhang-Suen thinning ────────────────────────────────────────────────
 * Even a tuned XDoG may produce 2-px-wide ridges at diagonal edges.
 * Zhang-Suen thinning reduces these to single-pixel skeletons so that the
 * edge-chainer never produces redundant parallel strokes on the same feature.
 *
 * ── Why pixel walking instead of Marching Squares ─────────────────────────
 * Marching Squares operates on a grid of 2×2 quads and produces closed
 * contour loops with implicit inner and outer edges — giving every boundary
 * two lines instead of one. A direct 8-connected pixel walk consumes each
 * edge pixel exactly once, producing genuine single-stroke paths.
 */
import paper from 'paper';

// ═══════════════════════════════════════════════════════════════════════════════
// Task 1 — XDoG Edge Filter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply XDoG edge detection to an ImageData.
 *
 * Internally: grayscale → two Gaussian blurs → XDoG formula → threshold →
 * Zhang-Suen thinning → 1-pixel-wide binary edge map.
 *
 * @param {ImageData} imageData  Source image (any size, any content).
 * @param {number}    sigma1     Small blur radius (e.g. 0.5–1.0). Controls edge sharpness.
 * @param {number}    sigma2     Large blur radius (e.g. 1.6–3.0, must be > sigma1).
 * @param {number}    tau        Blend factor (e.g. 0.95–0.99). Lower → more/thicker edges.
 * @param {number}    epsilon    Threshold on the DoG response. 0 = zero-crossing edges.
 *                               Positive → catch subtler edges. Negative → only strong edges.
 * @returns {Uint8Array} Flat pixel array, length = width × height.
 *                       0 = edge (black), 255 = background (white).
 */
export function applyXDoG(imageData, sigma1, sigma2, tau, epsilon) {
  const { width, height, data } = imageData;
  const n = width * height;

  // ── Grayscale (luminance-weighted) ────────────────────────────────────────
  const gray = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    gray[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255;
  }

  // ── Separable Gaussian blur ────────────────────────────────────────────────
  // Splitting into horizontal + vertical passes reduces O(n·r²) to O(n·r),
  // which matters for large sigma2 kernels on high-resolution images.

  function makeKernel(sigma) {
    const r = Math.ceil(3 * sigma);
    const k = new Float32Array(2 * r + 1);
    let sum = 0;
    for (let i = 0; i <= 2 * r; i++) {
      const x = i - r;
      k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
      sum += k[i];
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    return { k, r };
  }

  function blurH(src, { k, r }) {
    const out = new Float32Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (let d = -r; d <= r; d++) {
          const sx = Math.min(Math.max(x + d, 0), width - 1);
          v += src[y * width + sx] * k[d + r];
        }
        out[y * width + x] = v;
      }
    }
    return out;
  }

  function blurV(src, { k, r }) {
    const out = new Float32Array(n);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let v = 0;
        for (let d = -r; d <= r; d++) {
          const sy = Math.min(Math.max(y + d, 0), height - 1);
          v += src[sy * width + x] * k[d + r];
        }
        out[y * width + x] = v;
      }
    }
    return out;
  }

  function gaussianBlur(src, sigma) {
    const kernel = makeKernel(sigma);
    return blurV(blurH(src, kernel), kernel);
  }

  const g1 = gaussianBlur(gray, sigma1);
  const g2 = gaussianBlur(gray, sigma2);

  // ── XDoG formula and threshold ─────────────────────────────────────────────
  // dog = g1 - tau * g2
  //   Flat regions:  g1 ≈ g2, so dog ≈ g1*(1-tau) > 0  → background
  //   Dark edges:    dog dips below zero (LoG-like response) → edge
  //
  // epsilon shifts the zero-crossing:
  //   epsilon = 0   → detect exactly where dog crosses zero (standard)
  //   epsilon > 0   → include near-zero (more edges, may add noise)
  //   epsilon < 0   → only strong negative dips (fewer, crisper edges)

  const binary = new Uint8Array(n).fill(255);
  for (let i = 0; i < n; i++) {
    if (g1[i] - tau * g2[i] < epsilon) binary[i] = 0;
  }

  // ── Zhang-Suen thinning → 1-pixel-wide skeleton ───────────────────────────
  return zhangSuenThin(binary, width, height);
}

// ── Zhang-Suen iterative thinning ─────────────────────────────────────────────
// Repeatedly erodes foreground pixels that are not essential to 8-connectivity
// until no more pixels can be removed.  Guarantees single-pixel-wide lines.
//
// Neighbour labelling (paper convention):
//   p9 p2 p3
//   p8 p1 p4
//   p7 p6 p5

function zhangSuenThin(binary, width, height) {
  const img = new Uint8Array(binary);

  function fg(x, y) {
    if (x < 0 || x >= width || y < 0 || y >= height) return 0;
    return img[y * width + x] === 0 ? 1 : 0;
  }

  let anyChange = true;
  while (anyChange) {
    anyChange = false;

    for (let step = 0; step < 2; step++) {
      const toErase = [];

      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          if (img[y * width + x] !== 0) continue;

          const p2 = fg(x,   y - 1);
          const p3 = fg(x + 1, y - 1);
          const p4 = fg(x + 1, y);
          const p5 = fg(x + 1, y + 1);
          const p6 = fg(x,   y + 1);
          const p7 = fg(x - 1, y + 1);
          const p8 = fg(x - 1, y);
          const p9 = fg(x - 1, y - 1);

          // B — number of non-zero neighbours
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;

          // A — number of 0→1 transitions around the ring
          const ring = [p2, p3, p4, p5, p6, p7, p8, p9];
          let A = 0;
          for (let i = 0; i < 8; i++) {
            if (ring[i] === 0 && ring[(i + 1) % 8] === 1) A++;
          }
          if (A !== 1) continue;

          // Step-specific conditions (the two sub-iterations differ only here)
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          toErase.push(y * width + x);
        }
      }

      if (toErase.length > 0) {
        anyChange = true;
        for (const idx of toErase) img[idx] = 255;
      }
    }
  }

  return img;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task 2 — Edge Chaining (Pixel Walking → paper.Path)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Walk a binary edge map and return an array of paper.Path objects.
 *
 * Each edge pixel is visited exactly once (consumed on first touch), so no
 * stroke is ever drawn twice. Paths shorter than minPathLength are discarded
 * to suppress noise dots and stub segments that would waste plotter moves.
 *
 * After chaining, paper.Path.simplify() is called with a tight tolerance to
 * replace the pixelated staircase with smooth Bézier curves while preserving
 * the edge geometry.
 *
 * @param {number}     binaryWidth
 * @param {number}     binaryHeight
 * @param {Uint8Array} binaryPixelArray  Output of applyXDoG. 0=edge, 255=background.
 *                                       This array is NOT mutated — a copy is made.
 * @param {number}     minPathLength     Minimum pixel count to keep a path (e.g. 10).
 * @returns {paper.Path[]}
 */
export function chainEdgesToPaths(binaryWidth, binaryHeight, binaryPixelArray, minPathLength) {
  const w = binaryWidth;
  const h = binaryHeight;

  // Working copy — we mark visited pixels by setting them to 255.
  // The caller's array is left untouched.
  const consumed = new Uint8Array(binaryPixelArray);

  const paths = [];

  // 8-connected neighbour offsets, ordered to favour horizontal/vertical
  // continuity (straight lines stay straight rather than zigzagging diagonally).
  const DIRS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],   // cardinal first
    [1, 1], [1, -1], [-1, 1], [-1, -1], // diagonals second
  ];

  function isLive(x, y) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    return consumed[y * w + x] === 0;
  }

  function consume(x, y) {
    consumed[y * w + x] = 255;
  }

  function pickNeighbor(x, y) {
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (isLive(nx, ny)) return [nx, ny];
    }
    return null;
  }

  // ── Scan and walk ──────────────────────────────────────────────────────────
  // Scanning top→bottom, left→right means the first unvisited pixel of any
  // connected chain is almost always a true endpoint (top-left tip), so the
  // forward walk captures the full stroke without needing a separate backward
  // pass.

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!isLive(x, y)) continue;

      // Start chain from this pixel
      consume(x, y);
      const pts = [[x, y]];

      let cx = x;
      let cy = y;
      while (true) {
        const next = pickNeighbor(cx, cy);
        if (!next) break;
        [cx, cy] = next;
        consume(cx, cy);
        pts.push([cx, cy]);
      }

      if (pts.length < minPathLength) continue;

      const path = new paper.Path();
      path.strokeColor = new paper.Color(0, 0, 0);
      path.strokeWidth = 1;
      path.fillColor = null;

      for (const [px, py] of pts) {
        path.add(new paper.Point(px, py));
      }

      // Replace the pixel-staircase with smooth Bézier curves.
      // Tolerance of 1.5 px preserves plotter-relevant detail while
      // eliminating the jagged single-pixel steps on diagonal edges.
      path.simplify(1.5);

      paths.push(path);
    }
  }

  return paths;
}
