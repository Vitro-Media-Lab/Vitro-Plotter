/**
 * ImageUtils — Grayscale conversion, CMYK separation, filtering, binarization,
 * and pixel-data helpers used by the raster-based algorithms.
 */
import paper from 'paper';

// ── Marching Squares helpers (private to this module) ────────────────────────
// Used only by extractSimpleShadowMask to build closed CompoundPath blobs.
//
// Bit ordering for case index: TL=bit3, TR=bit2, BR=bit1, BL=bit0
// Edge indices: 0=Top, 1=Right, 2=Bottom, 3=Left
// Each entry is an array of [edgeA, edgeB] segment pairs.

const _MS_TABLE = [
  [],                    //  0: none inside
  [[3, 2]],              //  1: BL
  [[2, 1]],              //  2: BR
  [[3, 1]],              //  3: BL + BR
  [[0, 1]],              //  4: TR
  [[0, 1], [3, 2]],      //  5: TR + BL  (saddle — keep corners separate)
  [[0, 2]],              //  6: TR + BR
  [[0, 3]],              //  7: TR + BR + BL  (TL out)
  [[0, 3]],              //  8: TL
  [[0, 2]],              //  9: TL + BL
  [[0, 3], [1, 2]],      // 10: TL + BR  (saddle — keep corners separate)
  [[0, 1]],              // 11: TL + BR + BL  (TR out)
  [[3, 1]],              // 12: TL + TR
  [[2, 1]],              // 13: TL + TR + BL  (BR out)
  [[3, 2]],              // 14: TL + TR + BR  (BL out)
  [],                    // 15: all inside
];

/**
 * Returns the pixel-space coordinate of an edge midpoint for cell (cx, cy).
 * Cells are 1×1 pixel, so midpoints fall on half-integer coordinates,
 * which guarantees neighbouring cells share exact endpoints.
 */
function _edgeMidpoint(cx, cy, edge) {
  switch (edge) {
    case 0: return [cx + 0.5, cy];       // top
    case 1: return [cx + 1,   cy + 0.5]; // right
    case 2: return [cx + 0.5, cy + 1];   // bottom
    case 3: return [cx,       cy + 0.5]; // left
  }
}

/**
 * Chains a flat list of {x1,y1,x2,y2} segments into closed loops.
 * Uses a Map keyed by half-integer coords (multiplied by 2 → integers)
 * to avoid floating-point key collisions.
 *
 * @param {{ x1,y1,x2,y2 }[]} segs
 * @returns {number[][][]} array of loops, each loop is [[x,y], ...]
 */
function _chainToLoops(segs) {
  if (segs.length === 0) return [];

  // Encode half-integer coords as integer strings for reliable Map keys.
  const key = (x, y) => `${Math.round(x * 2)},${Math.round(y * 2)}`;

  const adj = new Map(); // key → [{segIdx, end: 0|1}]
  const used = new Array(segs.length).fill(false);

  for (let i = 0; i < segs.length; i++) {
    const { x1, y1, x2, y2 } = segs[i];
    const k0 = key(x1, y1), k1 = key(x2, y2);
    if (!adj.has(k0)) adj.set(k0, []);
    if (!adj.has(k1)) adj.set(k1, []);
    adj.get(k0).push({ segIdx: i, end: 0 });
    adj.get(k1).push({ segIdx: i, end: 1 });
  }

  const loops = [];

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    used[start] = true;

    const { x1, y1, x2, y2 } = segs[start];
    const pts = [[x1, y1], [x2, y2]];

    // Walk forward from the tail.
    let tailKey = key(x2, y2);
    for (;;) {
      const neighbors = adj.get(tailKey) || [];
      let stepped = false;
      for (const { segIdx, end } of neighbors) {
        if (used[segIdx]) continue;
        used[segIdx] = true;
        const s = segs[segIdx];
        const next = end === 0 ? [s.x2, s.y2] : [s.x1, s.y1];
        pts.push(next);
        tailKey = key(next[0], next[1]);
        stepped = true;
        break;
      }
      if (!stepped) break;
    }

    // Walk backward from the head.
    let headKey = key(x1, y1);
    for (;;) {
      const neighbors = adj.get(headKey) || [];
      let stepped = false;
      for (const { segIdx, end } of neighbors) {
        if (used[segIdx]) continue;
        used[segIdx] = true;
        const s = segs[segIdx];
        const next = end === 0 ? [s.x2, s.y2] : [s.x1, s.y1];
        pts.unshift(next);
        headKey = key(next[0], next[1]);
        stepped = true;
        break;
      }
      if (!stepped) break;
    }

    if (pts.length >= 3) loops.push(pts);
  }

  return loops;
}

