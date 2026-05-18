/**
 * Skeletonize — Single-Line Skeletonization with Variable Z-Axis Thickness
 *
 * Replaces boundary-tracing algorithms (d3-contour / Potrace) with a pipeline
 * that extracts the Medial Axis (skeleton) of rasterized shapes and maps local
 * thickness to Z-axis depth for variable-width calligraphic plotting.
 *
 * ── Pipeline ────────────────────────────────────────────────────
 *   1. Convert grayscale ImageData → binary grid (0 = white, 1 = black)
 *   2. Compute Euclidean Distance Transform (EDT) for local thickness
 *   3. Run Zhang-Suen thinning to reduce shapes to 1-pixel-wide skeleton
 *   4. Walk the skeleton using Moore-Neighbor tracing → ordered coordinate arrays
 *   5. Sample thickness at each skeleton point from the EDT
 *   6. Map thickness → Z-depth using a pluggable MarkerCalibrationProfile
 *   7. Create Paper.js Path objects with Z-depth stored in segment.data.zDepth
 *   8. Split paths at Z-depth discontinuities for smooth transitions
 *
 * ── Output ──────────────────────────────────────────────────────
 * Paper.js Path objects with:
 *   - strokeColor: 'black', strokeWidth: 1, fillColor: null (strict lines)
 *   - Each segment has segment.data.zDepth (mm) for G-code export
 *   - Paths are split where Z-depth changes abruptly (> threshold)
 *
 * ── Key Design Decisions ────────────────────────────────────────
 * - Distance Transform is computed BEFORE thinning so we have accurate
 *   thickness measurements at every pixel of the original shape.
 * - Thickness is sampled at skeleton points after thinning.
 * - Z-depth is stored as metadata on segments, not as strokeWidth,
 *   because the plotter controls thickness via Z-axis, not CSS.
 * - Path splitting prevents abrupt Z-jumps mid-stroke.
 */

import paper from 'paper';
import { computeDistanceTransform, sampleThicknessAtPoints } from './DistanceTransform.js';
import { getProfile } from './MarkerCalibrationProfile.js';

// ============================================================
// Step 1: Binary Grid Conversion
// ============================================================

/**
 * Convert grayscale ImageData into a binary 2D grid.
 * @param {ImageData} imageData
 * @param {number} threshold — brightness threshold (0–255), pixels darker than
 *                             this become 1 (black/ink), lighter become 0 (white)
 * @returns {{ grid: Uint8Array, width: number, height: number }}
 */
function imageDataToBinary(imageData, threshold = 128) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const grid = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      // Perceived luminance (Rec. 601 luma)
      const lum = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      // Pixel is "ink" (1) if darker than threshold
      grid[y * w + x] = lum < threshold ? 1 : 0;
    }
  }

  return { grid, width: w, height: h };
}

// ============================================================
// Step 2: Zhang-Suen Thinning Algorithm
// ============================================================

/**
 * Zhang-Suen fast parallel thinning algorithm.
 *
 * Iteratively removes boundary pixels while preserving connectivity,
 * until the shape is reduced to a 1-pixel-wide skeleton (centerline).
 *
 * Reference: "A fast parallel algorithm for thinning digital patterns"
 *            T. Y. Zhang and C. Y. Suen, CACM 1984
 *
 * @param {Uint8Array} grid — binary grid (0=white, 1=black)
 * @param {number} w — width
 * @param {number} h — height
 * @returns {Uint8Array} — thinned binary grid
 */
