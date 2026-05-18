/**
 * TextToPath — Converts text strings to raw paper.Path objects.
 *
 * Supports TWO font formats:
 *   1. SVG Fonts (.svg) — single-stroke "stick" fonts like EMSTech,
 *      Hershey, etc. These are IDEAL for pen plotters because each
 *      glyph is a single continuous stroke path (no fills, no outlines).
 *   2. TrueType/OpenType (.ttf/.otf) — standard outline fonts loaded
 *      via opentype.js. These produce closed-contour paths that are
 *      less ideal for plotters but work for larger text.
 *
 * Why this exists:
 *   Pen plotters cannot render native Canvas text or Paper.js PointText.
 *   The G-code exporter only sees paper.Path objects with segments.
 *   This module mathematically converts glyph outlines into paper.Path
 *   objects that the exporter naturally picks up.
 *
 * Plotter-Styled Output:
 *   - strokeColor: cyan (visible on dark canvas preview)
 *   - strokeWidth: 1
 *   - fillColor: null (NEVER fill — plotter can only draw strokes)
 */
import paper from 'paper';
import opentype from 'opentype.js';

/** Path to the default bundled font (served from Vite's public/ directory) */
const DEFAULT_FONT_URL = '/fonts/EMSTech.svg';

/** Cached font object — loaded once, reused for all conversions */
let _cachedFont = null;
let _fontLoadPromise = null;

/**
 * Check if the font has been loaded and is ready for use.
 * @returns {boolean}
 */
export function isFontReady() {
  return _cachedFont !== null;
}

/**
 * Get the cached font (synchronous). Returns null if not loaded yet.
 * @returns {object|null}
 */
export function getCachedFont() {
  return _cachedFont;
}

/**
 * Allow injecting a custom font.
 * Clears the cache and sets the new font.
 *
 * @param {object} font — either an opentype.Font or an SvgFont object
 */
export function setFont(font) {
  _cachedFont = font;
  _fontLoadPromise = Promise.resolve(font);
}

// ── SVG Font Parser ──────────────────────────────────────────

/**
 * Parse an SVG font XML string into a usable font object.
 *
 * SVG fonts define glyphs as SVG path data strings in <glyph> elements.
 * This parser extracts:
 *   - Font metrics (units-per-em, ascent, descent)
 *   - Glyph path data keyed by unicode character
 *   - Horizontal advance widths per glyph
 *
 * @param {string} svgText — the raw SVG XML text
 * @returns {object} — { type: 'svg', unitsPerEm, ascent, descent, glyphs: Map }
 */
function parseSvgFont(svgText) {
  // Extract font-face metrics
  const fontFaceMatch = svgText.match(/<font-face[^>]*\/?>/i);
  let unitsPerEm = 1000;
  let ascent = 800;
  let descent = -200;

  if (fontFaceMatch) {
    const upe = fontFaceMatch[0].match(/units-per-em="?(\d+)"?/i);
    if (upe) unitsPerEm = parseInt(upe[1], 10);
    const asc = fontFaceMatch[0].match(/ascent="?(\d+)"?/i);
    if (asc) ascent = parseInt(asc[1], 10);
    const desc = fontFaceMatch[0].match(/descent="?(-?\d+)"?/i);
    if (desc) descent = parseInt(desc[1], 10);
  }

  // Extract all <glyph> elements
  const glyphMap = new Map();
  const glyphRegex = /<glyph\s[^>]*\/?>/gi;
  let match;

  while ((match = glyphRegex.exec(svgText)) !== null) {
    const glyphTag = match[0];

    // Extract unicode character
    const unicodeMatch = glyphTag.match(/unicode="([^"]*)"/i);
    if (!unicodeMatch) continue;
    const unicode = unicodeMatch[1];
    if (!unicode || unicode === ' ') continue;

    // Extract path data
    const dMatch = glyphTag.match(/d="([^"]*)"/i);
    if (!dMatch) continue;
    const d = dMatch[1].trim();
    if (!d) continue;

    // Extract horizontal advance (optional, falls back to font default)
    const advMatch = glyphTag.match(/horiz-adv-x="?(\d+)"?/i);
    const advance = advMatch ? parseInt(advMatch[1], 10) : null;

    glyphMap.set(unicode, { d, advance });
  }

  // Also extract the space glyph's advance width
  const spaceMatch = svgText.match(/<glyph\s[^>]*unicode="\s"[^>]*horiz-adv-x="?(\d+)"?/i);
  const spaceAdvance = spaceMatch ? parseInt(spaceMatch[1], 10) : unitsPerEm * 0.5;

  return {
    type: 'svg',
    unitsPerEm,
    ascent,
    descent,
    glyphs: glyphMap,
    spaceAdvance,
    getPath(text, x, y, fontSize) {
      return svgFontGetPath(this, text, x, y, fontSize);
    },
  };
}

