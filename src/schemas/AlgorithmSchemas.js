/**
 * Algorithm Schemas — Data-Driven Settings Configuration
 *
 * Each algorithm defines its own set of controls. The SettingsPanel
 * maps over the active algorithm's schema to dynamically render sliders.
 *
 * When the user switches algorithms, slider values reset to schema defaults.
 */
export const ALGORITHM_SCHEMAS = {
  squiggle: [
    { id: 'density', label: 'Line Density', type: 'range', min: 20, max: 200, default: 80, step: 1 },
  ],
  crosshatch: [
    { id: 'density', label: 'Line Density', type: 'range', min: 20, max: 200, default: 80, step: 1 },
    { id: 'hatchDirs', label: 'Hatch Directions', type: 'checkboxGroup', options: [
      { id: 'hatchH',  label: '—', default: true },
      { id: 'hatchV',  label: '|', default: true },
      { id: 'hatchD1', label: '\\', default: true },
      { id: 'hatchD2', label: '/', default: true },
    ]},
  ],
  stipple: [
    { id: 'density', label: 'Point Density', type: 'range', min: 20, max: 200, default: 80, step: 1 },
  ],
  flowfield: [
    { id: 'density', label: 'Line Density', type: 'range', min: 20, max: 200, default: 80, step: 1 },
    { id: 'minSpacing', label: 'Min Spacing', type: 'range', min: 1, max: 10, default: 2, step: 1 },
    { id: 'maxSpacing', label: 'Max Spacing', type: 'range', min: 5, max: 30, default: 15, step: 1 },
    { id: 'stepSize', label: 'Step Size', type: 'range', min: 1, max: 5, default: 2, step: 1 },
  ],
  modulatedspiral: [
    { id: 'spiralTurns', label: 'Spiral Turns', type: 'range', min: 50, max: 300, default: 100, step: 1 },
    { id: 'wiggleAmplitude', label: 'Wiggle Amplitude', type: 'range', min: 1, max: 10, default: 4, step: 0.5 },
    { id: 'wiggleFrequency', label: 'Wiggle Frequency', type: 'range', min: 10, max: 100, default: 40, step: 1 },
  ],
  vectorsvg: [],
  scanline: [
    { id: 'density', label: 'Line Density', type: 'range', min: 20, max: 200, default: 80, step: 1 },
    { id: 'resolution', label: 'Trace Resolution', type: 'range', min: 1, max: 10, default: 2, step: 1 },
    { id: 'threshold', label: 'Threshold', type: 'range', min: 10, max: 240, default: 128, step: 1 },
  ],
  vectortrace: [
    { id: 'linesCount', label: 'Contour Levels', type: 'range', min: 3, max: 50, default: 10, step: 1 },
  ],
  skeletonize: [
    { id: 'threshold', label: 'Threshold', type: 'range', min: 10, max: 240, default: 128, step: 1 },
    { id: 'tolerance', label: 'Simplify Tolerance', type: 'range', min: 0.5, max: 5, default: 2.5, step: 0.5 },
    { id: 'minPathLength', label: 'Min Path Length', type: 'range', min: 2, max: 50, default: 5, step: 1 },
    { id: 'maxZStep', label: 'Max Z-Step (mm)', type: 'range', min: 0.05, max: 1.0, default: 0.3, step: 0.05 },
  ],
  calligraphy: [
    { id: 'sampleSpacing', label: 'Sample Spacing', type: 'range', min: 0.5, max: 8, default: 3, step: 0.5 },
    { id: 'minThickness', label: 'Prune Thickness', type: 'range', min: 0.5, max: 8, default: 1.5, step: 0.5 },
    { id: 'chainStitchDist', label: 'Chain Stitch (px)', type: 'range', min: 0, max: 60, default: 20, step: 1 },
    { id: 'minChainLen', label: 'Min Chain Length', type: 'range', min: 3, max: 30, default: 8, step: 1 },
    { id: 'simplifyDist', label: 'Simplify / Flatten', type: 'range', min: 0.5, max: 8, default: 3, step: 0.5 },
    { id: 'smoothingWindow', label: 'Z Smoothing', type: 'range', min: 1, max: 15, default: 5, step: 1 },
    { id: 'maxZStep', label: 'Max Z-Step (mm)', type: 'range', min: 0.05, max: 1.0, default: 0.3, step: 0.05 },
  ],
  subjectoutline: [
    { id: 'xdogSigma1',      label: 'Edge Sharpness (σ1)',  type: 'range', min: 0.3,  max: 3.0,  default: 0.8,  step: 0.1  },
    { id: 'xdogSigma2',      label: 'Blur Radius (σ2)',     type: 'range', min: 0.5,  max: 6.0,  default: 1.6,  step: 0.1  },
    { id: 'xdogTau',         label: 'Edge Sensitivity (τ)', type: 'range', min: 0.80, max: 0.99, default: 0.98, step: 0.01 },
    { id: 'xdogEpsilon',     label: 'Threshold (ε)',        type: 'range', min: -0.10, max: 0.10, default: 0.00, step: 0.01 },
    { id: 'minPathLength',   label: 'Min Path Length',      type: 'range', min: 3,    max: 60,   default: 10,   step: 1    },
  ],
  outlinecrosshatch: [
    { id: 'density', label: 'Hatch Density', type: 'range', min: 20, max: 200, default: 80, step: 1 },
    { id: 'hatchDirs', label: 'Hatch Directions', type: 'checkboxGroup', options: [
      { id: 'hatchH',  label: '—', default: true },
      { id: 'hatchV',  label: '|', default: true },
      { id: 'hatchD1', label: '\\', default: true },
      { id: 'hatchD2', label: '/', default: true },
    ]},
    { id: 'xdogSigma1',      label: 'Edge Sharpness (σ1)',  type: 'range',  min: 0.3,  max: 3.0,  default: 0.8,  step: 0.1  },
    { id: 'xdogSigma2',      label: 'Blur Radius (σ2)',     type: 'range',  min: 0.5,  max: 6.0,  default: 1.6,  step: 0.1  },
    { id: 'xdogTau',         label: 'Edge Sensitivity (τ)', type: 'range',  min: 0.80, max: 0.99, default: 0.98, step: 0.01 },
    { id: 'xdogEpsilon',     label: 'Threshold (ε)',        type: 'range',  min: -0.10, max: 0.10, default: 0.00, step: 0.01 },
    { id: 'minPathLength',   label: 'Min Path Length',      type: 'range',  min: 3,    max: 60,   default: 10,   step: 1    },
  ],
};

