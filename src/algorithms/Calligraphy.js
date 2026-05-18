/**
 * Calligraphy — Voronoi-based Medial Axis Extraction
 *
 * ── What this does ─────────────────────────────────────────────────
 * Takes an SVG of a calligraphy/outline font (closed filled paths),
 * extracts the centerline (medial axis) of each stroke using the
 * Voronoi diagram of densely-sampled boundary points — the
 * mathematically proven way to find medial axes of complex polygons.
 *
 * ── Algorithm ──────────────────────────────────────────────────────
 * For each set of outline paths (including CompoundPath holes):
 *   1. Evenly sample boundary points from all flattened paths
 *   2. Compute the Delaunay triangulation (→ Voronoi diagram) of
 *      all boundary points using d3-delaunay
 *   3. Keep only Voronoi vertices that lie strictly inside the
 *      original paths (the "internal skeleton")
 *   4. Build a graph from the Voronoi edges connecting internal
 *      vertices — this is the medial axis
 *   5. Traverse the graph to extract continuous centerline chains,
 *      splitting gracefully at junctions (degree > 2)
 *   6. For each centerline point, its distance to the nearest
 *      boundary site = half the stroke thickness; map to Z-depth
 *      via MarkerCalibrationProfile
 *
 * ── Why Voronoi works ─────────────────────────────────────────────
 * The Voronoi diagram of a dense set of boundary points has the
 * property that its internal edges approximate the medial axis.
 * Each Voronoi vertex (circumcenter of a Delaunay triangle) is
 * equidistant from three boundary sites. When two of those sites
 * are on opposite sides of the stroke and the third is adjacent
 * along the boundary, the vertex lies on the centerline.
 *
 * ── Output ────────────────────────────────────────────────────────
 * Paper.js Path objects with:
 *   - strokeColor: 'black', strokeWidth: 1, fillColor: null
 *   - Each segment has segment.data.zDepth (mm) for G-code export
 *   - Paths are split where Z-depth changes abruptly
 *   - Branches (junctions) are split into separate Path objects
 */

import paper from 'paper';
import { Delaunay } from 'd3-delaunay';
import { getProfile } from './MarkerCalibrationProfile.js';
import { splitAtZDiscontinuities, interpolateZDepthOnSimplifiedPath } from './Skeletonize.js';

// ============================================================
// Utilities
// ============================================================

