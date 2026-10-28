// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Thaqif Syarafuddin bin Roslan. A2B: https://github.com/thaqif0709/a2b (see NOTICE).

// The car on the map as a real 3D model (a chevron or a small car), drawn into the map with three.js through a
// MapLibre custom layer, so it sits on the road in the map's own perspective. three.js is loaded on first use;
// if it can't load or WebGL refuses, start() resolves false and the app keeps its flat arrow.

const THREE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';
const SIZE_PX = { chevron: 44, car: 48 }; // on-screen length, whatever the zoom
export const VEHICLES = [['chevron', 'Chevron'], ['car', 'Car']];
export const DEFAULT_VEHICLE = 'car'; // the car, unless Chevron was picked in Settings (kept on this phone)
// Paint colours to choose from in Settings; the first, a brighter take on the app's plum, is the default.
export const COLORS = [
  ['#e23d9b', 'Plum'], ['#1f7aff', 'Blue'], ['#12c4a6', 'Teal'], ['#ff7a1a', 'Orange'],
  ['#e5383b', 'Red'], ['#f5c400', 'Yellow'], ['#f4f4f6', 'White'], ['#2b2b31', 'Black'],
];
export const DEFAULT_COLOR = COLORS[0][0];

let THREE = null;
let loading = null;

// pose(): { pos: [lng, lat], heading } of the car as drawn this frame, or null to hide it.
export async function start(map, kind, color, pose) {
  try {
    THREE ??= await (loading ??= import(THREE_URL));
  } catch {
    loading = null;
    return false;
  }
  if (map.getLayer('vehicle-3d')) map.removeLayer('vehicle-3d');
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#ffffff', '#6b5a64', 1.6));
  const sun = new THREE.DirectionalLight('#ffffff', 2.2);
  sun.position.set(-0.6, 1.2, -0.4);
  scene.add(sun, kind === 'car' ? car(color) : chevron(color), contactShadow(kind));
  const camera = new THREE.Camera();
  const rotateUp = new THREE.Matrix4().makeRotationX(Math.PI / 2);
  let renderer = null;
  let failed = false;
  map.addLayer({
    id: 'vehicle-3d',
    type: 'custom',
    renderingMode: '3d',
    onAdd(m, gl) {
      try {
        renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
        renderer.autoClear = false;
      } catch {
        failed = true;
      }
    },
    render(gl, matrix) {
      const p = !failed && pose();
      if (!p) return;
      const [lng, lat] = p.pos;
      const merc = window.maplibregl.MercatorCoordinate.fromLngLat({ lng, lat }, 0);
      const metresPerPx = (40075016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** map.getZoom());
      const s = merc.meterInMercatorCoordinateUnits() * metresPerPx * SIZE_PX[kind];
      const model = new THREE.Matrix4()
        .makeTranslation(merc.x, merc.y, merc.z)
        .scale(new THREE.Vector3(s, -s, s))
        .multiply(rotateUp)
        .multiply(new THREE.Matrix4().makeRotationY((-p.heading * Math.PI) / 180));
      camera.projectionMatrix = new THREE.Matrix4().fromArray(matrix).multiply(model);
      renderer.resetState();
      renderer.render(scene, camera);
    },
  });
  return !failed;
}

export function stop(map) {
  if (map.getLayer('vehicle-3d')) map.removeLayer('vehicle-3d');
}

// ---------- Models: 1 unit long, +Y up, nose towards -Z ----------
const material = (color, o = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.1, ...o });

// A flat outline extruded upwards with rounded (bevelled) edges.
function slab(shape, height, bevel) {
  const g = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 4, curveSegments: 16 });
  g.rotateX(-Math.PI / 2); // the outline's +Y points forward (-Z); the extrusion goes up
  return g;
}

// Chevron outline (tip, right wing, notch, left wing) with each corner rounded off by radius r.
function arrowShape(w, l, notch, r) {
  const pts = [[0, l / 2], [w / 2, -l / 2], [0, -l / 2 + notch], [-w / 2, -l / 2]];
  const s = new THREE.Shape();
  pts.forEach((p, i) => {
    const prev = pts[(i + pts.length - 1) % pts.length], next = pts[(i + 1) % pts.length];
    const toward = (q, d) => {
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      return [p[0] + ((q[0] - p[0]) * d) / len, p[1] + ((q[1] - p[1]) * d) / len];
    };
    const [a, b] = [toward(prev, r), toward(next, r)];
    if (i === 0) s.moveTo(...a);
    else s.lineTo(...a);
    s.quadraticCurveTo(p[0], p[1], ...b);
  });
  s.closePath();
  return s;
}

function roundedRect(w, l, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -l / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + l - r);
  s.quadraticCurveTo(x + w, y + l, x + w - r, y + l);
  s.lineTo(x + r, y + l);
  s.quadraticCurveTo(x, y + l, x, y + l - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// A white rim all round the arrow (lit from within so it stays white in shade) keeps it apart from the route.
function chevron(color) {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(slab(arrowShape(1.08, 1.3, 0.4, 0.17), 0.17, 0.03), material('#ffffff', { emissive: '#ffffff', emissiveIntensity: 0.45 }));
  const arrow = new THREE.Mesh(slab(arrowShape(0.68, 0.84, 0.26, 0.09), 0.13, 0.04), material(color, { roughness: 0.35 }));
  arrow.position.set(0, 0.07, -0.03); // sits on top of the rim, so the white shows all round
  g.add(rim, arrow);
  return g;
}

function car(color) {
  const g = new THREE.Group();
  const paint = material(color, { roughness: 0.28, metalness: 0.3 });
  const glass = material('#1c2a38', { roughness: 0.08, metalness: 0.6 });
  const body = new THREE.Mesh(slab(roundedRect(0.44, 0.98, 0.13), 0.12, 0.04), paint);
  body.position.y = 0.07;
  const cabin = new THREE.Mesh(slab(roundedRect(0.36, 0.5, 0.1), 0.1, 0.025), glass);
  cabin.position.set(0, 0.22, 0.04);
  const roof = new THREE.Mesh(slab(roundedRect(0.33, 0.36, 0.08), 0.02, 0.015), paint);
  roof.position.set(0, 0.33, 0.06);
  g.add(body, cabin, roof);
  const wheel = new THREE.CylinderGeometry(0.085, 0.085, 0.06, 20);
  wheel.rotateZ(Math.PI / 2);
  const tyre = material('#18181b', { roughness: 0.9 });
  for (const [x, z] of [[-0.22, -0.3], [0.22, -0.3], [-0.22, 0.3], [0.22, 0.3]]) {
    const w = new THREE.Mesh(wheel, tyre);
    w.position.set(x, 0.085, z);
    g.add(w);
  }
  const lamp = (color, glow, z) => {
    for (const x of [-0.13, 0.13]) {
      const l = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.035, 0.02), material(color, { emissive: glow, emissiveIntensity: 0.7 }));
      l.position.set(x, 0.16, z);
      g.add(l);
    }
  };
  lamp('#fff6c8', '#fff1a8', -0.525); // headlights
  lamp('#ff3b47', '#c4121d', 0.525); // tail lights
  return g;
}

// A soft dark patch under the model, so it looks grounded.
function contactShadow(kind) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const r = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  r.addColorStop(0, 'rgba(0,0,0,0.45)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1.25, kind === 'car' ? 1.5 : 1.25), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.005;
  return m;
}
