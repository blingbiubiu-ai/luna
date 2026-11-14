// The login page is server-rendered. Keep its decorative canvas independent of
// the dashboard bundle so it can draw before the user authenticates.
export const loginDotMatrixScript = `
(() => {
  const canvas = document.querySelector(".login-dots");
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const color = getComputedStyle(canvas).getPropertyValue("--dots").trim();
  let width = 0, height = 0, pitch = 9, cells = [];
  let frame = 0, previousFrame = 0, elapsed = 0;

  function random(x, y, seed) {
    const mixed = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177);
    const hash = Math.imul(mixed ^ (mixed >>> 13), 2246822519);
    return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
  }

  function cloud(x, y, seed) {
    const col = Math.floor(x), row = Math.floor(y);
    const fx = x - col, fy = y - row;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const top = random(col, row, seed) * (1 - sx) + random(col + 1, row, seed) * sx;
    const bottom = random(col, row + 1, seed) * (1 - sx) + random(col + 1, row + 1, seed) * sx;
    return top * (1 - sy) + bottom * sy;
  }

  function paint(time, reveal) {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = color;
    const size = Math.round(pitch * .62);
    for (const cell of cells) {
      const age = time - cell.revealAt;
      if (reveal && age < 0) continue;
      const drift = cell.col + time * 1.8;
      const density = cloud(drift / 11, cell.row / 11, 3) * .68 +
        cloud(drift / 5, cell.row / 5 - time * .35, 7) * .32;
      const chance = Math.max(0, Math.min(.9, (density - .39) * 2.5));
      const beat = Math.floor(time / cell.period + cell.phase);
      if (random(cell.col + beat * 101, cell.row, 11) > chance + .025) continue;
      const tone = density > .72 && cell.phase > .65 ? .58 : .35;
      ctx.globalAlpha = reveal && age < .26 ? tone + .32 * (1 - age / .26) : tone;
      ctx.fillRect(cell.col * pitch + 1, cell.row * pitch + 1, size, size);
    }
    ctx.globalAlpha = 1;
  }

  function tick(now) {
    if (!previousFrame || now - previousFrame >= 33) {
      if (previousFrame) elapsed += (now - previousFrame) / 1000;
      previousFrame = now;
      paint(elapsed, true);
    }
    frame = requestAnimationFrame(tick);
  }

  function syncMotion() {
    cancelAnimationFrame(frame);
    previousFrame = 0;
    if (motion.matches) paint(4, false);
    else if (!document.hidden) frame = requestAnimationFrame(tick);
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    pitch = Math.max(9, Math.min(14, Math.round(height / 84)));
    const scale = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    cells = [];
    const originY = getComputedStyle(canvas.parentElement).position === "absolute" ? 0 : height;
    const diagonal = Math.hypot(width, height) || 1;
    for (let row = 0; row * pitch < height; row++) {
      for (let col = 0; col * pitch < width; col++) {
        const distance = Math.hypot(width - col * pitch, originY - row * pitch);
        cells.push({
          col, row,
          revealAt: .72 * distance / diagonal + .12 * random(col, row, 5),
          period: 1.2 + 2 * random(col, row, 13),
          phase: random(col, row, 17),
        });
      }
    }
    paint(motion.matches ? 4 : elapsed, !motion.matches);
  }

  new ResizeObserver(resize).observe(canvas);
  document.addEventListener("visibilitychange", syncMotion);
  motion.addEventListener("change", syncMotion);
  resize();
  syncMotion();
})();
`;
