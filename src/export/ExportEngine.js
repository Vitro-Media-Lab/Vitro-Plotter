/**
 * ExportEngine — Handles SVG, PNG, and G-code export using Paper.js
 * native capabilities where possible.
 *
 * All export methods now accept a `margin` parameter and apply the
 * margin transform to the output coordinates, so the exported file
 * matches what the user sees in the preview (content inset by margin).
 *
 * Labels (title/subtitle) are automatically included because they are
 * stored as Paper.js paths in the project's active layer, and all
 * export methods recursively walk groups to collect paths.
 *
 * Path Optimization:
 * Before G-code generation, the project is passed through
 * optimizeForPlotter() which deduplicates overlapping segments and
 * chains them into continuous paths — identical to vpype's linemerge.
 */
import paper from 'paper';
import { optimizeForPlotter } from './PathOptimizer.js';
import { sortByProximity } from '../algorithms/ChainUtils.js';

/**
 * Minimum path length filter threshold.
 * Any path whose total cumulative Euclidean length is below this
 * value (in Paper.js coordinate units) is discarded before export.
 * This eliminates tiny stray marks, dust specks, and degenerate
 * contour rings that would waste plotter time and ink.
 *
 * NOTE: Paths are in mm coordinate space (converted from pixel coords
 * by convertPathsToMm in App.jsx). A threshold of 1.0mm filters out
 * sub-millimeter artifacts while preserving short crosshatch segments
 * that are visible in the preview.
 */
const MIN_PATH_LENGTH = 1.0; // mm — paths shorter than this are discarded

/**
 * Calculate the total cumulative length of a polyline by summing
 * the Euclidean distance between all sequential (x, y) vertices.
 *
 * @param {paper.Path} path — the Paper.js path to measure
 * @returns {number} total cumulative length in Paper.js coordinate units
 */
function pathLength(path) {
  const segs = path.segments;
  if (segs.length < 2) return 0;
  let total = 0;
  let prev = segs[0].point;
  for (let i = 1; i < segs.length; i++) {
    const curr = segs[i].point;
    total += prev.getDistance(curr);
    prev = curr;
  }
  // If the path is closed, add the closing segment (last → first)
  if (path.closed && segs.length > 2) {
    total += segs[segs.length - 1].point.getDistance(segs[0].point);
  }
  return total;
}

/**
 * Apply a margin transform to a point in paper-mm coordinates.
 * Transforms from full-paper coordinates to margin-inset coordinates.
 *
 * @param {paper.Point} point — point in [0,paperW] × [0,paperH] space
 * @param {number} paperW
 * @param {number} paperH
 * @param {number} margin
 * @returns {{x: number, y: number}}
 */
function applyMarginToPoint(point, paperW, paperH, margin) {
  // Use a UNIFORM content scale to preserve aspect ratio.
  // The content is uniformly shrunk so it fits within the margin inset
  // on both axes, preventing distortion on non-square paper.
  const contentScale = Math.min(
    (paperW - 2 * margin) / paperW,
    (paperH - 2 * margin) / paperH
  );
  return {
    x: point.x * contentScale + margin,
    y: point.y * contentScale + margin,
  };
}

/**
 * Build an SVG string from Paper.js paths with margin applied directly
 * to coordinates. This avoids fragile SVG string hacking and ensures
 * the exported SVG has correct coordinates regardless of view transforms.
 *
 * @param {paper.Path[]} paths
 * @param {number} paperW
 * @param {number} paperH
 * @param {number} margin
 * @param {number} precision
 * @returns {string}
 */