function zhangSuenThinning(grid, w, h) {
  // Work on a copy
  const result = new Uint8Array(grid);
  let changed = true;

  while (changed) {
    changed = false;

    // ---- Sub-iteration 1: remove south-east boundary pixels ----
    const markers1 = [];

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (result[p] === 0) continue;

        // 8-neighbors in clockwise order:
        //  P9 P2 P3
        //  P8 P1 P4
        //  P7 P6 P5
        const p2 = result[p - w];       // north
        const p3 = result[p - w + 1];   // north-east
        const p4 = result[p + 1];        // east
        const p5 = result[p + w + 1];    // south-east
        const p6 = result[p + w];        // south
        const p7 = result[p + w - 1];    // south-west
        const p8 = result[p - 1];       // west
        const p9 = result[p - w - 1];   // north-west

        // Condition A: 2 <= B(P1) <= 6  (number of black neighbors)
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;

        // Condition B: A(P1) = 1  (number of 0→1 transitions in ordered cycle)
        let A = 0;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        for (let i = 0; i < 8; i++) {
          if (seq[i] === 0 && seq[i + 1] === 1) A++;
        }
        if (A !== 1) continue;

        // Condition C: P2 * P4 * P6 = 0
        if (p2 * p4 * p6 !== 0) continue;

        // Condition D: P4 * P6 * P8 = 0
        if (p4 * p6 * p8 !== 0) continue;

        markers1.push(p);
      }
    }

    // Apply markers
    for (const p of markers1) {
      result[p] = 0;
      changed = true;
    }

    // ---- Sub-iteration 2: remove north-west boundary pixels ----
    const markers2 = [];

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        if (result[p] === 0) continue;

        const p2 = result[p - w];
        const p3 = result[p - w + 1];
        const p4 = result[p + 1];
        const p5 = result[p + w + 1];
        const p6 = result[p + w];
        const p7 = result[p + w - 1];
        const p8 = result[p - 1];
        const p9 = result[p - w - 1];

        // Condition A
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;

        // Condition B
        let A = 0;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        for (let i = 0; i < 8; i++) {
          if (seq[i] === 0 && seq[i + 1] === 1) A++;
        }
        if (A !== 1) continue;

        // Condition C': P2 * P4 * P8 = 0
        if (p2 * p4 * p8 !== 0) continue;

        // Condition D': P2 * P6 * P8 = 0
        if (p2 * p6 * p8 !== 0) continue;

        markers2.push(p);
      }
    }

    // Apply markers
    for (const p of markers2) {
      result[p] = 0;
      changed = true;
    }
  }

  return result;
}

// ============================================================
// Step 3: Moore-Neighbor Centerline Walking
// ============================================================

/**
 * Moore-Neighbor contour tracing adapted for centerline walking.
 *
 * Given a binary skeleton (1-pixel-wide), trace each connected
 * component into an ordered array of {x, y} coordinates.
 *
 * @param {Uint8Array} skeleton — thinned binary grid
 * @param {number} w — width
 * @param {number} h — height
 * @returns {Array<Array<{x: number, y: number}>>} — array of paths
 */
