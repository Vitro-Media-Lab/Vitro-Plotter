/**
 * Stipple / Halftone Algorithm — Draws circles whose radius is
 * proportional to the darkness of each sampled pixel.
 *
 * Uses Paper.js Path (circle) objects.
 */
import paper from 'paper';

/**
 * @param {paper.Project} project
 * @param {ImageData} imageData  — grayscale pixel data
 * @param {number} density       — line density slider (20–200)
 */
export function generateStipple(project, imageData, density) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  const spacing = Math.max(2, Math.floor(12 / (density / 80)));
  const maxR = Math.max(0.5, density / 40);

  for (let y = 0; y < h; y += spacing) {
    for (let x = 0; x < w; x += spacing) {
      const idx = (y * w + x) * 4;
      const bright = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      const darkness = 1 - bright / 255;
      if (darkness > 0.05) {
        const r = Math.max(0.3, maxR * darkness);
        const circle = new paper.Path.Circle({
          center: new paper.Point(x, y),
          radius: r,
          strokeColor: new paper.Color('black'),
          strokeWidth: 1,
        });
        layer.addChild(circle);
      }
    }
  }
}