function buildSvgFromPaths(paths, paperW, paperH, margin, precision = 3) {
  const p = (n) => Number(n.toFixed(precision));
  let svg = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${paperW} ${paperH}" width="${paperW}mm" height="${paperH}mm">\n`;

  for (const path of paths) {
    if (path.segments.length < 2) continue;
    const segs = path.segments;
    const firstPt = applyMarginToPoint(segs[0].point, paperW, paperH, margin);
    let d = `M ${p(firstPt.x)} ${p(firstPt.y)}`;
    for (let i = 1; i < segs.length; i++) {
      const prev = segs[i - 1];
      const curr = segs[i];
      const ho = prev.handleOut;
      const hi = curr.handleIn;
      const pt = applyMarginToPoint(curr.point, paperW, paperH, margin);
      if (ho.x === 0 && ho.y === 0 && hi.x === 0 && hi.y === 0) {
        d += ` L ${p(pt.x)} ${p(pt.y)}`;
      } else {
        const cp1 = applyMarginToPoint({ x: prev.point.x + ho.x, y: prev.point.y + ho.y }, paperW, paperH, margin);
        const cp2 = applyMarginToPoint({ x: curr.point.x + hi.x, y: curr.point.y + hi.y }, paperW, paperH, margin);
        d += ` C ${p(cp1.x)},${p(cp1.y)} ${p(cp2.x)},${p(cp2.y)} ${p(pt.x)},${p(pt.y)}`;
      }
    }
    if (path.closed && segs.length > 1) {
      const prev = segs[segs.length - 1];
      const curr = segs[0];
      const ho = prev.handleOut;
      const hi = curr.handleIn;
      if (!(ho.x === 0 && ho.y === 0 && hi.x === 0 && hi.y === 0)) {
        const cp1 = applyMarginToPoint({ x: prev.point.x + ho.x, y: prev.point.y + ho.y }, paperW, paperH, margin);
        const cp2 = applyMarginToPoint({ x: curr.point.x + hi.x, y: curr.point.y + hi.y }, paperW, paperH, margin);
        d += ` C ${p(cp1.x)},${p(cp1.y)} ${p(cp2.x)},${p(cp2.y)} ${p(firstPt.x)},${p(firstPt.y)}`;
      }
      d += ' Z';
    }
    const color = path.strokeColor ? path.strokeColor.toCSS(true) : '#000000';
    const width = path.strokeWidth || 1;
    svg += `  <path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>\n`;
  }

  svg += '</svg>\n';
  return svg;
}

export class ExportEngine {
  /**
   * Recursively collect all paper.Path items from the active layer,
   * including paths nested inside groups (e.g., artworkLabels group).
   * Filters out paths whose total cumulative length is below MIN_PATH_LENGTH.
   *
   * @param {paper.Layer} layer
   * @returns {paper.Path[]}
   */
  static _collectAllPaths(layer) {
    const paths = [];
    function walk(items) {
      for (const item of items) {
        if (item instanceof paper.Path) {
          if (item.segments.length > 1 && pathLength(item) >= MIN_PATH_LENGTH) {
            paths.push(item);
          }
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          // Recursively descend into nested groups and compound paths
          walk(item.children);
        }
      }
    }
    walk(layer.children);
    return paths;
  }

  /**
   * Compute the margin-aware transform parameters.
   * This matches the transform used by layoutPaths() in App.jsx.
   *
   * @param {number} paperW — paper width in mm
   * @param {number} paperH — paper height in mm
   * @param {number} margin — margin in mm
   * @param {number} outputW — output width in pixels (for PNG)
   * @param {number} outputH — output height in pixels (for PNG)
   * @returns {{ scaleX: number, scaleY: number, offsetX: number, offsetY: number }}
   */
  static _getMarginTransform(paperW, paperH, margin, outputW, outputH) {
    // Uniform content scale preserves aspect ratio on non-square paper.
    // The min() ensures the tighter axis determines the scale.
    const contentScale = Math.min(
      (paperW - 2 * margin) / paperW,
      (paperH - 2 * margin) / paperH
    );
    const canvasScale = Math.min(outputW / paperW, outputH / paperH);
    const totalScale = contentScale * canvasScale;

    // Center the uniformly-scaled content within the paper, then center
    // the paper on the output canvas. Using paperDim/2 * (1 - contentScale)
    // instead of margin ensures correct centering when contentScale is
    // determined by the tighter axis (the looser axis needs more offset).
    return {
      scaleX: totalScale,
      scaleY: totalScale,
      offsetX: (outputW - paperW * canvasScale) / 2
             + (paperW / 2) * (1 - contentScale) * canvasScale,
      offsetY: (outputH - paperH * canvasScale) / 2
             + (paperH / 2) * (1 - contentScale) * canvasScale,
    };
  }