function traceCenterlines(skeleton, w, h) {
  const visited = new Uint8Array(w * h);
  const paths = [];

  // Moore neighborhood offsets (clockwise starting from west)
  const mooreDirs = [
    { dx: -1, dy: 0 },  // west
    { dx: -1, dy: -1 }, // north-west
    { dx: 0, dy: -1 },  // north
    { dx: 1, dy: -1 },  // north-east
    { dx: 1, dy: 0 },   // east
    { dx: 1, dy: 1 },   // south-east
    { dx: 0, dy: 1 },   // south
    { dx: -1, dy: 1 },  // south-west
  ];

  /**
   * Check if a pixel is a skeleton pixel (1) and optionally not visited.
   */
  function isSkeleton(x, y, checkVisited = true) {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const idx = y * w + x;
    return skeleton[idx] === 1 && (!checkVisited || visited[idx] === 0);
  }

  /**
   * Count skeleton neighbors (for detecting junctions/endpoints).
   */
  function countNeighbors(x, y) {
    let count = 0;
    for (const dir of mooreDirs) {
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      if (nx >= 0 && nx < w && ny >= 0 && ny < h && skeleton[ny * w + nx] === 1) {
        count++;
      }
    }
    return count;
  }

  /**
   * Find the next direction index to continue tracing.
   */
  function findNextDirection(x, y, prevDirIdx) {
    const startIdx = (prevDirIdx + 2) % 8;
    for (let i = 0; i < 8; i++) {
      const dirIdx = (startIdx + i) % 8;
      const dir = mooreDirs[dirIdx];
      const nx = x + dir.dx;
      const ny = y + dir.dy;
      if (isSkeleton(nx, ny, true)) {
        return dirIdx;
      }
    }
    return -1;
  }

  // Collect all skeleton pixel positions
  const allPixels = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (skeleton[y * w + x] === 1) {
        allPixels.push({ x, y });
      }
    }
  }

  // Sort: endpoints first (1 neighbor), then mid-line (2 neighbors),
  // then junctions (3+ neighbors).
  allPixels.sort((a, b) => {
    const na = countNeighbors(a.x, a.y);
    const nb = countNeighbors(b.x, b.y);
    return na - nb;
  });

  for (const start of allPixels) {
    const idx = start.y * w + start.x;
    if (visited[idx]) continue;

    const nCount = countNeighbors(start.x, start.y);
    // Skip isolated pixels
    if (nCount === 0) {
      visited[idx] = 1;
      continue;
    }

    // Start a new path
    const path = [{ x: start.x, y: start.y }];
    visited[idx] = 1;

    // Determine initial direction
    let currentDir = -1;
    for (let d = 0; d < 8; d++) {
      const dir = mooreDirs[d];
      const nx = start.x + dir.dx;
      const ny = start.y + dir.dy;
      if (isSkeleton(nx, ny, true)) {
        currentDir = d;
        break;
      }
    }

    if (currentDir === -1) continue;

    // Walk forward
    let cx = start.x + mooreDirs[currentDir].dx;
    let cy = start.y + mooreDirs[currentDir].dy;

    while (cx >= 0 && cx < w && cy >= 0 && cy < h) {
      const pi = cy * w + cx;
      if (skeleton[pi] === 0 || visited[pi]) break;

      visited[pi] = 1;
      path.push({ x: cx, y: cy });

      const nextDir = findNextDirection(cx, cy, currentDir);
      if (nextDir === -1) break;

      currentDir = nextDir;
      cx += mooreDirs[currentDir].dx;
      cy += mooreDirs[currentDir].dy;
    }

    // Only keep paths with at least 2 points
    if (path.length >= 2) {
      paths.push(path);
    }
  }

  return paths;
}

// ============================================================
// Step 4: Thickness Sampling & Z-Depth Mapping
// ============================================================

/**
 * Sample thickness from the Distance Transform at each skeleton point,
 * then map to Z-depth using the calibration profile.
 *
 * @param {Array<Array<{x: number, y: number}>>} centerlines — raw pixel paths
 * @param {Float64Array} distanceMap — EDT result (w × h)
 * @param {number} w — image width
 * @param {number} h — image height
 * @param {object} calibrationProfile — MarkerCalibrationProfile object
 * @param {number} pixelsPerMm — conversion factor (pixels per mm)
 * @returns {Array<Array<{x: number, y: number, zDepth: number}>>}
 */
function mapZDepth(centerlines, distanceMap, w, h, calibrationProfile, pixelsPerMm) {
  const result = [];

  for (const chain of centerlines) {
    const thicknessPixels = sampleThicknessAtPoints(distanceMap, w, h, chain);
    const mappedChain = [];

    for (let i = 0; i < chain.length; i++) {
      const pt = chain[i];
      // Convert thickness from pixels to mm
      const thicknessMm = thicknessPixels[i] / pixelsPerMm;
      // Map to Z-depth using the calibration profile
      const zDepth = calibrationProfile.mapThicknessToZ(thicknessMm);

      mappedChain.push({
        x: pt.x,
        y: pt.y,
        zDepth,
      });
    }

    result.push(mappedChain);
  }

  return result;
}

// ============================================================
// Step 5: Path Splitting at Z-Depth Discontinuities
// ============================================================

/**
 * Split a chain of points at locations where the Z-depth changes abruptly.
 *
 * This prevents the plotter from making sudden Z-axis jumps mid-stroke,
 * which would cause visible blobs or skips. Instead, we split the path
 * so each segment has a smooth Z transition.
 *
 * @param {Array<{x: number, y: number, zDepth: number}>} chain
 * @param {number} maxZStep — maximum allowed Z change between consecutive points (mm)
 * @param {number} minSegmentLength — minimum points in a split segment
 * @returns {Array<Array<{x: number, y: number, zDepth: number}>>}
 */
