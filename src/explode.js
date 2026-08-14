import * as THREE from 'three';

/**
 * Splitting a glTF scene into component parts for an exploded view.
 *
 * Two strategies, because Sketchfab exports come in two flavours:
 *
 *  - 'group'      one part per source mesh. Good when the model is already
 *                 split into meshes (e.g. the bicycle: one mesh per material —
 *                 Frame, Chrome, Tire, …). Clean, semantic parts.
 *
 *  - 'component'  split each mesh's geometry into connected components: islands
 *                 of triangles joined through shared vertex positions. Good when
 *                 the model is a single merged mesh (e.g. the bed, whose node is
 *                 literally named "...materialmerger.gles") and also as a full
 *                 teardown of a material-grouped mesh into every physical piece.
 *
 * Everything is baked into the scene's world space up front, so models with a
 * deep node hierarchy and per-node transforms are handled correctly.
 */

// ---- Union-find (disjoint set) ---------------------------------------------

class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(x) {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[x] !== root) {
      const next = this.parent[x];
      this.parent[x] = root;
      x = next;
    }
    return root;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

// ---- Weld map: vertices at the same location share an id --------------------
// Duplicate vertices at seams (needed for split normals / UVs) would otherwise
// break an island into pieces. Welding by quantized position stitches them back.
// `precision` is relative to model scale so it works for a 1-unit bed and a
// 100-unit bicycle alike.

function buildWeldMap(position, precision) {
  const inv = 1 / precision;
  const count = position.count;
  const weldOf = new Int32Array(count);
  const map = new Map();
  let next = 0;
  for (let i = 0; i < count; i++) {
    const x = Math.round(position.getX(i) * inv);
    const y = Math.round(position.getY(i) * inv);
    const z = Math.round(position.getZ(i) * inv);
    const key = x + '|' + y + '|' + z;
    let id = map.get(key);
    if (id === undefined) {
      id = next++;
      map.set(key, id);
    }
    weldOf[i] = id;
  }
  return { weldOf, weldCount: next };
}

// ---- Extract a subset of triangles into a standalone BufferGeometry ---------

