import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTextPlanePoint, resolveTextPlane, withTextPlane } from '../src/text-plane';

const elevation = Math.tan(15 * Math.PI / 180);
function close(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}

/** Independent geometric oracle: rotate a point in 3D, then intersect the ray
 * from the camera with the z=0 image plane. This does not use renderer camera
 * coefficients or its homography implementation. */
function intersectRay(x: number, y: number, yaw: number, perspective: number, referenceWidth: number) {
  const angle = yaw * Math.PI / 180;
  const focalDistance = referenceWidth * (100 + perspective) / (2 * perspective);
  const camera = { x: 0, y: -focalDistance * elevation, z: -focalDistance };
  const point = { x: x * Math.cos(angle), y, z: x * Math.sin(angle) };
  const ray = { x: point.x - camera.x, y: point.y - camera.y, z: point.z - camera.z };
  const distance = -camera.z / ray.z;
  return { x: camera.x + distance * ray.x, y: camera.y + distance * ray.y, scale: distance };
}

test('zero yaw paints directly on the original context without changing its state', () => {
  const original = { globalAlpha: .35 } as CanvasRenderingContext2D;
  let calls = 0;
  withTextPlane(original, 900, 300, {}, context => { calls++; assert.equal(context, original); assert.equal(context.globalAlpha, .35); });
  assert.equal(calls, 1); assert.equal(original.globalAlpha, .35);
  assert.equal(resolveTextPlane(900, 300, {}).perspective, 50);
  for (const perspective of [0, 50, 100, 300]) {
    const projection = resolveTextPlane(600, 80, { planeYaw: 0, planePerspective: perspective });
    for (const [x, y] of [[-300, -40], [0, 0], [300, 40]]) {
      assert.deepEqual(projectTextPlanePoint(x, y, projection), { x, y, scale: 1 });
    }
  }
});

test('projection agrees with an independently intersected 3D camera ray', () => {
  for (const yaw of [-75, -45, -15, 15, 45, 75]) {
    for (const perspective of [1, 25, 50, 100, 200, 300]) {
      for (const [width, height, referenceWidth] of [[600, 80, 600], [20, 40, 20], [240, 60, 900]]) {
        const projection = resolveTextPlane(width, height, { planeYaw: yaw, planePerspective: perspective }, 0, { referenceWidth });
        for (const x of [-width / 2, -width / 4, 0, width / 4, width / 2]) {
          for (const y of [-height / 2, 0, height / 2]) {
            const actual = projectTextPlanePoint(x, y, projection);
            const expected = intersectRay(x, y, yaw, perspective, referenceWidth);
            close(actual.x, expected.x); close(actual.y, expected.y); close(actual.scale, expected.scale);
          }
        }
      }
    }
  }
});

test('changing focal distance preserves center orientation, scale and baseline slope', () => {
  for (const yaw of [-75, -45, -15, 15, 45, 75]) {
    const expectedCosine = Math.cos(yaw * Math.PI / 180);
    const expectedSlope = -elevation * Math.tan(yaw * Math.PI / 180);
    for (const perspective of [0, 25, 50, 100, 200, 300]) {
      const projection = resolveTextPlane(600, 80, { planeYaw: yaw, planePerspective: perspective });
      assert.deepEqual(projectTextPlanePoint(0, 0, projection), { x: 0, y: 0, scale: 1 });
      const epsilon = 1e-3;
      const before = projectTextPlanePoint(-epsilon, 0, projection);
      const after = projectTextPlanePoint(epsilon, 0, projection);
      const down = projectTextPlanePoint(0, epsilon, projection);
      close((after.x - before.x) / (2 * epsilon), expectedCosine, 1e-10);
      close((after.y - before.y) / (2 * epsilon), expectedCosine * expectedSlope, 1e-10);
      close(down.y / epsilon, 1); close(down.x, 0);
      const left = projectTextPlanePoint(-300, 0, projection);
      const right = projectTextPlanePoint(300, 0, projection);
      close((right.y - left.y) / (right.x - left.x), expectedSlope);
    }
  }
});