  /**
   * Export the current Paper.js project as an SVG string.
   * Applies the margin transform directly to path coordinates so the
   * exported SVG visually matches the preview regardless of view transforms.
   *
   * @param {paper.Project} project
   * @param {number} paperWidth — paper width in mm
   * @param {number} paperHeight — paper height in mm
   * @param {number} margin — margin in mm
   */
  static exportSVG(project, paperWidth, paperHeight, margin = 0) {
    const allPaths = ExportEngine._collectAllPaths(project.activeLayer);
    return buildSvgFromPaths(allPaths, paperWidth, paperHeight, margin);
  }

  /**
   * Export the current Paper.js project as a PNG data URL.
   * Applies the margin transform when drawing paths so the
   * exported PNG visually matches the preview.
   *
   * @param {paper.Project} project
   * @param {number} paperWidth — paper width in mm
   * @param {number} paperHeight — paper height in mm
   * @param {number} margin — margin in mm
   */
  static exportPNG(project, paperWidth, paperHeight, margin = 0, engineRes = 1000) {
    // Compute the output scale so the PNG resolution matches the engine resolution.
    // The engine resolution is the pixel size of the rasterized image used by the
    // algorithm (e.g., 1500px for "High Detail"). We map that to the paper width
    // to determine pixels-per-mm, ensuring the exported PNG captures the same
    // level of detail as the preview.
    const pixelsPerMm = engineRes / paperWidth;
    // Ensure the shorter dimension is at least 1080px
    const minScale = 1080 / Math.min(paperWidth, paperHeight);
    const scale = Math.max(minScale, Math.round(pixelsPerMm));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(paperWidth * scale);
    canvas.height = Math.round(paperHeight * scale);
    const ctx = canvas.getContext('2d');

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Compute margin-aware transform
    const tf = ExportEngine._getMarginTransform(
      paperWidth, paperHeight, margin,
      canvas.width, canvas.height
    );

    // ── Line Width Matching ──────────────────────────────────────────
    // Paper.js renders strokeWidth in view-space (CSS) pixels regardless
    // of the view matrix. The preview canvas has its own px/mm scale
    // (canvasScale = viewSize.width / paperWidth), while the PNG canvas
    // has scale px/mm. To make the PNG lines visually match the preview,
    // we compute the ratio between the two scales.
    //
    //   correctLineWidth = strokeWidth * (pngPxPerMm / previewPxPerMm)
    //
    // We also account for the content scale reduction from margins:
    // when margin > 0, the view matrix scales content coordinates down
    // by contentScale, but Paper.js stroke widths are NOT affected by
    // the view matrix. This means strokes in the margin-inset area
    // appear proportionally THICKER relative to the content (by 1/contentScale).
    // To match this effect in the PNG, we must INCREASE the line width
    // by the same factor:
    //   lineWidthRatio = (pngPxPerMm / previewPxPerMm) / contentScale
    //
    // We derive previewPxPerMm from the Paper.js view's viewSize (CSS px).
    // If the view is unavailable, fall back to the PNG scale (no adjustment).
    // ─────────────────────────────────────────────────────────────────
    // Use uniform content scale matching _getMarginTransform to keep
    // line width compensation consistent with the coordinate transform.
    const contentScale = Math.min(
      (paperWidth - 2 * margin) / paperWidth,
      (paperHeight - 2 * margin) / paperHeight
    );
    let lineWidthRatio = 1;
    if (project.view && project.view.viewSize) {
      const previewPxPerMm = project.view.viewSize.width / paperWidth;
      // Divide by contentScale (not multiply) because Paper.js view matrix
      // scales coordinates but NOT stroke widths, making strokes appear
      // proportionally thicker in the margin-inset preview.
      lineWidthRatio = (scale / previewPxPerMm) / contentScale;
    }

    // Draw each path using its stroke color (falls back to black)
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const allPaths = ExportEngine._collectAllPaths(project.activeLayer);
    for (const item of allPaths) {
      const color = item.strokeColor
        ? item.strokeColor.toCSS(true)
        : '#000000';
      ctx.strokeStyle = color;
      ctx.lineWidth = (item.strokeWidth || 0.6) * lineWidthRatio;
      ctx.beginPath();
      const segs = item.segments;
      const first = segs[0].point;
      const fx = first.x * tf.scaleX + tf.offsetX;
      const fy = first.y * tf.scaleY + tf.offsetY;
      ctx.moveTo(fx, fy);
      for (let i = 1; i < segs.length; i++) {
        const prev = segs[i - 1];
        const curr = segs[i];
        const ho = prev.handleOut;
        const hi = curr.handleIn;
        const ex = curr.point.x * tf.scaleX + tf.offsetX;
        const ey = curr.point.y * tf.scaleY + tf.offsetY;
        if (ho.x === 0 && ho.y === 0 && hi.x === 0 && hi.y === 0) {
          ctx.lineTo(ex, ey);
        } else {
          ctx.bezierCurveTo(
            (prev.point.x + ho.x) * tf.scaleX + tf.offsetX,
            (prev.point.y + ho.y) * tf.scaleY + tf.offsetY,
            (curr.point.x + hi.x) * tf.scaleX + tf.offsetX,
            (curr.point.y + hi.y) * tf.scaleY + tf.offsetY,
            ex, ey
          );
        }
      }
      if (item.closed && segs.length > 1) {
        const prev = segs[segs.length - 1];
        const curr = segs[0];
        const ho = prev.handleOut;
        const hi = curr.handleIn;
        if (ho.x === 0 && ho.y === 0 && hi.x === 0 && hi.y === 0) {
          ctx.closePath();
        } else {
          ctx.bezierCurveTo(
            (prev.point.x + ho.x) * tf.scaleX + tf.offsetX,
            (prev.point.y + ho.y) * tf.scaleY + tf.offsetY,
            (curr.point.x + hi.x) * tf.scaleX + tf.offsetX,
            (curr.point.y + hi.y) * tf.scaleY + tf.offsetY,
            fx, fy
          );
          ctx.closePath();
        }
      }
      ctx.stroke();
    }

    return canvas.toDataURL('image/png');
  }