function extractGeometry(source, triangleIndices, indexArray) {
  const srcPos = source.getAttribute('position');
  const srcNormal = source.getAttribute('normal');
  const srcUv = source.getAttribute('uv');
  const srcTangent = source.getAttribute('tangent');

  const oldToNew = new Map();
  const newPos = [];
  const newNormal = srcNormal ? [] : null;
  const newUv = srcUv ? [] : null;
  const newTangent = srcTangent ? [] : null;
  const newIndex = [];

  for (const tri of triangleIndices) {
    for (let k = 0; k < 3; k++) {
      const oldIdx = indexArray[tri * 3 + k];
      let mapped = oldToNew.get(oldIdx);
      if (mapped === undefined) {
        mapped = newPos.length / 3;
        oldToNew.set(oldIdx, mapped);
        newPos.push(srcPos.getX(oldIdx), srcPos.getY(oldIdx), srcPos.getZ(oldIdx));
        if (newNormal) newNormal.push(srcNormal.getX(oldIdx), srcNormal.getY(oldIdx), srcNormal.getZ(oldIdx));
        if (newUv) newUv.push(srcUv.getX(oldIdx), srcUv.getY(oldIdx));
        if (newTangent) newTangent.push(srcTangent.getX(oldIdx), srcTangent.getY(oldIdx), srcTangent.getZ(oldIdx), srcTangent.getW(oldIdx));
      }
      newIndex.push(mapped);
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  if (newNormal) geom.setAttribute('normal', new THREE.Float32BufferAttribute(newNormal, 3));
  if (newUv) geom.setAttribute('uv', new THREE.Float32BufferAttribute(newUv, 2));
  if (newTangent) geom.setAttribute('tangent', new THREE.Float32BufferAttribute(newTangent, 4));
  geom.setIndex(newIndex);
  if (!newNormal) geom.computeVertexNormals();
  return geom;
}

// Ensure an index buffer exists (synthesize a trivial one for soup geometry).
function ensureIndexed(geometry) {
  if (geometry.index) return geometry;
  const count = geometry.getAttribute('position').count;
  const idx = new Uint32Array(count);
  for (let i = 0; i < count; i++) idx[i] = i;
  const g = geometry.clone();
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

/**
 * Split one (world-space) geometry into connected-component sub-geometries.
 * Returns [{ geometry, centroid, triangleCount }].
 */
function splitGeometryIntoComponents(geometry, weldPrecision) {
  geometry = ensureIndexed(geometry);
  const position = geometry.getAttribute('position');
  const indexArray = geometry.index.array;
  const triCount = indexArray.length / 3;

  const { weldOf, weldCount } = buildWeldMap(position, weldPrecision);
  const uf = new UnionFind(weldCount);
  for (let t = 0; t < triCount; t++) {
    const a = weldOf[indexArray[t * 3]];
    const b = weldOf[indexArray[t * 3 + 1]];
    const c = weldOf[indexArray[t * 3 + 2]];
    uf.union(a, b);
    uf.union(b, c);
  }

  const buckets = new Map();
  for (let t = 0; t < triCount; t++) {
    const root = uf.find(weldOf[indexArray[t * 3]]);
    let arr = buckets.get(root);
    if (!arr) buckets.set(root, (arr = []));
    arr.push(t);
  }

  const parts = [];
  for (const tris of buckets.values()) {
    const geom = extractGeometry(geometry, tris, indexArray);
    geom.computeBoundingBox();
    const centroid = geom.boundingBox.getCenter(new THREE.Vector3());
    parts.push({ geometry: geom, centroid, triangleCount: tris.length });
  }
  return parts;
}

// A readable categorical palette for tinting parts.
const PALETTE = [
  0xff6b6b, 0x4ecdc4, 0xffd93d, 0x6c5ce7, 0xff9f43,
  0x1dd1a1, 0xee5253, 0x54a0ff, 0xff6b9d, 0x00d2d3,
  0xa29bfe, 0xfd79a8, 0xe17055, 0x00b894, 0xfdcb6e,
];

// Turn "bicycle XXX remapped_43689.Shape_Alum_0" / material "Alum" into "Alum".
function cleanLabel(mesh) {
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  let raw = (mat && mat.name) || mesh.name || 'Part';
  raw = raw.replace(/^.*Shape_/, '').replace(/_0$/, '').replace(/_/g, ' ').trim();
  return raw || 'Part';
}

/**
 * Build an exploded-view group from every mesh under `root`.
 *
 * opts:
 *   mode          'group' | 'component'   (default 'component')
 *   tint          boolean — recolour parts with a categorical palette
 *   minTriangles  drop components smaller than this (component mode only)
 *
 * Returns { group, parts } where each part is
 *   { mesh, direction, restPosition, triangleCount, label }
 * The group has an identity transform (geometry is baked to world space), so
 * `scene.add(group)` places the model exactly where the original sat.
 */
export function buildExplodedView(root, opts = {}) {
  const mode = opts.mode ?? 'component';
  const useTint = opts.tint ?? false;
  const minTriangles = opts.minTriangles ?? 0;

  root.updateWorldMatrix(true, true);

  // Collect meshes + a world-space clone of each geometry.
  const sources = [];
  root.traverse((o) => {
    if (o.isMesh) sources.push(o);
  });

  // Model-wide bounds → a scale-relative weld precision.
  const wholeBox = new THREE.Box3().setFromObject(root);
  const modelSize = wholeBox.getSize(new THREE.Vector3()).length() || 1;
  const weldPrecision = modelSize * 1e-4;

  const group = new THREE.Group();
  group.name = 'ExplodedView';
  const parts = [];

  // First pass: produce raw part descriptors { geometry, centroid, material, label, triangleCount }.
  const raw = [];
  for (const src of sources) {
    const worldGeom = src.geometry.clone();
    worldGeom.applyMatrix4(src.matrixWorld); // bake node transform → world space

    if (mode === 'group') {
      worldGeom.computeBoundingBox();
      const centroid = worldGeom.boundingBox.getCenter(new THREE.Vector3());
      const tris = (worldGeom.index ? worldGeom.index.count : worldGeom.getAttribute('position').count) / 3;
      raw.push({ geometry: worldGeom, centroid, material: src.material, label: cleanLabel(src), triangleCount: tris });
    } else {
      const comps = splitGeometryIntoComponents(worldGeom, weldPrecision);
      const baseLabel = cleanLabel(src);
      const multi = comps.length > 1;
      comps
        .sort((a, b) => b.triangleCount - a.triangleCount)
        .forEach((c, i) => {
          if (c.triangleCount < minTriangles) return;
          raw.push({
            geometry: c.geometry,
            centroid: c.centroid,
            material: src.material,
            label: multi ? `${baseLabel} #${i + 1}` : baseLabel,
            triangleCount: c.triangleCount,
          });
        });
    }
  }

  // Model center = triangle-weighted average of part centroids.
  const center = new THREE.Vector3();
  let totalTris = 0;
  for (const r of raw) {
    center.addScaledVector(r.centroid, r.triangleCount);
    totalTris += r.triangleCount;
  }
  if (totalTris > 0) center.multiplyScalar(1 / totalTris);

  // Largest first for a tidy legend.
  raw.sort((a, b) => b.triangleCount - a.triangleCount);

  raw.forEach((r, i) => {
    // Clone the material per part so highlight/isolate (emissive + opacity)
    // affect only this part. In 'component' mode many parts share one source
    // material object, so without this a single highlight would bleed across
    // every part cut from the same original mesh.
    const material = useTint
      ? new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], metalness: 0.1, roughness: 0.8 })
      : (Array.isArray(r.material) ? r.material.map((m) => m.clone()) : r.material.clone());

    const mesh = new THREE.Mesh(r.geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = 'Part_' + i;
    mesh.userData.partIndex = i;

    const direction = r.centroid.clone().sub(center);
    if (direction.lengthSq() < 1e-10) direction.set(0, 1, 0);
    else direction.normalize();

    group.add(mesh);
    parts.push({
      mesh,
      direction,
      restPosition: new THREE.Vector3(0, 0, 0),
      triangleCount: r.triangleCount,
      label: `${r.label} (${r.triangleCount.toLocaleString()} tris)`,
      name: r.label, // clean name without the tri-count suffix, for matching
    });
  });

  return { group, parts };
}

// ---- Per-part visual state: highlight + isolate ----------------------------

function eachMaterial(mesh, fn) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) fn(m);
}

