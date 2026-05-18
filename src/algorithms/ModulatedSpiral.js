/**
 * Modulated Spiral — Industry-standard continuous-line algorithm for plotter art.
 *
 * Draws a perfect Archimedean spiral from the center outward. As the line
 * passes over dark pixels, a sine-wave wiggle is applied to the radius to
 * simulate shading. The spiral is deterministic, cannot cross itself, and
 * produces exactly one continuous line every time.
 *
 * Outputs a single Paper.js Path with smooth Bézier curves.
 */
import paper from 'paper';

/**
 * @param {paper.Project} project
 * @param {ImageData} imageData  — grayscale pixel data
 * @param {number} spiralTurns   — number of spiral revolutions (50–300)
 * @param {number} wiggleAmplitude — max wiggle displacement in dark areas (1–10)
 * @param {number} wiggleFrequency — sine wave frequency for wiggle (10–100)
 * @param {function} onProgress  — progress callback (msg, pct)
 */
export async function generateModulatedSpiral(
  project,
  imageData,
  spiralTurns,
  wiggleAmplitude,
  wiggleFrequency,
  onProgress
) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const turns = spiralTurns || 100;
  const amp = wiggleAmplitude || 4;
  const freq = wiggleFrequency || 40;

  // Center of the canvas
  const cx = w / 2;
  const cy = h / 2;

  // Maximum radius — leave a small margin so the spiral stays inside
  const margin = 4;
  const maxR = Math.min(cx, cy) - margin;

  // Angular step for high-resolution sampling (radians)
  const step = 0.05;
  const totalTheta = turns * Math.PI * 2;
  const totalSteps = Math.ceil(totalTheta / step);

  const path = [];

  for (let i = 0; i < totalSteps; i++) {
    const theta = i * step;

    // Base Archimedean radius: linear growth from 0 to maxR
    const baseR = (maxR / totalTheta) * theta;

    // Convert polar to Cartesian to find the pixel to sample
    const sampleX = cx + baseR * Math.cos(theta);
    const sampleY = cy + baseR * Math.sin(theta);

    // Sample the grayscale image at (sampleX, sampleY)
    const ix = Math.floor(sampleX);
    const iy = Math.floor(sampleY);
    let invertedBrightness = 0;

    if (ix >= 0 && ix < w && iy >= 0 && iy < h) {
      const idx = (iy * w + ix) * 4;
      // Luminosity from grayscale (all channels equal after grayscale conversion)
      const bright = data[idx] / 255; // 0.0 = black, 1.0 = white
      // Invert: 1.0 = black (shadow), 0.0 = white (highlight)
      invertedBrightness = 1 - bright;
      // Apply a contrast curve to boost shadow response
      invertedBrightness = invertedBrightness * invertedBrightness; // quadratic curve
    }

    // Modulate the radius: wiggle in dark areas, stay smooth in light areas
    const wiggle = Math.sin(theta * freq) * amp * invertedBrightness;
    const modulatedR = baseR + wiggle;

    // Final modulated Cartesian coordinates
    const finalX = cx + modulatedR * Math.cos(theta);
    const finalY = cy + modulatedR * Math.sin(theta);

    path.push({ x: finalX, y: finalY });

    // Yield to the event loop periodically for progress updates
    if (i % 5000 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (onProgress) onProgress('Generating spiral...', i / totalSteps);
    }
  }

  if (path.length < 2) return;

  // Create a single Paper.js path
  const paperPath = new paper.Path();
  paperPath.strokeColor = new paper.Color('black');
  paperPath.strokeWidth = 1;

  for (const pt of path) {
    paperPath.add(new paper.Point(pt.x, pt.y));
  }

  // Smooth the path so wiggles become fluid Bézier curves
  paperPath.smooth({ type: 'catmull-rom' });

  layer.addChild(paperPath);
}