function dist(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// ============================================================
// Boundary Sampling
// ============================================================

/**
 * Collect all closed sub-paths from a Paper.js item tree.
 * Handles CompoundPath by extracting individual Path children.
 *
 * @param {paper.Item} item — Path or CompoundPath
 * @returns {Array<paper.Path>} flat array of closed Path objects
 */
function collectClosedPaths(item) {
  const paths = [];
  function walk(item) {
    if (item instanceof paper.CompoundPath) {
      for (const child of item.children) {
        walk(child);
      }
    } else if (item instanceof paper.Path && item.closed && item.segments.length > 2) {
      paths.push(item);
    }
  }
  walk(item);
  return paths;
}

/**
 * Evenly sample boundary points from a Paper.js path.
 * Creates a temporary flattened clone so the original is unmodified.
 *
 * @param {paper.Path} path — original closed path (not modified)
 * @param {number} spacing — max distance between samples
 * @returns {Array<{x: number, y: number}>}
 */
function samplePathBoundary(path, spacing) {
  const clone = path.clone();
  clone.flatten(spacing);
  const pts = clone.segments.map((s) => ({ x: s.point.x, y: s.point.y }));
  clone.remove();
  return pts;
}

// ============================================================
// Voronoi-based Medial Axis Extraction
// ============================================================

/**
 * Given an array of boundary points and a containment predicate,
 * compute the Voronoi diagram and return the subset that lies
 * strictly inside the path — this is the medial axis graph.
 *
 * @param {Array<{x: number, y: number}>} boundaryPts
 * @param {function(number, number): boolean} containsFn — (x, y) → inside?
 * @returns {{ vertices: Array<{x: number, y: number, idx: number}>, edges: Array<{vA: number, vB: number}> }}
 */
function extractMedialAxis(boundaryPts, containsFn) {
  const n = boundaryPts.length;
  if (n < 4) return { vertices: [], edges: [] };

  // Build flat array for d3-delaunay
  const flatPts = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    flatPts[2 * i] = boundaryPts[i].x;
    flatPts[2 * i + 1] = boundaryPts[i].y;
  }

  // Compute Delaunay triangulation and Voronoi diagram
  const delaunay = new Delaunay(flatPts);
  // Bounds: expand the bounding box by 50% to prevent clipping
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of boundaryPts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const padX = (maxX - minX) * 0.5 || 100;
  const padY = (maxY - minY) * 0.5 || 100;
  const voronoi = delaunay.voronoi([minX - padX, minY - padY, maxX + padX, maxY + padY]);

  const { triangles, halfedges } = delaunay;
  const circumcenters = voronoi.circumcenters;
  const numTriangles = triangles.length / 3;

  // ── Step 1: Filter Voronoi vertices that are inside the path ──
  const triToVtx = new Map(); // triangle index → vertex index
  const vertices = [];

  for (let t = 0; t < numTriangles; t++) {
    const cx = circumcenters[2 * t];
    const cy = circumcenters[2 * t + 1];

    // Skip NaN/Infinity (degenerate triangles)
    if (!isFinite(cx) || !isFinite(cy)) continue;

    if (containsFn(cx, cy)) {
      triToVtx.set(t, vertices.length);
      vertices.push({ x: cx, y: cy, idx: vertices.length });
    }
  }

  // ── Step 2: Build edges from non-boundary Delaunay half-edges ──
  // For each pair of adjacent triangles (sharing a Delaunay edge),
  // the Voronoi edge connects their circumcenters.
  const edgeSet = new Set();
  const edges = [];

  for (let i = 0; i < halfedges.length; i++) {
    const opp = halfedges[i];
    if (opp === -1) continue; // boundary of the Voronoi diagram — skip

    const tA = Math.floor(i / 3);
    const tB = Math.floor(opp / 3);

    const vA = triToVtx.get(tA);
    const vB = triToVtx.get(tB);

    if (vA === undefined || vB === undefined) continue;
    if (vA === vB) continue;

    // Deduplicate
    const key = vA < vB ? `${vA},${vB}` : `${vB},${vA}`;
    if (edgeSet.has(key)) continue;
    edgeSet.add(key);

    edges.push({ vA, vB });
  }

  return { vertices, edges };
}

// ============================================================
// Iterative Graph Pruning — Remove Thin Voronoi Hairs
// ============================================================

/**
 * Iteratively prune leaf nodes whose thickness is below the threshold.
 *
 * The raw Voronoi diagram produces many "hair" vertices near the
 * boundary that are not part of the true medial axis. This function
 * strips them by repeatedly removing leaf (degree‑1) vertices whose
 * distance to the nearest boundary point is below `minThickness`.
 *
 * @param {Array<{x:number,y:number,idx:number}>} vertices — Voronoi vertices
 * @param {Array<{vA:number,vB:number}>} edges       — graph edges
 * @param {Array<{x:number,y:number}>} boundaryPts   — sampled boundary points
 * @param {number} minThickness — min distance to boundary to keep a leaf
 * @returns {{vertices, edges}} — pruned graph, indices are remapped
 */
