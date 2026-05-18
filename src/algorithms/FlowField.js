/**
 * Flow Field Algorithm — Evenly-spaced streamlines (Jobard & Lefer method)
 * that follow the image gradient to produce contour-like flow lines.
 *
 * Uses Paper.js Path and Point objects.
 *
 * ── Physical Pen Constraint ──────────────────────────────────────────────
 * A global minimum spacing floor is enforced so that no two lines are drawn
 * closer together than the physical width of the fineliner tip. This prevents
 * paper-tearing and ink floods in deep shadows.
 *
 *   physicalPenWidth  = 0.4 mm  (typical 0.4 mm fineliner tip)
 *   pixelsPerMm       = derived from image dimensions and paper size
 *   minSpacingPixels  = physicalPenWidth * pixelsPerMm
 *
 * Every reqSpacing calculation is clamped via:
 *   Math.max(minSpacingPixels, calculatedSpacing)
 */
import paper from 'paper';

/**
 * @param {paper.Project} project
 * @param {ImageData} imageData  — grayscale pixel data
 * @param {number} density       — line density slider (20–200)
 * @param {number} minSpacing    — minimum spacing between lines
 * @param {number} maxSpacing    — maximum spacing between lines
 * @param {number} stepSize      — integration step size
 * @param {object}  [penConstraints] — optional physical pen parameters
 * @param {number}  [penConstraints.physicalPenWidth=0.4] — fineliner tip width in mm
 * @param {number}  [penConstraints.pixelsPerMm=4]        — pixels per mm at current resolution
 */
export async function generateFlowField(project, imageData, density, minSpacing, maxSpacing, stepSize, penConstraints = {}) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const minSp = minSpacing || 2;
  const maxSp = maxSpacing || 15;
  const step = stepSize || 2;

  // ── Physical Pen Constraint ──────────────────────────────────────────
  // Clamp minimum spacing so the plotter never draws two lines closer
  // together than the physical width of the fineliner tip.
  const physicalPenWidth = penConstraints.physicalPenWidth ?? 0.4; // mm
  const pixelsPerMm      = penConstraints.pixelsPerMm ?? 4;        // px/mm
  const MIN_SPACING_PX   = physicalPenWidth * pixelsPerMm;         // floor in pixels
  // ──────────────────────────────────────────────────────────────────────

  const gridSize = Math.max(1, minSp);
  const grid = new Map();

  function gridKey(x, y) {
    const gx = Math.floor(x / gridSize);
    const gy = Math.floor(y / gridSize);
    return gx + ',' + gy;
  }

  function isValid(x, y, reqSpacing) {
    const gx = Math.floor(x / gridSize);
    const gy = Math.floor(y / gridSize);
    const rs2 = reqSpacing * reqSpacing;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = (gx + dx) + ',' + (gy + dy);
        const cell = grid.get(key);
        if (cell) {
          for (const p of cell) {
            const dx2 = x - p.x;
            const dy2 = y - p.y;
            if (dx2 * dx2 + dy2 * dy2 < rs2) return false;
          }
        }
      }
    }
    return true;
  }

  function addToGrid(x, y) {
    const key = gridKey(x, y);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ x, y });
  }

  // FIX 1: Read the Alpha channel. If it's transparent, force it to 255 (white background).
  function getBrightness(x, y) {
    const ix = Math.max(0, Math.min(w - 1, Math.floor(x)));
    const iy = Math.max(0, Math.min(h - 1, Math.floor(y)));
    const idx = (iy * w + ix) * 4;
    
    const alpha = data[idx + 3];
    if (alpha < 50) return 255; 
    
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  function imageGradient(x, y) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const gap = 3;
    const x0 = Math.max(0, Math.min(w - 1, ix - gap));
    const x1 = Math.max(0, Math.min(w - 1, ix + gap));
    const y0 = Math.max(0, Math.min(h - 1, iy - gap));
    const y1 = Math.max(0, Math.min(h - 1, iy + gap));
    const gx = (getBrightness(x1, iy) - getBrightness(x0, iy));
    const gy = (getBrightness(ix, y1) - getBrightness(ix, y0));
    return { dx: gx, dy: gy };
  }

  const seedQueue = [];
  const numSeeds = Math.max(200, Math.floor((w * h) / (minSp * maxSp * 2)));
  for (let i = 0; i < numSeeds; i++) {
    seedQueue.push({ x: Math.random() * w, y: Math.random() * h });
  }
  for (let i = seedQueue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [seedQueue[i], seedQueue[j]] = [seedQueue[j], seedQueue[i]];
  }

  const maxIterations = 50000;
  let iterationCount = 0;
  let currentPathPoints = [];

  function clearCurrentPathPoints() { currentPathPoints = []; }
  function addToCurrentPathPoints(x, y) { currentPathPoints.push({ x, y }); }

  function isSelfValid(x, y, reqSpacing) {
    const rs2 = reqSpacing * reqSpacing;
    const skipCount = Math.min(currentPathPoints.length, Math.ceil(reqSpacing / step) + 2);
    const startIdx = currentPathPoints.length - skipCount;
    for (let i = 0; i < startIdx; i++) {
      const p = currentPathPoints[i];
      const dx2 = x - p.x;
      const dy2 = y - p.y;
      if (dx2 * dx2 + dy2 * dy2 < rs2) return false;
    }
    return true;
  }

  // Fake Perlin noise using spatial trigonometry to create "fingerprint" swirls in flat areas
