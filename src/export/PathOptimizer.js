/**
 * PathOptimizer — Plotter Path Optimization for the Vitro Vector Engine.
 *
 * Performs two critical operations on a Paper.js project before G-code export:
 *
 * 1. Segment Deduplication (Spatial Hashing)
 *    Breaks all paths into individual line segments and removes any segment
 *    that overlaps another (including reversed-direction duplicates).
 *
 * 2. Greedy Path Chaining (Line Merge)
 *    Chains remaining segments into the longest possible continuous paths,
 *    minimizing pen-up/pen-down transitions during plotting.
 *
 * This acts identically to vpype's `linemerge` command used by professional
 * plotting software — strips garbage, connects dots, saves ink and time.
 *
 * @module PathOptimizer
 */

import paper from 'paper';

/**
 * Round a number to the specified number of decimal places.
 * @param {number} value
 * @param {number} decimals
 * @returns {number}
 */
function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Generate a spatial hash key for a point, rounded to `tolerance` decimal places.
 * @param {number} x
 * @param {number} y
 * @param {number} tolerance — decimal places (e.g., 0.1 → 1 decimal place)
 * @returns {string} e.g., "12.3,45.6"
 */
function pointKey(x, y, tolerance) {
  const decimals = Math.max(0, Math.round(-Math.log10(tolerance)));
  return `${roundTo(x, decimals)},${roundTo(y, decimals)}`;
}

/**
 * Generate a canonical (direction-independent) spatial hash key for a segment.
 * The two endpoint keys are sorted lexicographically so that Start→End and
 * End→Start produce the same hash, enabling reversed-overlap detection.
 *
 * @param {paper.Point} a
 * @param {paper.Point} b
 * @param {number} tolerance
 * @returns {string}
 */
function segmentKey(a, b, tolerance) {
  const ka = pointKey(a.x, a.y, tolerance);
  const kb = pointKey(b.x, b.y, tolerance);
  // Sort lexicographically so direction doesn't matter
  return ka < kb ? `${ka}->${kb}` : `${kb}->${ka}`;
}

/**
 * Extract all individual line segments from a Paper.js path.
 * Flattens curves to polylines first, then yields {start, end} pairs.
 *
 * @param {paper.Path} path
 * @param {number} flattenTolerance — curve flattening tolerance in mm
 * @returns {Array<{start: paper.Point, end: paper.Point}>}
 */
function extractSegments(path, flattenTolerance = 0.1) {
  const segments = [];

  if (path.segments.length < 2) return segments;

  // Flatten curves to polylines so we get straight segments
  const clone = path.clone();
  clone.flatten(flattenTolerance);

  for (let i = 0; i < clone.segments.length - 1; i++) {
    segments.push({
      start: clone.segments[i].point.clone(),
      end: clone.segments[i + 1].point.clone(),
    });
  }

  // If the path is closed, also add the closing segment (last → first)
  if (clone.closed && clone.segments.length > 2) {
    segments.push({
      start: clone.segments[clone.segments.length - 1].point.clone(),
      end: clone.segments[0].point.clone(),
    });
  }

  clone.remove();
  return segments;
}

/**
 * Deduplicate an array of segments using spatial hashing.
 * Both Start→End and End→Start orientations are checked so that
 * reversed overlapping segments are caught and removed.
 *
 * @param {Array<{start: paper.Point, end: paper.Point}>} segments
 * @param {number} tolerance — coordinate rounding tolerance (mm)
 * @returns {Array<{start: paper.Point, end: paper.Point}>}
 */
function deduplicateSegments(segments, tolerance) {
  const seen = new Set();
  const result = [];

  for (const seg of segments) {
    const key = segmentKey(seg.start, seg.end, tolerance);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(seg);
    }
  }

  return result;
}

/**
 * Build a spatial index mapping rounded point keys to segment indices.
 * Each endpoint (start and end) of every unused segment is indexed,
 * enabling O(1) lookup of connecting segments instead of O(n) scans.
 *
 * @param {Array<{start: paper.Point, end: paper.Point, used: boolean}>} pool
 * @param {number} tolerance
 * @returns {Map<string, Array<{segIdx: number, isStart: boolean}>>}
 */