function pruneVoronoiGraph(vertices, edges, boundaryPts, minThickness) {
  if (edges.length === 0) return { vertices, edges };

  // Build adjacency sets
  const adj = new Map();
  for (let i = 0; i < vertices.length; i++) adj.set(i, new Set());
  for (const { vA, vB } of edges) {
    adj.get(vA).add(vB);
    adj.get(vB).add(vA);
  }

  // Pre-compute distance to nearest boundary for every vertex
  const thickness = vertices.map((v) => {
    let minD = Infinity;
    for (const bp of boundaryPts) {
      const d = dist(v, bp);
      if (d < minD) minD = d;
    }
    return minD;
  });

  // Active set — vertices that survive
  const active = new Set(vertices.map((v) => v.idx));

  // Iteratively strip thin leaves
  let changed = true;
  while (changed) {
    changed = false;
    const toRemove = [];

    for (const vIdx of active) {
      const neighbors = [...adj.get(vIdx)].filter((n) => active.has(n));
      if (neighbors.length === 1 && thickness[vIdx] < minThickness) {
        toRemove.push(vIdx);
      }
    }

    for (const vIdx of toRemove) {
      active.delete(vIdx);
      changed = true;
    }
  }

  // Remap surviving vertices to contiguous indices
  const vtxMap = new Map();
  const newVertices = [];
  for (const v of vertices) {
    if (active.has(v.idx)) {
      vtxMap.set(v.idx, newVertices.length);
      newVertices.push({ x: v.x, y: v.y, idx: newVertices.length });
    }
  }

  const newEdges = [];
  for (const { vA, vB } of edges) {
    if (active.has(vA) && active.has(vB)) {
      newEdges.push({ vA: vtxMap.get(vA), vB: vtxMap.get(vB) });
    }
  }

  return { vertices: newVertices, edges: newEdges };
}

// ============================================================
// Graph Traversal — Longest Paths Through Junctions
// ============================================================

/**
 * Walk the medial axis graph to produce the longest possible
 * continuous centerline chains. Unlike the previous approach
 * that STOPS at junctions, this version walks THROUGH them
 * by choosing the straightest continuation at each junction.
 *
 * Strategy:
 *   1. Walk from each endpoint, following edges and passing
 *      through junctions by picking the neighbor with the
 *      smallest angle change (straightest continuation).
 *   2. Handle remaining degree-2 cycles not yet visited.
 *   3. Prune short spurs (artifact dead-end branches).
 *
 * @param {Array<{x: number, y: number, idx: number}>} vertices
 * @param {Array<{vA: number, vB: number}>} edges
 * @param {number} minChainLen — minimum points per chain
 * @returns {Array<Array<number>>} chains — each chain is an array of vertex indices
 */