/**
 * Generate an array of { commands, advance } for each character in the text.
 * This mirrors opentype.js's font.getPath() interface.
 *
 * @param {object} svgFont — the parsed SVG font object
 * @param {string} text — text to render
 * @param {number} x — starting X position
 * @param {number} y — starting Y position (baseline)
 * @param {number} fontSize — font size in points
 * @returns {Array<{commands: Array, advance: number}>}
 */
function svgFontGetPath(svgFont, text, x, y, fontSize) {
  const scale = fontSize / svgFont.unitsPerEm;
  const paths = [];

  let cursorX = x;

  for (const char of text) {
    if (char === ' ') {
      cursorX += svgFont.spaceAdvance * scale;
      continue;
    }

    const glyph = svgFont.glyphs.get(char);
    if (!glyph) continue;

    // Parse the SVG path d attribute into commands
    const commands = parseSvgPathData(glyph.d, cursorX, y, scale);
    paths.push({ commands, advance: (glyph.advance || svgFont.unitsPerEm) * scale });

    cursorX += (glyph.advance || svgFont.unitsPerEm) * scale;
  }

  return paths;
}

/**
 * Parse an SVG path `d` attribute string into an array of command objects.
 *
 * SVG path commands: M (moveTo), L (lineTo), C (cubicCurveTo),
 * Q (quadraticCurveTo), Z (closePath).
 *
 * Each command is transformed by the given offset and scale.
 *
 * @param {string} d — SVG path data string
 * @param {number} offsetX — X offset to apply
 * @param {number} offsetY — Y offset to apply
 * @param {number} scale — scale factor to apply
 * @returns {Array<{type: string, args: object}>}
 */
function parseSvgPathData(d, offsetX, offsetY, scale) {
  const commands = [];

  // Tokenize: split on commands (M, L, C, Q, Z, etc.) and their arguments
  // SVG path data format: command letter followed by coordinate pairs
  const tokens = d.match(/[MLCQZmlcqz]\s*[-\d.,\s]*/g);
  if (!tokens) return commands;

  for (const token of tokens) {
    const type = token[0].toUpperCase();
    // Extract all numeric values from the token
    const nums = token.slice(1).trim().match(/-?\d+\.?\d*/g);
    if (!nums) {
      if (type === 'Z') {
        commands.push({ type: 'Z', args: {} });
      }
      continue;
    }

    const values = nums.map(Number);

    switch (type) {
      case 'M': {
        // M x y
        if (values.length >= 2) {
          commands.push({
            type: 'M',
            args: {
              x: values[0] * scale + offsetX,
              y: -values[1] * scale + offsetY, // Flip Y: SVG y-down → paper y-up
            },
          });
        }
        break;
      }
      case 'L': {
        // L x y (or multiple pairs)
        for (let i = 0; i + 1 < values.length; i += 2) {
          commands.push({
            type: 'L',
            args: {
              x: values[i] * scale + offsetX,
              y: -values[i + 1] * scale + offsetY,
            },
          });
        }
        break;
      }
      case 'C': {
        // C x1 y1 x2 y2 x y
        for (let i = 0; i + 5 < values.length; i += 6) {
          commands.push({
            type: 'C',
            args: {
              x1: values[i] * scale + offsetX,
              y1: -values[i + 1] * scale + offsetY,
              x2: values[i + 2] * scale + offsetX,
              y2: -values[i + 3] * scale + offsetY,
              x: values[i + 4] * scale + offsetX,
              y: -values[i + 5] * scale + offsetY,
            },
          });
        }
        break;
      }
      case 'Q': {
        // Q x1 y1 x y
        for (let i = 0; i + 3 < values.length; i += 4) {
          commands.push({
            type: 'Q',
            args: {
              x1: values[i] * scale + offsetX,
              y1: -values[i + 1] * scale + offsetY,
              x: values[i + 2] * scale + offsetX,
              y: -values[i + 3] * scale + offsetY,
            },
          });
        }
        break;
      }
      case 'Z': {
        commands.push({ type: 'Z', args: {} });
        break;
      }
    }
  }

  return commands;
}

