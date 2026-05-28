import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import paper from 'paper';
import { VitroEngine } from './engine/VitroEngine.js';
import { ImageUtils } from './utils/ImageUtils.js';
import { runAlgorithm } from './algorithms/index.js';
import { ExportEngine } from './export/ExportEngine.js';
import { loadDefaultFont, generateTextPaths, positionTextGroup } from './engine/TextToPath.js';
import SettingsPanel from './components/SettingsPanel.jsx';

const PAPER_PRESETS = {
  bambu256: { w: 256, h: 256 },
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
  letter: { w: 215.9, h: 279.4 },
  custom: { w: 256, h: 256 },
};

const MARKER_COLORS = [
  { id: 'black',       label: 'Black',       hex: '#1a1a1a', r: 26,  g: 26,  b: 26  },
  { id: 'yellow',      label: 'Yellow',      hex: '#FFE600', r: 255, g: 230, b: 0   },
  { id: 'cyan',        label: 'Cyan',        hex: '#00AEEF', r: 0,   g: 174, b: 239 },
  { id: 'magenta',     label: 'Magenta',     hex: '#E8157A', r: 232, g: 21,  b: 122 },
  { id: 'purple',      label: 'Purple',      hex: '#8B2FC9', r: 139, g: 47,  b: 201 },
  { id: 'green',       label: 'Green',       hex: '#00A550', r: 0,   g: 165, b: 80  },
  { id: 'orange',      label: 'Orange',      hex: '#FF6B00', r: 255, g: 107, b: 0   },
  { id: 'red',         label: 'Red',         hex: '#E82020', r: 232, g: 32,  b: 32  },
  { id: 'light-green', label: 'Light Green', hex: '#7DC142', r: 125, g: 193, b: 66  },
  { id: 'blue',        label: 'Blue',        hex: '#0055B3', r: 0,   g: 85,  b: 179 },
];

const DEFAULT_ACTIVE_MARKER_IDS = ['cyan', 'magenta', 'yellow', 'black'];


function fmt(n) { return Number(n).toLocaleString(); }

