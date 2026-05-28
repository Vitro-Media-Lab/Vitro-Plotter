/**
 * Frequency Modulation Moiré (Direct 2D Local Gradient Displacement)
 *
 * The target image I(x,y) is treated as a smooth heightfield.  Its local
 * spatial gradients drive a symmetrical coordinate warp that compresses
 * lines exclusively at image features — no global integration artifacts.
 *
 * The displacement is split symmetrically (+½ / −½) between two independent
 * layers so neither layer individually reveals the image.  A shared Simplex
 * noise field K — evaluated at each layer's own warped coordinates — adds
 * visual camouflage without a predictable spatial pattern.
 *
 * Math:
 *   ∂X_raw[gy,gx] = I[gy, gx+1] − I[gy, gx−1]   (central difference on grid)
 *   ∂Y_raw[gy,gx] = I[gy+1, gx] − I[gy−1, gx]
 *
 *   ∂X_smooth = Gaussian(∂X_raw, σ=dispBlur)
 *   ∂Y_smooth = Gaussian(∂Y_raw, σ=dispBlur)
 *
 *   ΔX = ∂X_smooth · k,   ΔY = ∂Y_smooth · k
 *   X₁ = x + ΔX/2,  Y₁ = y + ΔY/2   (Layer 1)
 *   X₂ = x − ΔX/2,  Y₂ = y − ΔY/2   (Layer 2)
 *
 *   Φ₁ = φ₁(X₁,Y₁) + K(X₁,Y₁)·A
 *   Φ₂ = φ₂(X₂,Y₂) + K(X₂,Y₂)·A
 *
 *   Iso-contours extracted where Φ ≡ 0 (mod 2π).
 *
 * Base geometry options:
 *   Lines × Lines  — angled gratings at independent angles α₁, α₂
 *   Rings × Lines  — concentric rings (L1) vs. angled lines at α₂
 *   Rings × Rings  — two ring systems from horizontally offset centres
 *
 * Pipeline:
 *   1. Build Float32 intensity field, Gaussian-blur it
 *   2. Sub-pixel grid setup
 *   3. Central-difference gradient fields ∂X_raw, ∂Y_raw
 *   4. Gaussian-smooth gradients → symmetric ±½ displacement
 *   5. Evaluate Φ₁, Φ₂ at warped coords (geometry + noise)
 *   6. Phase-aware Marching Squares → raw edge segments
 *   7. O(N) hash-map chain builder → polylines
 *   8. Greedy nearest-neighbour sort → minimal pen travel
 *   9. Emit Paper.js paths (cyan = Layer 1, magenta = Layer 2)
 */
import paper from 'paper';
import { chainSegments, sortByProximity } from './ChainUtils.js';

// ─────────────────────────────────────────────────────────────────────────────
// Simplex Noise 2-D
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
const _F2 = 0.5*(Math.sqrt(3)-1), _G2C = (3-Math.sqrt(3))/6;