function traceMedialAxis(vertices, edges, minChainLen) {
  if (vertices.length < minChainLen || edges.length === 0) return [];

  // Build adjacency list
  const adj = new Map();
  for (let i = 0; i < vertices.length; i++) adj.set(i, []);
  for (const { vA, vB } of edges) {
    adj.get(vA).push(vB);
    adj.get(vB).push(vA);
  }

  // Classify vertices
  const endpoints = [];
  const junctions = new Set();
  for (let i = 0; i < vertices.length; i++) {
    const deg = adj.get(i).length;
    if (deg === 1) endpoints.push(i);
    if (deg > 2) junctions.add(i);
  }

  // Track which edges have been traversed (by their sorted vertex pair)
  const visitedEdges = new Set();
  function edgeKey(a, b) {
    return a < b ? `${a},${b}` : `${b},${a}`;
  }

  const chains = [];

  /**
   * Compute the angle change when going from 'mid' through 'next'.
   * Returns a value in [0, π] where 0 = straight ahead.
   */
  function angleChange(prev, mid, next) {
    if (prev === -1) return 0;
    const dx1 = vertices[mid].x - vertices[prev].x;
    const dy1 = vertices[mid].y - vertices[prev].y;
    const dx2 = vertices[next].x - vertices[mid].x;
    const dy2 = vertices[next].y - vertices[mid].y;
    const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
    const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
    if (len1 < 1e-10 || len2 < 1e-10) return 0;
    const dot = (dx1 * dx2 + dy1 * dy2) / (len1 * len2);
    return Math.acos(Math.max(-1, Math.min(1, dot)));
  }

  /**
   * Walk from a starting vertex, traversing through junctions by
   * always picking the straightest continuation. Stops when:
   *   - No further unvisited edges from current vertex
   *   - All remaining edges lead to already-visited vertices
   */
  function walkPath(start) {
    const path = [start];
    let prev = -1;
    let current = start;

    while (true) {
      const neighbors = adj.get(current).filter(n => n !== prev);
      if (neighbors.length === 0) break;

      // Choose the best neighbor
      let next;
      if (neighbors.length === 1) {
        next = neighbors[0];
      } else {
        // At a junction: pick the straightest continuation
        let bestAngle = Infinity;
        let bestNeighbor = -1;
        for (const n of neighbors) {
          const ek = edgeKey(current, n);
          if (visitedEdges.has(ek)) continue; // prefer unvisited
          const angle = angleChange(prev, current, n);
          if (angle < bestAngle) {
            bestAngle = angle;
            bestNeighbor = n;
          }
        }
        if (bestNeighbor === -1) {
          // All neighbors have visited edges — still pick the straightest
          for (const n of neighbors) {
            const angle = angleChange(prev, current, n);
            if (angle < bestAngle) {
              bestAngle = angle;
              bestNeighbor = n;
            }
          }
        }
        next = bestNeighbor;
      }

      if (next === -1) break;

      const ek = edgeKey(current, next);
      if (visitedEdges.has(ek)) break;
      visitedEdges.add(ek);

      prev = current;
      current = next;
      path.push(current);
    }

    return path.length >= minChainLen ? path : null;
  }

  // ── Phase 1: Walk from all endpoints ──
  for (const ep of endpoints) {
    const chain = walkPath(ep);
    if (chain) chains.push(chain);
  }

  // ── Phase 2: Walk from any remaining unvisited degree-2 vertices (cycles) ──
  const allVisited = new Set();
  for (const chain of chains) {
    for (const vi of chain) allVisited.add(vi);
  }

  for (let i = 0; i < vertices.length; i++) {
    if (allVisited.has(i) || adj.get(i).length !== 2) continue;
    const chain = walkPath(i);
    if (chain) chains.push(chain);
  }

  return chains;
}

// ============================================================
// Spur Pruning — Remove Short Dead-End Branches
// ============================================================

/**
 * Remove short, dead-end chains that are artifacts of the
 * Voronoi process. A "spur" is a chain whose one endpoint
 * connects to another chain (via a junction or shared vertex)
 * but is too short to represent a meaningful stroke.
 *
 * @param {Array<Array<number>>} chains — vertex index chains
 * @param {Array<Array<{vA: number, vB: number}>>} edges — Voronoi edges
 * @param {number} minSpurLength — minimum points to keep a spur
 * @returns {Array<Array<number>>} pruned chains
 */
function pruneSpurs(chains, edges, minSpurLength = 8) {
  if (chains.length < 2) return chains;

  // Build a set of all vertices that appear in each chain
  const chainVertexSets = chains.map(ch => new Set(ch));

  // For each chain, check if it looks like a spur:
  // A spur has one endpoint degree-1 in the graph AND connects
  // to another chain (its degree-1 endpoint's neighbor is in another chain)
  const keep = new Array(chains.length).fill(true);

  for (let c = 0; c < chains.length; c++) {
    const chain = chains[c];
    if (chain.length >= minSpurLength) continue;

    const first = chain[0];
    const last = chain[chain.length - 1];

    // Check if either endpoint is degree-1 in the chain's subgraph
    // and its only neighbor belongs to another chain
    function isSpurEndpoint(vIdx) {
      // Find the neighbor of vIdx in the Voronoi graph
      // that's NOT in the same chain
      for (const { vA, vB } of edges) {
        let neighbor = -1;
        if (vA === vIdx) neighbor = vB;
        else if (vB === vIdx) neighbor = vA;
        else continue;

        // Is this neighbor in a DIFFERENT chain?
        for (let oc = 0; oc < chains.length; oc++) {
          if (oc === c) continue;
          if (chainVertexSets[oc].has(neighbor)) {
            return true; // connects to another chain = spur
          }
        }
      }
      return false;
    }

    if (isSpurEndpoint(first) || isSpurEndpoint(last)) {
      keep[c] = false;
    }
  }

  return chains.filter((_, i) => keep[i]);
}