  /**
   * Generate Bambu A1 G-code from Paper.js project paths.
   * Applies margin transform to the coordinates so the plotter
   * output matches the preview.
   *
   * The margin transform maps coordinates from [0, paperW] × [0, paperH]
   * to [margin, paperW-margin] × [margin, paperH-margin], matching the
   * visual preview shown in the UI.
   *
   * Flattens curves, filters microscopic/duplicate points, and correctly
   * scales/centers the drawing to the print bed safely.
   */
  static generateBambuGcode(project, paperW, paperH, margin, zUp, zDown, feedrate) {
    const START_GCODE = `; --- BAMBU A1 PEN PLOTTER START ---
M412 S0 ; Turn OFF runout sensor
M104 S0 ; No-wait temp
M140 S0 ; No-wait bed
M106 S0 ; Fans off
G90 ; Absolute positioning
; G28 Home axes
G92 E0 ; Reset extruder
; --- END START G-CODE ---`;

    const END_GCODE = `; --- BAMBU A1 PEN PLOTTER END ---
G91
G1 Z10 F600
G90
G1 X0 Y256 F3000
M106 S0
M412 S1
M84
; --- END G-CODE ---`;

    let gcode = START_GCODE + '\n';
    let totalPoints = 0;

    const allSrcPaths = ExportEngine._collectAllPaths(project.activeLayer);
    const hasMoireLayers = allSrcPaths.some(p => p.data?.moire_layer != null);

    // Optimize a set of Paper.js paths in an isolated temp project, flatten
    // curves to polylines, and return them as plain {x,y} point arrays.
    // The temp project is created and destroyed entirely within this helper
    // so there is no risk of stale Paper.js state leaking back to the preview.
    const getChains = (srcPaths) => {
      if (srcPaths.length === 0) return [];
      const tmp = new paper.Project();
      tmp.activate();
      for (const p of srcPaths) {
        if (p.segments.length >= 2) tmp.activeLayer.addChild(p.clone());
      }
      optimizeForPlotter(tmp, 0.1);
      const chains = [];
      for (const item of tmp.activeLayer.children) {
        if (!(item instanceof paper.Path) || item.segments.length < 2) continue;
        item.flatten(0.5);
        if (item.segments.length < 2) continue;
        chains.push(item.segments.map(s => ({ x: s.point.x, y: s.point.y })));
      }
      tmp.remove();
      project.activate();
      return chains;
    };

    // Build the final ordered path list.
    // Dual-layer moiré plots are strictly segregated: Layer 1 is sorted and
    // drawn completely before Layer 2 begins. Each layer is sorted
    // independently top-to-bottom with bidirectional (boustrophedon) drawing.
    let finalChains;
    if (hasMoireLayers) {
      const l1 = getChains(allSrcPaths.filter(p => p.data?.moire_layer === 1));
      const l2 = getChains(allSrcPaths.filter(p => p.data?.moire_layer === 2));
      finalChains = [...sortByProximity(l1), ...sortByProximity(l2)];
    } else {
      finalChains = sortByProximity(getChains(allSrcPaths));
    }

    // ── Coordinate Map: tool offset + margin scaling ─────────────────
    const BED_W = 256.0;
    const BED_H = 256.0;
    const PEN_OFFSET_X = 0.0;
    const PEN_OFFSET_Y = 50.0; // pen mounted 50mm forward of nozzle

    const effectiveBedW = BED_W;
    const effectiveBedH = BED_H - PEN_OFFSET_Y;

    const printableW = effectiveBedW - (2 * margin);
    const printableH = effectiveBedH - (2 * margin);

    const scale = Math.min(printableW / paperW, printableH / paperH);

    const offsetX = (effectiveBedW / 2) - ((paperW * scale) / 2);
    const offsetY = (effectiveBedH / 2) - ((paperH * scale) / 2);

    const toGX = (x) => offsetX + (x * scale) + PEN_OFFSET_X;
    const toGY = (y) => offsetY + ((paperH - y) * scale) + PEN_OFFSET_Y;

    // ── Emit G-code ───────────────────────────────────────────────────
    for (const chain of finalChains) {
      if (chain.length < 2) continue;

      gcode += `G1 Z${zUp} F3000 ; pen up\n`;
      const fx = toGX(chain[0].x);
      const fy = toGY(chain[0].y);
      gcode += `G1 X${fx.toFixed(3)} Y${fy.toFixed(3)} F${feedrate}\n`;
      gcode += `G1 Z${zDown.toFixed(3)} F3000 ; pen down\n`;
      totalPoints++;

      let prevX = fx, prevY = fy;
      for (let i = 1; i < chain.length; i++) {
        const mx = toGX(chain[i].x);
        const my = toGY(chain[i].y);
        const dx = mx - prevX, dy = my - prevY;
        if ((dx * dx + dy * dy) < 0.01) continue;
        gcode += `G1 X${mx.toFixed(3)} Y${my.toFixed(3)} F${feedrate}\n`;
        totalPoints++;
        prevX = mx;
        prevY = my;
      }
    }

    gcode += END_GCODE + '\n';
    return { gcode, totalPoints };
  }