/**
 * Convert an array of SVG path commands into a paper.Path.
 *
 * @param {Array<{type: string, args: object}>} commands
 * @param {paper.Project} project
 * @returns {paper.Path}
 */
function svgCommandsToPaperPath(commands, project) {
  const paperPath = new paper.Path();
  paperPath.strokeColor = new paper.Color('cyan');
  paperPath.strokeWidth = 1;
  paperPath.fillColor = null;

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        paperPath.moveTo(new paper.Point(cmd.args.x, cmd.args.y));
        break;
      case 'L':
        paperPath.lineTo(new paper.Point(cmd.args.x, cmd.args.y));
        break;
      case 'C':
        paperPath.cubicCurveTo(
          new paper.Point(cmd.args.x1, cmd.args.y1),
          new paper.Point(cmd.args.x2, cmd.args.y2),
          new paper.Point(cmd.args.x, cmd.args.y)
        );
        break;
      case 'Q':
        paperPath.quadraticCurveTo(
          new paper.Point(cmd.args.x1, cmd.args.y1),
          new paper.Point(cmd.args.x, cmd.args.y)
        );
        break;
      case 'Z':
        paperPath.closePath();
        break;
    }
  }

  return paperPath;
}

// ── Font Loading ─────────────────────────────────────────────

/**
 * Load the default font, with caching.
 * Supports both SVG fonts (.svg) and TrueType/OpenType (.ttf/.otf).
 *
 * @returns {Promise<object>}
 */
export async function loadDefaultFont() {
  if (_cachedFont) return _cachedFont;
  if (_fontLoadPromise) return _fontLoadPromise;

  _fontLoadPromise = (async () => {
    try {
      const response = await fetch(DEFAULT_FONT_URL);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Detect font type by URL extension
      const isSvg = DEFAULT_FONT_URL.toLowerCase().endsWith('.svg');

      if (isSvg) {
        // Parse as SVG font
        const svgText = await response.text();
        const font = parseSvgFont(svgText);
        _cachedFont = font;
        return font;
      } else {
        // Parse as TrueType/OpenType binary via opentype.js
        const buffer = await response.arrayBuffer();
        const font = opentype.parse(buffer);
        _cachedFont = font;
        return font;
      }
    } catch (err) {
      _fontLoadPromise = null;
      throw new Error(`Failed to load font: ${err.message}`);
    }
  })();

  return _fontLoadPromise;
}

// ── Path Conversion ──────────────────────────────────────────

/**
 * Convert an opentype.js Path object into a paper.Path.
 *
 * @param {opentype.Path} opentypePath — the path from font.getPath()
 * @param {paper.Project} project — optional project to create the path in
 * @returns {paper.Path}
 */