test('focal strength changes the near and far heights monotonically without clipping ink', () => {
  for (const yaw of [-75, -45, -15, 15, 45, 75]) {
    let previousNearScale = 0; let previousSizeRatio = 0;
    for (const perspective of [0, 25, 50, 100, 150, 200, 250, 300]) {
      const projection = resolveTextPlane(600, 80, { planeYaw: yaw, planePerspective: perspective }, 512);
      const nearX = -Math.sign(yaw) * 300; const farX = -nearX;
      const nearHeight = projectTextPlanePoint(nearX, 40, projection).y - projectTextPlanePoint(nearX, -40, projection).y;
      const farHeight = projectTextPlanePoint(farX, 40, projection).y - projectTextPlanePoint(farX, -40, projection).y;
      const nearScale = nearHeight / 80;
      assert.ok(nearScale > previousNearScale);
      assert.ok(nearHeight / farHeight > previousSizeRatio);
      assert.ok(projection.sourceLeft <= -300 && projection.sourceRight >= 300, 'padding safety cannot remove the actual text body');
      assert.ok(1 + projection.depth * projection.sourceLeft >= .1 - 1e-12);
      assert.ok(1 + projection.depth * projection.sourceRight >= .1 - 1e-12);
      assert.ok(nearScale < 3.64 && farHeight / 80 > .57);
      previousNearScale = nearScale; previousSizeRatio = nearHeight / farHeight;
    }
  }
});

test('different line lengths and font heights receive equal near/far ratios and baseline orientation', () => {
  for (const yaw of [-65, 45]) for (const perspective of [0, 50, 300]) {
    const rows = [[20, 40], [220, 20], [660, 60], [1800, 16]].map(([width, height]) => {
      const projection = resolveTextPlane(width, height, { planeYaw: yaw, planePerspective: perspective });
      const a = projectTextPlanePoint(-width / 2, 0, projection);
      const b = projectTextPlanePoint(width / 2, 0, projection);
      const leftHeight = projectTextPlanePoint(-width / 2, height / 2, projection).y - projectTextPlanePoint(-width / 2, -height / 2, projection).y;
      const rightHeight = projectTextPlanePoint(width / 2, height / 2, projection).y - projectTextPlanePoint(width / 2, -height / 2, projection).y;
      return { slope: (b.y - a.y) / (b.x - a.x), ratio: leftHeight / rightHeight };
    });
    for (const row of rows.slice(1)) { close(row.slope, rows[0].slope); close(row.ratio, rows[0].ratio); }
  }
});

test('orthographic limit retains yaw and view elevation without introducing near/far scaling', () => {
  for (const yaw of [-75, -45, 45, 75]) {
    const projection = resolveTextPlane(600, 80, { planeYaw: yaw, planePerspective: 0 });
    for (const x of [-300, 0, 300]) for (const y of [-40, 0, 40]) {
      const point = projectTextPlanePoint(x, y, projection);
      close(point.x, Math.cos(yaw * Math.PI / 180) * x);
      close(point.y, y - elevation * Math.sin(yaw * Math.PI / 180) * x);
      assert.equal(point.scale, 1);
    }
  }
});

test('opposite yaw mirrors the complete plane and uniform text scaling preserves the camera', () => {
  for (const perspective of [0, 50, 300]) {
    const small = resolveTextPlane(600, 60, { planeYaw: 45, planePerspective: perspective });
    const large = resolveTextPlane(900, 90, { planeYaw: 45, planePerspective: perspective });
    const mirrored = resolveTextPlane(600, 60, { planeYaw: -45, planePerspective: perspective });
    for (const [x, y] of [[-300, -30], [-150, 0], [0, 0], [150, 0], [300, 30]]) {
      const a = projectTextPlanePoint(x, y, small);
      const b = projectTextPlanePoint(x * 1.5, y * 1.5, large);
      const c = projectTextPlanePoint(-x, y, mirrored);
      close(a.x * 1.5, b.x); close(a.y * 1.5, b.y); close(a.scale, b.scale);
      close(-a.x, c.x); close(a.y, c.y); close(a.scale, c.scale);
    }
  }
});

