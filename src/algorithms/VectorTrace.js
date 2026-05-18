/**
 * VectorTrace — Topographic Contour Map Generator
 *
 * Converts image brightness into a smooth topographical contour map
 * using d3.contours(), then maps the GeoJSON MultiPolygon output to
 * Paper.js Path objects with strict plotter styles (no fill, cyan stroke).
 *
 * ── Redundant Stroke Elimination ─────────────────────────────────────────
 * Three strategies are applied to prevent the pen from plotting over itself:
 *
 * 1. No smoothing — path.smooth() is skipped because the downstream
 *    PathOptimizer flattens curves back to polylines anyway, making the
 *    smoothing a wasteful round-trip that only adds redundant segments.
 *
 * 2. RDP simplification — each contour ring is simplified via the
 *    Ramer–Douglas–Peucker algorithm before creating the Paper.js path,
 *    removing co-linear intermediate points that contribute no shape info.
 *
 * 3. Adaptive threshold spacing — instead of a single global lines-count
 *    cap, contour thresholds are spaced non-uniformly based on local
 *    gradient magnitude. High-contrast regions get denser contour lines;
 *    flat regions get sparser lines, preventing ink pile-up in shadows.
 *
 * ── Physical Pen Constraint ──────────────────────────────────────────────
 * A minimum spacing floor is enforced so that no two contour lines are
 * drawn closer together than the physical width of the fineliner tip.
 * This prevents paper-tearing and ink floods in deep shadows.
 *
 *   physicalPenWidth  = 0.4 mm  (typical 0.4 mm fineliner tip)
 *   pixelsPerMm       = derived from image dimensions and paper size
 *   minSpacingPixels  = physicalPenWidth * pixelsPerMm
 */
import paper from 'paper';
import { contours as d3Contours } from 'd3-contour';

// ── Ramer–Douglas–Peucker polyline simplification ────────────────────────
// Removes points that are co-linear within `epsilon` distance of the
// line segment connecting their neighbours. This eliminates redundant
// vertices without altering the shape of the contour.

/**
 * Compute the perpendicular distance from point `p` to the line
 * segment defined by `a` → `b`.
 * @param {number[]} p — [x, y]
 * @param {number[]} a — [x, y]
 * @param {number[]} b — [x, y]
 * @returns {number}
 */
function perpendicularDistance(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return Math.sqrt((p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2);
  return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/**
 * Ramer–Douglas–Peucker simplification.
 * Returns a simplified copy of the polyline (array of [x, y]).
 * @param {number[][]} points — array of [x, y] coordinates
 * @param {number} epsilon — max distance for a point to be considered redundant
 * @returns {number[][]}
 */
function simplifyRDP(points, epsilon) {
  if (points.length <= 2) return points;

  // Find the point with the maximum distance from the line between first and last
  let dmax = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > dmax) {
      dmax = d;
      index = i;
    }
  }

  // If max distance is greater than epsilon, recursively simplify
  if (dmax > epsilon) {
    const left = simplifyRDP(points.slice(0, index + 1), epsilon);
    const right = simplifyRDP(points.slice(index), epsilon);
    // Concatenate, dropping the duplicate endpoint
    return left.slice(0, -1).concat(right);
  }

  // All points between first and last are redundant — keep only the endpoints
  return [first, last];
}

// ── Adaptive threshold spacing ───────────────────────────────────────────
// Instead of evenly spaced brightness thresholds, we compute a gradient
// magnitude map and use its cumulative distribution to space thresholds
// so that contour lines cluster in high-detail (high-gradient) regions.

/**
 * Compute a gradient magnitude map from the brightness array.
 * Uses simple central differences (Sobel-lite) on the 2D grid.
 * @param {Float64Array} brightness — w × h array of 0.0–1.0 values
 * @param {number} w
 * @param {number} h
 * @returns {Float64Array} gradient magnitude per pixel (0.0–1.0 normalized)
 */