// ============================================================
// Chain Stitching — Merge Fragments Into Continuous Paths
// ============================================================

/**
 * Stitch together chains whose endpoints are spatially close.
 * The Voronoi medial axis graph traversal produces fragments that
 * should be connected into one continuous stroke. This function
 * merges them by finding endpoint pairs within `maxGap` distance
 * and joining the chains (reversing one if needed for continuity).
 *
 * @param {Array<Array<{x: number, y: number, zDepth: number}>>} chains
 * @param {number} maxGap — max distance (px) between endpoints to stitch
 * @returns {Array<Array<{x: number, y: number, zDepth: number}>>}
 */
function stitchChains(chains, maxGap) {
  if (chains.length < 2) return chains;

  // Work on mutable copies
  let result = chains.map(ch => [...ch]);

  // Keep merging until no more changes
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < result.length && !changed; i++) {
      for (let j = i + 1; j < result.length && !changed; j++) {
        const merged = tryStitch(result[i], result[j], maxGap);
        if (merged) {
          result[i] = merged;
          result.splice(j, 1);
          changed = true;
        }
      }
    }
  }

  return result;
}

/**
 * Try to stitch two chains together by checking all 4 endpoint pairings.
 * Returns the merged chain if successful, null if no endpoints are close enough.
 */
function tryStitch(a, b, maxGap) {
  const aFirst = a[0];
  const aLast  = a[a.length - 1];
  const bFirst = b[0];
  const bLast  = b[b.length - 1];

  // All four endpoint-to-endpoint configurations
  // { revA, revB } = whether to reverse each chain before merging
  const configs = [
    { endA: aLast,  startB: bFirst, revA: false, revB: false },
    { endA: aLast,  startB: bLast,  revA: false, revB: true  },
    { endA: aFirst, startB: bFirst, revA: true,  revB: false },
    { endA: aFirst, startB: bLast,  revA: true,  revB: true  },
  ];

  for (const cfg of configs) {
    const d = dist(cfg.endA, cfg.startB);
    if (d <= maxGap) {
      const chainA = cfg.revA ? [...a].reverse() : a;
      const chainB = cfg.revB ? [...b].reverse() : b;

      // Smooth Z transition at the merge point
      const avgZ = (chainA[chainA.length - 1].zDepth + chainB[0].zDepth) / 2;
      chainA[chainA.length - 1].zDepth = avgZ;
      chainB[0].zDepth = avgZ;

      // Remove duplicate point at junction (B's first point is near A's last)
      const mergeIdx = chainB.length > 1 && dist(chainA[chainA.length - 1], chainB[0]) < 0.5 ? 1 : 0;

      return [...chainA, ...chainB.slice(mergeIdx)];
    }
  }

  return null;
}

// ============================================================
// Multipass Moving-Average Helper
// ============================================================

/**
 * Apply a moving-average filter one or more passes for
 * butter-smooth signal denoising.
 *
 * @param {number[]} arr — input array
 * @param {number} windowSize — window width (odd-ish)
 * @param {number} [passes=3] — number of passes
 * @returns {number[]}
 */
function multipassMovingAverage(arr, windowSize, passes = 3) {
  let data = [...arr];
  const halfW = Math.max(1, Math.floor(windowSize / 2));

  for (let pass = 0; pass < passes; pass++) {
    const smoothed = [];
    for (let i = 0; i < data.length; i++) {
      let sum = 0;
      let count = 0;
      for (let j = -halfW; j <= halfW; j++) {
        const idx = i + j;
        if (idx >= 0 && idx < data.length) {
          sum += data[idx];
          count++;
        }
      }
      smoothed.push(count > 0 ? sum / count : data[i]);
    }
    data = smoothed;
  }

  return data;
}