export class ImageUtils {
  /**
   * Convert ImageData to grayscale in-place.
   */
  static toGrayscale(imageData) {
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    return imageData;
  }

  /**
   * applyHardThreshold — Binarization Pre-Processor ("Kill the Grays").
   *
   * Iterates through the RGBA pixel array, converts each pixel to grayscale
   * using perceptual luminance (Rec. 601 luma), then applies a hard threshold:
   *
   *   - brightness < thresholdValue  →  force RGB to 0   (pure black)
   *   - brightness >= thresholdValue →  force RGB to 255 (pure white)
   *   - Alpha is forced to 255 (fully opaque)
   *
   * This eliminates soft gray "slopes" that cause vector algorithms to draw
   * multiple redundant, tightly packed contour/flow lines around anti-aliased
   * edges. After binarization, every edge is a sheer cliff — exactly one
   * boundary line is traced.
   *
   * Operates in-place and returns the same ImageData reference for chaining.
   *
   * @param {ImageData} imageData     — RGBA pixel data from a canvas
   * @param {number}    [thresholdValue=128] — brightness cutoff (0–255)
   * @returns {ImageData}  the same imageData reference, mutated in-place
   */
  static applyHardThreshold(imageData, thresholdValue = 128) {
    const d = imageData.data;
    const thr = Math.max(0, Math.min(255, thresholdValue));
    for (let i = 0; i < d.length; i += 4) {
      // Perceptual luminance (Rec. 601 luma)
      const brightness = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (brightness < thr) {
        d[i]     = 0;   // R
        d[i + 1] = 0;   // G
        d[i + 2] = 0;   // B
      } else {
        d[i]     = 255; // R
        d[i + 1] = 255; // G
        d[i + 2] = 255; // B
      }
      d[i + 3] = 255;   // Alpha — fully opaque
    }
    return imageData;
  }

  /**
   * Split ImageData into CMYK channels using Under-Color Removal (UCR).
   *
   * UCR replaces the neutral grey component in each pixel with black ink,
   * preventing 4 overlapping wet layers in dark shadow areas.
   *
   * K = max(0, min(C, M, Y) − blackFloor)
   *
   * blackFloor raises the activation threshold for the black channel so it
   * only engages in deep shadows. Without a floor, pure UCR activates K for
   * any pixel darker than ~50% grey, causing the black marker to dominate the
   * entire mid-tone range and saturated dark colors. A floor of 0.4 limits K
   * to pixels where min(C,M,Y) > 0.9 (i.e., max(R,G,B) < 0.1 — near-black),
   * which matches the physical constraint of marker plotters.
   *
   * Returns { cyan, magenta, yellow, black } as Float32Arrays of length
   * (imageData.width * imageData.height), one normalized float [0.0–1.0] per pixel.
   *
   * @param {ImageData} imageData
   * @param {number} [blackFloor=0.4] - offset subtracted from the raw UCR K value
   *   before clamping to 0. Higher = black only in deeper shadows.
   * @returns {{ cyan: Float32Array, magenta: Float32Array, yellow: Float32Array, black: Float32Array }}
   */
  static toCMYK(imageData, blackFloor = 0.4) {
    const d = imageData.data;
    const pixelCount = d.length / 4;
    const cyan    = new Float32Array(pixelCount);
    const magenta = new Float32Array(pixelCount);
    const yellow  = new Float32Array(pixelCount);
    const black   = new Float32Array(pixelCount);

    for (let i = 0; i < pixelCount; i++) {
      const r = d[i * 4]     / 255;
      const g = d[i * 4 + 1] / 255;
      const b = d[i * 4 + 2] / 255;

      const c = 1 - r;
      const m = 1 - g;
      const y = 1 - b;

      const k = Math.max(0, Math.min(c, m, y) - blackFloor);

      cyan[i]    = c - k;
      magenta[i] = m - k;
      yellow[i]  = y - k;
      black[i]   = k;
    }

    return { cyan, magenta, yellow, black };
  }