  /**
   * Generate GRBL G-code from Paper.js project paths.
   * Applies margin transform to the coordinates so the plotter
   * output matches the preview.
   *
   * The margin transform maps coordinates from [0, paperW] × [0, paperH]
   * to [margin, paperW-margin] × [margin, paperH-margin], matching the
   * visual preview shown in the UI.
   */
  static generateGrblGcode(project, paperW, paperH, margin, zUp, zDown, feedrate) {
    let gcode = '; GRBL G-Code generated by Vitro Vector Engine\n';
    gcode += `; Paper: ${paperW}x${paperH} mm, Margin: ${margin} mm\n`;
    gcode += 'G21 ; mm mode\n';
    gcode += 'G90 ; absolute positioning\n';
    gcode += 'G28 ; home\n';
    gcode += 'M3 S0 ; spindle off (pen up)\n';
    gcode += `G1 Z${zUp} F3000\n`;
    gcode += `G1 X${margin} Y${margin} F${feedrate}\n`;

    let totalPoints = 0;

    // ── Margin Transform ──────────────────────────────────────
    // Apply the same margin transform as layoutPaths() in App.jsx:
    //   contentScale = (paper - 2*margin) / paper
    //   newX = oldX * contentScale + margin
    //   newY = oldY * contentScale + margin
    // Uses a UNIFORM content scale to preserve aspect ratio on non-square paper.
    const contentScale = Math.min(
      (paperW - 2 * margin) / paperW,
      (paperH - 2 * margin) / paperH
    );

    // Helper to apply margin transform to a point
    const marginX = (x) => x * contentScale + margin;
    const marginY = (y) => y * contentScale + margin;

    // ── Path Optimization: deduplicate + chain segments ──
    // Clone paths once into a temporary project for optimization
    const tempProject = new paper.Project();
    const tempLayer = tempProject.activeLayer;
    const allSrcPaths = ExportEngine._collectAllPaths(project.activeLayer);
    for (const item of allSrcPaths) {
      if (item.segments.length >= 2) {
        tempLayer.addChild(item.clone());
      }
    }
    optimizeForPlotter(tempProject, 0.1);
    // ── End Path Optimization ──

    // Iterate optimized paths directly from tempLayer (no extra clone)
    for (const item of tempLayer.children) {
      if (!(item instanceof paper.Path) || item.segments.length < 2) continue;
      item.flatten(0.5);

      // ── Variable Z-Depth Support ──────────────────────────────────
      // Check if this path has Z-depth metadata on its segments.
      const hasZData = item.segments.some(seg => seg.data?.zDepth != null);

      if (hasZData) {
        // Use the first segment's Z-depth for initial pen-down
        const firstZ = item.segments[0].data?.zDepth != null
          ? item.segments[0].data.zDepth
          : zDown;
        gcode += `G1 Z${firstZ.toFixed(3)} F3000 ; pen down (z-depth)\n`;

        for (let i = 0; i < item.segments.length; i++) {
          const seg = item.segments[i];
          const x = marginX(seg.point.x);
          const y = marginY(seg.point.y);

          // Emit Z change if this segment has different Z than previous
          if (i > 0) {
            const segZ = seg.data?.zDepth;
            if (segZ != null) {
              const prevZ = item.segments[i - 1]?.data?.zDepth;
              if (prevZ == null || Math.abs(segZ - prevZ) > 0.001) {
                gcode += `G1 Z${segZ.toFixed(3)} F3000\n`;
              }
            }
          }

          gcode += `G1 X${x.toFixed(3)} Y${y.toFixed(3)} F${feedrate}\n`;
          totalPoints++;
        }
      } else {
        // Legacy mode: no Z-depth data, use global zDown
        gcode += 'M3 S1000 ; spindle on (pen down)\n';
        for (const seg of item.segments) {
          const x = marginX(seg.point.x);
          const y = marginY(seg.point.y);
          gcode += `G1 X${x.toFixed(3)} Y${y.toFixed(3)} F${feedrate}\n`;
          totalPoints++;
        }
        gcode += 'M3 S0 ; spindle off (pen up)\n';
      }
    }

    tempProject.remove();
    project.activate(); // restore main preview project as the active Paper.js project

    gcode += `G1 Z${zUp} F3000 ; pen up\n`;
    gcode += 'G1 X0 Y0 F3000 ; return home\n';
    gcode += 'M30 ; program end\n';

    return { gcode, totalPoints };
  }