function splitAtZDiscontinuities(chain, maxZStep = 0.3, minSegmentLength = 3) {
  if (chain.length < minSegmentLength) return [chain];

  const segments = [];
  let current = [chain[0]];

  for (let i = 1; i < chain.length; i++) {
    const prev = chain[i - 1];
    const curr = chain[i];
    const zDelta = Math.abs(curr.zDepth - prev.zDepth);

    if (zDelta > maxZStep && current.length >= minSegmentLength) {
      // Close the current segment and start a new one
      // Include the previous point as the last point of the current segment
      // to maintain continuity
      segments.push(current);
      current = [prev, curr];
    } else {
      current.push(curr);
    }
  }

  // Push the last segment
  if (current.length >= 2) {
    segments.push(current);
  } else if (current.length === 1 && segments.length > 0) {
    // Append orphan point to the last segment
    segments[segments.length - 1].push(current[0]);
  }

  return segments;
}

// ============================================================
// Step 6: Paper.js Path Creation with Z-Depth Metadata
// ============================================================

/**
 * Convert Z-mapped centerline chains into Paper.js Path objects.
 *
 * Each segment gets:
 *   - segment.point — the (x, y) coordinate
 *   - segment.data.zDepth — the Z-axis depth for this point (mm)
 *
 * Paths are smoothed with Paper.js simplify() to convert jagged
 * pixel steps into smooth curves, while preserving Z-depth data.
 *
 * @param {paper.Project} project — Paper.js project
 * @param {Array<Array<{x: number, y: number, zDepth: number}>>} chains — Z-mapped chains
 * @param {number} simplifyTolerance — tolerance for path.simplify()
 * @param {number} minPathLength — minimum path length in pixels to keep
 */
function chainsToPaperPaths(project, chains, simplifyTolerance = 2.5, minPathLength = 5) {
  const layer = project.activeLayer;

  for (const chain of chains) {
    if (chain.length < 2) continue;

    const path = new paper.Path();
    path.strokeColor = new paper.Color('black');
    path.strokeWidth = 1;
    path.fillColor = null;

    for (const p of chain) {
      const seg = new paper.Segment(new paper.Point(p.x, p.y));
      // Store Z-depth as custom metadata on the segment
      seg.data = { zDepth: p.zDepth };
      path.addSegments([seg]);
    }

    // Apply Paper.js simplify() to convert jagged pixel steps into
    // smooth Bézier curves. After simplify(), segments may be added
    // or removed. We need to re-interpolate Z-depth on the new segments.
    path.simplify(simplifyTolerance);

    // Re-interpolate Z-depth on simplified segments
    interpolateZDepthOnSimplifiedPath(path, chain);

    // Filter out tiny artifact paths
    if (path.length < minPathLength || path.segments.length < 2) {
      path.remove();
      continue;
    }

    layer.addChild(path);
  }
}

/**
 * After path.simplify(), the number and position of segments may change.
 * This function re-interpolates Z-depth values from the original chain
 * onto the simplified path's segments using linear interpolation along
 * the path's curve length.
 *
 * @param {paper.Path} path — the simplified Paper.js path
 * @param {Array<{x: number, y: number, zDepth: number}>} originalChain — original points with Z
 */
