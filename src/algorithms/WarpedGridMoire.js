/**
 * Phase-Key Moiré (2-Share Visual Cryptography via Shared Key Field)
 *
 * The image is hidden symmetrically across two independent vector layers.
 * A shared key field K(x,y) camouflages the image data inside each layer's
 * line structure but cancels out exactly in the moiré interference (Φ₁ − Φ₂),
 * revealing only the image modulation φₘ.
 *
 * Math:
 *   K(x,y)  = key field — one of: Simplex fBm, Sine, Radial Sine, Spiral
 *   φₘ(x,y) = I(x,y) · π          — image encoded as ±π/2 split
 *
 *   Φ₁ = φ₁(x,y) + K·A + φₘ/2
 *   Φ₂ = φ₂(x,y) + K·A − φₘ/2
 *
 *   Moiré fringes appear where Φ₁ − Φ₂ = 0 (mod 2π):
 *     φ₁ − φ₂ + φₘ = 0 (mod 2π)   ← K cancels completely
 *
 * All key types return values in [-1, 1] and are evaluated identically on
 * both layers, so the cryptographic cancellation guarantee is preserved
 * regardless of which key geometry is selected.
 *
 * Pipeline:
 *   1. Build Float32 intensity field, Gaussian-blur it
 *   2. Evaluate Φ₁ and Φ₂ on a sub-pixel grid
 *   3. Phase-aware Marching Squares → raw edge segments
 *   4. O(N) hash-map chain builder → continuous polylines
 *   5. Greedy nearest-neighbour sort → minimal pen travel
 *   6. Emit Paper.js paths (cyan = Layer 1, magenta = Layer 2)
 */
import paper from 'paper';
import { chainSegments, sortByProximity } from './ChainUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Simplex Noise 2-D (Perlin 2001) — fixed permutation table
// ─────────────────────────────────────────────────────────────────────────────
const _SRC = [
  151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,69,142,
  8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,252,219,203,117,
  35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,171,168,68,175,74,165,71,
  134,139,48,27,166,77,146,158,231,83,111,229,122,60,211,133,230,220,105,92,41,
  55,46,245,40,244,102,143,54,65,25,63,161,1,216,80,73,209,76,132,187,208,89,
  18,169,200,196,135,130,116,188,159,86,164,100,109,198,173,186,3,64,52,217,226,
  250,124,123,5,202,38,147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,
  189,28,42,223,183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,
  172,9,129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,
  228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,239,
  107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,4,150,254,
  138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,61,156,180,
];
const _PERM = new Uint8Array(512);
for (let i = 0; i < 512; i++) _PERM[i] = _SRC[i & 255];
const _G2 = [[1,1],[-1,1],[1,-1],[-1,-1],[1,0],[-1,0],[0,1],[0,-1]];
const _F2  = 0.5 * (Math.sqrt(3) - 1);
const _G2C = (3 - Math.sqrt(3)) / 6;

function simplex2(x, y) {
  const s = (x + y) * _F2;
  const i = Math.floor(x + s), j = Math.floor(y + s);
  const t = (i + j) * _G2C;
  const x0 = x - (i - t), y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
  const x1 = x0 - i1 + _G2C, y1 = y0 - j1 + _G2C;
  const x2 = x0 - 1 + 2*_G2C, y2 = y0 - 1 + 2*_G2C;
  const ii = i & 255, jj = j & 255;
  const gi0 = _PERM[ii +    _PERM[jj]]      & 7;
  const gi1 = _PERM[ii+i1 + _PERM[jj+j1]]  & 7;
  const gi2 = _PERM[ii+1  + _PERM[jj+1]]   & 7;
  const c = (gi, dx, dy) => { const t2 = 0.5-dx*dx-dy*dy; if (t2<0) return 0; const tt=t2*t2; return tt*tt*(_G2[gi][0]*dx+_G2[gi][1]*dy); };
  return 70*(c(gi0,x0,y0)+c(gi1,x1,y1)+c(gi2,x2,y2));
}

