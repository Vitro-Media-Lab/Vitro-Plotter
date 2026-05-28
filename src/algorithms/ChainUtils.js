/**
 * ChainUtils — Canonical segment chaining and proximity sorting for all
 * iso-contour and moiré algorithms.
 *
 * Previously every algorithm file kept its own copy of these two functions.
 * Centralising them here means any fix or tuning improvement propagates to
 * all algorithms at once.
 */

const MIN_CHAIN_PTS = 5;   // discard chains with fewer than this many points
const MIN_CHAIN_LEN = 5.0; // discard chains whose Euclidean length is below this (px)

/**
 * Chain raw {x1,y1,x2,y2} segments into continuous polylines.
 *
 * Uses a spatial-hash bucketing scheme with 3×3 neighbour-bucket search and
 * Euclidean distance verification.  Each endpoint is indexed in its own exact
 * bucket; lookups search all 9 surrounding buckets and pick the closest
 * endpoint within snapRadius to absorb floating-point drift at bucket edges.
 *
 * After chaining, chains shorter than MIN_CHAIN_PTS points or MIN_CHAIN_LEN
 * cumulative pixel-length are discarded to eliminate micro-artifacts.
 *
 * Each chain is grown bidirectionally (tail AND head) so the longest
 * possible polylines are assembled before the proximity sort runs.
 *
 * @param {Array<{x1:number,y1:number,x2:number,y2:number}>} rawSegs
 * @param {number} snapRadius  — bucket width in pixels (default 1.0)
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function chainSegments(rawSegs, snapRadius = 1.0) {
  if (rawSegs.length === 0) return [];

  const inv   = 1 / snapRadius;
  const snapR2 = snapRadius * snapRadius;

  // Index endpoints in their exact bucket only.
  // Lookups search all 9 surrounding buckets + Euclidean check.
  const adj = new Map();
  const addAdj = (x, y, si, end) => {
    const k = `${Math.round(x * inv)}_${Math.round(y * inv)}`;
    if (!adj.has(k)) adj.set(k, []);
    adj.get(k).push({ si, end, x, y });
  };

  for (let i = 0; i < rawSegs.length; i++) {
    const { x1, y1, x2, y2 } = rawSegs[i];
    addAdj(x1, y1, i, 0);
    addAdj(x2, y2, i, 1);
  }

  const used = new Uint8Array(rawSegs.length);

  // 3×3 neighbour-bucket search with Euclidean distance verification.
  function findNeighbor(px, py) {
    const bxc = Math.round(px * inv);
    const byc = Math.round(py * inv);
    let best = null, bestD2 = snapR2;
    for (let dbx = -1; dbx <= 1; dbx++) {
      for (let dby = -1; dby <= 1; dby++) {
        const candidates = adj.get(`${bxc + dbx}_${byc + dby}`);
        if (!candidates) continue;
        for (const c of candidates) {
          if (used[c.si]) continue;
          const dx = c.x - px, dy = c.y - py;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) { bestD2 = d2; best = c; }
        }
      }
    }
    return best;
  }

  const chains = [];

  for (let start = 0; start < rawSegs.length; start++) {
    if (used[start]) continue;
    used[start] = 1;

    const { x1, y1, x2, y2 } = rawSegs[start];
    const chain = [{ x: x1, y: y1 }, { x: x2, y: y2 }];

    // Grow forward from the tail
    let tx = x2, ty = y2;
    for (;;) {
      const m = findNeighbor(tx, ty);
      if (!m) break;
      used[m.si] = 1;
      const s = rawSegs[m.si];
      const [nx, ny] = m.end === 0 ? [s.x2, s.y2] : [s.x1, s.y1];
      chain.push({ x: nx, y: ny });
      tx = nx; ty = ny;
    }

    // Grow backward from the head
    let hx = x1, hy = y1;
    for (;;) {
      const m = findNeighbor(hx, hy);
      if (!m) break;
      used[m.si] = 1;
      const s = rawSegs[m.si];
      const [nx, ny] = m.end === 0 ? [s.x2, s.y2] : [s.x1, s.y1];
      chain.unshift({ x: nx, y: ny });
      hx = nx; hy = ny;
    }

    chains.push(chain);
  }

  // Discard micro-chains by point count and cumulative Euclidean length.
  return chains.filter(chain => {
    if (chain.length < MIN_CHAIN_PTS) return false;
    let len = 0;
    for (let i = 1; i < chain.length; i++) {
      const dx = chain[i].x - chain[i-1].x, dy = chain[i].y - chain[i-1].y;
      len += Math.sqrt(dx * dx + dy * dy);
      if (len >= MIN_CHAIN_LEN) return true; // early exit
    }
    return false;
  });
}

/**
 * Sort chains top-to-bottom with bidirectional (boustrophedon) drawing.
 *
 * Pass 1 — Linear spatial sweep: sort all chains by the minimum Y of their
 * two endpoints so the plotter works from top to bottom across the canvas.
 * Only the endpoints are compared (not the full chain bounding box).
 *
 * Pass 2 — Bidirectional flip: within that fixed sorted order, check whether
 * the current chain's start or end is closer to the previous chain's end
 * point. If the end is closer, reverse the chain so the plotter draws
 * back-and-forth (boustrophedon) without disrupting the top-to-bottom sweep.
 *
 * @param {Array<Array<{x:number,y:number}>>} chains
 * @returns {Array<Array<{x:number,y:number}>>}
 */
export function sortByProximity(chains) {
  if (chains.length <= 1) return chains;

  // Pass 1: top-to-bottom sweep by minimum endpoint Y
  const sorted = chains.slice().sort((a, b) => {
    const aY = Math.min(a[0].y, a[a.length - 1].y);
    const bY = Math.min(b[0].y, b[b.length - 1].y);
    return aY - bY;
  });

  // Pass 2: reverse individual chains for bidirectional drawing
  let prevX = 0, prevY = 0;
  for (const chain of sorted) {
    const s = chain[0], e = chain[chain.length - 1];
    const ds2 = (s.x - prevX) ** 2 + (s.y - prevY) ** 2;
    const de2 = (e.x - prevX) ** 2 + (e.y - prevY) ** 2;
    if (de2 < ds2) chain.reverse();
    const last = chain[chain.length - 1];
    prevX = last.x;
    prevY = last.y;
  }

  return sorted;
}
