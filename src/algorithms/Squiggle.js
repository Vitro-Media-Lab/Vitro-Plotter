import paper from 'paper';

export function generateSquiggle(project, imageData, linesCount = 80) {
  const w = imageData.width;
  const h = imageData.height;
  const data = imageData.data;
  const layer = project.activeLayer;

  // 1. Predictable Density: Calculate step based on how many lines we actually want.
  const step = Math.max(2, Math.floor(h / linesCount));
  
  // 2. Safe Amplitude: Prevent lines from touching.
  const maxAmp = step * 0.45;
  
  // 3. Constant Frequency: Keeps the horizontal wave uniform.
  const baseFreq = 0.2; 

  for (let y = step / 2; y < h; y += step) {
    const path = new paper.Path();
    path.strokeColor = new paper.Color('cyan');
    path.strokeWidth = 1;
    path.fillColor = null;

    let currentAmp = 0; // Tracks the smoothed wave height

    // Step by 2 pixels to keep resolution high but prevent node overload
    for (let x = 0; x < w; x += 2) {
      const idx = (Math.floor(y) * w + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      
      // Calculate brightness (0.0 = black, 1.0 = white)
      const bright = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      
      // Target amplitude based on shadow (darker = bigger wave)
      const targetAmp = (1 - bright) * maxAmp;

      // CRITICAL FIX: Amplitude Easing. 
      // Smoothly transition the wave height so it doesn't violently spike on photo grain.
      currentAmp += (targetAmp - currentAmp) * 0.15; 

      const py = y + Math.sin(x * baseFreq) * currentAmp;
      path.add(new paper.Point(x, py));
    }

    path.smooth({ type: 'continuous' });
    layer.addChild(path);
  }
}