/** Glow a single part on/off. Remembers each material's original emissive. */
export function setHighlight(part, on, color = 0x4ecdc4) {
  eachMaterial(part.mesh, (m) => {
    if (!m.emissive) return;
    if (on) {
      if (m.userData._origEmissive === undefined) m.userData._origEmissive = m.emissive.getHex();
      m.emissive.setHex(color);
      m.emissiveIntensity = 1.6; // strong glow so it pops on dark materials
    } else {
      m.emissive.setHex(m.userData._origEmissive ?? 0x000000);
      m.emissiveIntensity = 1.0;
    }
  });
}

/** Fade a part back (used to spotlight one part by dimming the rest). */
export function setDimmed(part, on, opacity = 0.07) {
  eachMaterial(part.mesh, (m) => {
    if (on) {
      if (m.userData._origTransparent === undefined) {
        m.userData._origTransparent = m.transparent;
        m.userData._origOpacity = m.opacity;
      }
      m.transparent = true;
      m.opacity = opacity;
      m.depthWrite = false;
    } else {
      m.transparent = m.userData._origTransparent ?? false;
      m.opacity = m.userData._origOpacity ?? 1;
      m.depthWrite = true;
    }
  });
}

/**
 * Spotlight a set of parts (by index) and dim all others. Accepts a single
 * index or an array; pass -1 or [] to clear. Clears any previous spotlight
 * first, so it is safe to call every step.
 *
 * opts.highlight (default true): glow the spotlit parts with an emissive tint.
 * Pass `false` to leave them at their original material so their real texture
 * shows through — the parts still stand out because everything else is dimmed.
 * Explore uses this so a tapped part reads as "fully textured, rest ghosted".
 */
export function isolateParts(parts, indices, opts = {}) {
  const highlight = opts.highlight ?? true;
  const set = new Set((Array.isArray(indices) ? indices : [indices]).filter((i) => i >= 0));
  parts.forEach((p) => { setDimmed(p, false); setHighlight(p, false); });
  if (set.size === 0) return;
  parts.forEach((p, i) => {
    if (set.has(i)) { if (highlight) setHighlight(p, true); }
    else setDimmed(p, true);
  });
}

/** Back-compat single-part spotlight. */
export function isolatePart(parts, index) {
  isolateParts(parts, index);
}

/** Clear all highlight + dim state. */
export function clearPartStates(parts) {
  for (const p of parts) { setDimmed(p, false); setHighlight(p, false); }
}

/** All part indices whose name matches any keyword (case-insensitive). */
export function findParts(parts, keywords) {
  const keys = (Array.isArray(keywords) ? keywords : [keywords]).map((k) => k.toLowerCase());
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const name = (parts[i].name || parts[i].label || '').toLowerCase();
    if (keys.some((k) => name.includes(k))) out.push(i);
  }
  return out;
}

/** First part index whose name matches any keyword (case-insensitive). -1 if none. */
export function findPart(parts, keywords) {
  const all = findParts(parts, keywords);
  return all.length ? all[0] : -1;
}

/**
 * Move one part along its explode direction by `amount` world units.
 * Exposed so an animation can give each part its own amount (a staggered
 * cascade) instead of driving them all as one rigid shell.
 */
export function setPartExplode(part, amount) {
  part.mesh.position.copy(part.restPosition).addScaledVector(part.direction, amount);
}

/**
 * Move every part along its explode direction by `amount` world units.
 * amount = 0 reassembles the model exactly.
 */
export function setExplode(parts, amount) {
  for (const p of parts) setPartExplode(p, amount);
}