export default function App() {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const sourcePreviewRef = useRef(null);

  // ── Core State ────────────────────────────────────────────
  const [algo, setAlgo] = useState('squiggle');
  const [isProcessing, setIsProcessing] = useState(false);
  const [canvasWarning, setCanvasWarning] = useState(null);
  const [engineStats, setEngineStats] = useState(null);
  const [paperLabel, setPaperLabel] = useState('256×256 mm');

  // Mutable refs for non-React state (avoids re-render loops)
  const stateRef = useRef({
    sourceImage: null,
    sourceSvgText: null,
    isSvg: false,
    activeMarkers: MARKER_COLORS.filter(m => DEFAULT_ACTIVE_MARKER_IDS.includes(m.id)),
    spotAllPaths: null,
    paperWidth: 256,
    paperHeight: 256,
    cachedImageData: null,
    cachedWidth: 0,
    cachedHeight: 0,
    algoWorkerSettings: {},
    preWorkerSettings: {},
    postWorkerSettings: {},
    labelsWorkerSettings: {},
    isProcessing: false,
    currentAlgo: 'squiggle',
    // Saved mm-space segment data for re-layout on resize.
    // Each entry: { item, segments: [{x, y, hiX, hiY, hoX, hoY}] }
    mmPathData: null,
  });

  // ── Engine Initialization ─────────────────────────────────
  useLayoutEffect(() => {
    if (!canvasRef.current) return;
    const engine = new VitroEngine(canvasRef.current);
    engine.activate();
    const s = stateRef.current;
    engine.resize(s.paperWidth, s.paperHeight);
    engineRef.current = engine;

    // Load the default font for text-to-path conversion
    loadDefaultFont().catch(err => {
      console.warn('TextToPath: Default font failed to load:', err);
    });

    // Use ResizeObserver for reliable canvas sizing.
    // After resizing, re-layout paths so the view matrix matches the
    // new canvas dimensions. Paper.js may reset the view matrix when
    // viewSize changes, so we must re-apply our custom transform.
    const observer = new ResizeObserver(() => {
      const eng = engineRef.current;
      if (!eng) return;
      const st = stateRef.current;
      eng.resize(st.paperWidth, st.paperHeight);
      // Re-layout paths so the view matrix is updated for the new size
      if (eng.getStats().pathCount > 0) {
        reLayoutPaths();
      }
    });
    observer.observe(canvasRef.current.parentElement);

    return () => {
      observer.disconnect();
      // Prevent stale engine ref from being used after unmount
      engineRef.current = null;
    };
  }, []);

  // ── Worker Settings Change Handlers ───────────────────────
  const handleWorkerSettingsChange = useCallback((settings) => {
    stateRef.current.algoWorkerSettings = settings;
    const s = stateRef.current;
    // For vector algorithms on SVG (calligraphy / vectorsvg), parameter changes
    // must reload the SVG and re-run the algorithm — the raster pipeline does not
    // apply because there is no ImageData source.
    if (s.isSvg && s.sourceSvgText && (s.currentAlgo === 'calligraphy' || s.currentAlgo === 'vectorsvg')) {
      processFile(new File([s.sourceSvgText], 'reload.svg', { type: 'image/svg+xml' }));
    } else {
      triggerReprocess();
    }
  }, []);

  const handlePreprocessChange = useCallback((settings) => {
    stateRef.current.preWorkerSettings = settings;
    // Pre-processing filters (brightness, contrast, blur, invert) are raster-only.
    // For SVG + vector algo, ignore filter changes (no raster pipeline).
    const s = stateRef.current;
    if (s.isSvg && (s.currentAlgo === 'calligraphy' || s.currentAlgo === 'vectorsvg')) {
      return;
    }
    triggerReprocessWithFilters();
  }, []);

  const handlePostprocessChange = useCallback((settings) => {
    stateRef.current.postWorkerSettings = settings;
    triggerPostProcess();
  }, []);

  const handleLabelsChange = useCallback((settings) => {
    stateRef.current.labelsWorkerSettings = settings;
    triggerPostProcess();
  }, []);

  const handleMarkerToggle = useCallback((markerId, checked) => {
    const s = stateRef.current;
    const marker = MARKER_COLORS.find(m => m.id === markerId);
    if (!marker) return;
    if (checked) {
      if (!s.activeMarkers.some(m => m.id === markerId)) {
        s.activeMarkers = [...s.activeMarkers, marker];
      }
    } else {
      const next = s.activeMarkers.filter(m => m.id !== markerId);
      if (next.length === 0) return;
      s.activeMarkers = next;
    }
    const modeEl = document.getElementById('colorMode');
    if (s.sourceImage && modeEl?.value === 'spot') triggerReprocess();
  }, []);

  // ── Algorithm Switch ──────────────────────────────────────
  const handleAlgoChange = useCallback((newAlgo) => {
    setAlgo(newAlgo);
    const s = stateRef.current;
    s.currentAlgo = newAlgo;

    if (s.sourceImage || s.sourceSvgText) {
      if (s.isSvg) {
        // For vector-based algorithms (vectorsvg, calligraphy), reload the SVG
        // so the raw vector paths are available for Z-modulation.
        // For raster algorithms, trigger a reprocess from the cached image.
        if (newAlgo === 'vectorsvg' || newAlgo === 'calligraphy') {
          processFile(new File([s.sourceSvgText], 'reload.svg', { type: 'image/svg+xml' }));
        } else {
          triggerReprocess();
        }
      } else {
        triggerReprocess();
      }
    }
  }, []);

  // ── File Upload ───────────────────────────────────────────
  const processFile = useCallback(async (file) => {
    if (stateRef.current.isProcessing) return;
    setIsProcessing(true);
    stateRef.current.isProcessing = true;

    try {
      const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
      const s = stateRef.current;

      if (isSvg) {
        const text = await file.text();
        s.isSvg = true;
        s.sourceSvgText = text;

        const engine = engineRef.current;
        if (!engine) return;
        // Activate the engine's PaperScope so that importSVG and any
        // direct Paper.js constructors (e.g. new paper.Point) operate
        // on the correct project.
        engine.activate();
        engine.clear();
        const svgItem = engine.project.importSVG(text, { expandShapes: true });

        if (!svgItem) throw new Error('No paths found in SVG');

        const bounds = svgItem.bounds;
        if (bounds) {
          const scaleX = s.paperWidth / bounds.width;
          const scaleY = s.paperHeight / bounds.height;
          const scale = Math.min(scaleX, scaleY);
          svgItem.scale(scale);
          svgItem.position = new paper.Point(s.paperWidth / 2, s.paperHeight / 2);
        }

        // ── Flatten SVG hierarchy: bake transforms into path coordinates ──
        // svgItem.scale() and svgItem.position set a matrix on the SVG item
        // (Group or CompoundPath). This matrix would NOT be reflected in the
        // raw segment coordinates read by _collectAllPaths() or getStats().
        // We need to "bake" the transform into each path's segments and then
        // remove the wrapper, so paths are in paper-mm coordinate space.
        const svgMatrix = svgItem.matrix.clone();
        const allDescendantPaths = [];
        function collectPaths(item) {
          if (item instanceof paper.Path) {
            allDescendantPaths.push(item);
          } else if (item.children) {
            for (const child of item.children) {
              collectPaths(child);
            }
          }
        }
        collectPaths(svgItem);

        // Transform each path's segments by the SVG item's matrix
        for (const path of allDescendantPaths) {
          path.transform(svgMatrix);
          // Clear any fill color from SVG — plotter paths are strokes only
          path.fillColor = null;
        }

        // Move all paths to the active layer (top-level), removing the SVG wrapper
        const layer = engine.project.activeLayer;
        for (const path of allDescendantPaths) {
          layer.addChild(path);
        }
        // Remove the now-empty SVG wrapper item
        if (svgItem !== layer && svgItem.parent) {
          svgItem.remove();
        }

        // ── Run Calligraphy Z-Modulation for SVG font paths ──
        // If the calligraphy algorithm is selected, apply Z-depth modulation
        // to the vector paths. This must happen BEFORE post-processing so
        // that smoothing and layout operate on the Z-annotated paths.
        if (s.currentAlgo === 'calligraphy') {
          engine.activate();
          await runAlgorithm('calligraphy', engine.project, null, getAlgoParams());
        }

        // SVG paths are already in paper-mm space (baked via path.transform above).
        // Calling convertPathsToMm with paper dimensions is an identity transform,
        // but it populates mmPathData so restoreMmCoords works correctly on export.
        convertPathsToMm(engine, s.paperWidth, s.paperHeight);

        await applyPostProcessing();

        // ── Cache rasterized SVG for raster algorithm switching ──
        // When the user switches from a vector algorithm (calligraphy / vectorsvg)
        // to a raster algorithm (squiggle, skeletonize, etc.), triggerReprocess
        // needs an HTMLImageElement (s.sourceImage) to feed into processRasterImage.
        // We create one from the original SVG text so the raster pipeline works.
        const svgBlob = new Blob([text], { type: 'image/svg+xml' });
        const svgFile = new File([svgBlob], 'source.svg', { type: 'image/svg+xml' });
        s.sourceImage = await ImageUtils.loadImage(svgFile);
      } else {
        s.isSvg = false;
        const img = await ImageUtils.loadImage(file);
        s.sourceImage = img;
        await processRasterImage(img);
      }
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
      stateRef.current.isProcessing = false;
    }
  }, []);

  // ── Raster Processing ─────────────────────────────────────
  const processRasterImage = useCallback(async (img) => {
    const s = stateRef.current;
    const engine = engineRef.current;
    if (!engine) return;

    // Activate the engine's PaperScope so that any direct `new paper.Path()`
    // calls in this function (e.g. CMYK "all" channel reconstruction) create
    // paths in the correct project. The runAlgorithm dispatcher also activates
    // the scope, but this covers the gap between algorithm runs.
    engine.activate();

    const engineResEl = document.getElementById('engineResolution');
    const engineRes = parseInt(engineResEl?.value || '1000');

    const { imageData, width, height } = ImageUtils.rasterize(img, engineRes);

    s.cachedImageData = new Uint8ClampedArray(imageData.data);
    s.cachedWidth = width;
    s.cachedHeight = height;

    // Apply pre-processing filters from debounced worker settings
    const pre = s.preWorkerSettings;
    const brightness = (pre.brightness ?? 100) / 100;
    const contrast = (pre.contrast ?? 100) / 100;
    const saturation = (pre.saturation ?? 100) / 100;
    const blur = pre.blur ?? 0;
    const invertEl = document.getElementById('invertPreprocessCheck');
    const invert = invertEl?.checked || false;
    ImageUtils.applyFilters(imageData, { brightness, contrast, saturation, blur, invert });

    renderSourcePreview(imageData);

    const colorModeEl = document.getElementById('colorMode');
    const mode = colorModeEl?.value || 'monochrome';
    const thresholdVal = s.algoWorkerSettings.threshold ?? 128;

    // ── Save pre-binarization grayscale data for algorithms
    // that need continuous tone information (e.g., Crosshatch
    // uses multiple brightness thresholds per direction).
    // We convert to grayscale FIRST, then save a copy, then
    // binarize the original for algorithms that need hard edges.
    // ─────────────────────────────────────────────────────────
    let grayscaleData = null;

    if (mode === 'spot') {
      const markers = s.activeMarkers;
      if (!markers || markers.length === 0) return;

      const currentAlgo = s.currentAlgo || algo;

      // ── Dual-layer moiré algorithms: run ONCE, split by moire_layer tag ──
      // These algorithms encode two independent layers (cyan + magenta) that
      // must be generated from the full grayscale image — not from per-marker
      // color separations. Running them once avoids N×the cost and preserves
      // the correct image encoding in each layer.
      const DUAL_LAYER_MOIRE = new Set(['staticmoire', 'curvilinearnoise', 'warpedgrid', 'freqmod']);
      if (DUAL_LAYER_MOIRE.has(currentAlgo)) {
        engine.clear();
        const grayFull = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
        ImageUtils.toGrayscale(grayFull);
        const grayGray = new ImageData(new Uint8ClampedArray(grayFull.data), width, height);
        const baseParams = getAlgoParams();
        await runAlgorithm(currentAlgo, engine.project, grayFull, baseParams, null, grayGray);

        // Snapshot items by moire_layer BEFORE convertPathsToMm modifies coords.
        // convertPathsToMm updates segment coordinates in-place, so these refs
        // will hold mm-space coords after the call.
        const itemsByLayer = { 1: [], 2: [] };
        for (const item of engine.project.activeLayer.children) {
          if (item instanceof paper.Path) {
            const lyr = item.data?.moire_layer ?? 1;
            (itemsByLayer[lyr] || itemsByLayer[1]).push(item);
          }
        }

        convertPathsToMm(engine, width, height);

        const collectItems = (items) =>
          items.filter(it => it.segments && it.segments.length > 1)
               .map(it => it.segments.map(seg => ({ x: seg.point.x, y: seg.point.y })));

        // Map Layer 1 → first active marker, Layer 2 → second active marker.
        // This lets the user switch pen colors via the normal marker UI.
        const markerL1 = markers[0];
        const markerL2 = markers[1] ?? markers[0];
        const sameMarker = markerL1.id === markerL2.id;

        const allPaths = {};
        if (sameMarker) {
          allPaths[markerL1.id] = [
            ...collectItems(itemsByLayer[1]),
            ...collectItems(itemsByLayer[2]),
          ];
        } else {
          allPaths[markerL1.id] = collectItems(itemsByLayer[1]);
          allPaths[markerL2.id] = collectItems(itemsByLayer[2]);
        }
        s.spotAllPaths = allPaths;

        engine.clear();
        const renderMarkers = sameMarker ? [markerL1] : [markerL1, markerL2];
        for (const marker of renderMarkers) {
          for (const pts of allPaths[marker.id] ?? []) {
            const p = new paper.Path();
            p.strokeColor = new paper.Color(marker.hex);
            p.strokeWidth = 1;
            for (const pt of pts) p.add(new paper.Point(pt.x, pt.y));
            engine.project.activeLayer.addChild(p);
          }
        }
        // Paths are already in mm-space; passing paperW×paperH as the image
        // dimensions makes convertPathsToMm a no-op transform, but it updates
        // mmPathData to reference the new path objects so restoreMmCoords works.
        convertPathsToMm(engine, s.paperWidth, s.paperHeight);

        await applyPostProcessing();
        return;
      }

      // separateSpotColors expects a color (non-grayscale) source; pass a copy
      // so the dithering pass doesn't mutate imageData (used by source preview).
      const colorCopy = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
      const separated = ImageUtils.separateSpotColors(colorCopy, markers);

      const isOutlineAlgo    = currentAlgo === 'subjectoutline'    || currentAlgo === 'outlinecrosshatch';

      // For outline algorithms, build a full-image grayscale before the channel
      // loop so XDoG sees the complete subject, not a single separated channel.
      const fullGrayscaleData = isOutlineAlgo
        ? (() => {
            const d = new ImageData(new Uint8ClampedArray(imageData.data), width, height);
            ImageUtils.toGrayscale(d);
            return d;
          })()
        : null;

      const baseParams = getAlgoParams();

      const allPaths = {};
      for (const marker of markers) {
        engine.clear();
        const channelImageData = separated[marker.id];
        // Blur the binary dithered mask back into a smooth density image so that
        // algorithms like Crosshatch (which sample per-pixel brightness against
        // multiple thresholds) see continuous tonal regions rather than an
        // alternating 0/255 halftone pattern that shatters every hatch line.
        const chGrayscaleData = new ImageData(new Uint8ClampedArray(channelImageData.data), width, height);
        ImageUtils.applyFilters(chGrayscaleData, { blur: 3 });
        ImageUtils.applyHardThreshold(channelImageData, thresholdVal);
        const runParams = {
          ...baseParams,
          ...(isOutlineAlgo ? { skipOutline: true } : {}),
        };
        await runAlgorithm(currentAlgo, engine.project, channelImageData, runParams, null, chGrayscaleData);
        convertPathsToMm(engine, width, height);
        allPaths[marker.id] = engine.collectPaths();
      }

      // Draw the monochrome XDoG outline once, using the full-image grayscale,
      // and append it to the black layer so it sits cleanly on top of all hatch.
      if (isOutlineAlgo && fullGrayscaleData) {
        const blackMarker = markers.find(m => m.id === 'black');
        if (blackMarker) {
          engine.clear();
          await runAlgorithm(currentAlgo, engine.project, fullGrayscaleData, { ...baseParams, outlineOnly: true }, null, fullGrayscaleData);
          convertPathsToMm(engine, width, height);
          allPaths[blackMarker.id] = [...(allPaths[blackMarker.id] || []), ...engine.collectPaths()];
        }
      }

      s.spotAllPaths = allPaths;

      engine.clear();
      for (const marker of markers) {
        for (const pts of allPaths[marker.id]) {
          const p = new paper.Path();
          p.strokeColor = new paper.Color(marker.hex);
          p.strokeWidth = 1;
          for (const pt of pts) p.add(new paper.Point(pt.x, pt.y));
          engine.project.activeLayer.addChild(p);
        }
      }
      // Paths are already in mm-space; passing paperW×paperH as the image
      // dimensions makes convertPathsToMm a no-op transform, but it updates
      // mmPathData to reference the new path objects so restoreMmCoords works.
      convertPathsToMm(engine, s.paperWidth, s.paperHeight);
    } else {
      engine.clear();
      ImageUtils.toGrayscale(imageData);
      // ── Save pre-binarization grayscale for algorithms that
      // need continuous tone (e.g., Crosshatch) ──────────────
      grayscaleData = new ImageData(
        new Uint8ClampedArray(imageData.data),
        width,
        height
      );
      // ──────────────────────────────────────────────────────
      // ── Binarization Pre-Processor ("Kill the Grays") ────────
      ImageUtils.applyHardThreshold(imageData, thresholdVal);
      // ─────────────────────────────────────────────────────────
      await runAlgorithm(s.currentAlgo || algo, engine.project, imageData, getAlgoParams(), null, grayscaleData);
      convertPathsToMm(engine, width, height);
    }

    await applyPostProcessing();
  }, [algo]);

  function getAlgoParams() {
    const s = stateRef.current;
    const aw = s.algoWorkerSettings;
    // Compute pixelsPerMm from the cached image dimensions and paper size.
    // This ensures the physical pen constraint is correctly scaled to
    // the actual drawing resolution.
    const imgW = s.cachedWidth || 1000;
    const paperW = s.paperWidth || 256;
    const pixelsPerMm = imgW / paperW;
    return {
      density: aw.density ?? 80,
      spiralTurns: aw.spiralTurns ?? 100,
      wiggleAmplitude: aw.wiggleAmplitude ?? 4,
      wiggleFrequency: aw.wiggleFrequency ?? 40,
      minSpacing: aw.minSpacing ?? 2,
      maxSpacing: aw.maxSpacing ?? 15,
      stepSize: aw.stepSize ?? 2,
      resolution: aw.resolution ?? 2,
      threshold: aw.threshold ?? 128,
      tolerance: aw.tolerance ?? 1,
      blurRadius: aw.blurRadius ?? 0,
      // ── Static Moiré Fringe parameters ──────────────────────
      pitch:         aw.pitch         ?? 12,
      fringeDensity: aw.fringeDensity ?? 0.8,
      carrierType:       aw.carrierType       ?? 'circles',
      carrierAngle:      aw.carrierAngle      ?? '0',
      lineDensity:   aw.lineDensity   ?? 60,
      contourHeight: aw.contourHeight ?? 5,
      topoAngle:     aw.topoAngle     ?? '45',
      // ── Curvilinear Noise Moiré parameters ───────────────────
      noiseGridAngle1: aw.noiseGridAngle1 ?? 30,
      noiseGridAngle2: aw.noiseGridAngle2 ?? 60,
      noiseScale:      aw.noiseScale      ?? 300,
      noiseAmplitude:  aw.noiseAmplitude  ?? 3,
      fringeIntensity: aw.fringeIntensity ?? 0.8,
      moireLayerView:  aw.moireLayerView  ?? 'both',
      // ── Phase-Key / Freq-Mod Moiré parameters ────────────────
      warpAngle1:    aw.warpAngle1    ?? 45,
      warpAngle2:    aw.warpAngle2    ?? 135,
      keyGeometry:   aw.keyGeometry   ?? 'lines',
      keyType:       aw.keyType       ?? 'noise',
      warpIntensity: aw.warpIntensity ?? 50,
      dispBlur:      aw.dispBlur      ?? 15,
      pathomit: aw.pathomit ?? 8,
      minPathLength: aw.minPathLength ?? 10,
      // ── Calligraphy Parameters (Voronoi medial axis) ──────────
      sampleSpacing: aw.sampleSpacing ?? 3,
      minThickness: aw.minThickness ?? 1.5,
      minChainLen: aw.minChainLen ?? 8,
      simplifyDist: aw.simplifyDist ?? 3,
      smoothingWindow: aw.smoothingWindow ?? 5,
      chainStitchDist: aw.chainStitchDist ?? 20,
      // ── Calibration & Z-Step (shared with skeletonize) ────────
      calibrationProfile: aw.calibrationProfile ?? 'sharpieFinePoint',
      maxZStep: aw.maxZStep ?? 0.3,
      // ── Physical Pen Constraint ──────────────────────────────
      // The engine mathematically refuses to plot two lines closer together
      // than the physical width of the fineliner tip (default 0.4 mm).
      penConstraints: {
        physicalPenWidth: 0.4,          // mm — typical 0.4 mm fineliner
        pixelsPerMm,                     // px/mm — derived from image/paper ratio
      },
      // ── Hatch direction toggles (Crosshatch / Outline+Hatch) ─
      hatchH:  aw.hatchH  ?? true,
      hatchV:  aw.hatchV  ?? true,
      hatchD1: aw.hatchD1 ?? true,
      hatchD2: aw.hatchD2 ?? true,
      // ── XDoG outline parameters (SubjectOutline / Outline+Hatch) ─
      xdogSigma1:  aw.xdogSigma1  ?? 0.8,
      xdogSigma2:  aw.xdogSigma2  ?? 1.6,
      xdogTau:     aw.xdogTau     ?? 0.98,
      xdogEpsilon: aw.xdogEpsilon ?? 0.0,
      // ─────────────────────────────────────────────────────────
    };
  }

  function convertPathsToMm(engine, imgW, imgH) {
    const s = stateRef.current;
    const paperW = s.paperWidth;
    const paperH = s.paperHeight;
    const imgAspect = imgW / imgH;
    const paperAspect = paperW / paperH;
    let drawW, drawH, offsetX, offsetY;
    if (imgAspect > paperAspect) {
      drawW = paperW;
      drawH = paperW / imgAspect;
      offsetX = 0;
      offsetY = (paperH - drawH) / 2;
    } else {
      drawH = paperH;
      drawW = paperH * imgAspect;
      offsetX = (paperW - drawW) / 2;
      offsetY = 0;
    }

    const mmData = [];

    function convertItem(item) {
      if (item instanceof paper.Path && item.segments.length > 1) {
        const segData = [];
        for (const seg of item.segments) {
          const px = seg.point.x;
          const py = seg.point.y;
          seg.point.x = (px / imgW) * drawW + offsetX;
          seg.point.y = (py / imgH) * drawH + offsetY;
          // Transform Bézier handles proportionally (defensive — smoothing
          // hasn't been applied yet at this point, but handles may exist
          // from algorithms that use path.simplify())
          if (seg.handleIn) {
            seg.handleIn.x = (seg.handleIn.x / imgW) * drawW;
            seg.handleIn.y = (seg.handleIn.y / imgH) * drawH;
          }
          if (seg.handleOut) {
            seg.handleOut.x = (seg.handleOut.x / imgW) * drawW;
            seg.handleOut.y = (seg.handleOut.y / imgH) * drawH;
          }
          // Save mm-space coordinates for re-layout on resize
          segData.push({
            x: seg.point.x,
            y: seg.point.y,
            hiX: seg.handleIn ? seg.handleIn.x : 0,
            hiY: seg.handleIn ? seg.handleIn.y : 0,
            hoX: seg.handleOut ? seg.handleOut.x : 0,
            hoY: seg.handleOut ? seg.handleOut.y : 0,
          });
        }
        mmData.push({ item, segments: segData });
      } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
        for (const child of item.children) {
          convertItem(child);
        }
      }
    }
    for (const item of engine.project.activeLayer.children) {
      convertItem(item);
    }

    // Save mm-space data for re-layout on resize
    s.mmPathData = mmData;
  }

  /**
   * Restore segment coordinates from saved mm-space data.
   * Called before layoutPaths() to ensure a clean mm-space baseline.
   */
  function restoreMmCoords(engine) {
    const s = stateRef.current;
    if (!s.mmPathData) return;
    for (const entry of s.mmPathData) {
      const item = entry.item;
      if (item.segments && item.segments.length === entry.segments.length) {
        for (let i = 0; i < item.segments.length; i++) {
          const seg = item.segments[i];
          const data = entry.segments[i];
          seg.point.x = data.x;
          seg.point.y = data.y;
          if (seg.handleIn) {
            seg.handleIn.x = data.hiX;
            seg.handleIn.y = data.hiY;
          }
          if (seg.handleOut) {
            seg.handleOut.x = data.hoX;
            seg.handleOut.y = data.hoY;
          }
        }
      }
    }
  }

  /**
   * Apply the canvas-pixel transform to paths by baking it directly into
   * segment coordinates using path.transform(). Reset view and layer
   * matrices to identity so Paper.js renders paths at exact pixel positions.
   *
   * If mmPathData is available, segments are first restored to mm-space
   * before applying the transform. This ensures the transform is always
   * applied from a clean mm-space state, even after previous transforms
   * (e.g., on resize).
   */
  function layoutPaths(engine, paperW, paperH, margin, smoothIter = 0) {
    // Guard against null view — can happen if ResizeObserver fires before
    // Paper.js has fully initialised the view, or after unmount.
    if (!engine.scope.view) return;
    const viewSize = engine.scope.view.viewSize;
    const canvasW = viewSize.width;
    const canvasH = viewSize.height;

    // Restore mm-space coordinates before computing the transform.
    // Smoothing must happen AFTER this restore so it operates on the clean
    // mm-space baseline rather than on already-transformed pixel coordinates.
    restoreMmCoords(engine);

    // Apply curve smoothing in mm-space, before the pixel transform.
    // Doing it here (not before layoutPaths) ensures restoreMmCoords cannot
    // overwrite the smoothed segments, which was the original bug.
    if (smoothIter > 0) {
      for (let i = 0; i < smoothIter; i++) {
        engine.smoothAll('catmull-rom');
      }
    }

    // The paths are in mm coordinates spanning [0, paperW] × [0, paperH].
    // We want them to fit within a margin inset from the paper edges.
    //
    // Transform pipeline:
    //   1. Uniformly scale content so it fits within the margin inset on the
    //      TIGHTER axis while preserving aspect ratio (contentScale = min(...)).
    //   2. Center the uniformly-scaled content within the paper. Since the
    //      contentScale is determined by the tighter axis, the looser axis
    //      will have extra space — centering accounts for this.
    //   3. Uniformly scale mm → canvas pixels (preserving aspect ratio).
    //   4. Center the paper on the canvas.
    //
    // Using a UNIFORM content scale (not separate X/Y) prevents distortion
    // when the paper is non-square (e.g., A4 portrait 210×297mm).

    // Uniform content scale: shrink so content fits within margin on both axes.
    // The min() ensures the tighter axis determines the scale.
    const contentScale = Math.min(
      (paperW - 2 * margin) / paperW,
      (paperH - 2 * margin) / paperH
    );

    // Uniform canvas scale: fit paper within canvas while preserving aspect ratio
    const canvasScale = Math.min(canvasW / paperW, canvasH / paperH);

    // Combined scale: contentScale (mm-space margin inset) × canvasScale (mm→px)
    const totalScale = contentScale * canvasScale;

    // ── Centering derivation ──────────────────────────────────────────
    // After contentScale, the content spans [0, paperW*contentScale] in mm.
    // We want this to be centered within the paper [0, paperW].
    // The centering offset in mm space is:
    //   mmOffset = (paperW - paperW * contentScale) / 2
    //            = paperW / 2 * (1 - contentScale)
    //
    // When contentScale is determined by the width (the tighter axis),
    //   paperW / 2 * (1 - contentScale) = margin   (by definition)
    // But when the height is the looser axis,
    //   paperH / 2 * (1 - contentScale) > margin
    //
    // Using margin * canvasScale for BOTH axes would under-shift the looser
    // axis, causing the content to appear shifted toward the origin (top-left).
    //
    // The correct offset centers the content within the paper AFTER the
    // uniform scale, then centers the paper on the canvas:
    const offsetX = (canvasW - paperW * canvasScale) / 2
                  + (paperW / 2) * (1 - contentScale) * canvasScale;
    const offsetY = (canvasH - paperH * canvasScale) / 2
                  + (paperH / 2) * (1 - contentScale) * canvasScale;

    // ── Bake transform into segment coordinates ──────────────
    // Instead of using the view matrix (which Paper.js may override during
    // its rendering cycle), we bake the full transform directly into segment
    // coordinates using path.transform(). This ensures pixel-perfect preview
    // positioning regardless of Paper.js internal matrix handling.
    //
    // path.transform() with _applyMatrix=true (default for Path items) calls
    // Path._transformContent() which bakes the matrix into segment coords
    // and resets the path's _matrix to identity.
    const transformMatrix = new paper.Matrix(
      totalScale, 0, 0, totalScale, offsetX, offsetY
    );
    function transformItem(item) {
      if (item instanceof paper.Path && item.segments.length > 1) {
        item.transform(transformMatrix);
      } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
        for (const child of item.children) {
          transformItem(child);
        }
      }
    }
    for (const child of engine.project.activeLayer.children) {
      transformItem(child);
    }

    // Reset view and layer matrices to identity so Paper.js renders paths
    // at their exact baked pixel coordinates with no additional transform.
    engine.scope.view.matrix = new paper.Matrix();
    engine.project.activeLayer.matrix = new paper.Matrix();
  }

  function renderSourcePreview(imageData) {
    const canvas = sourcePreviewRef.current;
    if (!canvas) return;
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = imageData.width;
    tempCanvas.height = imageData.height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.putImageData(imageData, 0, 0);
    ctx.clearRect(0, 0, 200, 200);
    ctx.drawImage(tempCanvas, 0, 0, 200, 200);
  }

  // ── Post-Processing ───────────────────────────────────────
  const applyPostProcessing = useCallback(async () => {
    const s = stateRef.current;
    const engine = engineRef.current;
    if (!engine) return;

    const colorModeEl = document.getElementById('colorMode');
    const mode = colorModeEl?.value || 'monochrome';
    const isSpot = (mode === 'spot');

    const marginEl = document.getElementById('marginSlider');
    const margin = parseInt(marginEl?.value || '10');
    const penWidthEl = document.getElementById('penWidth');
    const width = parseFloat(penWidthEl?.value || '1');
    const inkColorEl = document.getElementById('inkColor');
    const inkColor = inkColorEl?.value || '#22d3ee';

    // ── Generate Artwork Labels (Title & Subtitle) BEFORE layoutPaths ──
    // Text paths must be added to the project BEFORE layoutPaths() applies
    // the view matrix transform, so they get transformed along with artwork.
    // This runs for ALL modes including CMYK All.
    const labels = s.labelsWorkerSettings;
    const titleText = labels.title ?? '';
    const subtitleText = labels.subtitle ?? '';
    const textScale = labels.textScale ?? 1.0;

    // Remove any previous label group to avoid duplicates
    const existingLabelGroup = engine.project.activeLayer.children.find(
      child => child.name === 'artworkLabels'
    );
    if (existingLabelGroup) {
      existingLabelGroup.remove();
    }

    if ((titleText.trim() || subtitleText.trim()) && (!isSpot || s.activeMarkers.some(m => m.id === 'black'))) {
      try {
        // Calculate artwork bounds from all non-label paths (exclude artworkLabels group)
        // Collect both Path and CompoundPath items (CompoundPath from SVG import)
        const artworkPaths = [];
        function collectArtworkPaths(items) {
          for (const child of items) {
            if (child instanceof paper.Path && child.name !== 'artworkLabels') {
              artworkPaths.push(child);
            } else if (child instanceof paper.Group || child instanceof paper.CompoundPath) {
              collectArtworkPaths(child.children);
            }
          }
        }
        collectArtworkPaths(engine.project.activeLayer.children);

        let artworkBounds = null;
        if (artworkPaths.length > 0) {
          artworkBounds = artworkPaths.reduce((bounds, child) => {
            if (bounds) {
              return bounds.unite(child.bounds);
            }
            return child.bounds.clone();
          }, null);
        }

        // If no artwork paths exist yet, use paper dimensions as fallback bounds
        if (!artworkBounds) {
          artworkBounds = new paper.Rectangle(
            0, 0,
            s.paperWidth, s.paperHeight
          );
        }

        const textGroup = generateTextPaths({
          project: engine.project,
          titleText,
          subtitleText,
          scale: textScale,
          titleSize: 48,
          subtitleSize: 28,
        });

        if (textGroup) {
          // Position the text group in the top margin, above the artwork
          positionTextGroup(textGroup, artworkBounds, 5, s.paperWidth, s.paperHeight);

          if (isSpot) {
            const blackMarker = MARKER_COLORS.find(m => m.id === 'black');
            function setBlackStroke(items) {
              for (const item of items) {
                if (item instanceof paper.Path) {
                  item.strokeColor = new paper.Color(blackMarker?.hex || '#1a1a1a');
                } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
                  setBlackStroke(item.children);
                }
              }
            }
            setBlackStroke(textGroup.children);
          }

          engine.project.activeLayer.addChild(textGroup);
        }
      } catch (err) {
        console.warn('TextToPath: Failed to generate text paths:', err);
      }
    }

    const post = s.postWorkerSettings;
    const smoothIter = post.smoothing ?? 0;

    if (isSpot && s.spotAllPaths) {
      // Layout Paper.js paths (all channels are already added to the project)
      layoutPaths(engine, s.paperWidth, s.paperHeight, margin, smoothIter);

      // Set stroke properties on ALL Paper.js paths (artwork + labels)
      // Clear fillColor so SVG paths render as strokes only
      // Spot color mode: each channel renders as a solid ink color with no
      // blend-mode mixing. Channels are ordered C→M→Y→K so black renders last
      // and covers any edge-case overlaps, matching physical plotter behavior.
      function styleItems(items) {
        for (const item of items) {
          if (item instanceof paper.Path) {
            item.strokeWidth = width;
            item.strokeCap = 'round';
            item.strokeJoin = 'round';
            item.fillColor = null;
            item.blendMode = 'normal';
          } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
            styleItems(item.children);
          }
        }
      }
      styleItems(engine.project.activeLayer.children);

      // White background so spot colors render against white paper.
      // layoutPaths() has already baked mm→CSS-pixel coords into all paths and
      // reset the view matrix to identity, so the bgRect must use canvas CSS-pixel
      // dimensions — not mm dimensions — to cover the full canvas.
      const bgViewSize = engine.scope.view?.viewSize;
      const bgW = bgViewSize ? bgViewSize.width : s.paperWidth;
      const bgH = bgViewSize ? bgViewSize.height : s.paperHeight;
      const bgRect = new paper.Path.Rectangle(new paper.Rectangle(0, 0, bgW, bgH));
      bgRect.fillColor = new paper.Color(1, 1, 1);
      bgRect.strokeColor = null;
      engine.project.activeLayer.insertChild(0, bgRect);

      let totalPaths = 0;
      let totalPoints = 0;
      for (const marker of s.activeMarkers) {
        const paths = s.spotAllPaths[marker.id] || [];
        totalPaths += paths.length;
        for (const p of paths) totalPoints += p.length;
      }

      setEngineStats({ pathCount: totalPaths, pointCount: totalPoints });
      setCanvasWarning(totalPaths === 0 ? 'No paths generated. Try adjusting threshold or contrast.' : null);
      setIsProcessing(false);
      s.isProcessing = false;
      return;
    }

    layoutPaths(engine, s.paperWidth, s.paperHeight, margin, smoothIter);

    const strokeColor = inkColor;

    // Set stroke color and width on ALL paths (artwork + labels) for visibility
    // Clear fillColor so SVG paths render as strokes only
    // Recursively traverse groups and compound paths to style nested paths
    function styleItems(items) {
      for (const item of items) {
        if (item instanceof paper.Path) {
          item.strokeColor = new paper.Color(strokeColor);
          item.strokeWidth = width;
          item.strokeCap = 'round';
          item.strokeJoin = 'round';
          item.fillColor = null;
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          styleItems(item.children);
        }
      }
    }
    styleItems(engine.project.activeLayer.children);

    // Get stats with guardrails
    const stats = engine.getStats();
    setEngineStats({ pathCount: stats.pathCount, pointCount: stats.pointCount });
    setCanvasWarning(stats.emptyError);

    // Guard against null view — can happen if the component unmounts
    // during an async post-processing step.
    if (engine.scope.view) {
      engine.scope.view.draw();
    }

    setIsProcessing(false);
    s.isProcessing = false;
  }, []);

  /**
   * Draw a subtractive CMYK composite preview using Canvas2D multiply blending.
   *
   * In real CMYK printing, each ink layer absorbs (subtracts) specific
   * wavelengths of light from white paper:
   *   - Cyan   absorbs Red     → reflects Green + Blue  (#00FFFF)
   *   - Magenta absorbs Green  → reflects Red + Blue    (#FF00FF)
   *   - Yellow  absorbs Blue   → reflects Red + Green   (#FFFF00)
   *   - Black   absorbs all    → reflects nothing       (#000000)
   *
   * The Canvas2D 'multiply' compositing mode naturally models subtractive
   * mixing on a white background:
   *   Cyan × Magenta = #0000FF (blue)  ✓
   *   Cyan × Yellow  = #00FF00 (green) ✓
   *   Magenta × Yellow = #FF0000 (red) ✓
   *   All three = #000000 (black)      ✓
   *
   * This is both mathematically correct AND hardware-accelerated by the GPU.
   */
  function drawCmykCompositePreview(allPaths, width, margin) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const canvasW = canvas.width / dpr;
    const canvasH = canvas.height / dpr;
    const s = stateRef.current;

    // Paper.js may have ctx.scale(pixelRatio, pixelRatio) on the context.
    // This function draws in physical pixel space (coordinates already
    // multiplied by dpr), so we reset to identity for the duration.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Clear to white paper
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const paperW = s.paperWidth;
    const paperH = s.paperHeight;

    // Margin-aware transform (same as layoutPaths)
    const contentScale = Math.min(
      (paperW - 2 * margin) / paperW,
      (paperH - 2 * margin) / paperH
    );
    const canvasScale = Math.min(canvasW / paperW, canvasH / paperH);
    const totalScale = contentScale * canvasScale;
    const offsetX = (canvasW - paperW * canvasScale) / 2
                  + (paperW / 2) * (1 - contentScale) * canvasScale;
    const offsetY = (canvasH - paperH * canvasScale) / 2
                  + (paperH / 2) * (1 - contentScale) * canvasScale;

    // Helper to draw a set of point arrays with the given style
    function drawPointArrays(paths, strokeStyle, lineWidth) {
      if (!paths || paths.length === 0) return;
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const path of paths) {
        if (!path || path.length < 2) continue;
        ctx.moveTo(
          (path[0].x * totalScale + offsetX) * dpr,
          (path[0].y * totalScale + offsetY) * dpr
        );
        for (let i = 1; i < path.length; i++) {
          ctx.lineTo(
            (path[i].x * totalScale + offsetX) * dpr,
            (path[i].y * totalScale + offsetY) * dpr
          );
        }
      }
      ctx.stroke();
    }

    // Helper to extract {x,y} point arrays from Paper.js paths (recursively walks groups and compound paths)
    function extractPointsFromPaperItems(items) {
      const result = [];
      for (const item of items) {
        if (item instanceof paper.Path && item.segments.length > 1) {
          const pts = item.segments.map(seg => ({ x: seg.point.x, y: seg.point.y }));
          result.push(pts);
        } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
          const nested = extractPointsFromPaperItems(item.children);
          result.push(...nested);
        }
      }
      return result;
    }

    // Use 'multiply' compositing — this is the key to subtractive color mixing.
    // Each channel's ink color is multiplied into the existing canvas color,
    // which naturally models how physical inks absorb light.
    ctx.globalCompositeOperation = 'multiply';

    // Full opacity (1.0) is required for mathematically correct subtractive mixing.
    // With multiply blend mode: result = dest × (alpha × src + (1 - alpha)).
    // At 0.9 opacity, cyan only absorbs 90% of red (10% bleeds through), and
    // black renders as dark gray instead of true black. Path density — not opacity —
    // is what encodes ink coverage.
    const channelConfig = [
      { key: 'cyan',    color: 'rgba(0, 255, 255, 1.0)' },
      { key: 'magenta', color: 'rgba(255, 0, 255, 1.0)' },
      { key: 'yellow',  color: 'rgba(255, 255, 0, 1.0)' },
      { key: 'black',   color: 'rgba(0, 0, 0, 1.0)' },
    ];

    for (const { key, color } of channelConfig) {
      drawPointArrays(allPaths[key], color, (width || 1) * dpr);
    }

    // Reset compositing mode for subsequent drawing
    ctx.globalCompositeOperation = 'source-over';

    // ── Draw Artwork Labels on top of the CMYK composite ──
    // Labels (title/subtitle) are stored as Paper.js paths in the project's
    // artworkLabels group. Extract them and draw in black so they appear
    // as ink on the composite preview.
    const engine = engineRef.current;
    if (engine) {
      const labelGroup = engine.project.activeLayer.children.find(
        child => child.name === 'artworkLabels'
      );
      if (labelGroup) {
        const labelPaths = extractPointsFromPaperItems([labelGroup]);
        if (labelPaths.length > 0) {
          drawPointArrays(labelPaths, '#000000', (width || 1) * dpr);
        }
      }
    }

    ctx.restore();
  }

  // ── Reprocess Triggers ────────────────────────────────────
  const triggerReprocess = useCallback(async () => {
    const s = stateRef.current;
    if (s.isProcessing || !s.sourceImage) return;
    setIsProcessing(true);
    s.isProcessing = true;
    try {
      await processRasterImage(s.sourceImage);
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
      s.isProcessing = false;
    }
  }, [processRasterImage]);

  const triggerReprocessWithFilters = useCallback(async () => {
    const s = stateRef.current;
    if (s.isProcessing || !s.sourceImage) return;
    setIsProcessing(true);
    s.isProcessing = true;
    try {
      await processRasterImage(s.sourceImage);
    } catch (err) {
      console.error(err);
    } finally {
      setIsProcessing(false);
      s.isProcessing = false;
    }
  }, [processRasterImage]);

  const triggerPostProcess = useCallback(async () => {
    const s = stateRef.current;
    const engine = engineRef.current;
    if (s.isProcessing) return;
    if (!engine) return;
    const stats = engine.getStats();
    // Allow label-only updates even when pathCount === 0
    const labels = s.labelsWorkerSettings;
    const hasLabels = labels && (labels.title?.trim() || labels.subtitle?.trim());
    if (stats.pathCount === 0 && !hasLabels) return;
    setIsProcessing(true);
    s.isProcessing = true;
    try {
      await applyPostProcessing();
    } catch (err) {
      console.error(err);
      setIsProcessing(false);
      s.isProcessing = false;
    }
  }, [applyPostProcessing]);

  const reLayoutPaths = useCallback(async () => {
    const s = stateRef.current;
    const engine = engineRef.current;
    if (s.isProcessing) return;
    if (!engine) return;
    const modeEl = document.getElementById('colorMode');
    const mode = modeEl?.value || 'monochrome';
    const isSpot = (mode === 'spot');
    // Allow re-layout when labels exist even if no artwork paths
    const labels = s.labelsWorkerSettings;
    const hasLabels = labels && (labels.title?.trim() || labels.subtitle?.trim());
    if (!isSpot && engine.getStats().pathCount === 0 && !hasLabels) return;
    if (isSpot && !s.spotAllPaths) return;

    const marginEl = document.getElementById('marginSlider');
    const margin = parseInt(marginEl?.value || '10');

    const smoothIter = s.postWorkerSettings?.smoothing ?? 0;

    if (isSpot) {
      layoutPaths(engine, s.paperWidth, s.paperHeight, margin, smoothIter);
      if (engine.scope.view) {
        engine.scope.view.draw();
      }
      return;
    }

    // For all other modes: just update the view matrix — no reprocessing needed.
    // Path coordinates are unchanged; only the Paper.js view transform changes.
    layoutPaths(engine, s.paperWidth, s.paperHeight, margin, smoothIter);
    if (engine.scope.view) {
      engine.scope.view.draw();
    }
  }, []);

  // ── Event Binding Setup ───────────────────────────────────
  const listenersAttachedRef = useRef(false);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    // Guard against duplicate event listener registration.
    // The useEffect dependencies include callback refs that change on algo switch,
    // causing the effect to re-run and attach duplicate listeners.
    if (listenersAttachedRef.current) return;
    listenersAttachedRef.current = true;

    const fileInput = document.getElementById('fileInput');
    const fileZone = document.getElementById('fileZone');
    const filePlaceholder = document.getElementById('filePlaceholder');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');

    if (fileZone) {
      fileZone.addEventListener('click', () => fileInput?.click());
    }
    if (fileInput) {
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          const file = e.target.files[0];
          if (filePlaceholder) filePlaceholder.classList.add('hidden');
          if (fileInfo) fileInfo.classList.remove('hidden');
          if (fileName) fileName.textContent = file.name;
          if (fileSize) fileSize.textContent = `${(file.size / 1024).toFixed(1)} KB`;
          if (fileZone) fileZone.classList.add('has-file');
          processFile(file);
        }
      });
    }

    if (fileZone) {
      fileZone.addEventListener('dragover', (e) => { e.preventDefault(); fileZone.style.borderColor = '#06b6d4'; });
      fileZone.addEventListener('dragleave', () => { fileZone.style.borderColor = ''; });
      fileZone.addEventListener('drop', (e) => {
        e.preventDefault();
        fileZone.style.borderColor = '';
        if (e.dataTransfer.files.length > 0) {
          const file = e.dataTransfer.files[0];
          if (filePlaceholder) filePlaceholder.classList.add('hidden');
          if (fileInfo) fileInfo.classList.remove('hidden');
          if (fileName) fileName.textContent = file.name;
          if (fileSize) fileSize.textContent = `${(file.size / 1024).toFixed(1)} KB`;
          if (fileZone) fileZone.classList.add('has-file');
          processFile(file);
        }
      });
    }

    const colorModeEl = document.getElementById('colorMode');
    if (colorModeEl) {
      colorModeEl.addEventListener('change', () => {
        const spotMarkerGroup = document.getElementById('spotMarkerGroup');
        if (spotMarkerGroup) {
          spotMarkerGroup.classList.toggle('hidden', colorModeEl.value !== 'spot');
        }
        const s = stateRef.current;
        if (s.sourceImage) triggerReprocess();
      });
    }

    const paperSizeEl = document.getElementById('paperSize');
    const customSizeGroup = document.getElementById('customSizeGroup');
    const paperLabelEl = document.getElementById('paperLabel');
    const customWidthEl = document.getElementById('customWidth');
    const customHeightEl = document.getElementById('customHeight');

    if (paperSizeEl) {
      paperSizeEl.addEventListener('change', () => {
        const preset = PAPER_PRESETS[paperSizeEl.value];
        if (preset) {
          stateRef.current.paperWidth = preset.w;
          stateRef.current.paperHeight = preset.h;
          if (paperLabelEl) paperLabelEl.textContent = `${preset.w}×${preset.h} mm`;
          if (customSizeGroup) customSizeGroup.classList.toggle('hidden', paperSizeEl.value !== 'custom');
          // Resize the canvas to match the new paper aspect ratio
          engine.resize(preset.w, preset.h);
          if (engine.getStats().pathCount > 0) reLayoutPaths();
        }
      });
    }

    if (customWidthEl) {
      customWidthEl.addEventListener('change', () => {
        if (paperSizeEl?.value === 'custom') {
          const w = parseInt(customWidthEl.value) || 256;
          const h = parseInt(customHeightEl?.value || '256') || 256;
          stateRef.current.paperWidth = w;
          stateRef.current.paperHeight = h;
          if (paperLabelEl) paperLabelEl.textContent = `${w}×${h} mm`;
          // Resize the canvas to match the new paper aspect ratio
          engine.resize(w, h);
          if (engine.getStats().pathCount > 0) reLayoutPaths();
        }
      });
    }
    if (customHeightEl) {
      customHeightEl.addEventListener('change', () => {
        if (paperSizeEl?.value === 'custom') {
          const w = parseInt(customWidthEl?.value || '256') || 256;
          const h = parseInt(customHeightEl.value) || 256;
          stateRef.current.paperWidth = w;
          stateRef.current.paperHeight = h;
          if (paperLabelEl) paperLabelEl.textContent = `${w}×${h} mm`;
          // Resize the canvas to match the new paper aspect ratio
          engine.resize(w, h);
          if (engine.getStats().pathCount > 0) reLayoutPaths();
        }
      });
    }

    const inkColorEl = document.getElementById('inkColor');
    const inkColorSwatch = document.getElementById('inkColorSwatch');
    if (inkColorEl && inkColorSwatch) {
      inkColorEl.addEventListener('input', () => {
        inkColorSwatch.style.background = inkColorEl.value;
        // In spot mode each path already carries its marker's ink color —
        // the inkColor picker only affects monochrome output.
        const modeEl = document.getElementById('colorMode');
        if (modeEl?.value === 'spot') return;
        const color = inkColorEl.value;
        // Recursively style paths inside groups and compound paths (e.g., artworkLabels, SVG imports)
        function styleItems(items) {
          for (const item of items) {
            if (item instanceof paper.Path) {
              item.strokeColor = new paper.Color(color);
              item.fillColor = null;
            } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
              styleItems(item.children);
            }
          }
        }
        styleItems(engine.project.activeLayer.children);
        if (engine.scope.view) {
          engine.scope.view.draw();
        }
      });
    }

    const penWidthEl = document.getElementById('penWidth');
    if (penWidthEl) {
      penWidthEl.addEventListener('change', () => {
        const w = parseFloat(penWidthEl.value);
        // Recursively style paths inside groups and compound paths (e.g., artworkLabels, SVG imports)
        function styleItems(items) {
          for (const item of items) {
            if (item instanceof paper.Path) {
              item.strokeWidth = w;
              item.fillColor = null;
            } else if (item instanceof paper.Group || item instanceof paper.CompoundPath) {
              styleItems(item.children);
            }
          }
        }
        styleItems(engine.project.activeLayer.children);
        if (engine.scope.view) {
          engine.scope.view.draw();
        }
      });
    }

    const clearBtn = document.getElementById('clearBtn');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        engine.clear();
        if (engine.scope.view) {
          engine.scope.view.draw();
        }
        stateRef.current.spotAllPaths = null;
        setEngineStats(null);
        setCanvasWarning(null);
        const statGcode = document.getElementById('statGcode');
        if (statGcode) statGcode.textContent = '\u2014';
      });
    }

    const marginSlider = document.getElementById('marginSlider');
    const marginValue = document.getElementById('marginValue');
    if (marginSlider && marginValue) {
      marginSlider.addEventListener('input', () => {
        marginValue.textContent = `${marginSlider.value} mm`;
        reLayoutPaths();
      });
    }

    const invertCheck = document.getElementById('invertPreprocessCheck');
    if (invertCheck) {
      invertCheck.addEventListener('change', () => {
        triggerReprocessWithFilters();
      });
    }

    const engineResolutionEl = document.getElementById('engineResolution');
    if (engineResolutionEl) {
      engineResolutionEl.addEventListener('change', () => {
        const s = stateRef.current;
        if (s.sourceImage) triggerReprocess();
      });
    }

    // Export buttons
    const exportSvgBtn = document.getElementById('exportSvgBtn');
    const exportPngBtn = document.getElementById('exportPngBtn');
    const exportBambuBtn = document.getElementById('exportBambuBtn');
    const exportGrblBtn = document.getElementById('exportGrblBtn');
    const downloadAllBtn = document.getElementById('downloadAllBtn');

    function isSpotMode() {
      const modeEl = document.getElementById('colorMode');
      return modeEl?.value === 'spot';
    }

    function getExportPaths() {
      if (isSpotMode()) return null;
      return engine.collectPaths();
    }

    function handleExportWithAllCheck(fn) {
      const paths = getExportPaths();
      if (!paths) {
        alert('SVG export requires Monochrome mode. Use PNG or G-code export for Spot Color output.');
        return;
      }
      fn(paths);
    }

    if (exportSvgBtn) {
      exportSvgBtn.addEventListener('click', () => {
        handleExportWithAllCheck(() => {
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const smoothIter = stateRef.current.postWorkerSettings?.smoothing ?? 0;
          restoreMmCoords(engine);
          if (smoothIter > 0) for (let i = 0; i < smoothIter; i++) engine.smoothAll('catmull-rom');
          const svg = ExportEngine.exportSVG(
            engine.project,
            stateRef.current.paperWidth,
            stateRef.current.paperHeight,
            margin
          );
          ExportEngine.downloadFile(svg, 'vitro_export.svg', 'image/svg+xml');
          layoutPaths(engine, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, smoothIter);
          if (engine.scope.view) engine.scope.view.draw();
        });
      });
    }

    if (exportPngBtn) {
      exportPngBtn.addEventListener('click', () => {
        // Spot Color mode: capture the composite preview canvas directly
        if (isSpotMode()) {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const dataUrl = canvas.toDataURL('image/png');
          ExportEngine.downloadFile(dataUrl, 'vitro_cmyk_all.png', 'image/png');
          return;
        }
        handleExportWithAllCheck(() => {
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const smoothIter = stateRef.current.postWorkerSettings?.smoothing ?? 0;
          const engineResEl = document.getElementById('engineResolution');
          const engineRes = parseInt(engineResEl?.value || '1000');
          restoreMmCoords(engine);
          if (smoothIter > 0) for (let i = 0; i < smoothIter; i++) engine.smoothAll('catmull-rom');
          const dataUrl = ExportEngine.exportPNG(
            engine.project,
            stateRef.current.paperWidth,
            stateRef.current.paperHeight,
            margin,
            engineRes
          );
          ExportEngine.downloadFile(dataUrl, 'vitro_export.png', 'image/png');
          layoutPaths(engine, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, smoothIter);
          if (engine.scope.view) engine.scope.view.draw();
        });
      });
    }

    if (exportBambuBtn) {
      exportBambuBtn.addEventListener('click', () => {
        if (isSpotMode()) {
          const s = stateRef.current;
          if (!s.spotAllPaths || !s.activeMarkers) return;
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const zUp = parseFloat(document.getElementById('zUpSlider')?.value || '5');
          const zDown = parseFloat(document.getElementById('zDownSlider')?.value || '0.2');
          const feedrate = parseInt(document.getElementById('feedrateSlider')?.value || '3000');
          const files = ExportEngine.generateSpotBambuGcode(
            s.spotAllPaths, s.activeMarkers,
            s.paperWidth, s.paperHeight, margin, zUp, zDown, feedrate
          );
          let totalPts = 0;
          let totalKb = 0;
          for (const f of files) {
            ExportEngine.downloadFile(f.gcode, f.filename, 'text/plain');
            totalPts += f.totalPoints;
            totalKb += f.gcode.length;
          }
          const statGcode = document.getElementById('statGcode');
          if (statGcode) statGcode.textContent = `${fmt(totalPts)} pts, ${(totalKb / 1024).toFixed(1)} KB (${files.length} files)`;
          return;
        }
        handleExportWithAllCheck(() => {
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const smoothIter = stateRef.current.postWorkerSettings?.smoothing ?? 0;
          const zUp = parseFloat(document.getElementById('zUpSlider')?.value || '5');
          const zDown = parseFloat(document.getElementById('zDownSlider')?.value || '0.2');
          const feedrate = parseInt(document.getElementById('feedrateSlider')?.value || '3000');
          restoreMmCoords(engine);
          if (smoothIter > 0) for (let i = 0; i < smoothIter; i++) engine.smoothAll('catmull-rom');
          const result = ExportEngine.generateBambuGcode(
            engine.project, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, zUp, zDown, feedrate
          );
          ExportEngine.downloadFile(result.gcode, 'vitro_bambu.gcode', 'text/plain');
          const statGcode = document.getElementById('statGcode');
          if (statGcode) statGcode.textContent = `${fmt(result.totalPoints)} pts, ${(result.gcode.length / 1024).toFixed(1)} KB`;
          layoutPaths(engine, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, smoothIter);
          if (engine.scope.view) engine.scope.view.draw();
        });
      });
    }

    if (exportGrblBtn) {
      exportGrblBtn.addEventListener('click', () => {
        if (isSpotMode()) {
          const s = stateRef.current;
          if (!s.spotAllPaths || !s.activeMarkers) return;
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const zUp = parseFloat(document.getElementById('zUpSlider')?.value || '5');
          const zDown = parseFloat(document.getElementById('zDownSlider')?.value || '0.2');
          const feedrate = parseInt(document.getElementById('feedrateSlider')?.value || '3000');
          const files = ExportEngine.generateSpotGrblGcode(
            s.spotAllPaths, s.activeMarkers,
            s.paperWidth, s.paperHeight, margin, zUp, zDown, feedrate
          );
          let totalPts = 0;
          let totalKb = 0;
          for (const f of files) {
            ExportEngine.downloadFile(f.gcode, f.filename, 'text/plain');
            totalPts += f.totalPoints;
            totalKb += f.gcode.length;
          }
          const statGcode = document.getElementById('statGcode');
          if (statGcode) statGcode.textContent = `${fmt(totalPts)} pts, ${(totalKb / 1024).toFixed(1)} KB (${files.length} files)`;
          return;
        }
        handleExportWithAllCheck(() => {
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const smoothIter = stateRef.current.postWorkerSettings?.smoothing ?? 0;
          const zUp = parseFloat(document.getElementById('zUpSlider')?.value || '5');
          const zDown = parseFloat(document.getElementById('zDownSlider')?.value || '0.2');
          const feedrate = parseInt(document.getElementById('feedrateSlider')?.value || '3000');
          restoreMmCoords(engine);
          if (smoothIter > 0) for (let i = 0; i < smoothIter; i++) engine.smoothAll('catmull-rom');
          const result = ExportEngine.generateGrblGcode(
            engine.project, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, zUp, zDown, feedrate
          );
          ExportEngine.downloadFile(result.gcode, 'vitro_grbl.gcode', 'text/plain');
          const statGcode = document.getElementById('statGcode');
          if (statGcode) statGcode.textContent = `${fmt(result.totalPoints)} pts, ${(result.gcode.length / 1024).toFixed(1)} KB`;
          layoutPaths(engine, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, smoothIter);
          if (engine.scope.view) engine.scope.view.draw();
        });
      });
    }

    if (downloadAllBtn) {
      downloadAllBtn.addEventListener('click', () => {
        // Spot Color mode: export PNG composite + per-color Bambu G-code files
        if (isSpotMode()) {
          const s = stateRef.current;
          if (!s.spotAllPaths || !s.activeMarkers) return;

          // PNG composite preview
          const canvas = canvasRef.current;
          if (canvas) {
            const dataUrl = canvas.toDataURL('image/png');
            ExportEngine.downloadFile(dataUrl, 'vitro_cmyk_all.png', 'image/png');
          }

          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const zUp = parseFloat(document.getElementById('zUpSlider')?.value || '5');
          const zDown = parseFloat(document.getElementById('zDownSlider')?.value || '0.2');
          const feedrate = parseInt(document.getElementById('feedrateSlider')?.value || '3000');

          // Per-color Bambu G-code files (one per active color)
          const bambuFiles = ExportEngine.generateSpotBambuGcode(
            s.spotAllPaths, s.activeMarkers,
            s.paperWidth, s.paperHeight, margin, zUp, zDown, feedrate
          );
          for (const f of bambuFiles) {
            ExportEngine.downloadFile(f.gcode, f.filename, 'text/plain');
          }

          return;
        }
        handleExportWithAllCheck(() => {
          const margin = parseInt(document.getElementById('marginSlider')?.value || '10');
          const smoothIter = stateRef.current.postWorkerSettings?.smoothing ?? 0;
          const zUp = parseFloat(document.getElementById('zUpSlider')?.value || '5');
          const zDown = parseFloat(document.getElementById('zDownSlider')?.value || '0.2');
          const feedrate = parseInt(document.getElementById('feedrateSlider')?.value || '3000');

          restoreMmCoords(engine);
          if (smoothIter > 0) for (let i = 0; i < smoothIter; i++) engine.smoothAll('catmull-rom');

          const svg = ExportEngine.exportSVG(
            engine.project,
            stateRef.current.paperWidth,
            stateRef.current.paperHeight,
            margin
          );
          ExportEngine.downloadFile(svg, 'vitro_export.svg', 'image/svg+xml');

          const engineResEl = document.getElementById('engineResolution');
          const engineRes = parseInt(engineResEl?.value || '1000');
          const pngData = ExportEngine.exportPNG(
            engine.project,
            stateRef.current.paperWidth,
            stateRef.current.paperHeight,
            margin,
            engineRes
          );
          ExportEngine.downloadFile(pngData, 'vitro_export.png', 'image/png');

          const bambu = ExportEngine.generateBambuGcode(engine.project, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, zUp, zDown, feedrate);
          ExportEngine.downloadFile(bambu.gcode, 'vitro_bambu.gcode', 'text/plain');

          const grbl = ExportEngine.generateGrblGcode(engine.project, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, zUp, zDown, feedrate);
          ExportEngine.downloadFile(grbl.gcode, 'vitro_grbl.gcode', 'text/plain');

          layoutPaths(engine, stateRef.current.paperWidth, stateRef.current.paperHeight, margin, smoothIter);
          if (engine.scope.view) engine.scope.view.draw();
        });
      });
    }

    // Machine sliders
    const zUpSlider = document.getElementById('zUpSlider');
    const zUpValue = document.getElementById('zUpValue');
    const zDownSlider = document.getElementById('zDownSlider');
    const zDownValue = document.getElementById('zDownValue');
    const feedrateSlider = document.getElementById('feedrateSlider');
    const feedrateValue = document.getElementById('feedrateValue');

    if (zUpSlider && zUpValue) {
      zUpSlider.addEventListener('input', () => {
        zUpValue.textContent = `${parseFloat(zUpSlider.value).toFixed(1)} mm`;
      });
    }
    if (zDownSlider && zDownValue) {
      zDownSlider.addEventListener('input', () => {
        zDownValue.textContent = `${parseFloat(zDownSlider.value).toFixed(1)} mm`;
      });
    }
    if (feedrateSlider && feedrateValue) {
      feedrateSlider.addEventListener('input', () => {
        feedrateValue.textContent = feedrateSlider.value;
      });
    }
  }, [processFile, triggerReprocess, triggerReprocessWithFilters, triggerPostProcess, reLayoutPaths]);

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-neutral-950/80 border-b border-neutral-800/60 px-5 py-2.5">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500 to-fuchsia-600 flex items-center justify-center text-white font-bold text-xs">V</div>
            <h1 className="text-lg font-bold text-white tracking-tight">Vitro <span className="text-cyan-400">Vector Engine</span></h1>
          </div>
          <div className="flex items-center gap-3">
            <span id="statusBadge" className={`status-badge ${isProcessing ? 'status-processing' : engineStats ? 'status-ready' : 'status-idle'}`}>
              {isProcessing ? 'Processing...' : engineStats ? 'Ready' : 'Idle'}
            </span>
            <span className="text-[10px] text-neutral-600 font-mono">v3.0</span>
          </div>
        </div>
      </header>

      {/* Main Three-Pane Layout */}
      <div className="flex-1 flex flex-col xl:flex-row max-w-7xl mx-auto w-full p-3 xl:p-5 gap-4 items-start">
        {/* LEFT PANEL — Settings */}
        <aside className="w-full xl:w-72 shrink-0 space-y-4">
          <SettingsPanel
            algo={algo}
            onAlgoChange={handleAlgoChange}
            onWorkerSettingsChange={handleWorkerSettingsChange}
            onPreprocessChange={handlePreprocessChange}
            onPostprocessChange={handlePostprocessChange}
            onLabelsChange={handleLabelsChange}
            engineStats={engineStats}
            isProcessing={isProcessing}
            canvasWarning={canvasWarning}
            sourcePreviewRef={sourcePreviewRef}
            markerColors={MARKER_COLORS}
            defaultActiveMarkerIds={DEFAULT_ACTIVE_MARKER_IDS}
            onMarkerToggle={handleMarkerToggle}
          />
        </aside>

        {/* CENTER PANEL — Preview */}
        <main className="flex-1 flex flex-col gap-4 min-w-0 sticky top-0 z-10">
          <div className="panel-card flex-1 flex flex-col">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <h2 className="panel-title mb-0">Preview</h2>
                <span id="paperLabel" className="text-[10px] text-neutral-600 font-mono">{paperLabel}</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="relative cursor-pointer" title="Preview ink color">
                  <input type="color" id="inkColor" defaultValue="#000000" className="sr-only" />
                  <span className="w-5 h-5 rounded-full border border-neutral-600 block" id="inkColorSwatch" style={{ background: '#000000' }}></span>
                </label>
                <select id="penWidth" defaultValue="1" className="text-[10px] bg-neutral-800 border border-neutral-700 rounded px-1.5 py-1 text-gray-300 focus:outline-none focus:border-cyan-500 cursor-pointer" title="Preview stroke width">
                  <option value="0.5">0.5px</option>
                  <option value="1">1px</option>
                  <option value="1.5">1.5px</option>
                  <option value="2">2px</option>
                  <option value="3">3px</option>
                </select>
                <button id="clearBtn" className="text-[10px] text-neutral-600 hover:text-red-400 transition-colors px-2 py-1 rounded hover:bg-red-950/30" title="Clear canvas">Clear</button>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center overflow-hidden relative">
              <canvas ref={canvasRef} id="previewCanvas"></canvas>
              {/* Processing Overlay */}
              <div id="processingOverlay" className={`absolute inset-0 bg-black/70 flex flex-col items-center justify-center rounded-lg ${isProcessing ? '' : 'hidden'}`} style={{ zIndex: 10 }}>
                <svg className="w-10 h-10 text-cyan-400 animate-spin mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                <p className="text-cyan-300 text-sm font-medium">Processing...</p>
                <p className="text-neutral-500 text-xs mt-1">This may take a moment</p>
              </div>
              {/* Canvas Warning Overlay */}
              {canvasWarning && (
                <div className="absolute top-3 left-3 right-3 bg-amber-950/80 border border-amber-700/50 rounded-lg px-3 py-2 text-xs text-amber-400" style={{ zIndex: 11 }}>
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    <span>{canvasWarning}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </main>

        {/* RIGHT PANEL — Export & Machine */}
        <aside className="w-full xl:w-64 shrink-0 space-y-4">
          <div className="panel-card space-y-2.5">
            <h2 className="panel-title">Export</h2>
            <button id="exportSvgBtn" className="btn-export flex items-center gap-2" disabled={!engineStats}>
              <svg className="w-4 h-4 shrink-0 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
              <span className="flex-1 text-left">Export SVG</span>
              <span className="text-[10px] text-neutral-600">.svg</span>
            </button>
            <button id="exportPngBtn" className="btn-export flex items-center gap-2" disabled={!engineStats}>
              <svg className="w-4 h-4 shrink-0 text-fuchsia-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
              <span className="flex-1 text-left">Export PNG</span>
              <span className="text-[10px] text-neutral-600">.png</span>
            </button>
            <button id="exportBambuBtn" className="btn-export flex items-center gap-2" disabled={!engineStats}>
              <svg className="w-4 h-4 shrink-0 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
              </svg>
              <span className="flex-1 text-left">Bambu A1 G-Code</span>
              <span className="text-[10px] text-neutral-600">.gcode</span>
            </button>
            <button id="exportGrblBtn" className="btn-export flex items-center gap-2" disabled={!engineStats}>
              <svg className="w-4 h-4 shrink-0 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span className="flex-1 text-left">GRBL G-Code</span>
              <span className="text-[10px] text-neutral-600">.gcode</span>
            </button>
          </div>

          <div className="panel-card space-y-3">
            <h2 className="panel-title">Machine</h2>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="zUpSlider" className="sidebar-label mb-0">Z Pen Up</label>
                <span id="zUpValue" className="value-badge">5.0 mm</span>
              </div>
              <input type="range" id="zUpSlider" min="1" max="20" defaultValue="5" step="0.5" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="zDownSlider" className="sidebar-label mb-0">Z Pen Down</label>
                <span id="zDownValue" className="value-badge">0.2 mm</span>
              </div>
              <input type="range" id="zDownSlider" min="0" max="5" defaultValue="0.2" step="0.1" />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label htmlFor="feedrateSlider" className="sidebar-label mb-0">Feedrate XY</label>
                <span id="feedrateValue" className="value-badge">3000</span>
              </div>
              <input type="range" id="feedrateSlider" min="500" max="8000" defaultValue="3000" step="100" />
            </div>
          </div>

          <button id="downloadAllBtn" className="btn-primary flex items-center justify-center gap-2" disabled={!engineStats}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download All
          </button>
        </aside>
      </div>
    </div>
  );
}