  /**
   * Generate Bambu A1 G-code from per-color point arrays (spot color mode).
   * Each color's paths are arrays of {x,y} points in mm coordinates.
   * The margin transform is applied to coordinates so the plotter output
   * matches the preview.
   *
   * @param {Object} spotAllPaths - { markerId: [ [ {x,y}, ... ], ... ] }
   * @param {Array} activeMarkers - [ { id, label, hex }, ... ]
   * @param {number} paperW - paper width in mm
   * @param {number} paperH - paper height in mm
   * @param {number} margin - margin in mm
   * @param {number} zUp - pen-up Z height
   * @param {number} zDown - pen-down Z height
   * @param {number} feedrate - XY feedrate
   * @returns {Array} - [ { markerId, label, filename, gcode, totalPoints }, ... ]
   */
  static generateSpotBambuGcode(spotAllPaths, activeMarkers, paperW, paperH, margin, zUp, zDown, feedrate) {
    const START_GCODE = [
      '; --- BAMBU A1 PEN PLOTTER START ---',
      'M412 S0 ; Turn OFF runout sensor',
      'M104 S0 ; No-wait temp',
      'M140 S0 ; No-wait bed',
      'M106 S0 ; Fans off',
      'G90 ; Absolute positioning',
      // 'G28 ; Home axes', // intentionally omitted — manual home on power-up
      'G92 E0 ; Reset extruder',
      '; --- END START G-CODE ---',
    ].join('\n');

    const END_GCODE = [
      '; --- BAMBU A1 PEN PLOTTER END ---',
      'G91',
      'G1 Z10 F600',
      'G90',
      'G1 X0 Y256 F3000',
      'M106 S0',
      'M412 S1',
      'M84',
      '; --- END G-CODE ---',
    ].join('\n');

    const BED_W = 256.0;
    const BED_H = 256.0;
    const PEN_OFFSET_X = 0.0;
    const PEN_OFFSET_Y = 50.0; // pen mounted 50mm forward of nozzle

    const effectiveBedW = BED_W;
    const effectiveBedH = BED_H - PEN_OFFSET_Y;

    const printableW = effectiveBedW - (2 * margin);
    const printableH = effectiveBedH - (2 * margin);

    const scale = Math.min(printableW / paperW, printableH / paperH);

    const offsetX = (effectiveBedW / 2) - ((paperW * scale) / 2);
    const offsetY = (effectiveBedH / 2) - ((paperH * scale) / 2);

    const toGX = (x) => offsetX + (x * scale) + PEN_OFFSET_X;
    const toGY = (y) => offsetY + ((paperH - y) * scale) + PEN_OFFSET_Y;

    const files = [];

    for (const marker of activeMarkers) {
      const paths = spotAllPaths[marker.id];
      if (!paths || paths.length === 0) continue;

      let gcode = `; Spot Color: ${marker.label} (${marker.hex})\n`;
      gcode += `; Paper: ${paperW}x${paperH} mm, Margin: ${margin} mm\n`;
      gcode += START_GCODE + '\n';
      let totalPoints = 0;

      for (const pts of paths) {
        if (pts.length < 2) continue;

        gcode += `G1 Z${zUp} F3000 ; pen up\n`;

        const fx = toGX(pts[0].x);
        const fy = toGY(pts[0].y);
        gcode += `G1 X${fx.toFixed(3)} Y${fy.toFixed(3)} F${feedrate}\n`;
        gcode += `G1 Z${zDown.toFixed(3)} F3000 ; pen down\n`;
        totalPoints++;

        let prevX = fx;
        let prevY = fy;

        for (let i = 1; i < pts.length; i++) {
          const mx = toGX(pts[i].x);
          const my = toGY(pts[i].y);
          const dx = mx - prevX;
          const dy = my - prevY;

          // Skip microscopic line segments (< 0.1mm)
          if ((dx * dx + dy * dy) < 0.01) continue;

          gcode += `G1 X${mx.toFixed(3)} Y${my.toFixed(3)} F${feedrate}\n`;
          totalPoints++;
          prevX = mx;
          prevY = my;
        }
      }

      gcode += END_GCODE + '\n';

      const safeLabel = marker.label.toLowerCase().replace(/\s+/g, '_');
      files.push({
        markerId: marker.id,
        label: marker.label,
        filename: `vitro_bambu_${safeLabel}.gcode`,
        gcode,
        totalPoints,
      });
    }

    return files;
  }