function buildSpatialIndex(pool, tolerance) {
  const index = new Map();
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].used) continue;
    const sk = pointKey(pool[i].start.x, pool[i].start.y, tolerance);
    const ek = pointKey(pool[i].end.x, pool[i].end.y, tolerance);
    if (!index.has(sk)) index.set(sk, []);
    if (!index.has(ek)) index.set(ek, []);
    index.get(sk).push({ segIdx: i, isStart: true });
    index.get(ek).push({ segIdx: i, isStart: false });
  }
  return index;
}

/**
 * Remove a segment's endpoints from the spatial index.
 * Called when a segment is consumed so it won't be found again.
 *
 * @param {Map<string, Array<{segIdx: number, isStart: boolean}>>} index
 * @param {{start: paper.Point, end: paper.Point}} seg
 * @param {number} segIdx
 * @param {number} tolerance
 */
function removeFromIndex(index, seg, segIdx, tolerance) {
  const sk = pointKey(seg.start.x, seg.start.y, tolerance);
  const ek = pointKey(seg.end.x, seg.end.y, tolerance);
  _removeEntry(index, sk, segIdx);
  _removeEntry(index, ek, segIdx);
}

function _removeEntry(index, key, segIdx) {
  const entries = index.get(key);
  if (!entries) return;
  const idx = entries.findIndex(e => e.segIdx === segIdx);
  if (idx !== -1) entries.splice(idx, 1);
  if (entries.length === 0) index.delete(key);
}

/**
 * Greedy path chaining: connect segments end-to-end into the longest
 * possible continuous paths, minimizing pen-up transitions.
 *
 * Uses a spatial hash index for O(1) endpoint lookups instead of O(n) scans.
 *
 * Algorithm:
 * 1. Build a spatial index mapping each endpoint coordinate → segment indices.
 * 2. Pick an unvisited segment to start a new chain.
 * 3. Look up the current chain tip in the spatial index to find connecting
 *    segments in O(1) time.
 * 4. If found, append it (reversing if needed) and remove from index.
 * 5. Repeat until no more matches, then start a new chain.
 * 6. Continue until all segments are consumed.
 *
 * @param {Array<{start: paper.Point, end: paper.Point}>} segments
 * @param {number} tolerance — point-matching tolerance (mm)
 * @returns {Array<Array<paper.Point>>} — array of chained point arrays
 */
