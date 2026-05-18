/**
 * DistanceTransform — Computes the Euclidean Distance Transform (EDT) of a
 * binary image using Meijster's algorithm (O(w×h) time, O(w×h) memory).
 *
 * For each foreground pixel (1 = ink), the EDT stores the Euclidean distance
 * to the nearest background pixel (0 = white). This distance map is used by
 * the skeletonization pipeline to:
 *
 *   1. Compute local thickness at each skeleton point (2 × distance).
 *   2. Guide the thinning process (optional).
 *
 * ── Algorithm ───────────────────────────────────────────────────
 * Meijster's distance transform is a two-pass, dimension-separable approach:
 *
 *   Phase 1 (columns):  For each column, compute the squared distance to
 *                       the nearest background pixel in that column.
 *   Phase 2 (rows):     For each row, combine column distances using the
 *                       lower envelope of parabolas to get the true EDT.
 *
 * Reference: "A General Algorithm for Computing Distance Transforms in
 *            Linear Time" — A. Meijster, J.B.T.M. Roerdink, W.H. Hesselink
 *            (Mathematical Morphology and its Applications to Image and
 *             Signal Processing, 2000)
 *
 * ── Output ──────────────────────────────────────────────────────
 * A Float64Array of the same dimensions as the input grid, where each
 * element is the Euclidean distance (in pixels) to the nearest background
 * pixel. For background pixels (0 in the input), the distance is 0.
 */

/**
 * Compute the squared Euclidean Distance Transform of a binary grid.
 *
 * @param {Uint8Array} grid — binary grid (0 = background/white, 1 = foreground/ink)
 * @param {number} w — width in pixels
 * @param {number} h — height in pixels
 * @returns {Float64Array} — squared distances (w × h)
 */
function computeSquaredEDT(grid, w, h) {
  // ── Phase 1: Column-wise distance to nearest foreground pixel ──
  // For each column x, compute g[x][y] = (y - nearest_foreground_y)²
  // where nearest_foreground_y is the closest y with grid[y*w + x] === 1.
  // If no foreground pixel exists in the column, the distance is infinity.

  const INF = 1e20;
  const g = new Float64Array(w * h);

  for (let x = 0; x < w; x++) {
    // Scan top → bottom
    let nearest = -INF;
    for (let y = 0; y < h; y++) {
      if (grid[y * w + x] === 1) {
        nearest = y;
      }
      const diff = nearest === -INF ? INF : y - nearest;
      g[y * w + x] = diff * diff;
    }

    // Scan bottom → top
    nearest = INF;
    for (let y = h - 1; y >= 0; y--) {
      if (grid[y * w + x] === 1) {
        nearest = y;
      }
      if (nearest !== INF) {
        const diff = nearest - y;
        const d2 = diff * diff;
        if (d2 < g[y * w + x]) {
          g[y * w + x] = d2;
        }
      }
    }
  }

  // ── Phase 2: Row-wise lower envelope of parabolas ──
  // For each row y, compute the final squared EDT by combining the
  // column-wise distances using the lower envelope of parabolas.
  // This is the Meijster "row" pass.

  const f = new Float64Array(w * h);

  for (let y = 0; y < h; y++) {
    // Compute the lower envelope of parabolas for this row.
    // Each column x defines a parabola: (x - t)² + g[y][x]
    // We find, for each column, which parabola gives the minimum value.

    const envelope = new Int32Array(w);   // column index of the parabola
    const boundary = new Float64Array(w); // x-coordinate of the intersection boundary
    let envelopeSize = 0;

    for (let x = 0; x < w; x++) {
      const gVal = g[y * w + x];

      // Compute the intersection of the parabola at `x` with the last
      // parabola in the envelope.
      let boundaryX = 0;
      while (envelopeSize > 0) {
        const lastCol = envelope[envelopeSize - 1];
        const lastG = g[y * w + lastCol];

        // Intersection of parabolas (x - t)² + gVal and (lastCol - t)² + lastG
        // Solve: (x - t)² + gVal = (lastCol - t)² + lastG
        // => t = (x² + gVal - lastCol² - lastG) / (2 * (x - lastCol))
        const numerator = x * x + gVal - lastCol * lastCol - lastG;
        const denominator = 2 * (x - lastCol);

        if (denominator <= 0) {
          // Shouldn't happen for well-ordered columns, but guard against it
          envelopeSize--;
          continue;
        }

        boundaryX = numerator / denominator;

        if (boundaryX <= boundary[envelopeSize - 1]) {
          // The last parabola is completely dominated by the new one
          envelopeSize--;
        } else {
          break;
        }
      }

      envelope[envelopeSize] = x;
      boundary[envelopeSize] = boundaryX;
      envelopeSize++;
    }

    // Evaluate the lower envelope at each column
    let envIdx = 0;
    for (let x = 0; x < w; x++) {
      // Advance to the correct parabola segment
      while (envIdx < envelopeSize - 1 && boundary[envIdx + 1] <= x) {
        envIdx++;
      }

      const col = envelope[envIdx];
      const dx = x - col;
      f[y * w + x] = dx * dx + g[y * w + col];
    }
  }

  return f;
}

/**
 * Compute the Euclidean Distance Transform (actual distance, not squared).
 *
 * @param {Uint8Array} grid — binary grid (0 = background, 1 = foreground)
 * @param {number} w — width in pixels
 * @param {number} h — height in pixels
 * @returns {Float64Array} — Euclidean distances (w × h)
 */
function computeDistanceTransform(grid, w, h) {
  const squared = computeSquaredEDT(grid, w, h);
  const result = new Float64Array(squared.length);
  for (let i = 0; i < squared.length; i++) {
    result[i] = Math.sqrt(squared[i]);
  }
  return result;
}

/**
 * Sample the distance transform at a set of skeleton points.
 * Returns the local thickness (2 × distance) at each point.
 *
 * @param {Float64Array} distanceMap — EDT result (w × h)
 * @param {number} w — width in pixels
 * @param {number} h — height in pixels
 * @param {Array<{x: number, y: number}>} skeletonPoints — array of points
 * @returns {Float64Array} — local thickness at each point (in pixels)
 */
function sampleThicknessAtPoints(distanceMap, w, h, skeletonPoints) {
  const thickness = new Float64Array(skeletonPoints.length);
  for (let i = 0; i < skeletonPoints.length; i++) {
    const px = Math.round(skeletonPoints[i].x);
    const py = Math.round(skeletonPoints[i].y);
    if (px >= 0 && px < w && py >= 0 && py < h) {
      // Thickness = 2 × distance to nearest background edge
      thickness[i] = 2 * distanceMap[py * w + px];
    } else {
      thickness[i] = 0;
    }
  }
  return thickness;
}

export {
  computeSquaredEDT,
  computeDistanceTransform,
  sampleThicknessAtPoints,
};