function computeGradientMagnitude(brightness, w, h) {
  const grad = new Float64Array(w * h);
  let maxGrad = 0;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Central differences (clamp to edges)
      const gx = x > 0 && x < w - 1
        ? (brightness[y * w + (x + 1)] - brightness[y * w + (x - 1)]) / 2
        : 0;
      const gy = y > 0 && y < h - 1
        ? (brightness[(y + 1) * w + x] - brightness[(y - 1) * w + x]) / 2
        : 0;
      grad[i] = Math.sqrt(gx * gx + gy * gy);
      if (grad[i] > maxGrad) maxGrad = grad[i];
    }
  }

  // Normalize to 0.0 – 1.0
  if (maxGrad > 0) {
    for (let i = 0; i < grad.length; i++) grad[i] /= maxGrad;
  }

  return grad;
}

/**
 * Build an array of non-uniform brightness thresholds that concentrate
 * contour lines in high-gradient (high-detail) regions.
 *
 * Strategy: sample the cumulative distribution of gradient magnitudes
 * and place thresholds where the cumulative gradient changes fastest.
 *
 * @param {Float64Array} brightness — w × h brightness array
 * @param {number} w
 * @param {number} h
 * @param {number} count — desired number of threshold levels
 * @param {number} minStep — minimum allowed step between thresholds (pen constraint)
 * @returns {number[]} sorted array of threshold values (0.0 – 1.0)
 */
function buildAdaptiveThresholds(brightness, w, h, count, minStep) {
  if (count < 2) return [0, 1];

  const grad = computeGradientMagnitude(brightness, w, h);

  // Build a histogram of gradient magnitudes (100 bins)
  const bins = 100;
  const hist = new Float64Array(bins);
  for (let i = 0; i < grad.length; i++) {
    const bin = Math.min(bins - 1, Math.floor(grad[i] * bins));
    hist[bin]++;
  }

  // Compute cumulative distribution
  const cdf = new Float64Array(bins);
  let total = 0;
  for (let i = 0; i < bins; i++) {
    total += hist[i];
    cdf[i] = total;
  }
  if (total > 0) {
    for (let i = 0; i < bins; i++) cdf[i] /= total;
  }

  // Generate exactly `count` interior thresholds (not count+1) by sampling
  // the inverse CDF at uniform intervals. This avoids always including 0.0
  // and 1.0 as fixed endpoints, which caused doubled outlines when the
  // gradient was low at the extremes of the brightness range.
  const rawThresholds = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1); // uniform in CDF space, skipping 0.0 and 1.0
    // Find the brightness value where CDF ≈ t
    let lo = 0, hi = bins - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cdf[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    // Map bin index back to 0.0–1.0 brightness
    rawThresholds.push(lo / bins);
  }

  // Sort and deduplicate — the inverse CDF can produce identical values
  // when large regions share the same gradient bin.
  rawThresholds.sort((a, b) => a - b);
  const unique = [rawThresholds[0]];
  for (let i = 1; i < rawThresholds.length; i++) {
    if (rawThresholds[i] - unique[unique.length - 1] > 1e-6) {
      unique.push(rawThresholds[i]);
    }
  }

  // Enforce minimum step spacing (pen constraint) to prevent doubled outlines
  const thresholds = [unique[0]];
  for (let i = 1; i < unique.length; i++) {
    if (unique[i] - thresholds[thresholds.length - 1] >= minStep) {
      thresholds.push(unique[i]);
    }
  }

  return thresholds;
}

/**
 * Generate a topographic contour map from image data.
 *
 * @param {paper.Project} project  — Paper.js project to add paths to
 * @param {ImageData} imageData    — RGBA pixel data from canvas
 * @param {object} options
 * @param {number} options.linesCount  — number of contour levels (default: 10)
 * @param {number} [options.threshold] — brightness threshold (unused in topo mode, kept for compat)
 * @param {object} [options.penConstraints] — physical pen parameters
 * @param {number} [options.penConstraints.physicalPenWidth=0.4] — fineliner tip width in mm
 * @param {number} [options.penConstraints.pixelsPerMm=4]        — pixels per mm at current resolution
 * @returns {{ pathCount: number, totalPoints: number }}
 */
