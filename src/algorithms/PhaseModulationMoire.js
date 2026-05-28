import paper from 'paper';

/**
 * Phase Modulation Moiré Image Reveal
 *
 * Two interlocking vector gratings produce an interference pattern that reveals
 * the source image. Layer 1 is a uniform reference grating (straight vertical
 * lines). Layer 2 is a rotated grating whose lines are locally displaced in
 * phase by the underlying image intensity, bending them toward or away from the
 * reference lines and causing the moiré fringes to trace the image content.
 *
 * Mathematical basis:
 *   f1(x,y) = cos(2π·f·x)                            — reference grating
 *   f2(x,y) = cos(2π·f·(x·cosθ + y·sinθ) + k·I(x,y))  — modulated grating
 *
 * The n-th contour of f2 passes through (x, y) where:
 *   x_nom = (n·S − y·sinθ) / cosθ           (nominal, unmodulated position)
 *   x_mod = x_nom − (k / 2π·f·cosθ)·I       (first-order phase-displaced position)
 *
 * With S = lineSpacing = w/density and using A = k/(2π) as the amplitude slider,
 * the displacement simplifies to:
 *   x_mod = x_nom − A·S·I(x_nom, y)
 *
 * @param {paper.Project} project
 * @param {ImageData} imageData   — continuous-tone grayscale data (pre-binarization)
 * @param {number} density        — lines across the canvas width
 * @param {number} angleDeg       — Layer 2 rotation angle in degrees
 * @param {number} amplitude      — phase displacement amplitude (0–1, fraction of S)
 */
export function generatePhaseModulationMoire(
  project,
  imageData,
  density = 60,
  angleDeg = 3,
  amplitude = 0.5,
) {
  if (!imageData) return;

  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const S = w / density;                          // line spacing in pixels
  const theta = (angleDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const dispScale = amplitude * S;                 // max pixel displacement

  // ── Bilinear sampler ────────────────────────────────────────────────────
  // Returns normalised intensity [0=black … 1=white] at sub-pixel coords.
  function sample(x, y) {
    const x0 = Math.floor(Math.max(0, Math.min(w - 2, x)));
    const y0 = Math.floor(Math.max(0, Math.min(h - 2, y)));
    const fx = x - x0;
    const fy = y - y0;
    const get = (xi, yi) => data[(yi * w + xi) * 4] / 255;
    return (
      get(x0,     y0)     * (1 - fx) * (1 - fy) +
      get(x0 + 1, y0)     * fx       * (1 - fy) +
      get(x0,     y0 + 1) * (1 - fx) * fy       +
      get(x0 + 1, y0 + 1) * fx       * fy
    );
  }

  // ── Commit helper ────────────────────────────────────────────────────────
  // Smooths and anchors a path to the layer, or discards trivial paths.
  function commitPath(p) {
    if (!p) return null;
    if (p.segments.length > 1) {
      p.smooth({ type: 'continuous' });
      layer.addChild(p);
    } else {
      p.remove();
    }
    return null;
  }

  // ── Layer 1: Reference Grating ───────────────────────────────────────────
  // Straight vertical lines at uniform spacing S — plotted in cyan.
  for (let n = 0; n <= density; n++) {
    const x = n * S;
    const p = new paper.Path([
      new paper.Point(x, 0),
      new paper.Point(x, h),
    ]);
    p.strokeColor = new paper.Color('cyan');
    p.strokeWidth = 1;
    p.fillColor = null;
    layer.addChild(p);
  }

  // ── Layer 2: Phase-Modulated Grating ────────────────────────────────────
  // For each nominal contour line n, sweep y from 0→h and compute x_mod.
  // Paths are broken and restarted whenever the line exits the canvas.
  //
  // Coverage: we need lines up to the far corner of the rotated canvas.
  const uMax = w * cosT + h * sinT;
  const numLines2 = Math.ceil(uMax / S) + 2;

  // Allow lines to wander slightly beyond canvas edges before breaking —
  // avoids spurious micro-breaks caused by large displacement at bright pixels.
  const edgeMargin = dispScale + S;

  // Step every 2 rows: smooth curves tolerate this gap with no visible loss.
  const YSTEP = 2;

  for (let n = 0; n < numLines2; n++) {
    let current = null;

    for (let y = 0; y <= h; y += YSTEP) {
      // Nominal (unmodulated) x position for the n-th rotated line at row y
      const xNom = (n * S - y * sinT) / cosT;

      // Skip rows where the unmodulated line is far outside the canvas —
      // the displacement can at most move it by edgeMargin further.
      if (xNom < -edgeMargin || xNom > w + edgeMargin) {
        current = commitPath(current);
        continue;
      }

      // Sample image intensity at the nominal position
      const intensity = sample(
        Math.max(0, Math.min(w - 1, xNom)),
        Math.max(0, Math.min(h - 1, y)),
      );

      // Apply phase displacement: dark pixels (I≈0) leave the line in place;
      // bright pixels (I≈1) shift it by −dispScale, opening the moiré fringe.
      const xMod = xNom - dispScale * intensity;

      // Break path when the displaced line leaves the visible canvas
      if (xMod < 0 || xMod > w) {
        current = commitPath(current);
        continue;
      }

      if (!current) {
        current = new paper.Path();
        current.strokeColor = new paper.Color('magenta');
        current.strokeWidth = 1;
        current.fillColor = null;
      }

      current.add(new paper.Point(xMod, y));
    }

    commitPath(current);
  }
}