test('effect padding changes source bounds without changing text camera or projected ink', () => {
  const camera = { referenceWidth: 240 };
  const body = resolveTextPlane(240, 60, { planeYaw: 65, planePerspective: 300 }, 0, camera);
  const padded = resolveTextPlane(240, 60, { planeYaw: 65, planePerspective: 300 }, 512, camera);
  assert.equal(body.cosine, padded.cosine); assert.equal(body.depth, padded.depth);
  assert.equal(body.referenceWidth, padded.referenceWidth); assert.equal(body.slope, padded.slope);
  for (const x of [-120, 0, 120]) assert.deepEqual(projectTextPlanePoint(x, 12, body), projectTextPlanePoint(x, 12, padded));
  assert.ok(padded.sourceLeft > -120 - 512, 'only unsafe near-side effect extent is clipped');
  assert.equal(padded.sourceRight, 120 + 512);
  assert.ok(1 + padded.depth * padded.sourceLeft >= .1 - 1e-12);
  assert.equal(resolveTextPlane(240, 60, { planeYaw: 75, planePerspective: 300 }, 0, { referenceWidth: 2 }).referenceWidth, 240,
    'an undersized camera reference must never cut through the text body');
});

test('extreme inputs and one-glyph padded bounds remain finite and fit the output', () => {
  for (const [width, height] of [[20, 40], [20_000, 20_000]]) {
    for (const yaw of [-1000, -75, 0, 75, 1000]) {
      const projection = resolveTextPlane(width, height, { planeYaw: yaw, planePerspective: 1000 }, 1000);
      assert.ok(Math.abs(projection.yaw) <= 75); assert.equal(projection.perspective, 300); assert.equal(projection.padding, 512);
      for (const x of [projection.sourceLeft, projection.sourceRight]) for (const y of [projection.sourceTop, projection.sourceBottom]) {
        const point = projectTextPlanePoint(x, y, projection);
        assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
        assert.ok(point.scale <= 10 + 1e-10 && point.scale > 0);
        assert.ok(point.x >= projection.left - 1e-8 && point.x <= projection.right + 1e-8);
        assert.ok(point.y >= projection.top - 1e-8 && point.y <= projection.bottom + 1e-8);
      }
    }
  }
  assert.equal(resolveTextPlane(900, 300, { planeYaw: NaN, planePerspective: Infinity }, -1).yaw, 0);
  assert.equal(resolveTextPlane(900, 300, { planeYaw: '40', planePerspective: Infinity }, -1).padding, 0);
});

function fakeCanvasContext() {
  const mounted = new Set<unknown>();
  const created: any[] = [];
  const owner: any = { body: { append: (canvas: unknown) => mounted.add(canvas) }, createElement: () => {
    const canvas: any = { width: 1, height: 1, ownerDocument: owner, dataset: {}, style: {},
      setAttribute() {}, remove() { mounted.delete(canvas); } };
    const calls: unknown[][] = []; const states: any[] = [];
    const context: any = { canvas, globalAlpha: 1, font: '400 48px serif', globalCompositeOperation: 'source-over', filter: 'none',
      shadowColor: '#00000000', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
      setTransform() {}, clearRect() {}, setLineDash() {}, getLineDash: () => [],
      save() { states.push({ ...this }); }, restore() { Object.assign(this, states.pop()); },
      drawImage(...args: unknown[]) { calls.push(args); } };
    canvas.getContext = () => context; canvas.context = context; canvas.draws = calls;
    created.push(canvas); return canvas;
  } };
  const canvas = owner.createElement('canvas'); canvas.width = 1920; canvas.height = 1080;
  return { context: canvas.context as CanvasRenderingContext2D, canvas, created, mounted };
}

