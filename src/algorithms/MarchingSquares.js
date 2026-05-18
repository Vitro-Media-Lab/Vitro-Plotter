/**
 * Marching Squares Contour Trace Algorithm — Generates contour paths
 * from a binary grid using the standard 16-case marching squares lookup
 * table with linear interpolation.
 *
 * Outputs Paper.js Path objects for each chained contour.
 */
import paper from 'paper';

// Standard Marching Squares edge table (16 cases)
// Each entry: [edge1_start, edge1_end, edge2_start, edge2_end] or empty
// Edges: 0=top, 1=right, 2=bottom, 3=left
const EDGE_TABLE = [
  [],                   // 0: 0000
  [[3, 0]],             // 1: 0001
  [[0, 1]],             // 2: 0010
  [[3, 1]],             // 3: 0011
  [[1, 2]],             // 4: 0100
  [[3, 0], [1, 2]],     // 5: 0101 (ambiguous)
  [[0, 2]],             // 6: 0110
  [[3, 2]],             // 7: 0111
  [[2, 3]],             // 8: 1000
  [[2, 0]],             // 9: 1001
  [[0, 1], [2, 3]],     // 10: 1010 (ambiguous)
  [[2, 1]],             // 11: 1011
  [[1, 3]],             // 12: 1100
  [[1, 0]],             // 13: 1101
  [[0, 3]],             // 14: 1110
  [],                   // 15: 1111
];

/**
 * Get interpolated point along a cell edge.
 */
function getEdgePoint(cellX, cellY, edge, bTL, bTR, bBR, bBL, threshold) {
  let x1, y1, x2, y2;
  switch (edge) {
    case 0: x1 = cellX; y1 = cellY; x2 = cellX + 1; y2 = cellY; break;
    case 1: x1 = cellX + 1; y1 = cellY; x2 = cellX + 1; y2 = cellY + 1; break;
    case 2: x1 = cellX + 1; y1 = cellY + 1; x2 = cellX; y2 = cellY + 1; break;
    case 3: x1 = cellX; y1 = cellY + 1; x2 = cellX; y2 = cellY; break;
  }

  let va, vb;
  switch (edge) {
    case 0: va = bTL; vb = bTR; break;
    case 1: va = bTR; vb = bBR; break;
    case 2: va = bBR; vb = bBL; break;
    case 3: va = bBL; vb = bTL; break;
  }

  const t = (threshold - va) / (vb - va);
  const clampedT = Math.max(0, Math.min(1, t));
  return {
    x: x1 + clampedT * (x2 - x1),
    y: y1 + clampedT * (y2 - y1),
  };
}

/**
 * Build a graph from raw segments and trace continuous paths.
 * Uses exact coordinate matching with a small tolerance to handle
 * floating-point discrepancies between adjacent cells.
 */
