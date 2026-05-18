/**
 * MarkerCalibrationProfile — Maps visual thickness (mm) to Z-axis depth (mm).
 *
 * Different markers have different pressure-to-width responses. This module
 * provides a pluggable calibration profile so the user can swap markers
 * without changing the skeletonization pipeline.
 *
 * ── Profile Format ──────────────────────────────────────────────
 * A profile is an object with:
 *   name        — human-readable label (e.g. "Sharpie Fine Point")
 *   description — optional notes
 *   mapThicknessToZ(thicknessMm) — function: visual thickness → Z depth
 *   mapZToThickness(zDepth)      — function: Z depth → visual thickness (inverse)
 *   minThickness — minimum line width the marker produces (mm)
 *   maxThickness — maximum line width the marker produces (mm)
 *   minZ        — Z depth at minThickness (mm, typically 0 = just touching)
 *   maxZ        — Z depth at maxThickness (mm, typically negative = pressed down)
 *
 * ── Built-in Profiles ───────────────────────────────────────────
 *   - sharpieFinePoint  : 0.5 mm – 2.0 mm  over Z 0.0 to -2.0 mm
 *   - sharpieUltraFine  : 0.3 mm – 1.2 mm  over Z 0.0 to -1.5 mm
 *   - pilotG2            : 0.4 mm – 1.8 mm  over Z 0.0 to -2.5 mm
 *   - linearCalibration  : generic linear mapping (user provides min/max)
 */

// ── Sharpie Fine Point ──────────────────────────────────────────
const sharpieFinePoint = {
  name: 'Sharpie Fine Point',
  description: 'Standard Sharpie Fine Point (0.5mm tip, moderate pressure response)',
  minThickness: 0.5,
  maxThickness: 2.0,
  minZ: 0.0,
  maxZ: -2.0,

  /**
   * Map a visual thickness (mm) to a Z-axis depth (mm).
   * Uses a quadratic curve: Z = a * t² + b * t + c
   * Fitted to three points: (0.5, 0.0), (1.25, -1.0), (2.0, -2.0)
   * @param {number} thicknessMm — visual line width in mm
   * @returns {number} Z depth in mm (negative = lower = harder press)
   */
  mapThicknessToZ(thicknessMm) {
    const t = Math.max(this.minThickness, Math.min(this.maxThickness, thicknessMm));
    // Quadratic fit through the three calibration points
    // Coefficients: a = -0.6667, b = -0.6667, c = 0.6667
    const a = -0.6667;
    const b = -0.6667;
    const c = 0.6667;
    return a * t * t + b * t + c;
  },

  /**
   * Inverse: given a Z depth, estimate the visual thickness.
   * @param {number} zDepth — Z depth in mm
   * @returns {number} estimated visual thickness in mm
   */
  mapZToThickness(zDepth) {
    const z = Math.max(this.maxZ, Math.min(this.minZ, zDepth));
    // Inverse of quadratic: t = (-b - sqrt(b² - 4a(c - z))) / (2a)
    const a = -0.6667;
    const b = -0.6667;
    const c = 0.6667 - z;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return this.minThickness;
    const t = (-b - Math.sqrt(discriminant)) / (2 * a);
    return Math.max(this.minThickness, Math.min(this.maxThickness, t));
  },
};

// ── Sharpie Ultra Fine Point ────────────────────────────────────
const sharpieUltraFine = {
  name: 'Sharpie Ultra Fine Point',
  description: 'Sharpie Ultra Fine Point (0.3mm tip, subtle pressure response)',
  minThickness: 0.3,
  maxThickness: 1.2,
  minZ: 0.0,
  maxZ: -1.5,

  mapThicknessToZ(thicknessMm) {
    const t = Math.max(this.minThickness, Math.min(this.maxThickness, thicknessMm));
    // Linear mapping: Z = -1.667 * (t - 0.3)
    return -1.667 * (t - this.minThickness);
  },

  mapZToThickness(zDepth) {
    const z = Math.max(this.maxZ, Math.min(this.minZ, zDepth));
    return this.minThickness + z / -1.667;
  },
};

// ── Pilot G2 (gel pen) ──────────────────────────────────────────
const pilotG2 = {
  name: 'Pilot G2 (0.7mm)',
  description: 'Pilot G2 gel pen (0.7mm tip, wider pressure range)',
  minThickness: 0.4,
  maxThickness: 1.8,
  minZ: 0.0,
  maxZ: -2.5,

  mapThicknessToZ(thicknessMm) {
    const t = Math.max(this.minThickness, Math.min(this.maxThickness, thicknessMm));
    // Cubic curve for more natural feel: Z = -2.5 * ((t - 0.4) / 1.4)^1.5
    const normalized = (t - this.minThickness) / (this.maxThickness - this.minThickness);
    return this.maxZ * Math.pow(normalized, 1.5);
  },

  mapZToThickness(zDepth) {
    const z = Math.max(this.maxZ, Math.min(this.minZ, zDepth));
    const normalized = Math.pow(z / this.maxZ, 1 / 1.5);
    return this.minThickness + normalized * (this.maxThickness - this.minThickness);
  },
};

// ── Generic Linear Calibration ──────────────────────────────────
/**
 * Create a linear calibration profile with custom min/max values.
 * @param {object} opts
 * @param {string} opts.name — profile name
 * @param {number} opts.minThickness — minimum line width (mm)
 * @param {number} opts.maxThickness — maximum line width (mm)
 * @param {number} opts.minZ — Z at minThickness (mm, typically 0)
 * @param {number} opts.maxZ — Z at maxThickness (mm, typically negative)
 * @returns {object} calibration profile
 */
function createLinearProfile({ name = 'Custom Linear', minThickness = 0.3, maxThickness = 2.0, minZ = 0.0, maxZ = -2.0 } = {}) {
  const range = maxThickness - minThickness;
  const zRange = maxZ - minZ;
  const slope = range !== 0 ? zRange / range : 0;

  return {
    name,
    description: `Linear calibration: ${minThickness}mm → ${maxThickness}mm over Z ${minZ} to ${maxZ}`,
    minThickness,
    maxThickness,
    minZ,
    maxZ,

    mapThicknessToZ(thicknessMm) {
      const t = Math.max(minThickness, Math.min(maxThickness, thicknessMm));
      return minZ + slope * (t - minThickness);
    },

    mapZToThickness(zDepth) {
      const z = Math.max(maxZ, Math.min(minZ, zDepth));
      return minThickness + (z - minZ) / slope;
    },
  };
}

// ── Profile Registry ────────────────────────────────────────────
const BUILT_IN_PROFILES = {
  sharpieFinePoint,
  sharpieUltraFine,
  pilotG2,
};

/**
 * Get a calibration profile by name.
 * @param {string} name — profile name (key in BUILT_IN_PROFILES) or 'custom'
 * @param {object} [customOpts] — options for createLinearProfile if name === 'custom'
 * @returns {object} calibration profile
 */
function getProfile(name = 'sharpieFinePoint', customOpts) {
  if (name === 'custom' && customOpts) {
    return createLinearProfile(customOpts);
  }
  return BUILT_IN_PROFILES[name] || sharpieFinePoint;
}

export {
  sharpieFinePoint,
  sharpieUltraFine,
  pilotG2,
  createLinearProfile,
  getProfile,
  BUILT_IN_PROFILES,
};