  /**
   * Separate a color ImageData into per-marker binary channels using nearest-color
   * quantization in RGB space, with optional Floyd-Steinberg dithering.
   *
   * White (255,255,255) is silently included as the "paper" color so that light
   * pixels are assigned to paper rather than forced onto the nearest ink.
   *
   * UCR (Under-Color Removal) is integrated into the quantization step via the
   * blackFloor parameter (mirrors toCMYK). For each pixel the neutral grey
   * component K = max(0, min(C,M,Y) − blackFloor) is computed, then:
   *
   *   Neutral pixel  (chroma < 15%): hard UCR rule —
   *     K > 0  → black marker (dark shadow)
   *     K ≤ 0  → paper / white (light neutral, no ink)
   *   Colored pixel  (chroma ≥ 15%): UCR-biased nearest-color —
   *     the query pixel is lerped toward the black marker by K before
   *     the distance search, biasing dark saturated colors toward black.
   *
   * Error diffusion always runs against the original buffer values so the
   * dither targets the source image regardless of which UCR path fired.
   *
   * Each returned ImageData is grayscale-packed RGBA where:
   *   0   (black) = this marker draws on this pixel
   *   255 (white) = paper shows through here (no ink)
   *
   * @param {ImageData} imageData
   * @param {Array<{id:string, r:number, g:number, b:number}>} activePalette
   * @param {boolean} [applyDither=true]
   * @param {number}  [blackFloor=0.4]  matches toCMYK — higher = black only in deeper shadows
   * @returns {Object.<string, ImageData>}  keyed by marker id
   */
  static separateSpotColors(imageData, activePalette, applyDither = true, blackFloor = 0.4) {
    const { width, height } = imageData;
    const src = imageData.data;

    const palette = [
      { id: '__white__', r: 255, g: 255, b: 255 },
      ...activePalette,
    ];

    // Pre-locate black marker once (null if not in active palette)
    const blackEntry = activePalette.find(m => m.id === 'black') || null;

    // Float working buffers so dither error can accumulate without clamping
    const rBuf = new Float32Array(width * height);
    const gBuf = new Float32Array(width * height);
    const bBuf = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      rBuf[i] = src[i * 4];
      gBuf[i] = src[i * 4 + 1];
      bBuf[i] = src[i * 4 + 2];
    }

    // One binary mask per active marker (0=draw, 255=skip)
    const masks = {};
    for (const m of activePalette) {
      masks[m.id] = new Uint8ClampedArray(width * height).fill(255);
    }

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        const pr = Math.max(0, Math.min(255, rBuf[idx]));
        const pg = Math.max(0, Math.min(255, gBuf[idx]));
        const pb = Math.max(0, Math.min(255, bBuf[idx]));

        // ── UCR ────────────────────────────────────────────────
        const c = 1 - pr / 255, m = 1 - pg / 255, yc = 1 - pb / 255;
        const k = Math.max(0, Math.min(c, m, yc) - blackFloor);
        const chroma = (Math.max(pr, pg, pb) - Math.min(pr, pg, pb)) / 255;

        let bestId = '__white__';

        if (blackEntry && chroma < 0.15) {
          // Neutral pixel: hard UCR rule — never route to a colored marker.
          // Dark neutrals (K > 0) go to black; light neutrals leave as paper.
          bestId = k > 0 ? 'black' : '__white__';
        } else {
          // Colored pixel: lerp the query point toward black proportional to K
          // so dark saturated colors are progressively biased toward black.
          let qr = pr, qg = pg, qb = pb;
          if (blackEntry && k > 0) {
            qr = pr + (blackEntry.r - pr) * k;
            qg = pg + (blackEntry.g - pg) * k;
            qb = pb + (blackEntry.b - pb) * k;
          }

          let bestDist = Infinity;
          for (const col of palette) {
            const dr = qr - col.r, dg = qg - col.g, db = qb - col.b;
            const dist = dr * dr + dg * dg + db * db;
            if (dist < bestDist) { bestDist = dist; bestId = col.id; }
          }
        }
        // ───────────────────────────────────────────────────────

