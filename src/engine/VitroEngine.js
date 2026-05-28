/**
 * VitroEngine — Core Paper.js wrapper for the Vitro Vector Engine.
 *
 * Manages the Paper.js project, layer lifecycle, and provides
 * high-level operations for clearing, smoothing, and iterating paths.
 *
 * Guardrails & Sanity Checks:
 * - getStats() returns { pathCount, pointCount, isEmpty, emptyError }
 * - If the resulting path array is completely empty (length 0),
 *   returns a specific error flag so the UI can overlay a warning.
 */
import paper from 'paper';

export class VitroEngine {
  constructor(canvas) {
    this.scope = new paper.PaperScope();
    this.scope.setup(canvas);
    this.project = this.scope.project;
    this._canvas = canvas;
    this._activated = false;
  }

  /**
   * Activate this engine's PaperScope so that `new paper.Path()` and other
   * Paper.js constructors create items in this scope's project rather than
   * in a stale or null global scope.
   *
   * Must be called before any algorithm runs (and after any async yield
   * where another scope might have been activated).
   */
  activate() {
    this.scope.activate();
    this._activated = true;
  }

  /**
   * Resize the Paper.js view to match the paper aspect ratio while fitting
   * within the container. The canvas element is sized so that its aspect ratio
   * matches the selected paper size, preventing distortion of the preview.
   *
   * Uses the parent element's dimensions as the available space so that
   * the canvas correctly re-sizes when the container resizes (e.g., window resize).
   *
   * @param {number} [paperW] — paper width in mm (optional; if omitted, fills container)
   * @param {number} [paperH] — paper height in mm (optional)
   */
  resize(paperW, paperH) {
    const canvas = this._canvas;
    if (!canvas) return;

    // Use the parent element's dimensions as the available container space.
    // This ensures correct sizing when the container resizes (e.g., window resize),
    // since the canvas itself may have explicit dimensions set from a previous resize.
    const parent = canvas.parentElement;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    if (parentRect.width === 0 || parentRect.height === 0) return;

    let cssW, cssH;

    if (paperW && paperH && paperW > 0 && paperH > 0) {
      // Size the canvas to match the paper aspect ratio while fitting
      // within the container's available space.
      const paperAspect = paperW / paperH;
      const containerAspect = parentRect.width / parentRect.height;

      if (paperAspect > containerAspect) {
        // Paper is wider relative to container → fit by width
        cssW = parentRect.width;
        cssH = parentRect.width / paperAspect;
      } else {
        // Paper is taller relative to container → fit by height
        cssH = parentRect.height;
        cssW = parentRect.height * paperAspect;
      }
    } else {
      // No paper dimensions provided — fill the container (legacy behavior)
      cssW = parentRect.width;
      cssH = parentRect.height;
    }

    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;

    // Guard against null view
    if (!this.scope.view) return;
    // Paper.js _setElementSize handles canvas.width/height and applies
    // ctx.scale(pixelRatio, pixelRatio). We must NOT pre-set canvas.width
    // here: doing so resets the context to identity, and if viewSize is
    // unchanged setViewSize returns early without re-applying the DPR scale,
    // leaving the context at identity for all subsequent draws.
    this.scope.view.viewSize = new paper.Size(cssW, cssH);
  }

  /** Clear all items from the active layer. */
  clear() {
    this.project.activeLayer.removeChildren();
  }

  /** Remove all layers and start fresh. */
  reset() {
    this.project.clear();
    this.project.addLayer(new paper.Layer());
  }

  /**
   * Smooth all paths in the active layer using Paper.js's built-in
   * path.smooth() with the specified type.
   *
   * Flattens curves to polylines before smoothing so that repeated
   * smoothing iterations don't compound Bézier handle distortion.
   * Recursively processes paths inside groups (e.g., artworkLabels).
   * @param {'catmull-rom'|'continuous'|'asymmetric'} type
   * @param {number} [flattenTolerance=0.5] — tolerance for flattening curves before smoothing
   */
  smoothAll(type = 'catmull-rom') {
    function processItems(items) {
      for (const item of items) {
        if (item instanceof paper.Path) {
          // Do NOT flatten before smoothing — flatten can change the segment
          // count, which breaks restoreMmCoords (it silently skips paths whose
          // segment count no longer matches the saved mm-space snapshot).
          // layoutPaths always calls restoreMmCoords first, so paths are already
          // restored to their original straight-line polyline state on entry.
          item.smooth({ type });
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          processItems(item.children);
        }
      }
    }
    processItems(this.project.activeLayer.children);
  }

  /**
   * Flatten all paths to straight-line segments at the given tolerance.
   * This converts curves to polylines for G-code export.
   * Recursively processes paths inside groups (e.g., artworkLabels).
   * @param {number} tolerance  — maximum error in canvas pixels
   */
  flattenAll(tolerance = 0.5) {
    function processItems(items) {
      for (const item of items) {
        if (item instanceof paper.Path) {
          item.flatten(tolerance);
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          processItems(item.children);
        }
      }
    }
    processItems(this.project.activeLayer.children);
  }

  /**
   * Iterate all paths and yield arrays of {x,y} points.
   * Useful for G-code generation.
   * Recursively includes paths inside groups (e.g., artworkLabels).
   */
  *iteratePoints() {
    function* walkItems(items) {
      for (const item of items) {
        if (item instanceof paper.Path && item.segments.length > 1) {
          const pts = item.segments.map((seg) => ({
            x: seg.point.x,
            y: seg.point.y,
          }));
          yield pts;
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          yield* walkItems(item.children);
        }
      }
    }
    yield* walkItems(this.project.activeLayer.children);
  }

  /**
   * Collect all paths as arrays of {x,y} points.
   */
  collectPaths() {
    const paths = [];
    for (const pts of this.iteratePoints()) {
      paths.push(pts);
    }
    return paths;
  }

  /**
   * Get stats: number of paths and total points.
   * Includes guardrail: if pathCount is 0, sets isEmpty flag.
   * Recursively counts paths inside groups (e.g., artworkLabels).
   *
   * @returns {{ pathCount: number, pointCount: number, isEmpty: boolean, emptyError: string|null }}
   */
  getStats() {
    let pathCount = 0;
    let pointCount = 0;

    function countItems(items) {
      for (const item of items) {
        if (item instanceof paper.Path && item.segments.length > 1) {
          pathCount++;
          pointCount += item.segments.length;
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          countItems(item.children);
        }
      }
    }

    countItems(this.project.activeLayer.children);

    const isEmpty = pathCount === 0;
    const emptyError = isEmpty
      ? 'No paths generated. Try adjusting threshold or contrast.'
      : null;

    return { pathCount, pointCount, isEmpty, emptyError };
  }

  /** Access the underlying PaperScope (for advanced use). */
  get scope() {
    return this._scope;
  }
  set scope(s) {
    this._scope = s;
  }
  get project() {
    return this._project;
  }
  set project(p) {
    this._project = p;
  }
}