function fbm(x, y) {
  let v=0, amp=0.5, freq=1, norm=0;
  for (let o=0;o<4;o++) { v+=simplex2(x*freq,y*freq)*amp; norm+=amp; amp*=0.5; freq*=2; }
  return v/norm;
}

// ─────────────────────────────────────────────────────────────────────────────
// Separable Gaussian blur
// ─────────────────────────────────────────────────────────────────────────────
function gaussianBlur(src, w, h, radius) {
  if (radius < 0.5) return src;
  const sigma=radius/2.5, kHalf=Math.ceil(sigma*3), kSize=2*kHalf+1;
  const kernel=new Float32Array(kSize); let ksum=0;
  for (let i=0;i<kSize;i++) { const d=i-kHalf; kernel[i]=Math.exp(-(d*d)/(2*sigma*sigma)); ksum+=kernel[i]; }
  for (let i=0;i<kSize;i++) kernel[i]/=ksum;
  const tmp=new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) { let acc=0; for (let k=0;k<kSize;k++) { const sx=Math.max(0,Math.min(w-1,x+k-kHalf)); acc+=src[y*w+sx]*kernel[k]; } tmp[y*w+x]=acc; }
  const out=new Float32Array(w*h);
  for (let y=0;y<h;y++) for (let x=0;x<w;x++) { let acc=0; for (let k=0;k<kSize;k++) { const sy=Math.max(0,Math.min(h-1,y+k-kHalf)); acc+=tmp[sy*w+x]*kernel[k]; } out[y*w+x]=acc; }
  return out;
}