/**
 * Global Pre-Processing Schema — applies to all raster algorithms.
 * Uses the same Two-Tier debounced state architecture.
 */
export const PREPROCESS_SCHEMA = [
  { id: 'brightness', label: 'Brightness', type: 'range', min: 0, max: 200, default: 100, step: 1, suffix: '%' },
  { id: 'contrast', label: 'Contrast', type: 'range', min: 0, max: 300, default: 100, step: 1, suffix: '%' },
  { id: 'saturation', label: 'Saturation', type: 'range', min: 0, max: 300, default: 100, step: 1, suffix: '%' },
  { id: 'blur', label: 'Blur (Noise Reduction)', type: 'range', min: 0, max: 10, default: 0, step: 0.5, suffix: ' px' },
];

/**
 * Post-Processing Schema — applies after algorithm generation.
 */
export const POSTPROCESS_SCHEMA = [
  { id: 'smoothing', label: 'Curve Smoothing', type: 'range', min: 0, max: 5, default: 0, step: 1 },
];

/**
 * Artwork Labels Schema — Title, Subtitle, and Text Scale.
 * These are string inputs (title, subtitle) and a range slider (textScale).
 * They use the same Two-Tier debounced state architecture.
 */
export const LABELS_SCHEMA = [
  { id: 'title', label: 'Title', type: 'text', default: '' },
  { id: 'subtitle', label: 'Subtitle', type: 'text', default: '' },
  { id: 'textScale', label: 'Text Scale', type: 'range', min: 0.5, max: 5.0, default: 1.0, step: 0.1 },
];

/**
 * Build default settings object from a schema array.
 * @param {Array} schema
 * @returns {Object}
 */
export function getDefaults(schema) {
  const defaults = {};
  for (const field of schema) {
    if (field.type === 'checkboxGroup') {
      // Flatten each option into the top-level settings object so individual
      // checkbox IDs (hatchH, hatchV, …) are addressable as plain keys.
      for (const opt of field.options) {
        defaults[opt.id] = opt.default ?? true;
      }
    } else {
      defaults[field.id] = field.default;
    }
  }
  return defaults;
}

/**
 * Get the schema for a given algorithm.
 * @param {string} algoName
 * @returns {Array}
 */
export function getSchemaForAlgo(algoName) {
  return ALGORITHM_SCHEMAS[algoName] || [];
}