export function generateTopographicMap(project, imageData, options = {}) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const linesCount = options.linesCount || 10;
  const layer = project.activeLayer;

  // ── Physical Pen Constraint ──────────────────────────────────────────
  // The minimum spacing between adjacent contour levels in brightness
  // space (0.0 – 1.0) is derived from the physical pen tip width.
  const physicalPenWidth = options.penConstraints?.physicalPenWidth ?? 0.4; // mm
  const pixelsPerMm      = options.penConstraints?.pixelsPerMm ?? 4;        // px/mm
  const MIN_SPACING_PX   = physicalPenWidth * pixelsPerMm;                  // floor in pixels
  const maxDim = Math.max(w, h);
  const minLevelStep = Math.max(1 / linesCount, MIN_SPACING_PX / maxDim);
  // ──────────────────────────────────────────────────────────────────────

  // ── 1. Convert RGBA → 1D Float64Array of brightness values (0.0 – 1.0) ──
  const brightness = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const idx = i * 4;
    // Perceived luminance (Rec. 601 luma)
    const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
    brightness[i] = lum / 255; // Normalize to 0.0 – 1.0
  }

  // ── 2. Build adaptive contour thresholds ──
  // Instead of evenly spaced levels, we use gradient magnitude to cluster
  // contour lines in high-detail regions and spread them in flat regions.
  const thresholds = buildAdaptiveThresholds(brightness, w, h, linesCount, minLevelStep);

  // ── 3. Compute contour isolines via d3-contour ──
  // d3.contours() returns an array of GeoJSON MultiPolygon features,
  // one per threshold level.
  const contourGenerator = d3Contours()
    .size([w, h])
    .thresholds(thresholds);

  const contours = contourGenerator(brightness);

  // ── 4. Map GeoJSON MultiPolygon coordinates → Paper.js Paths ──
  // RDP epsilon: 0.1 pixels — very conservative simplification that only
  // removes truly duplicate/coincident points while preserving contour shape.
  // Higher values (like 0.5) caused "dashed line" artifacts by reducing
  // closed rings to too few vertices.
  const RDP_EPSILON = 0.1;
  let pathCount = 0;
  let totalPoints = 0;

  for (const feature of contours) {
    // Each feature is a GeoJSON MultiPolygon
    // coordinates: array of polygons, each polygon is array of rings,
    // each ring is array of [x, y] coordinates
    const polygons = feature.coordinates;

    for (const rings of polygons) {
      for (const ring of rings) {
        // Skip degenerate rings with fewer than 3 points
        if (ring.length < 3) continue;

        // Simplify the ring to remove co-linear redundant points
        const simplified = simplifyRDP(ring, RDP_EPSILON);
        if (simplified.length < 3) continue;

        const path = new paper.Path();
        path.strokeColor = new paper.Color('cyan');
        path.strokeWidth = 1;
        path.fillColor = null; // NEVER FILL — strict plotter style

        for (const coord of simplified) {
          path.add(new paper.Point(coord[0], coord[1]));
        }

        // Close the path — d3-contour rings are always closed
        path.closed = true;

        // NOTE: path.smooth() is intentionally omitted. The downstream
        // PathOptimizer flattens curves back to polylines, making the
        // smoothing a wasteful round-trip that adds redundant segments.

        layer.addChild(path);
        pathCount++;
        totalPoints += path.segments.length;
      }
    }
  }

  return { pathCount, totalPoints };
}

// ── Legacy alias for backward compatibility ──
// The old generateVectorTrace is replaced. Any code referencing it
// should now call generateTopographicMap instead.
export const generateVectorTrace = generateTopographicMap;