        if (bestId !== '__white__') masks[bestId][idx] = 0;

        if (applyDither) {
          // Error against the original buffer values (not the UCR-biased query)
          const best = palette.find(col => col.id === bestId);
          const er = pr - best.r, eg = pg - best.g, eb = pb - best.b;
          // Floyd-Steinberg weights: 7/16, 3/16, 5/16, 1/16
          if (x + 1 < width) {
            const ri = idx + 1;
            rBuf[ri] += er * 0.4375; gBuf[ri] += eg * 0.4375; bBuf[ri] += eb * 0.4375;
          }
          if (y + 1 < height) {
            if (x - 1 >= 0) {
              const ri = idx + width - 1;
              rBuf[ri] += er * 0.1875; gBuf[ri] += eg * 0.1875; bBuf[ri] += eb * 0.1875;
            }
            const ri = idx + width;
            rBuf[ri] += er * 0.3125; gBuf[ri] += eg * 0.3125; bBuf[ri] += eb * 0.3125;
            if (x + 1 < width) {
              const ri2 = idx + width + 1;
              rBuf[ri2] += er * 0.0625; gBuf[ri2] += eg * 0.0625; bBuf[ri2] += eb * 0.0625;
            }
          }
        }
      }
    }

    const result = {};
    for (const m of activePalette) {
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const v = masks[m.id][i];
        rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v;
        rgba[i * 4 + 3] = 255;
      }
      result[m.id] = new ImageData(rgba, width, height);
    }
    return result;
  }

  /**
   * Get pixel brightness at (x, y) from raw RGBA data.
   */
  static getBrightness(x, y, width, data) {
    const idx = (y * width + x) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  /**
   * Apply brightness, contrast, blur, and invert filters to ImageData.
   * Operates in-place and returns it.
   */
  static applyFilters(imageData, { brightness = 1, contrast = 1, blur = 0, invert = false, saturation = 1 } = {}) {
    const w = imageData.width;
    const h = imageData.height;
    const d = imageData.data;

    // Per-pixel brightness/contrast/saturation/invert
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];

      // Saturation: lerp between luma and original color
      if (saturation !== 1) {
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        r = luma + saturation * (r - luma);
        g = luma + saturation * (g - luma);
        b = luma + saturation * (b - luma);
      }

      r *= brightness;
      g *= brightness;
      b *= brightness;
      r = ((r / 255 - 0.5) * contrast + 0.5) * 255;
      g = ((g / 255 - 0.5) * contrast + 0.5) * 255;
      b = ((b / 255 - 0.5) * contrast + 0.5) * 255;
      if (invert) {
        r = 255 - r;
        g = 255 - g;
        b = 255 - b;
      }
      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, g));
      d[i + 2] = Math.max(0, Math.min(255, b));
    }

    // Simple box blur
    if (blur > 0) {
      const radius = Math.max(1, Math.round(blur));
      const temp = new Uint8ClampedArray(d);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          let rSum = 0, gSum = 0, bSum = 0, count = 0;
          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const sx = x + dx, sy = y + dy;
              if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
                const idx = (sy * w + sx) * 4;
                rSum += temp[idx];
                gSum += temp[idx + 1];
                bSum += temp[idx + 2];
                count++;
              }
            }
          }
          const idx = (y * w + x) * 4;
          d[idx] = rSum / count;
          d[idx + 1] = gSum / count;
          d[idx + 2] = bSum / count;
        }
      }
    }

    return imageData;
  }

  /**
   * Load a File/Blob into an HTMLImageElement.
   */
  static loadImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Failed to decode image'));
        img.src = e.target.result;
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  /**
   * extractSimpleShadowMask — Binary shadow region → closed CompoundPath blob.
   *
   * Pipeline:
   *   1. Grayscale (luminance)
   *   2. 3×3 median filter — smooths salt-and-pepper noise without blurring
   *      edges, producing a clean binary boundary suitable for Marching Squares.
   *   3. Hard threshold → binary grid (1 = shadow, 0 = light)
   *   4. Marching Squares → closed contour loops
   *   5. paper.CompoundPath with evenodd fill — correctly handles shadow blobs
   *      that contain lighter interior "holes"
   *
   * The returned CompoundPath is NOT inserted into the active layer; callers
   * use it purely as a clip geometry for boolean intersect() operations.
   *
   * @param {ImageData} imageData
   * @param {number}    thresholdVal  Brightness cutoff 0–255. Pixels below this
   *                                  are considered shadow. Typical: 50–200.
   * @returns {paper.CompoundPath|null}  null when no shadow pixels exist.
   */
  static extractSimpleShadowMask(imageData, thresholdVal) {
    const { width: w, height: h, data } = imageData;
    const n = w * h;

    // ── 1. Grayscale ───────────────────────────────────────────────────────
    const gray = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }

    // ── 2. 3×3 Median filter ───────────────────────────────────────────────
    // Collect 9 neighbours, sort, pick index 4 (the median).
    // Border pixels clamp to the nearest edge (replicate padding).
    const filtered = new Float32Array(n);
    const nb = new Float32Array(9);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(Math.max(x + dx, 0), w - 1);
            const ny = Math.min(Math.max(y + dy, 0), h - 1);
            nb[k++] = gray[ny * w + nx];
          }
        }
        // Insertion sort on 9 elements — faster than Array.sort for tiny arrays.
        for (let i = 1; i < 9; i++) {
          const v = nb[i];
          let j = i - 1;
          while (j >= 0 && nb[j] > v) { nb[j + 1] = nb[j]; j--; }
          nb[j + 1] = v;
        }
        filtered[y * w + x] = nb[4];
      }
    }

    // ── 3. Binary grid ─────────────────────────────────────────────────────
    const grid = new Uint8Array(n);
    let shadowCount = 0;
    for (let i = 0; i < n; i++) {
      if (filtered[i] < thresholdVal) { grid[i] = 1; shadowCount++; }
    }
    if (shadowCount === 0) return null;

    // ── 4. Marching Squares → raw segments ────────────────────────────────
    const rawSegs = [];
    for (let y = 0; y < h - 1; y++) {
      for (let x = 0; x < w - 1; x++) {
        const TL = grid[y * w + x];
        const TR = grid[y * w + (x + 1)];
        const BR = grid[(y + 1) * w + (x + 1)];
        const BL = grid[(y + 1) * w + x];
        const caseIdx = (TL << 3) | (TR << 2) | (BR << 1) | BL;
        for (const [e1, e2] of _MS_TABLE[caseIdx]) {
          const [x1, y1] = _edgeMidpoint(x, y, e1);
          const [x2, y2] = _edgeMidpoint(x, y, e2);
          rawSegs.push({ x1, y1, x2, y2 });
        }
      }
    }
    if (rawSegs.length === 0) return null;

    // ── 5. Chain segments → closed loops → CompoundPath ───────────────────
    const loops = _chainToLoops(rawSegs);
    if (loops.length === 0) return null;

    // Build off-screen — { insert: false } keeps it out of the active layer.
    const compound = new paper.CompoundPath({ insert: false });
    compound.fillColor = new paper.Color(0, 0, 0);
    compound.fillRule = 'evenodd'; // holes inside shadow blobs render correctly
    compound.strokeColor = null;

    for (const loop of loops) {
      const path = new paper.Path({ insert: false });
      for (const [px, py] of loop) path.add(new paper.Point(px, py));
      path.closed = true;
      compound.addChild(path);
    }

    return compound;
  }

  /**
   * Draw an image onto an offscreen canvas at a given max dimension,
   * returning { canvas, ctx, imageData }.
   */
  static rasterize(img, maxDim = 1000) {
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    if (w > maxDim || h > maxDim) {
      const s = maxDim / Math.max(w, h);
      w = Math.round(w * s);
      h = Math.round(h * s);
    }
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    return { canvas, ctx, imageData, width: w, height: h };
  }
}