function sampleF(field, w, h, x, y) {
  const x0=Math.floor(Math.max(0,Math.min(w-2,x))), y0=Math.floor(Math.max(0,Math.min(h-2,y)));
  const fx=x-x0, fy=y-y0;
  const g=(xi,yi)=>field[yi*w+xi];
  return g(x0,y0)*(1-fx)*(1-fy)+g(x0+1,y0)*fx*(1-fy)+g(x0,y0+1)*(1-fx)*fy+g(x0+1,y0+1)*fx*fy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase-aware Marching Squares
// ─────────────────────────────────────────────────────────────────────────────
const TWO_PI = 2 * Math.PI;

function extractPhaseContours(phaseField, cols, rows, cellPx) {
  const rawSegs = [];
  function edgeCrossings(phiA, phiB, ax, ay, bx, by, crossings) {
    const nA=Math.floor(phiA/TWO_PI), nB=Math.floor(phiB/TWO_PI);
    if (nA===nB) return;
    const lo=Math.min(nA,nB)+1, hi=Math.max(nA,nB);
    for (let n=lo;n<=hi;n++) { const t=(n*TWO_PI-phiA)/(phiB-phiA); if (t>=0&&t<=1) crossings.push({x:ax+t*(bx-ax),y:ay+t*(by-ay),n}); }
  }
  for (let gy=0;gy<rows-1;gy++) {
    for (let gx=0;gx<cols-1;gx++) {
      const phiTL=phaseField[gy*cols+gx], phiTR=phaseField[gy*cols+gx+1];
      const phiBR=phaseField[(gy+1)*cols+gx+1], phiBL=phaseField[(gy+1)*cols+gx];
      const x0=gx*cellPx, y0=gy*cellPx, x1=x0+cellPx, y1=y0+cellPx;
      const crossings=[];
      edgeCrossings(phiTL,phiTR,x0,y0,x1,y0,crossings);
      edgeCrossings(phiTR,phiBR,x1,y0,x1,y1,crossings);
      edgeCrossings(phiBR,phiBL,x1,y1,x0,y1,crossings);
      edgeCrossings(phiBL,phiTL,x0,y1,x0,y0,crossings);
      if (crossings.length===2) {
        rawSegs.push({x1:crossings[0].x,y1:crossings[0].y,x2:crossings[1].x,y2:crossings[1].y});
      } else if (crossings.length>=4) {
        const byN=new Map();
        for (const c of crossings) { if (!byN.has(c.n)) byN.set(c.n,[]); byN.get(c.n).push(c); }
        for (const pts of byN.values()) if (pts.length>=2) rawSegs.push({x1:pts[0].x,y1:pts[0].y,x2:pts[1].x,y2:pts[1].y});
      }
    }
  }
  return rawSegs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Procedural key functions — all return ∈ [-1, 1]
//
// tPara = py·cosA − px·sinA  (coordinate along the line direction)
// ns    = Key Scale in pixels (controls wavelength / arch span)
// cx/cy = canvas centre (used by radial / spiral / hyperbolic)
// ─────────────────────────────────────────────────────────────────────────────

// Sine Wave: sinusoidal oscillation along the line direction.
// Period = 2·ns pixels — at ns=300 roughly one wave spans a typical canvas.
function keySine(tPara, ns) {
  return Math.sin(Math.PI * tPara / ns);
}

// Radial Sine: concentric rings centred on the canvas.
// Ring spacing = 2π·ns / (2π) = ns pixels between zero-crossings.
function keyRadial(px, py, ns, cx, cy) {
  const r = Math.sqrt((px - cx) ** 2 + (py - cy) ** 2);
  return Math.sin(r / ns);
}

// Spiral: concentric rings with an angular twist.
// Each ring rotates one full turn relative to the previous.
function keySpiral(px, py, ns, cx, cy) {
  const dx = px - cx, dy = py - cy;
  const r   = Math.sqrt(dx * dx + dy * dy);
  return Math.sin(r / ns + Math.atan2(dy, dx));
}

// Parabolic Bow: quadratic hill along the line direction.
// K=1 at tPara=0 (line centre), falls off to −1 (clamped) at |tPara|>ns·√2.
// Lower ns = tighter, more pronounced bow.
function keyParabolic(tPara, ns) {
  const t = tPara / ns;
  return Math.max(-1, Math.min(1, 1 - t * t));
}

// Hyperbolic Bands: rectangular-hyperbola phase bands.
// sin() wraps the xy-product into oscillating bands; ns² sets band density.
// Lower ns = tighter bands; higher ns = broad, near-linear warp.
function keyHyperbolic(px, py, cx, cy, ns) {
  return Math.sin(((px - cx) * (py - cy)) / (ns * ns));
}

// Single Arc: one smooth cosine arch along the line direction.
// K=1 at tPara=0, smoothly reaches −1 at |tPara|=ns, clamped beyond.
// Unlike keySine this never oscillates — it is a single arch.
function keyArc(tPara, ns) {
  const t = Math.max(-1, Math.min(1, tPara / ns));
  return Math.cos(Math.PI * t);
}

/**
 * Phase-Key Moiré
 *
 * @param {paper.Project} project
 * @param {ImageData}     imageData      — continuous-tone grayscale data
 * @param {number}        pitch          — line pitch P in pixels
 * @param {number}        lineAngle      — line angle in degrees (applied to both layers)
 * @param {number}        noiseScale     — key spatial scale in pixels (higher = smoother)
 * @param {number}        noiseAmplitude — key amplitude in 2π units (camouflage strength)
 * @param {number}        blurRadius     — Gaussian pre-blur radius
 * @param {string}        moireLayerView — 'both' | 'layer1' | 'layer2'
 * @param {string}        keyType        — 'noise'|'sine'|'radial'|'spiral'|'parabolic'|'hyperbolic'|'arc'
 */
export function generateWarpedGridMoire(
  project,
  imageData,
  pitch          = 16,
  lineAngle      = 45,
  noiseScale     = 300,
  noiseAmplitude = 3,
  blurRadius     = 4,
  moireLayerView = 'both',
  keyType        = 'noise',
) {
  if (!imageData) return;

  const w = imageData.width;
  const h = imageData.height;
  const { data } = imageData;
  const layer = project.activeLayer;
  const P = Math.max(4, pitch);

  const alpha = lineAngle * (Math.PI / 180);
  const cosA = Math.cos(alpha), sinA = Math.sin(alpha);
  const ns = Math.max(10, noiseScale);
  const cx = w / 2, cy = h / 2;

  // ── 1. Intensity field [0=dark … 1=white] ────────────────────────────────
  const rawIntensity = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    rawIntensity[i] =
      (0.299 * data[i*4] + 0.587 * data[i*4+1] + 0.114 * data[i*4+2]) / 255;
  }
  const intensity = gaussianBlur(rawIntensity, w, h, blurRadius);

  // ── 2. Sub-pixel sampling grid ────────────────────────────────────────────
  const step = Math.max(1, Math.floor(P / 5));
  const cols = Math.floor(w / step) + 1;
  const rows = Math.floor(h / step) + 1;

  // ── 3. Build phase fields ─────────────────────────────────────────────────
  const phi1Field = new Float32Array(cols * rows);
  const phi2Field = new Float32Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const px = Math.min(gx * step, w - 1);
      const py = Math.min(gy * step, h - 1);

      // Along-line coordinate — oriented to the actual line direction so key
      // shapes are independent of lineAngle (tPara=0 runs through line centres).
      const tPara = py * cosA - px * sinA;

      // Shared key — identical value on both layers so it cancels in Φ₁ − Φ₂.
      let rawK;
      if      (keyType === 'sine')       rawK = keySine(tPara, ns);
      else if (keyType === 'radial')     rawK = keyRadial(px, py, ns, cx, cy);
      else if (keyType === 'spiral')     rawK = keySpiral(px, py, ns, cx, cy);
      else if (keyType === 'parabolic')  rawK = keyParabolic(tPara, ns);
      else if (keyType === 'hyperbolic') rawK = keyHyperbolic(px, py, cx, cy, ns);
      else if (keyType === 'arc')        rawK = keyArc(tPara, ns);
      else                               rawK = fbm(px / ns, py / ns);
      const K = rawK * noiseAmplitude * TWO_PI;

      // Image modulation: bright (I=1) → +π/2 on L1, −π/2 on L2 → Δ=π (max separation)
      //                   dark  (I=0) → 0 on both → lines coincide
      const phiM_half = sampleF(intensity, w, h, px, py) * Math.PI * 0.5;

      // Both layers share the same parallel line base geometry at lineAngle.
      // The image is revealed purely by the ±½ phase modulation split.
      const phiBase = (TWO_PI / P) * (px * cosA + py * sinA);

      // Cryptographic layers: shared key K added to both, image split ±half
      phi1Field[gy * cols + gx] = phiBase + K + phiM_half + (TWO_PI * 10000);
      phi2Field[gy * cols + gx] = phiBase + K - phiM_half + (TWO_PI * 10000);
    }
  }

  // ── 4. Marching Squares ───────────────────────────────────────────────────
  const segs1 = moireLayerView !== 'layer2' ? extractPhaseContours(phi1Field, cols, rows, step) : [];
  const segs2 = moireLayerView !== 'layer1' ? extractPhaseContours(phi2Field, cols, rows, step) : [];

  // ── 5–6. Chain + sort ─────────────────────────────────────────────────────
  const sorted1 = sortByProximity(chainSegments(segs1));
  const sorted2 = sortByProximity(chainSegments(segs2));

  // ── 7. Emit Paper.js paths ────────────────────────────────────────────────
  const MIN_PTS = 3;
  function emitChains(chains, color, layerIndex) {
    for (const chain of chains) {
      if (chain.length < MIN_PTS) continue;
      const path = new paper.Path();
      path.strokeColor = new paper.Color(color);
      path.strokeWidth = 1;
      path.fillColor   = null;
      path.data        = { moire_layer: layerIndex };
      for (const pt of chain) path.add(new paper.Point(pt.x, pt.y));
      path.smooth({ type: 'continuous' });
      layer.addChild(path);
    }
  }

  emitChains(sorted1, 'cyan',    1); // Layer 1 — key + +½ image modulation
  emitChains(sorted2, 'magenta', 2); // Layer 2 — key + −½ image modulation
}