function chainSegments(segments, tolerance) {
  if (segments.length === 0) return [];

  // Work on a copy we can mutate
  const pool = segments.map(s => ({
    start: s.start.clone(),
    end: s.end.clone(),
    used: false,
  }));

  // Build spatial index for O(1) endpoint lookups
  const index = buildSpatialIndex(pool, tolerance);

  const chains = [];

  // Helper: find the next segment that connects to the given point using the spatial index
  function findMatch(point) {
    const pk = pointKey(point.x, point.y, tolerance);
    const candidates = index.get(pk);
    if (!candidates || candidates.length === 0) return null;

    let bestIdx = -1;
    let bestDist = Infinity;
    let needsReverse = false;

    for (const candidate of candidates) {
      const seg = pool[candidate.segIdx];
      if (seg.used) continue;

      if (candidate.isStart) {
        // The indexed point is the segment's start → segment end connects to our point
        // Actually: if candidate.isStart, the indexed point IS seg.start
        // So our point matches seg.start → we need to append seg as-is (start→end)
        const dist = point.getDistance(seg.start);
        if (dist <= tolerance && dist < bestDist) {
          bestDist = dist;
          bestIdx = candidate.segIdx;
          needsReverse = false;
        }
      } else {
        // The indexed point is the segment's end → segment start connects to our point
        const dist = point.getDistance(seg.end);
        if (dist <= tolerance && dist < bestDist) {
          bestDist = dist;
          bestIdx = candidate.segIdx;
          needsReverse = true;
        }
      }
    }

    if (bestIdx === -1) return null;
    return { index: bestIdx, reverse: needsReverse };
  }

  // Process until all segments are consumed
  while (index.size > 0) {
    // Pick the first segment still in the index to start a new chain
    const firstKey = index.keys().next().value;
    const firstEntry = index.get(firstKey)[0];
    const startIdx = firstEntry.segIdx;

    // Start a new chain
    const chain = [];
    pool[startIdx].used = true;
    removeFromIndex(index, pool[startIdx], startIdx, tolerance);
    chain.push(pool[startIdx].start.clone());
    chain.push(pool[startIdx].end.clone());

    let tip = pool[startIdx].end.clone();
    let tail = pool[startIdx].start.clone();

    // Grow forward from the tip
    let forwardDone = false;
    while (!forwardDone) {
      forwardDone = true;
      const match = findMatch(tip);
      if (match) {
        const seg = pool[match.index];
        seg.used = true;
        removeFromIndex(index, seg, match.index, tolerance);

        if (match.reverse) {
          // Segment end matches our tip; add start as new point
          chain.push(seg.start.clone());
          tip = seg.start.clone();
        } else {
          // Segment start matches our tip; add end as new point
          chain.push(seg.end.clone());
          tip = seg.end.clone();
        }
        forwardDone = false;
      }
    }

    // Grow backward from the tail (prepend segments)
    // findMatch's reverse flag semantics (relative to forward growth):
    //   reverse=false → seg.start matches point → append seg.end (forward)
    //   reverse=true  → seg.end matches point → append seg.start (forward)
    //
    // For backward growth, the same flag works correctly:
    //   reverse=false → seg.start matches tail → prepend seg.end (reversed order)
    //   reverse=true  → seg.end matches tail → prepend seg.start (as-is)
    let backwardDone = false;
    while (!backwardDone) {
      backwardDone = true;
      const match = findMatch(tail);
      if (match) {
        const seg = pool[match.index];
        seg.used = true;
        removeFromIndex(index, seg, match.index, tolerance);

        if (match.reverse) {
          // seg.end matches tail → prepend seg.start (as-is)
          chain.unshift(seg.start.clone());
          tail = seg.start.clone();
        } else {
          // seg.start matches tail → prepend seg.end (reversed)
          chain.unshift(seg.end.clone());
          tail = seg.end.clone();
        }
        backwardDone = false;
      }
    }

    chains.push(chain);
  }

  return chains;
}

/**
 * Optimize a Paper.js project for plotter output.
 *
 * Performs:
 * 1. Segment Deduplication — removes overlapping/redundant line segments
 * 2. Greedy Path Chaining — connects segments into continuous paths
 * 3. Cleanup — replaces old paths with optimized ones, applies plotter styles
 *
 * @param {paper.Project} project — the Paper.js project to optimize
 * @param {number} [tolerance=0.1] — spatial tolerance in mm (default 0.1mm)
 */
export function optimizeForPlotter(project, tolerance = 0.1) {
  const layer = project.activeLayer;
  if (!layer || layer.children.length === 0) return;

  // ── Step 1: Extract all segments from every path ──────────
  const allSegments = [];

  function collectSegments(items) {
    for (const item of items) {
      if (item instanceof paper.Path && item.segments.length > 1) {
        const segs = extractSegments(item, tolerance);
        allSegments.push(...segs);
      } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
        collectSegments(item.children);
      }
    }
  }

  collectSegments(layer.children);

  if (allSegments.length === 0) return;

  // ── Step 2: Deduplicate segments ──────────────────────────
  const uniqueSegments = deduplicateSegments(allSegments, tolerance);

  if (uniqueSegments.length === 0) return;

  // ── Step 3: Greedy path chaining ──────────────────────────
  const chains = chainSegments(uniqueSegments, tolerance);

  // ── Step 4: Cleanup — replace old paths with optimized ones ──
  layer.removeChildren();

  for (const chain of chains) {
    if (chain.length < 2) continue;

    const path = new paper.Path();
    path.addSegments(chain);

    // Apply standard plotter styles
    path.strokeColor = new paper.Color('cyan');
    path.strokeWidth = 1;
    path.fillColor = null;
    path.strokeCap = 'round';
    path.strokeJoin = 'round';

    layer.addChild(path);
  }
}
