/**
 * Original procedural pi and ring-badge artwork, authored from rounded strokes.
 * Mechanism inspired by Codex 0.160's described extruded-SDF / lit-3D / Braille
 * pipeline. No artwork, stencil, or implementation was copied or ported.
 *
 * Coordinates use y-up. A terminal cell is approximately twice as tall as wide,
 * so its 2x4 Braille dots have approximately equal physical spacing. Projection
 * therefore uses the same scale on both dot axes, not a horizontal resize.
 */
export const WATERMARK_REPLAY_MS = 7200;
export type WatermarkPainter = (text: string, shade: number) => string;

const MAX_WIDTH = 60;
const MAX_HEIGHT = 24;
const GRID = 129;
const EXTENT = 1.25;
const STEP = (EXTENT * 2) / (GRID - 1);
const HALF_DEPTH = 0.16;
const BEVEL = 0.065;
const SIDE_LAYERS = 11;
const MAX_SURFACE_POINTS = 65536;
const SHADE_LEVELS = 7;
const CAMERA_DISTANCE = 4.5;
const BRAILLE_BITS = [1, 2, 4, 64, 8, 16, 32, 128];

function stroke(x: number, y: number, ax: number, ay: number, bx: number, by: number, radius: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - t * dx, y - ay - t * dy) - radius;
}

function piDistance(x: number, y: number): number {
  // Wide rounded slab, two upright legs, and independently drawn outward feet.
  const qx = Math.abs(x) - (0.98 - 0.055);
  const qy = Math.abs(y - 0.67) - (0.13 - 0.055);
  const cap = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.055;
  return Math.min(
    cap,
    stroke(x, y, -0.52, 0.60, -0.55, -0.57, 0.11),
    stroke(x, y, 0.48, 0.60, 0.50, -0.57, 0.11),
    stroke(x, y, -0.55, -0.57, -0.75, -0.70, 0.11),
    stroke(x, y, 0.50, -0.57, 0.73, -0.70, 0.11),
  );
}

function badgeDistance(x: number, y: number): number {
  return Math.min(Math.abs(Math.hypot(x, y) - 1.005) - 0.075, piDistance(x / 0.62, y / 0.62) * 0.62);
}

function smoothstep(t: number): number {
  const u = Math.max(0, Math.min(1, t));
  return u * u * (3 - 2 * u);
}

/**
 * Pure per-instance renderer. paint must preserve text's visible cells (e.g. add
 * ANSI style only); spaces are never passed to paint. Shade is quantized 0..1.
 * Idle opacity and replay brightness/fade belong to the caller, not this module.
 * No timers, IO, Pi imports, external dependencies, or shared mutable caches.
 */