// ============================================================
// Flatten Smoothed Path to Dense Polyline (Z-Preserving)
// ============================================================

/**
 * After path.smooth({ type: 'catmull-rom' }), walk the Bezier curve
 * at `tolerance` intervals and produce a dense polyline whose
 * segments carry interpolated segment.data.zDepth values.
 *
 * This is required because the G-code exporter reads only
 * segment.point and ignores Paper.js Bezier handles.
 *
 * Algorithm:
 *   1. Save zDepth from each current segment.
 *   2. Walk the smoothed curve using path.getPointAt(offset).
 *   3. At each sample, interpolate Z between the two bounding
 *      original segments by parametric arc-length t.
 *   4. Replace the path's segments with the new dense polyline.
 *
 * @param {paper.Path} path — smoothed Paper.js path (modified in place)
 * @param {number} tolerance — step size in pixels (default: 2)
 */
function flattenPathWithZ(path, tolerance = 2) {
  const totalLen = path.length;
  if (totalLen < tolerance || path.segments.length < 2) return;

  // Save Z values from segments BEFORE we replace them
  const zValues = path.segments.map((seg) => seg.data.zDepth);
  const segCount = zValues.length;

  // Number of sample points along the curve
  const numSamples = Math.max(2, Math.ceil(totalLen / tolerance));
  const points = [];

  for (let i = 0; i < numSamples; i++) {
    const t = i / (numSamples - 1);               // 0 … 1
    const offset = t * totalLen;
    const pt = path.getPointAt(offset);
    if (!pt) continue;

    // Map t to the original-segment interval and interpolate Z
    const segT = t * (segCount - 1);
    const segIdx = Math.min(Math.floor(segT), segCount - 2);
    const frac = segT - segIdx;

    const idx0 = segIdx;
    const idx1 = Math.min(segIdx + 1, segCount - 1);

    const zDepth = zValues[idx0] + (zValues[idx1] - zValues[idx0]) * frac;

    points.push({ x: pt.x, y: pt.y, zDepth });
  }

  if (points.length < 2) return;

  // Replace all segments with the dense polyline
  path.removeSegments();
  for (const p of points) {
    const seg = new paper.Segment(new paper.Point(p.x, p.y));
    seg.data = { zDepth: p.zDepth };
    path.addSegments([seg]);
  }
}

// ============================================================
// Thickness → Z-Depth Mapping
// ============================================================

/**
 * For each centerline point, compute its thickness as twice the
 * distance to the nearest boundary site (full stroke width).
 * Then map through the calibration profile and smooth.
 *
 * @param {Array<number>} chainIndices — vertex indices in the chain
 * @param {Array<{x: number, y: number}>} vertices — all Voronoi vertices
 * @param {Array<{x: number, y: number}>} boundaryPts — all boundary sample points
 * @param {object} profile — calibration profile
 * @param {number} smoothingWindow — moving average window size
 * @returns {Array<{x: number, y: number, zDepth: number}>}
 */
function mapChainToZDepth(chainIndices, vertices, boundaryPts, profile, smoothingWindow) {
  const nB = boundaryPts.length;

  // Step 1: Compute raw half-thickness (distance to nearest boundary)
  const rawHalfThickness = chainIndices.map((vIdx) => {
    const pt = vertices[vIdx];
    let minDist = Infinity;
    for (let i = 0; i < nB; i++) {
      const d = dist(pt, boundaryPts[i]);
      if (d < minDist) minDist = d;
    }
    return minDist;
  });

  // Step 2: Heavy multipass moving-average smoothing.
  // Use a larger effective window (3× the user's smoothingWindow) for
  // butter-smooth transitions that prevent Z-discontinuity shattering.
  const effectiveWindow = Math.max(5, smoothingWindow * 3);
  const smoothThickness = multipassMovingAverage(rawHalfThickness, effectiveWindow, 3);

  // Step 3: Map smoothed thickness → Z-depth via calibration profile
  const result = [];
  for (let i = 0; i < chainIndices.length; i++) {
    const pt = vertices[chainIndices[i]];
    // full stroke width = 2 × half-thickness
    const fullThickness = smoothThickness[i] * 2;
    result.push({
      x: pt.x,
      y: pt.y,
      zDepth: profile.mapThicknessToZ(fullThickness),
    });
  }

  return result;
}