export function opentypePathToPaperPath(opentypePath, project) {
  const paperPath = new paper.Path();
  paperPath.strokeColor = new paper.Color('cyan');
  paperPath.strokeWidth = 1;
  paperPath.fillColor = null;

  for (const cmd of opentypePath.commands) {
    switch (cmd.type) {
      case 'M':
        paperPath.moveTo(new paper.Point(cmd.x, cmd.y));
        break;
      case 'L':
        paperPath.lineTo(new paper.Point(cmd.x, cmd.y));
        break;
      case 'C':
        paperPath.cubicCurveTo(
          new paper.Point(cmd.x1, cmd.y1),
          new paper.Point(cmd.x2, cmd.y2),
          new paper.Point(cmd.x, cmd.y)
        );
        break;
      case 'Q':
        paperPath.quadraticCurveTo(
          new paper.Point(cmd.x1, cmd.y1),
          new paper.Point(cmd.x, cmd.y)
        );
        break;
      case 'Z':
        paperPath.closePath();
        break;
      default:
        console.warn(`Unknown opentype command: ${cmd.type}`);
    }
  }

  return paperPath;
}

// ── Text Generation ──────────────────────────────────────────

/**
 * Generate paper.Path objects for title and subtitle text.
 *
 * Works with both SVG fonts (single-stroke, ideal for plotters)
 * and TrueType/OpenType fonts (outline-based, via opentype.js).
 *
 * @param {object} options
 * @param {paper.Project} options.project — the Paper.js project
 * @param {string} options.titleText — title string (empty = skip)
 * @param {string} options.subtitleText — subtitle string (empty = skip)
 * @param {number} options.scale — text scale multiplier (0.5–5.0, default 1.0)
 * @param {object} [options.font] — optional pre-loaded font; uses default if omitted
 * @param {number} [options.titleSize=48] — base font size for title in points
 * @param {number} [options.subtitleSize=28] — base font size for subtitle in points
 * @returns {paper.Group|null} — a group containing the text paths, or null if no text
 */
export function generateTextPaths({
  project,
  titleText,
  subtitleText,
  scale = 1.0,
  font,
  titleSize = 48,
  subtitleSize = 28,
} = {}) {
  if (!project) {
    console.warn('TextToPath: No project provided');
    return null;
  }

  const resolvedFont = font || _cachedFont;
  if (!resolvedFont) {
    console.warn('TextToPath: No font loaded. Call loadDefaultFont() first.');
    return null;
  }

  const hasTitle = titleText && titleText.trim().length > 0;
  const hasSubtitle = subtitleText && subtitleText.trim().length > 0;

  if (!hasTitle && !hasSubtitle) return null;

  const textGroup = new paper.Group();
  textGroup.name = 'artworkLabels';

  // ── Generate Title Paths ──────────────────────────────────
  if (hasTitle) {
    const scaledTitleSize = titleSize * scale;
    const titlePaperPath = generateSingleTextPath(
      resolvedFont, titleText.trim(), scaledTitleSize
    );
    if (titlePaperPath) {
      titlePaperPath.name = 'title';
      textGroup.addChild(titlePaperPath);
    }
  }

  // ── Generate Subtitle Paths ───────────────────────────────
  if (hasSubtitle) {
    const scaledSubtitleSize = subtitleSize * scale;
    const subtitlePaperPath = generateSingleTextPath(
      resolvedFont, subtitleText.trim(), scaledSubtitleSize
    );
    if (subtitlePaperPath) {
      subtitlePaperPath.name = 'subtitle';
      textGroup.addChild(subtitlePaperPath);
    }
  }

  return textGroup;
}

/**
 * Generate a paper item (Path or Group) for a text string using the given font.
 *
 * For SVG fonts (single-stroke): returns a paper.Group containing one paper.Path
 * per character. Each character is a separate path so the plotter can lift the
 * pen between glyphs.
 *
 * For opentype.js fonts (outline): returns a single paper.Path with all contours.
 *
 * @param {object} font — resolved font object (svg or opentype)
 * @param {string} text — text to render
 * @param {number} fontSize — font size in points
 * @returns {paper.Path|paper.Group|null}
 */