export function createWatermarkRenderer(): {
  render(width: number, height: number, elapsedMs: number | null, paint: WatermarkPainter): string[];
} {
  // Cache both analytic signed-distance fields and gradients once. Morphing is
  // their interpolated level set, not cross-fading two unrelated frame images.
  const sampleCount = GRID * GRID;
  const piField = new Float32Array(sampleCount);
  const badgeField = new Float32Array(sampleCount);
  const piDx = new Float32Array(sampleCount);
  const piDy = new Float32Array(sampleCount);
  const badgeDx = new Float32Array(sampleCount);
  const badgeDy = new Float32Array(sampleCount);
  const epsilon = STEP / 4;
  for (let iy = 0; iy < GRID; iy++) {
    const y = -EXTENT + iy * STEP;
    for (let ix = 0; ix < GRID; ix++) {
      const x = -EXTENT + ix * STEP;
      const i = iy * GRID + ix;
      piField[i] = piDistance(x, y);
      badgeField[i] = badgeDistance(x, y);
      piDx[i] = (piDistance(x + epsilon, y) - piDistance(x - epsilon, y)) / (2 * epsilon);
      piDy[i] = (piDistance(x, y + epsilon) - piDistance(x, y - epsilon)) / (2 * epsilon);
      badgeDx[i] = (badgeDistance(x + epsilon, y) - badgeDistance(x - epsilon, y)) / (2 * epsilon);
      badgeDy[i] = (badgeDistance(x, y + epsilon) - badgeDistance(x, y - epsilon)) / (2 * epsilon);
    }
  }

  // Interleaved xyz + normal xyz. The scratch surface and all raster buffers are
  // reused. The fixed point cap also bounds work for pathological morph fields.
  const scratch = new Float32Array(MAX_SURFACE_POINTS * 6);
  function buildSurface(morph: number): number {
    const inverseMorph = 1 - morph;
    let count = 0;
    function append(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
      if (count >= MAX_SURFACE_POINTS) return;
      const i = count++ * 6;
      scratch[i] = x;
      scratch[i + 1] = y;
      scratch[i + 2] = z;
      scratch[i + 3] = nx;
      scratch[i + 4] = ny;
      scratch[i + 5] = nz;
    }
    for (let iy = 0; iy < GRID; iy++) {
      const y = -EXTENT + iy * STEP;
      for (let ix = 0; ix < GRID; ix++) {
        const x = -EXTENT + ix * STEP;
        const i = iy * GRID + ix;
        const distance = piField[i] * inverseMorph + badgeField[i] * morph;
        if (distance > STEP * 0.7) continue;
        const gx = piDx[i] * inverseMorph + badgeDx[i] * morph;
        const gy = piDy[i] * inverseMorph + badgeDy[i] * morph;
        const gradientLength = Math.hypot(gx, gy);
        const nx = gradientLength > 1e-5 ? gx / gradientLength : 0;
        const ny = gradientLength > 1e-5 ? gy / gradientLength : 0;
        if (distance <= 0) {
          // Round the front/back rim into the extrusion's side wall. Flat face
          // samples have axial normals; bevels and walls have real 3D normals.
          const rim = Math.max(0, Math.min(BEVEL, distance + BEVEL));
          const arc = Math.sqrt(Math.max(0, BEVEL * BEVEL - rim * rim));
          const z = HALF_DEPTH - BEVEL + arc;
          const normalZ = arc / BEVEL;
          append(x, y, z, nx * rim / BEVEL, ny * rim / BEVEL, normalZ);
          append(x, y, -z, nx * rim / BEVEL, ny * rim / BEVEL, -normalZ);
        }
        if (Math.abs(distance) <= STEP * 0.7 && gradientLength > 1e-5) {
          // One Newton step projects neighboring field samples onto the contour.
          // Explicit side layers preserve thickness when the face turns edge-on.
          // Blended gradients can nearly cancel. Bound the projection step so
          // points remain near the finite grid and never approach the camera.
          const correction = Math.max(-2 * STEP, Math.min(2 * STEP, distance / gradientLength));
          const edgeX = x - nx * correction;
          const edgeY = y - ny * correction;
          for (let layer = 0; layer < SIDE_LAYERS; layer++) {
            const z = (HALF_DEPTH - BEVEL) * (2 * layer / (SIDE_LAYERS - 1) - 1);
            append(edgeX, edgeY, z, nx, ny, 0);
          }
        }
      }
    }
    return count;
  }
  const piCount = buildSurface(0);
  const piSurface = scratch.slice(0, piCount * 6);
  const badgeCount = buildSurface(1);
  const badgeSurface = scratch.slice(0, badgeCount * 6);
  let cachedMorph = -1;
  let cachedCount = 0;
  const depth = new Float32Array(MAX_WIDTH * 2 * MAX_HEIGHT * 4);
  const dotShade = new Uint8Array(depth.length);
  const cellMask = new Uint8Array(MAX_WIDTH * MAX_HEIGHT);
  const cellShade = new Uint8Array(cellMask.length);

  return {
    render(width, height, elapsedMs, paint) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return [];
      const columns = Math.min(MAX_WIDTH, Math.floor(width));
      const rows = Math.min(MAX_HEIGHT, Math.floor(height));
      const dotWidth = columns * 2;
      const dotHeight = rows * 4;
      const dotCount = dotWidth * dotHeight;
      depth.fill(-Infinity, 0, dotCount);

      const elapsed = elapsedMs !== null && Number.isFinite(elapsedMs)
        ? Math.max(0, Math.min(WATERMARK_REPLAY_MS, elapsedMs)) : 0;
      let morph = 0;
      let yaw = 0;
      let pitch = 0;
      let roll = 0;
      if (elapsed > 0 && elapsed < WATERMARK_REPLAY_MS) {
        const returning = elapsed >= WATERMARK_REPLAY_MS / 2;
        const phase = (elapsed % (WATERMARK_REPLAY_MS / 2)) / (WATERMARK_REPLAY_MS / 2);
        // Settle exactly before each endpoint: sin(2π) rounding otherwise
        // exposes edge-on side samples for a one-frame silhouette pop.
        const turn = smoothstep(phase / 0.88);
        yaw = turn === 1 ? 0 : 2 * Math.PI * turn;
        const transition = smoothstep((phase - 0.15) / 0.70);
        morph = returning ? 1 - transition : transition;
        const envelope = turn === 1 ? 0 : Math.sin(Math.PI * turn);
        pitch = 0.12 * envelope * Math.sin(yaw);
        roll = 0.035 * envelope * Math.sin(2 * Math.PI * turn);
      }
      let surface: Float32Array;
      let pointCount: number;
      if (morph === 0) {
        surface = piSurface;
        pointCount = piCount;
      } else if (morph === 1) {
        surface = badgeSurface;
        pointCount = badgeCount;
      } else {
        if (morph !== cachedMorph) {
          cachedCount = buildSurface(morph);
          cachedMorph = morph;
        }
        surface = scratch;
        pointCount = cachedCount;
      }

      // Rotation matrix Rz(roll) * Rx(pitch) * Ry(yaw); apply equally to positions
      // and normals. All trigonometry is per-frame, never per-dot or per-cell.
      const cy = Math.cos(yaw), sy = Math.sin(yaw);
      const cp = Math.cos(pitch), sp = Math.sin(pitch);
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const m00 = cr * cy - sr * sp * sy, m01 = -sr * cp, m02 = cr * sy + sr * sp * cy;
      const m10 = sr * cy + cr * sp * sy, m11 = cr * cp, m12 = sr * sy - cr * sp * cy;
      const m20 = -cp * sy, m21 = sp, m22 = cp * cy;
      const scale = Math.min(dotWidth, dotHeight) / 2.55;
      const centerX = (dotWidth - 1) / 2;
      const centerY = (dotHeight - 1) / 2;
      // Pre-rotate normalized light into model coordinates: Lambert dot products
      // need no per-point normal transform or expensive per-cell color work.
      const lightX = -0.45, lightY = 0.60, lightZ = Math.sqrt(1 - 0.45 ** 2 - 0.60 ** 2);
      const lx = m00 * lightX + m10 * lightY + m20 * lightZ;
      const ly = m01 * lightX + m11 * lightY + m21 * lightZ;
      const lz = m02 * lightX + m12 * lightY + m22 * lightZ;
      for (let point = 0; point < pointCount; point++) {
        const i = point * 6;
        const x = surface[i], y = surface[i + 1], z = surface[i + 2];
        const nx = surface[i + 3], ny = surface[i + 4], nz = surface[i + 5];
        if (m20 * nx + m21 * ny + m22 * nz <= 0) continue;
        const rotatedZ = m20 * x + m21 * y + m22 * z;
        const perspective = CAMERA_DISTANCE / (CAMERA_DISTANCE - rotatedZ);
        const px = Math.round(centerX + (m00 * x + m01 * y + m02 * z) * scale * perspective);
        const py = Math.round(centerY - (m10 * x + m11 * y + m12 * z) * scale * perspective);
        if (px < 0 || px >= dotWidth || py < 0 || py >= dotHeight) continue;
        const index = py * dotWidth + px;
        if (rotatedZ <= depth[index]) continue;
        depth[index] = rotatedZ;
        const diffuse = Math.max(0, Math.min(1, nx * lx + ny * ly + nz * lz));
        dotShade[index] = Math.round((0.20 + 0.80 * diffuse) * SHADE_LEVELS);
      }

      // Standard Unicode Braille layout: left 1/2/3/7, right 4/5/6/8.
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          let mask = 0;
          let shadeSum = 0;
          let occupied = 0;
          for (let dx = 0; dx < 2; dx++) {
            for (let dy = 0; dy < 4; dy++) {
              const index = (row * 4 + dy) * dotWidth + column * 2 + dx;
              if (depth[index] === -Infinity) continue;
              mask |= BRAILLE_BITS[dx * 4 + dy];
              shadeSum += dotShade[index];
              occupied++;
            }
          }
          const cell = row * columns + column;
          cellMask[cell] = mask;
          cellShade[cell] = occupied ? Math.round(shadeSum / occupied) : 0;
        }
      }
      const lines: string[] = [];
      for (let row = 0; row < rows; row++) {
        let line = "";
        let column = 0;
        while (column < columns) {
          const cell = row * columns + column;
          if (cellMask[cell] === 0) {
            line += " ";
            column++;
            continue;
          }
          const shade = cellShade[cell];
          let run = "";
          do {
            run += String.fromCharCode(0x2800 + cellMask[row * columns + column]);
            column++;
          } while (column < columns && cellMask[row * columns + column] !== 0 && cellShade[row * columns + column] === shade);
          line += paint(run, shade / SHADE_LEVELS);
        }
        lines.push(line);
      }
      return lines;
    },
  };
}
