/**
 * Algorithm Dispatcher — Routes to the correct algorithm generator
 * based on the selected algorithm name.
 */
import { generateSquiggle } from './Squiggle.js';
import { generateCrosshatch } from './Crosshatch.js';
import { generateStipple } from './Stipple.js';
import { generateFlowField } from './FlowField.js';
import { generateMarchingSquares } from './MarchingSquares.js';
import { generateVectorTrace } from './VectorTrace.js';
import { generateModulatedSpiral } from './ModulatedSpiral.js';
import { generateSkeletonTrace } from './Skeletonize.js';
import { generateCalligraphy } from './Calligraphy.js';
import { applyXDoG, chainEdgesToPaths } from './SubjectOutline.js';

/**
 * Run the selected algorithm, populating the Paper.js project's active layer.
 *
 * @param {string} algo       — algorithm name
 * @param {paper.Project} project
 * @param {ImageData} imageData        — binarized image data (for edge detection / contour tracing)
 * @param {object} params              — { density, spiralTurns, wiggleAmplitude, wiggleFrequency, minSpacing, maxSpacing, stepSize, resolution, threshold, tolerance, blurRadius, pathomit, minPathLength, linesCount, penConstraints, calibrationProfile, pixelsPerMm, maxZStep }
 * @param {function} onProgress        — optional progress callback
 * @param {ImageData} grayscaleData    — optional pre-binarization grayscale data (for algorithms that need continuous tone, e.g. Crosshatch)
 */
export async function runAlgorithm(algo, project, imageData, params = {}, onProgress, grayscaleData) {
  const { density = 80,
          spiralTurns = 100, wiggleAmplitude = 4, wiggleFrequency = 40,
          minSpacing = 2, maxSpacing = 15, stepSize = 2,
          resolution = 2, threshold = 128,
          tolerance = 1, blurRadius = 0, pathomit = 8, minPathLength = 5,
          linesCount = 10,
          penConstraints = {},
          calibrationProfile = 'sharpieFinePoint',
          pixelsPerMm = 4,
          maxZStep = 0.3 } = params;

  // Activate the project's PaperScope so that `new paper.Path()` and other
  // Paper.js constructors create items in the correct project rather than
  // in a stale or null global scope. This is critical because the algorithm
  // files import the global `paper` module and rely on the active scope.
  if (project && project.scope) {
    project.scope.activate();
  }

  switch (algo) {
    case 'squiggle':
      generateSquiggle(project, imageData, density);
      break;

    case 'crosshatch':
      // Crosshatch needs the pre-binarization grayscale data so its
      // multiple brightness thresholds (one per hatch direction) can
      // differentiate between different tonal regions. Without this,
      // a binarized image makes all thresholds behave identically.
      generateCrosshatch(project, grayscaleData || imageData, density, params);
      break;

    case 'stipple':
      generateStipple(project, imageData, density);
      break;

    case 'flowfield':
      await generateFlowField(project, imageData, density, minSpacing, maxSpacing, stepSize, penConstraints);
      break;

    case 'modulatedspiral':
      await generateModulatedSpiral(project, imageData, spiralTurns, wiggleAmplitude, wiggleFrequency, onProgress);
      break;

    case 'vectorsvg':
      // Vector algorithm: SVG paths are already imported by main.js via Paper.js.
      // No raster processing needed — the SVG vector data stays as Paper.js paths.
      break;

    case 'scanline':
      generateMarchingSquares(project, imageData, resolution, threshold);
      break;

    case 'vectortrace':
      await generateVectorTrace(project, imageData, { linesCount, penConstraints });
      break;

    case 'skeletonize':
      generateSkeletonTrace(project, imageData, {
        threshold,
        simplifyTolerance: tolerance,
        minPathLength,
        maxZStep,
        calibrationProfile,
        pixelsPerMm,
      });
      break;

    case 'calligraphy':
      // Calligraphy extracts medial axes from outlined SVG font paths
      // using Voronoi-based medial axis extraction.
      // It does NOT need external imageData — it works from vectors.
      generateCalligraphy(project, {
        sampleSpacing: params.sampleSpacing ?? 3,
        minThickness: params.minThickness ?? 1.5,
        chainStitchDist: params.chainStitchDist ?? 20,
        minChainLen: params.minChainLen ?? 8,
        simplifyDist: params.simplifyDist ?? 3,
        smoothingWindow: params.smoothingWindow ?? 5,
        maxZStep: params.maxZStep ?? 0.3,
        calibrationProfile: params.calibrationProfile ?? 'sharpieFinePoint',
        minPathLength: params.minPathLength ?? 5,
      });
      break;

    case 'outlinecrosshatch': {
      const src = grayscaleData || imageData;
      if (!params.skipOutline) {
        const binary = applyXDoG(
          src,
          params.xdogSigma1  ?? 0.8,
          params.xdogSigma2  ?? 1.6,
          params.xdogTau     ?? 0.98,
          params.xdogEpsilon ?? 0.0,
        );
        chainEdgesToPaths(src.width, src.height, binary, params.minPathLength ?? 10);
      }
      if (!params.outlineOnly) {
        generateCrosshatch(project, src, density, params);
      }
      break;
    }

    case 'subjectoutline': {
      const binary = applyXDoG(
        grayscaleData || imageData,
        params.xdogSigma1  ?? 0.8,
        params.xdogSigma2  ?? 1.6,
        params.xdogTau     ?? 0.98,
        params.xdogEpsilon ?? 0.00,
      );
      const w = (grayscaleData || imageData).width;
      const h = (grayscaleData || imageData).height;
      chainEdgesToPaths(w, h, binary, params.minPathLength ?? 10);
      break;
    }

    default:
      console.warn(`Unknown algorithm: ${algo}`);
  }
}