function simplex2(x, y) {
  const s=(x+y)*_F2, i=Math.floor(x+s), j=Math.floor(y+s);
  const t=(i+j)*_G2C, x0=x-(i-t), y0=y-(j-t);
  const i1=x0>y0?1:0, j1=1-i1;
  const x1=x0-i1+_G2C, y1=y0-j1+_G2C, x2=x0-1+2*_G2C, y2=y0-1+2*_G2C;
  const ii=i&255, jj=j&255;
  const gi0=_PERM[ii+_PERM[jj]]&7, gi1=_PERM[ii+i1+_PERM[jj+j1]]&7, gi2=_PERM[ii+1+_PERM[jj+1]]&7;
  const c=(gi,dx,dy)=>{const t2=0.5-dx*dx-dy*dy;if(t2<0)return 0;const tt=t2*t2;return tt*tt*(_G2[gi][0]*dx+_G2[gi][1]*dy);};
  return 70*(c(gi0,x0,y0)+c(gi1,x1,y1)+c(gi2,x2,y2));
}
function fbm(x, y) {
  let v=0,amp=0.5,freq=1,norm=0;
  for(let o=0;o<4;o++){v+=simplex2(x*freq,y*freq)*amp;norm+=amp;amp*=0.5;freq*=2;}
  return v/norm;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gaussian blur + bilinear sample
// ─────────────────────────────────────────────────────────────────────────────
function gaussianBlur(src, w, h, radius) {
  if (radius < 0.5) return src;
  const sigma=radius/2.5, kHalf=Math.ceil(sigma*3), kSize=2*kHalf+1;
  const kernel=new Float32Array(kSize); let ksum=0;
  for(let i=0;i<kSize;i++){const d=i-kHalf;kernel[i]=Math.exp(-(d*d)/(2*sigma*sigma));ksum+=kernel[i];}
  for(let i=0;i<kSize;i++) kernel[i]/=ksum;
  const tmp=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){let acc=0;for(let k=0;k<kSize;k++){const sx=Math.max(0,Math.min(w-1,x+k-kHalf));acc+=src[y*w+sx]*kernel[k];}tmp[y*w+x]=acc;}
  const out=new Float32Array(w*h);
  for(let y=0;y<h;y++) for(let x=0;x<w;x++){let acc=0;for(let k=0;k<kSize;k++){const sy=Math.max(0,Math.min(h-1,y+k-kHalf));acc+=tmp[sy*w+x]*kernel[k];}out[y*w+x]=acc;}
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
  function edgeCrossings(phiA, phiB, ax, ay, bx, by, out) {
    const nA=Math.floor(phiA/TWO_PI), nB=Math.floor(phiB/TWO_PI);
    if(nA===nB) return;
    const lo=Math.min(nA,nB)+1, hi=Math.max(nA,nB);
    for(let n=lo;n<=hi;n++){const t=(n*TWO_PI-phiA)/(phiB-phiA);if(t>=0&&t<=1)out.push({x:ax+t*(bx-ax),y:ay+t*(by-ay),n});}
  }
  for(let gy=0;gy<rows-1;gy++) {
    for(let gx=0;gx<cols-1;gx++) {
      const TL=phaseField[gy*cols+gx], TR=phaseField[gy*cols+gx+1];
      const BR=phaseField[(gy+1)*cols+gx+1], BL=phaseField[(gy+1)*cols+gx];
      const x0=gx*cellPx, y0=gy*cellPx, x1=x0+cellPx, y1=y0+cellPx;
      const cr=[];
      edgeCrossings(TL,TR,x0,y0,x1,y0,cr); edgeCrossings(TR,BR,x1,y0,x1,y1,cr);
      edgeCrossings(BR,BL,x1,y1,x0,y1,cr); edgeCrossings(BL,TL,x0,y1,x0,y0,cr);
      if(cr.length===2) {
        rawSegs.push({x1:cr[0].x,y1:cr[0].y,x2:cr[1].x,y2:cr[1].y});
      } else if(cr.length>=4) {
        const byN=new Map();
        for(const c of cr){if(!byN.has(c.n))byN.set(c.n,[]);byN.get(c.n).push(c);}
        for(const pts of byN.values()) if(pts.length>=2) rawSegs.push({x1:pts[0].x,y1:pts[0].y,x2:pts[1].x,y2:pts[1].y});
      }
    }
  }
  return rawSegs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Frequency Modulation Moiré (Pitch Squeezing)
 *
 * @param {paper.Project} project
 * @param {ImageData}     imageData      — continuous-tone grayscale data
 * @param {number}        pitch          — base line pitch P in pixels
 * @param {string}        keyGeometry    — 'lines' | 'rings_lines' | 'rings_rings'
 * @param {number}        warpAngle1     — Layer 1 line angle in degrees
 * @param {number}        warpAngle2     — Layer 2 line angle in degrees
 * @param {number}        warpIntensity  — gradient displacement scale k; typical useful range 20–150
 * @param {number}        noiseScale     — pixels per noise unit
 * @param {number}        noiseAmplitude — noise camouflage strength
 * @param {number}        blurRadius     — Gaussian pre-blur on intensity
 * @param {string}        moireLayerView — 'both' | 'layer1' | 'layer2'
 */
export function generateFreqModMoire(
  project,
  imageData,
  pitch          = 16,
  keyGeometry    = 'lines',
  warpAngle1     = 45,
  warpAngle2     = 135,
  warpIntensity  = 1.5,
  dispBlur       = 15,
  noiseScale     = 300,
  noiseAmplitude = 2,
  blurRadius     = 6,
  moireLayerView = 'both',
) {
  if (!imageData) return;

  const w = imageData.width, h = imageData.height;
  const { data } = imageData;
  const layer = project.activeLayer;
  const P = Math.max(4, pitch);

  const alpha1 = warpAngle1 * (Math.PI / 180);
  const alpha2 = warpAngle2 * (Math.PI / 180);
  const cosA1 = Math.cos(alpha1), sinA1 = Math.sin(alpha1);
  const cosA2 = Math.cos(alpha2), sinA2 = Math.sin(alpha2);

  const ns = Math.max(10, noiseScale);
  const cx = w / 2, cy = h / 2;
  const rc1x = cx - w * 0.25, rc2x = cx + w * 0.25;

  // ── 1. Intensity field + blur ─────────────────────────────────────────────
  const rawI = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    rawI[i] = (0.299*data[i*4] + 0.587*data[i*4+1] + 0.114*data[i*4+2]) / 255;
  }
  const intensity = gaussianBlur(rawI, w, h, blurRadius);

  // ── 2. Sub-pixel grid ─────────────────────────────────────────────────────
  const step = Math.max(1, Math.floor(P / 5));
  const cols = Math.floor(w / step) + 1;
  const rows = Math.floor(h / step) + 1;

  // ── 3. Central-difference gradient of intensity at each grid point ────────
  // Sample the pre-blurred intensity at neighbouring grid points to get a
  // smooth, locally-defined gradient vector — no global integration needed.
  const dXRaw = new Float32Array(cols * rows);
  const dYRaw = new Float32Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const pyC = Math.min(gy * step, h - 1);
      const pxC = Math.min(gx * step, w - 1);
      const pxL = Math.min(Math.max(0, gx - 1) * step, w - 1);
      const pxR = Math.min((gx + 1) * step, w - 1);
      const pyU = Math.min(Math.max(0, gy - 1) * step, h - 1);
      const pyD = Math.min((gy + 1) * step, h - 1);
      dXRaw[gy * cols + gx] = (sampleF(intensity, w, h, pxR, pyC) - sampleF(intensity, w, h, pxL, pyC)) * 50.0;
      dYRaw[gy * cols + gx] = (sampleF(intensity, w, h, pxC, pyD) - sampleF(intensity, w, h, pxC, pyU)) * 50.0;
    }
  }

  // ── 4. Gaussian-smooth gradients → symmetric ±½ displacement ─────────────
  // Smoothing removes high-frequency noise in the gradient field and widens
  // the influence zone of each image feature for cleaner iso-contours.
  const dXSmooth = gaussianBlur(dXRaw, cols, rows, dispBlur);
  const dYSmooth = gaussianBlur(dYRaw, cols, rows, dispBlur);

  // ── 5. Phase fields at gradient-warped coordinates ────────────────────────
  const phi1Field = new Float32Array(cols * rows);
  const phi2Field = new Float32Array(cols * rows);

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const origX = gx * step;
      const origY = gy * step;

      const dX = dXSmooth[gy * cols + gx] * warpIntensity;
      const dY = dYSmooth[gy * cols + gx] * warpIntensity;

      // Symmetric ±½ split between layers
      const X1 = origX + dX * 0.5,  Y1 = origY + dY * 0.5;
      const X2 = origX - dX * 0.5,  Y2 = origY - dY * 0.5;

      // Base geometry evaluated at each layer's warped coordinates
      let phi1, phi2;
      if (keyGeometry === 'rings_rings') {
        phi1 = (TWO_PI / P) * Math.sqrt((X1 - rc1x) ** 2 + (Y1 - cy) ** 2);
        phi2 = (TWO_PI / P) * Math.sqrt((X2 - rc2x) ** 2 + (Y2 - cy) ** 2);
      } else if (keyGeometry === 'rings_lines') {
        phi1 = (TWO_PI / P) * Math.sqrt((X1 - cx) ** 2 + (Y1 - cy) ** 2);
        phi2 = (TWO_PI / P) * (X2 * cosA2 + Y2 * sinA2);
      } else {
        phi1 = (TWO_PI / P) * (X1 * cosA1 + Y1 * sinA1);
        phi2 = (TWO_PI / P) * (X2 * cosA2 + Y2 * sinA2);
      }

      // Noise evaluated at each layer's OWN warped coords — travels with the
      // lines rather than being a fixed spatial overlay.
      const K1 = fbm(X1 / ns, Y1 / ns) * noiseAmplitude * TWO_PI;
      const K2 = fbm(X2 / ns, Y2 / ns) * noiseAmplitude * TWO_PI;

      phi1Field[gy * cols + gx] = phi1 + K1 + (TWO_PI * 10000);
      phi2Field[gy * cols + gx] = phi2 + K2 + (TWO_PI * 10000);
    }
  }

  // ── 6. Marching Squares ───────────────────────────────────────────────────
  const segs1 = moireLayerView !== 'layer2' ? extractPhaseContours(phi1Field, cols, rows, step) : [];
  const segs2 = moireLayerView !== 'layer1' ? extractPhaseContours(phi2Field, cols, rows, step) : [];

  // ── 7–9. Chain, sort, emit ────────────────────────────────────────────────
  const sorted1 = sortByProximity(chainSegments(segs1));
  const sorted2 = sortByProximity(chainSegments(segs2));

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

  emitChains(sorted1, 'cyan',    1);
  emitChains(sorted2, 'magenta', 2);
}