  /**
   * Generate GRBL G-code from per-color point arrays (spot color mode).
   * Each color's paths are arrays of {x,y} points in mm coordinates.
   * The margin transform is applied to coordinates so the plotter output
   * matches the preview.
   *
   * @param {Object} spotAllPaths - { markerId: [ [ {x,y}, ... ], ... ] }
   * @param {Array} activeMarkers - [ { id, label, hex }, ... ]
   * @param {number} paperW - paper width in mm
   * @param {number} paperH - paper height in mm
   * @param {number} margin - margin in mm
   * @param {number} zUp - pen-up Z height
   * @param {number} zDown - pen-down Z height
   * @param {number} feedrate - XY feedrate
   * @returns {Array} - [ { markerId, label, filename, gcode, totalPoints }, ... ]
   */
  static generateSpotGrblGcode(spotAllPaths, activeMarkers, paperW, paperH, margin, zUp, zDown, feedrate) {
    const contentScale = Math.min(
      (paperW - 2 * margin) / paperW,
      (paperH - 2 * margin) / paperH
    );
    const marginX = (x) => x * contentScale + margin;
    const marginY = (y) => y * contentScale + margin;

    const files = [];

    for (const marker of activeMarkers) {
      const paths = spotAllPaths[marker.id];
      if (!paths || paths.length === 0) continue;

      let gcode = `; GRBL G-Code generated by Vitro Vector Engine\n`;
      gcode += `; Spot Color: ${marker.label} (${marker.hex})\n`;
      gcode += `; Paper: ${paperW}x${paperH} mm, Margin: ${margin} mm\n`;
      gcode += 'G21 ; mm mode\n';
      gcode += 'G90 ; absolute positioning\n';
      gcode += 'G28 ; home\n';
      gcode += 'M3 S0 ; spindle off (pen up)\n';
      gcode += `G1 Z${zUp} F3000\n`;
      gcode += `G1 X${margin} Y${margin} F${feedrate}\n`;

      let totalPoints = 0;

      for (const pts of paths) {
        if (pts.length < 2) continue;

        gcode += 'M3 S1000 ; spindle on (pen down)\n';

        for (const pt of pts) {
          const x = marginX(pt.x);
          const y = marginY(pt.y);
          gcode += `G1 X${x.toFixed(3)} Y${y.toFixed(3)} F${feedrate}\n`;
          totalPoints++;
        }

        gcode += 'M3 S0 ; spindle off (pen up)\n';
      }

      gcode += `G1 Z${zUp} F3000 ; pen up\n`;
      gcode += 'G1 X0 Y0 F3000 ; return home\n';
      gcode += 'M30 ; program end\n';

      const safeLabel = marker.label.toLowerCase().replace(/\s+/g, '_');
      files.push({
        markerId: marker.id,
        label: marker.label,
        filename: `vitro_grbl_${safeLabel}.gcode`,
        gcode,
        totalPoints,
      });
    }

    return files;
  }

  /**
   * Download a file via a temporary anchor element.
   * Handles both raw content (SVG string, G-code text) and data URLs (PNG).
   */
  static downloadFile(content, filename, mimeType) {
    let url;
    // If content is already a data URL (e.g., from canvas.toDataURL), use it directly
    if (typeof content === 'string' && content.startsWith('data:')) {
      url = content;
    } else {
      const blob = new Blob([content], { type: mimeType });
      url = URL.createObjectURL(blob);
    }
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Only revoke if we created an object URL (not for data URLs)
    if (!content.startsWith('data:')) {
      URL.revokeObjectURL(url);
    }
  }
}