function interpolateZDepthOnSimplifiedPath(path, originalChain) {
  if (originalChain.length < 2 || path.segments.length < 2) return;

  // Compute cumulative arc length of the original chain
  const origLengths = [0];
  for (let i = 1; i < originalChain.length; i++) {
    const dx = originalChain[i].x - originalChain[i - 1].x;
    const dy = originalChain[i].y - originalChain[i - 1].y;
    origLengths.push(origLengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalOrigLength = origLengths[origLengths.length - 1];
  if (totalOrigLength === 0) return;

  // Compute cumulative arc length of the simplified path
  const segs = path.segments;
  const simpLengths = [0];
  for (let i = 1; i < segs.length; i++) {
    const dx = segs[i].point.x - segs[i - 1].point.x;
    const dy = segs[i].point.y - segs[i - 1].point.y;
    simpLengths.push(simpLengths[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalSimpLength = simpLengths[simpLengths.length - 1];
  if (totalSimpLength === 0) return;

  // For each simplified segment, find its position along the total length
  // and interpolate Z from the original chain
  for (let i = 0; i < segs.length; i++) {
    const t = simpLengths[i] / totalSimpLength; // 0..1 along simplified path
    const origPos = t * totalOrigLength;

    // Find the two original points that bracket this position
    let lo = 0;
    let hi = origLengths.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >>> 1;
      if (origLengths[mid] < origPos) lo = mid;
      else hi = mid;
    }

    // Linear interpolation between originalChain[lo] and originalChain[hi]
    const segLen = origLengths[hi] - origLengths[lo];
    const localT = segLen > 0 ? (origPos - origLengths[lo]) / segLen : 0;
    const zLo = originalChain[lo].zDepth;
    const zHi = originalChain[hi].zDepth;
    const zInterp = zLo + localT * (zHi - zLo);

    segs[i].data = { zDepth: zInterp };
  }
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Run the full skeletonization + Z-mapping pipeline:
 *   1. Binary grid conversion
 *   2. Euclidean Distance Transform (for thickness measurement)
 *   3. Zhang-Suen thinning
 *   4. Centerline walking
 *   5. Thickness sampling & Z-depth mapping
 *   6. Path splitting at Z discontinuities
 *   7. Paper.js path creation with Z-depth metadata
 *
 * @param {paper.Project} project — Paper.js project to populate
 * @param {ImageData} imageData — pre-processed grayscale pixel data
 * @param {object} params
 * @param {number} [params.threshold=128] — binarization threshold (0–255)
 * @param {number} [params.simplifyTolerance=2.5] — path smoothing tolerance
 * @param {number} [params.minPathLength=5] — minimum path length in pixels
 * @param {number} [params.maxZStep=0.3] — max Z change before splitting path (mm)
 * @param {string} [params.calibrationProfile='sharpieFinePoint'] — marker profile name
 * @param {number} [params.pixelsPerMm=4] — pixels per mm (for thickness conversion)
 * @param {object} [params.customCalibration] — custom calibration options (if profile='custom')
 * @returns {{ pathCount: number, totalPoints: number }}
 */
export function generateSkeletonTrace(project, imageData, params = {}) {
  const {
    threshold = 128,
    simplifyTolerance = 2.5,
    minPathLength = 5,
    maxZStep = 0.3,
    calibrationProfile = 'sharpieFinePoint',
    pixelsPerMm = 4,
    customCalibration,
  } = params;

  // Resolve calibration profile
  const profile = getProfile(calibrationProfile, customCalibration);

  // Step 1: Convert to binary grid
  const { grid, width, height } = imageDataToBinary(imageData, threshold);

  // Step 2: Compute Euclidean Distance Transform (for thickness)
  // This is done BEFORE thinning so we measure the original shape's thickness
  const distanceMap = computeDistanceTransform(grid, width, height);

  // Step 3: Zhang-Suen thinning
  const skeleton = zhangSuenThinning(grid, width, height);

  // Step 4: Trace centerlines
  const centerlines = traceCenterlines(skeleton, width, height);

  // Step 5: Map thickness → Z-depth
  const zMappedChains = mapZDepth(centerlines, distanceMap, width, height, profile, pixelsPerMm);

  // Step 6: Split paths at Z discontinuities
  const splitChains = [];
  for (const chain of zMappedChains) {
    const segments = splitAtZDiscontinuities(chain, maxZStep);
    splitChains.push(...segments);
  }

  // Step 7: Create Paper.js paths with Z-depth metadata
  chainsToPaperPaths(project, splitChains, simplifyTolerance, minPathLength);

  return {
    pathCount: splitChains.length,
    totalPoints: splitChains.reduce((sum, p) => sum + p.length, 0),
  };
}

// Export individual steps for testing/debugging and reuse (Calligraphy.js)
export {
  imageDataToBinary,
  zhangSuenThinning,
  traceCenterlines,
  mapZDepth,
  splitAtZDiscontinuities,
  interpolateZDepthOnSimplifiedPath,
  chainsToPaperPaths,
};