test('one reusable raster pair projects integer columns and composites opacity only once', () => {
  const fake = fakeCanvasContext(); fake.context.globalAlpha = .4;
  let paintCalls = 0;
  const paint = (context: CanvasRenderingContext2D) => {
    paintCalls++; assert.notEqual(context, fake.context); assert.equal(context.globalAlpha, 1);
    assert.equal(fake.mounted.size, 1); context.globalAlpha *= .25;
  };
  withTextPlane(fake.context, 900, 300, { planeYaw: 45 }, paint, 64);
  assert.equal(paintCalls, 1); assert.equal(fake.context.globalAlpha, .4); assert.equal(fake.mounted.size, 0);
  assert.equal(fake.created.length, 3);
  const output = fake.created[2]; const interior = output.draws.slice(1, -1);
  assert.ok(interior.length > 400);
  for (const call of interior) { assert.ok(Number.isInteger(call[5])); assert.equal(call[7], 1); }
  assert.equal(fake.canvas.draws.length, 1, 'only the complete projected image reaches the transformed destination');
  withTextPlane(fake.context, 900, 300, { planeYaw: -35 }, paint, 64);
  assert.equal(fake.created.length, 3, 'the two canvases are reused for other layers and angles');
  assert.equal(fake.mounted.size, 0); assert.equal(fake.context.globalAlpha, .4);
});

test('column raster uses the projected baseline position instead of an extra strength-dependent tilt', () => {
  const fake = fakeCanvasContext();
  for (const perspective of [0, 50, 300]) {
    const projection = resolveTextPlane(600, 80, { planeYaw: 45, planePerspective: perspective }, 0);
    withTextPlane(fake.context, 600, 80, { planeYaw: 45, planePerspective: perspective }, () => {});
    const output = fake.created[2];
    const rasterLeft = Math.floor(projection.left) - 1; const rasterTop = Math.floor(projection.top) - 1;
    const sourceHeight = fake.created[1].height;
    for (const call of output.draws.slice(1, -1)) {
      const middleX = rasterLeft + Number(call[5]) + Number(call[7]) / 2;
      const bodyScale = 1 - projection.depth * middleX / projection.cosine;
      const rasterBaseline = rasterTop + Number(call[6]) - projection.sourceTop * bodyScale;
      close(rasterBaseline, projection.slope * middleX, 1e-7);
      close(Number(call[8]), sourceHeight * bodyScale, 1e-7);
    }
    output.draws.length = 0;
  }
});

test('large planes bound scratch memory and failed painting removes the temporary font canvas', () => {
  const fake = fakeCanvasContext();
  withTextPlane(fake.context, 20_000, 20_000, { planeYaw: 75, planePerspective: 300 }, () => {}, 512);
  for (const canvas of fake.created.slice(1)) {
    assert.ok(canvas.width <= 4096 && canvas.height <= 4096);
    assert.ok(canvas.width * canvas.height <= 4 * 1024 * 1024);
  }
  const draws = fake.canvas.draws.length;
  assert.throws(() => withTextPlane(fake.context, 900, 300, { planeYaw: 45 }, () => { throw new Error('failed painter'); }), /failed painter/);
  assert.equal(fake.mounted.size, 0); assert.equal(fake.canvas.draws.length, draws);
});

test('asymmetric padded source uses its actual origin and keeps camera raster memory bounded', () => {
  const fake = fakeCanvasContext();
  for (const yaw of [-75, 75]) {
    withTextPlane(fake.context, 20, 40, { planeYaw: yaw, planePerspective: 300 }, () => {}, 512, { referenceWidth: 20 });
    for (const canvas of fake.created.slice(1)) {
      assert.ok(canvas.width <= 4096 && canvas.height <= 4096);
      assert.ok(canvas.width * canvas.height <= 4 * 1024 * 1024);
    }
    for (const call of fake.created[2].draws) {
      for (const coordinate of call.slice(1)) assert.ok(Number.isFinite(coordinate));
      assert.ok(call[1] >= -1e-9 && call[1] + call[3] <= fake.created[1].width + 1e-9,
        'inverse columns address the asymmetric source without assuming its origin is its midpoint');
    }
    fake.created[2].draws.length = 0;
  }
  assert.equal(fake.mounted.size, 0);
});