function generateSingleTextPath(font, text, fontSize) {
  try {
    if (font.type === 'svg') {
      // SVG font: get path commands per character
      const charPaths = font.getPath(text, 0, 0, fontSize);
      if (!charPaths || charPaths.length === 0) return null;

      // Create one paper.Path per character (each glyph is a single stroke)
      const charPaperPaths = [];
      for (const charResult of charPaths) {
        if (!charResult.commands || charResult.commands.length === 0) continue;
        const pp = svgCommandsToPaperPath(charResult.commands);
        charPaperPaths.push(pp);
      }

      if (charPaperPaths.length === 0) return null;

      // If only one character, return it directly
      if (charPaperPaths.length === 1) return charPaperPaths[0];

      // Multiple characters: group them so each remains a separate path
      // (plotter lifts pen between characters)
      const group = new paper.Group(charPaperPaths);
      return group;
    } else {
      // opentype.js font
      const opentypePath = font.getPath(text, 0, 0, fontSize);
      return opentypePathToPaperPath(opentypePath);
    }
  } catch (err) {
    console.warn('TextToPath: Failed to generate text path:', err);
    return null;
  }
}

/**
 * Position the text group in the top margin, centered horizontally above the artwork.
 *
 * The text sits in the margin area between the top of the paper and the top of the
 * artwork bounds. If there isn't enough room in the margin, it places the text
 * just above the artwork with the specified gap.
 *
 * @param {paper.Group} textGroup — the group returned by generateTextPaths()
 * @param {paper.Rectangle} artworkBounds — bounds of the main artwork layer
 * @param {number} [gap=5] — gap between top of artwork and bottom of text
 * @param {number} [paperWidth] — paper width for centering (uses artwork center if omitted)
 * @param {number} [paperHeight] — paper height (used to constrain within top margin)
 */
export function positionTextGroup(textGroup, artworkBounds, gap = 5, paperWidth, paperHeight) {
  if (!textGroup || textGroup.children.length === 0) return;

  // Reset group position so we can measure natural bounds of children
  textGroup.position = new paper.Point(0, 0);

  // Center X: use paper center if provided, otherwise artwork center
  const centerX = paperWidth
    ? paperWidth / 2
    : artworkBounds.center.x;

  // Calculate the Y position where the bottom of the text should sit
  // This is artworkBounds.top - gap (above the artwork)
  const textBottomY = artworkBounds.top - gap;

  // If we have both title and subtitle, stack them vertically
  if (textGroup.children.length >= 2) {
    const titlePath = textGroup.children[0];
    const subtitlePath = textGroup.children[1];

    // Reset individual positions to measure natural bounds
    titlePath.position = new paper.Point(0, 0);
    subtitlePath.position = new paper.Point(0, 0);

    const titleBounds = titlePath.bounds;
    const subtitleBounds = subtitlePath.bounds;

    // Stack: subtitle on bottom, title above it
    // Bottom of subtitle sits at textBottomY
    const subtitleCenterY = textBottomY - subtitleBounds.height / 2;

    // Interline gap proportional to title height
    const interlineGap = Math.max(2, titleBounds.height * 0.3);
    const titleCenterY = textBottomY - subtitleBounds.height - interlineGap - titleBounds.height / 2;

    titlePath.position = new paper.Point(centerX, titleCenterY);
    subtitlePath.position = new paper.Point(centerX, subtitleCenterY);
  } else if (textGroup.children.length === 1) {
    // Single text item: bottom of text sits at textBottomY
    const singlePath = textGroup.children[0];
    singlePath.position = new paper.Point(0, 0);
    const singleBounds = singlePath.bounds;
    const centerY = textBottomY - singleBounds.height / 2;
    singlePath.position = new paper.Point(centerX, centerY);
  }
}