function chainSegments(rawSegments) {
  if (rawSegments.length === 0) return [];

  const EPSILON = 0.001;

  /**
   * Find the index of a matching point in the points array within tolerance.
   * Returns -1 if no match found.
   */
  function findPoint(pts, x, y) {
    for (let i = 0; i < pts.length; i++) {
      if (Math.abs(pts[i].x - x) < EPSILON && Math.abs(pts[i].y - y) < EPSILON) {
        return i;
      }
    }
    return -1;
  }

  // Collect all unique points and build adjacency: for each point index,
  // store which segment indices connect to it, and which end (0 or 1) of that segment.
  const points = [];
  const pointToSegments = []; // Map<pointIndex, Array<{segIdx, end}>>

  function addPoint(x, y, segIdx, end) {
    const idx = findPoint(points, x, y);
    if (idx !== -1) {
      pointToSegments[idx].push({ segIdx, end });
      return idx;
    }
    const newIdx = points.length;
    points.push({ x, y });
    pointToSegments.push([{ segIdx, end }]);
    return newIdx;
  }

  // Track which segments have been used
  const used = new Array(rawSegments.length).fill(false);

  // Build the graph: each segment has two endpoints (point indices)
  const segEndpoints = rawSegments.map((seg, i) => {
    const p0 = addPoint(seg.x1, seg.y1, i, 0);
    const p1 = addPoint(seg.x2, seg.y2, i, 1);
    return [p0, p1];
  });

  // Trace paths
  const paths = [];

  for (let startSeg = 0; startSeg < rawSegments.length; startSeg++) {
    if (used[startSeg]) continue;

    // Start a new path from this segment
    used[startSeg] = true;
    const path = [];
    const [epA, epB] = segEndpoints[startSeg];
    path.push({ x: points[epA].x, y: points[epA].y });
    path.push({ x: points[epB].x, y: points[epB].y });

    // Extend forward from the tail (end of path)
    let tailPointIdx = epB;
    let extended = true;
    while (extended) {
      extended = false;
      const connections = pointToSegments[tailPointIdx];
      for (const conn of connections) {
        if (used[conn.segIdx]) continue;
        used[conn.segIdx] = true;
        const otherEnd = conn.end === 0 ? segEndpoints[conn.segIdx][1] : segEndpoints[conn.segIdx][0];
        path.push({ x: points[otherEnd].x, y: points[otherEnd].y });
        tailPointIdx = otherEnd;
        extended = true;
        break;
      }
    }

    // Extend backward from the head (start of path)
    let headPointIdx = epA;
    extended = true;
    while (extended) {
      extended = false;
      const connections = pointToSegments[headPointIdx];
      for (const conn of connections) {
        if (used[conn.segIdx]) continue;
        used[conn.segIdx] = true;
        const otherEnd = conn.end === 0 ? segEndpoints[conn.segIdx][1] : segEndpoints[conn.segIdx][0];
        path.unshift({ x: points[otherEnd].x, y: points[otherEnd].y });
        headPointIdx = otherEnd;
        extended = true;
        break;
      }
    }

    // Only keep paths with 3+ points (meaningful contours)
    if (path.length >= 3) {
      paths.push(path);
    }
  }

  return paths;
}

/**
 * @param {paper.Project} project
 * @param {ImageData} imageData  — grayscale pixel data
 * @param {number} resolution    — trace resolution (1–10, grid step)
 * @param {number} threshold     — brightness threshold (0–255)
 */
export function generateMarchingSquares(project, imageData, resolution, threshold) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const step = resolution || 2;
  const thr = threshold !== undefined ? threshold : 128;

  const cols = Math.floor(w / step);
  const rows = Math.floor(h / step);
  const brightness = new Float32Array((cols + 1) * (rows + 1));
  const binary = new Uint8Array((cols + 1) * (rows + 1));

  for (let gy = 0; gy <= rows; gy++) {
    for (let gx = 0; gx <= cols; gx++) {
      const px = Math.min(gx * step, w - 1);
      const py = Math.min(gy * step, h - 1);
      const idx = (py * w + px) * 4;
      const b = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const gi = gy * (cols + 1) + gx;
      brightness[gi] = b;
      binary[gi] = b < thr ? 1 : 0;
    }
  }

  // Collect raw segments
  const rawSegments = [];

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const idxTL = gy * (cols + 1) + gx;
      const idxTR = gy * (cols + 1) + (gx + 1);
      const idxBR = (gy + 1) * (cols + 1) + (gx + 1);
      const idxBL = (gy + 1) * (cols + 1) + gx;

      const bTL = binary[idxTL];
      const bTR = binary[idxTR];
      const bBR = binary[idxBR];
      const bBL = binary[idxBL];

      const caseIndex = (bTL << 3) | (bTR << 2) | (bBR << 1) | bBL;
      const edges = EDGE_TABLE[caseIndex];
      if (!edges || edges.length === 0) continue;

      const brightTL = brightness[idxTL];
      const brightTR = brightness[idxTR];
      const brightBR = brightness[idxBR];
      const brightBL = brightness[idxBL];
      const cellX = gx * step;
      const cellY = gy * step;

      for (let e = 0; e < edges.length; e += 2) {
        const p1 = getEdgePoint(cellX, cellY, edges[e], brightTL, brightTR, brightBR, brightBL, thr);
        const p2 = getEdgePoint(cellX, cellY, edges[e + 1], brightTL, brightTR, brightBR, brightBL, thr);
        rawSegments.push({ x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y });
      }
    }
  }

  // Chain segments into paths using robust graph-based approach
  const paths = chainSegments(rawSegments);

  // Create Paper.js Path objects
  for (const chain of paths) {
    const path = new paper.Path();
    path.strokeColor = new paper.Color('black');
    path.strokeWidth = 1;
    for (const p of chain) {
      path.add(new paper.Point(p.x, p.y));
    }
    layer.addChild(path);
  }
}
