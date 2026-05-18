/**
 * TSP (Traveling Salesman Problem) Algorithm — Generates stipple points
 * via rejection sampling, then connects them using nearest-neighbor
 * construction + 2-opt optimization.
 *
 * After optimization, applies Long Edge Culling to snip the path at
 * jumps exceeding maxJump, producing multiple shorter paths instead of
 * one long path with ugly crossover lines.
 *
 * Outputs multiple Paper.js Paths (one per snipped segment).
 */
import paper from 'paper';

/**
 * @param {paper.Project} project
 * @param {ImageData} imageData  — grayscale pixel data
 * @param {number} density       — line density slider (20–200)
 * @param {number} nodes         — number of TSP nodes
 * @param {number} optPasses     — 2-opt optimization passes
 * @param {number} maxJump       — max allowed edge distance before snipping (internal canvas pixels)
 * @param {function} onProgress  — progress callback (msg, pct)
 */
export async function generateTSP(project, imageData, density, nodes, optPasses, maxJump, onProgress) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const numNodes = nodes || 3000;
  const passes = optPasses || 10;
  const jumpThreshold = maxJump || 50;

  // Step 1: Generate stipple points via rejection sampling
  const points = [];
  const totalAttempts = numNodes * 10;
  for (let i = 0; i < totalAttempts && points.length < numNodes; i++) {
    const x = Math.random() * w;
    const y = Math.random() * h;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
      const idx = (iy * w + ix) * 4;
      const bright = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const darkness = 1 - bright / 255;
      if (Math.random() < darkness * 0.8) {
        points.push({ x, y });
      }
    }
    if (i % 1000 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (onProgress) onProgress('Sampling points...', i / totalAttempts);
    }
  }

  if (points.length < 2) return;

  // Step 2: Nearest Neighbor path construction
  const visited = new Array(points.length).fill(false);
  const order = [0];
  visited[0] = true;
  let current = 0;

  for (let i = 1; i < points.length; i++) {
    let nearest = -1;
    let nearestDist = Infinity;
    const cx = points[current].x;
    const cy = points[current].y;
    for (let j = 0; j < points.length; j++) {
      if (visited[j]) continue;
      const dx = points[j].x - cx;
      const dy = points[j].y - cy;
      const dist = dx * dx + dy * dy;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = j;
      }
    }
    if (nearest !== -1) {
      order.push(nearest);
      visited[nearest] = true;
      current = nearest;
    }
    if (i % 500 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (onProgress) onProgress('Building path...', i / points.length);
    }
  }

  // Step 3: 2-Opt optimization
  for (let pass = 0; pass < passes; pass++) {
    let improved = true;
    let iterations = 0;
    const maxIter = order.length * 5;
    while (improved && iterations < maxIter) {
      improved = false;
      iterations++;
      const i = Math.floor(Math.random() * (order.length - 1));
      const j = Math.floor(Math.random() * (order.length - 1));
      if (i === j) continue;
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      const ax = points[order[a]].x, ay = points[order[a]].y;
      const bx = points[order[a + 1]].x, by = points[order[a + 1]].y;
      const cx = points[order[b]].x, cy = points[order[b]].y;
      const dx = points[order[(b + 1) % order.length]].x, dy = points[order[(b + 1) % order.length]].y;
      const d1 = Math.hypot(ax - bx, ay - by) + Math.hypot(cx - dx, cy - dy);
      const d2 = Math.hypot(ax - cx, ay - cy) + Math.hypot(bx - dx, by - dy);
      if (d2 < d1) {
        order.splice(a + 1, b - a, ...order.slice(a + 1, b + 1).reverse());
        improved = true;
      }
    }
    if (onProgress) onProgress(`Optimizing (pass ${pass + 1}/${passes})...`, (pass + 1) / passes);
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  // Step 4: Long Edge Culling — snip the path at jumps exceeding the threshold
  const culledPaths = [];
  let currentPath = [];

  for (let i = 0; i < order.length; i++) {
    const pt = points[order[i]];
    currentPath.push(pt);

    if (i < order.length - 1) {
      const nextPt = points[order[i + 1]];
      const dx = nextPt.x - pt.x;
      const dy = nextPt.y - pt.y;
      const dist = Math.hypot(dx, dy);

      if (dist > jumpThreshold) {
        // Snip here: finalize the current path and start a new one
        if (currentPath.length >= 2) {
          culledPaths.push(currentPath);
        }
        currentPath = [];
      }
    }
  }

  // Don't forget the last segment
  if (currentPath.length >= 2) {
    culledPaths.push(currentPath);
  }

  // If culling produced nothing (e.g. threshold too high), fall back to one path
  if (culledPaths.length === 0 && order.length >= 2) {
    culledPaths.push(order.map(idx => points[idx]));
  }

  // Step 5: Create Paper.js paths for each snipped segment
  for (const segment of culledPaths) {
    const path = new paper.Path();
    path.strokeColor = new paper.Color('black');
    path.strokeWidth = 1;

    for (const pt of segment) {
      path.add(new paper.Point(pt.x, pt.y));
    }

    layer.addChild(path);
  }
}