// ============================================================
// Main Entry Point
// ============================================================

/**
 * Extract centerlines from outlined SVG font paths using
 * Voronoi-based medial axis extraction (mathematically proven).
 *
 * @param {paper.Project} project — Paper.js project with outlined paths
 * @param {object} params
 * @param {number} [params.sampleSpacing=3] — max spacing between boundary samples (px)
 * @param {number} [params.minThickness=1.5] — iterative prune: remove leaves closer than this to boundary
 * @param {number} [params.chainStitchDist=20] — max distance (px) to stitch fragmented chains
 * @param {number} [params.minChainLen=8] — minimum centerline chain length
 * @param {number} [params.simplifyDist=3] — simplification / flattening tolerance
 * @param {number} [params.smoothingWindow=5] — Z smoothing window (effective window = ×3)
 * @param {number} [params.maxZStep=0.3] — max Z change before splitting (mm)
 * @param {string} [params.calibrationProfile='sharpieFinePoint'] — marker profile
 * @param {number} [params.minPathLength=5] — minimum path length for output
 * @param {object} [params.customCalibration] — custom calibration options
 * @returns {{pathCount: number, totalPoints: number}}
 */
export function generateCalligraphy(project, params = {}) {
  const {
    sampleSpacing = 3,
    minThickness = 1.5,
    minChainLen = 8,
    simplifyDist = 3,
    smoothingWindow = 5,
    maxZStep = 0.3,
    calibrationProfile = 'sharpieFinePoint',
    minPathLength = 5,
    chainStitchDist = 20,
    customCalibration,
  } = params;

  const profile = getProfile(calibrationProfile, customCalibration);
  const layer = project.activeLayer;

  // ── Step 1: Collect original items + their closed sub-paths ──
  const allPaths = [];
  // Store ORIGINAL items (Path or CompoundPath) for proper winding-aware contains()
  const originalItems = [];
  function collectFromLayer(items) {
    for (const item of items) {
      if (item instanceof paper.CompoundPath || (item instanceof paper.Path && item.closed && item.segments.length > 2)) {
        originalItems.push(item);
      }
      const subPaths = collectClosedPaths(item);
      allPaths.push(...subPaths);
    }
  }
  collectFromLayer(layer.children);

  if (allPaths.length === 0) {
    console.warn('[Calligraphy] No closed paths found');
    layer.removeChildren();
    return { pathCount: 0, totalPoints: 0 };
  }

  // ── Step 2: Sample boundary points from all paths ──
  const boundaryPts = [];

  for (const path of allPaths) {
    const pts = samplePathBoundary(path, sampleSpacing);
    if (pts.length >= 3) {
      boundaryPts.push(...pts);
    }
  }

  if (boundaryPts.length < 6) {
    console.warn('[Calligraphy] Too few boundary points');
    layer.removeChildren();
    return { pathCount: 0, totalPoints: 0 };
  }

  // ── Step 3: Build containment predicate ──
  // Use the ORIGINAL items (CompoundPath/Path) which handle winding correctly.
  // For a CompoundPath like "O", item.contains() properly excludes the hole.
  function containsFn(x, y) {
    const pt = new paper.Point(x, y);
    for (const item of originalItems) {
      if (item.contains(pt)) return true;
    }
    return false;
  }

  // ── Step 4: Extract medial axis from Voronoi diagram ──
  let { vertices, edges } = extractMedialAxis(boundaryPts, containsFn);

  if (vertices.length < minChainLen || edges.length === 0) {
    console.warn('[Calligraphy] Medial axis extraction produced no internal vertices');
    layer.removeChildren();
    return { pathCount: 0, totalPoints: 0 };
  }

  // ── Step 4.5: Iteratively prune thin Voronoi hairs ──
  // Removes leaf vertices whose thickness is below the threshold,
  // stripping away boundary noise before graph traversal.
  const pruned = pruneVoronoiGraph(vertices, edges, boundaryPts, minThickness);
  vertices = pruned.vertices;
  edges = pruned.edges;

  if (vertices.length < minChainLen || edges.length === 0) {
    console.warn('[Calligraphy] Pruning removed all vertices');
    layer.removeChildren();
    return { pathCount: 0, totalPoints: 0 };
  }

  // ── Step 5: Trace the medial axis graph into continuous chains ──
  let chainIndices = traceMedialAxis(vertices, edges, minChainLen);

  // Prune short spurs (artifact dead-end branches) — more aggressive
  chainIndices = pruneSpurs(chainIndices, edges, 12);

  if (chainIndices.length === 0) {
    console.warn('[Calligraphy] No valid centerline chains found');
    layer.removeChildren();
    return { pathCount: 0, totalPoints: 0 };
  }

  // ── Step 6: Map each chain to Z-depth ──
  let zChains = [];

  for (const indices of chainIndices) {
    const zChain = mapChainToZDepth(indices, vertices, boundaryPts, profile, smoothingWindow);
    if (zChain.length >= minChainLen) {
      zChains.push(zChain);
    }
  }

  if (zChains.length === 0) {
    console.warn('[Calligraphy] No chains after Z-depth mapping');
    layer.removeChildren();
    return { pathCount: 0, totalPoints: 0 };
  }

  // ── Step 7: Stitch chains whose endpoints are spatially close ──
  // This reconnects fragments that the Voronoi graph traversal split apart
  zChains = stitchChains(zChains, chainStitchDist);

  // ── Step 8: Split at Z discontinuities ──
  const allChains = [];
  for (const chain of zChains) {
    const segments = splitAtZDiscontinuities(chain, maxZStep, 3);
    for (const seg of segments) {
      if (seg.length >= minChainLen) {
        allChains.push(seg);
      }
    }
  }

  // ── Step 9: Clear layer, create Paper.js paths, smooth ──
  layer.removeChildren();

  if (allChains.length === 0) {
    console.warn('[Calligraphy] No chains survived Z-discontinuity splitting');
    return { pathCount: 0, totalPoints: 0 };
  }

  // Create paper.Path objects with Catmull-Rom smoothing and Z-depth preservation
  let totalPoints = 0;
  for (const chain of allChains) {
    if (chain.length < minPathLength) continue;

    const path = new paper.Path();
    for (const pt of chain) {
      const seg = new paper.Segment(new paper.Point(pt.x, pt.y));
      seg.data = { zDepth: pt.zDepth };
      path.addSegments([seg]);
    }

    // Step A: Simplify geometry — reduces segment count, smooths zig-zags
    path.simplify(simplifyDist);

    // Step B: Re-interpolate Z-depth on simplified segments
    interpolateZDepthOnSimplifiedPath(path, chain);

    // Step C: Catmull-Rom curve smoothing
    path.smooth({ type: 'catmull-rom' });

    // Step D: Flatten the smooth curve to a dense polyline with
    //         arc-length interpolated Z-depth on every segment.
    //         Required because the G-code exporter reads only
    //         segment.point, ignoring Paper.js Bezier handles.
    flattenPathWithZ(path, simplifyDist);

    path.strokeColor = 'black';
    path.strokeWidth = 1;
    path.fillColor = null;

    totalPoints += path.segments.length;
  }

  return {
    pathCount: allChains.length,
    totalPoints,
  };
}