// Fake Perlin noise: smoothed out multiplier so the swirls are larger and more organic
  function getSwirlAngle(x, y) {
    return (Math.sin(x * 0.01) + Math.cos(y * 0.01) + Math.sin((x+y) * 0.005)) * Math.PI;
  }

  function integrateSeed(seed, direction) {
    const pathPoints = [];
    let px = seed.x;
    let py = seed.y;
    const dir = direction;

    const initGrad = imageGradient(px, py);
    // THE FIX: Calculate the TANGENT, not the gradient (swap x and y, negate one)
    let currentAngle = Math.atan2(initGrad.dx * dir, -initGrad.dy * dir);

    for (let s = 0; s < 500; s++) {
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      if (ix < 0 || ix >= w || iy < 0 || iy >= h) break;

      const bright = getBrightness(ix, iy);
      
      // Brutal hard-stop for backgrounds
      if (bright > 245) break;

      // ── Physical Pen Constraint ─────────────────────────────────
      // Clamp spacing so the plotter never draws lines closer than
      // the physical width of the fineliner tip.
      const reqSpacing = Math.max(
        MIN_SPACING_PX,
        minSp + (bright / 255) * (maxSp - minSp)
      );

      if (!isValid(px, py, reqSpacing)) break;
      if (s >= 3 && !isSelfValid(px, py, reqSpacing)) break;

      pathPoints.push({ x: px, y: py });
      addToCurrentPathPoints(px, py);

      const grad = imageGradient(px, py);
      const edgeStrength = Math.sqrt(grad.dx * grad.dx + grad.dy * grad.dy);
      
      // THE FIX: True contour angle
      const contourAngle = Math.atan2(grad.dx * dir, -grad.dy * dir);
      const swirlAngle = getSwirlAngle(px, py) * dir;
      
      // Smooth interpolation based on how sharp the edge is (0.0 to 1.0)
      // If it's a weak edge (< 5), it's 100% swirl. If it's a strong edge (> 25), it's 100% contour.
      const edgeBlend = Math.min(1.0, Math.max(0.0, (edgeStrength - 5) / 20));

      // Vector blending (the only mathematically safe way to transition between angles)
      const vx = Math.cos(contourAngle) * edgeBlend + Math.cos(swirlAngle) * (1 - edgeBlend);
      const vy = Math.sin(contourAngle) * edgeBlend + Math.sin(swirlAngle) * (1 - edgeBlend);
      let targetAngle = Math.atan2(vy, vx);

      // Prevent 360-degree wrap-around snapping
      let angleDiff = targetAngle - currentAngle;
      if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      else if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      // Smooth steering
      currentAngle += angleDiff * 0.2;
      
      px += Math.cos(currentAngle) * step;
      py += Math.sin(currentAngle) * step;
    }

    return pathPoints;
  }

  while (seedQueue.length > 0 && iterationCount < maxIterations) {
    const seed = seedQueue.pop();
    iterationCount++;

    if (iterationCount % 30 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const ix = Math.floor(seed.x);
    const iy = Math.floor(seed.y);
    if (ix < 0 || ix >= w || iy < 0 || iy >= h) continue;

    const bright = getBrightness(ix, iy);
    
    // FIX 3: Do not even spawn starting seeds in the background
    if (bright > 245) continue;

    // ── Physical Pen Constraint ─────────────────────────────────
    const reqSpacing = Math.max(
      MIN_SPACING_PX,
      minSp + (bright / 255) * (maxSp - minSp)
    );

    if (!isValid(seed.x, seed.y, reqSpacing)) continue;

    clearCurrentPathPoints();

    const forwardPath = integrateSeed(seed, 1);
    const backwardPath = integrateSeed(seed, -1);

    backwardPath.reverse();
    const fullPath = backwardPath.concat(forwardPath);

    if (fullPath.length >= 15) {
      const paperPath = new paper.Path();
      paperPath.strokeColor = new paper.Color('cyan');
      paperPath.strokeWidth = 1;
      paperPath.fillColor = null; // FIX 4: Explicitly kill fills so it doesn't blob
      
      for (const p of fullPath) {
        paperPath.add(new paper.Point(p.x, p.y));
      }
      
      // FIX 5: Smooth the output
      paperPath.smooth({ type: 'continuous' });
      layer.addChild(paperPath);

      for (const p of fullPath) {
        addToGrid(p.x, p.y);
      }

      const branchInterval = Math.max(10, Math.floor(minSp * 3));
      for (let i = branchInterval; i < fullPath.length; i += branchInterval) {
        const bp = fullPath[i];
        const angle = Math.atan2(
          fullPath[Math.min(i + 1, fullPath.length - 1)].y - fullPath[Math.max(0, i - 1)].y,
          fullPath[Math.min(i + 1, fullPath.length - 1)].x - fullPath[Math.max(0, i - 1)].x
        );
        for (const side of [-1, 1]) {
          const sx = bp.x + Math.cos(angle + side * Math.PI / 2) * minSp * 1.5;
          const sy = bp.y + Math.sin(angle + side * Math.PI / 2) * minSp * 1.5;
          if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
            seedQueue.push({ x: sx, y: sy });
          }
        }
      }
    }
  }
}