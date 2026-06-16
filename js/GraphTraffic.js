import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { CONFIG } from './Config.js';
import { GameManager } from './GameManager.js';
import { createExhaust } from './ParticleSystem.js';
import { LANE_WIDTH, lanePointAt, buildNetworkRoutes } from './RoadNetwork.js';

// ============================================
// GRAPH TRAFFIC ENGINE
// Drives cars along the lanes of an arbitrary RoadNetwork: speed capped by
// each segment's limit, time-based routing to a destination sink, turns that
// follow the junction geometry at any angle, and the proven car-following /
// stuck-relief behaviors ported from the grid engine but expressed in world
// space so they work on non-grid layouts.
// ============================================

const MAX_VEHICLES = 1200;
const CELL_SIZE = 12;
const AHEAD_RADIUS = 24;
const ROUTE_REFRESH_INTERVAL = 1.5;

// Intelligent Driver Model + reaction-time constants (engine units; "speed" is
// distance per engine-time-step h = delta*60, so positions advance speed*h).
const CAR_LENGTH = 4.2;          // bumper-to-bumper conversion (centre-distance − this = gap)
const EMERGENCY_DECEL = 0.03;    // hard safety brake when the gap collapses

let scene = null;
let network = null;
export let vehicles = [];
let routes = new Map();
let routeTimer = 0;

// ---- instanced car rendering (mirrors the grid engine's approach) ----
let carBodyMesh = null, carDetailMesh = null;
const dummy = new THREE.Object3D();

// Per-type driver parameters. headway/jam/comfortDecel/react drive the IDM
// car-following; aggressive = short headway + quick reaction, cautious = long
// headway + slow reaction. (Engine units; tuned for believable visuals.)
const VEHICLE_TYPES = {
    NORMAL: { max: 1.0, accel: 1.0, headway: 12, jam: 1.6, comfortDecel: 0.010, react: 0.45, colors: [0x4ecdc4, 0x45b7d1, 0xff9f43, 0x54a0ff, 0x5f27cd] },
    AGGRESSIVE: { max: 1.15, accel: 1.4, headway: 8, jam: 1.2, comfortDecel: 0.013, react: 0.30, colors: [0xff0000, 0xff4400, 0x333333] },
    CAUTIOUS: { max: 0.85, accel: 0.8, headway: 18, jam: 2.2, comfortDecel: 0.008, react: 0.65, colors: [0xeeeeee, 0xcccccc, 0xaaddff] }
};

function mergedGeometry(parts) {
    const position = [], normal = [], color = [];
    const c = new THREE.Color(), m = new THREE.Matrix4();
    for (const part of parts) {
        const g = part.geo.toNonIndexed();
        if (part.rotZ) m.makeRotationZ(part.rotZ); else m.identity();
        m.setPosition(part.x || 0, part.y || 0, part.z || 0);
        g.applyMatrix4(m);
        const p = g.attributes.position, n = g.attributes.normal;
        c.setHex(part.color);
        for (let i = 0; i < p.count; i++) {
            position.push(p.getX(i), p.getY(i), p.getZ(i));
            normal.push(n.getX(i), n.getY(i), n.getZ(i));
            color.push(c.r, c.g, c.b);
        }
        g.dispose(); part.geo.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(color, 3));
    return geo;
}

function initCarMeshes() {
    const body = mergedGeometry([
        { geo: new THREE.BoxGeometry(2.2, 1, 4.2), y: 0.7, color: 0xffffff },
        { geo: new THREE.BoxGeometry(1.8, 0.8, 2.2), y: 1.4, z: -0.2, color: 0xffffff }
    ]);
    const details = [
        { geo: new THREE.BoxGeometry(1.6, 0.6, 0.1), y: 1.4, z: 0.91, color: 0x333333 },
        { geo: new THREE.BoxGeometry(1.6, 0.6, 0.1), y: 1.4, z: -1.31, color: 0x333333 },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: -0.7, y: 0.8, z: 2.11, color: 0xffffcc },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: 0.7, y: 0.8, z: 2.11, color: 0xffffcc },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: -0.7, y: 0.8, z: -2.11, color: 0xff4444 },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: 0.7, y: 0.8, z: -2.11, color: 0xff4444 }
    ];
    for (const wx of [-1.1, 1.1]) for (const wz of [-1.2, 1.2]) {
        details.push({ geo: new THREE.CylinderGeometry(0.4, 0.4, 0.4, 8), rotZ: Math.PI / 2, x: wx, y: 0.4, z: wz, color: 0x222222 });
    }
    carBodyMesh = new THREE.InstancedMesh(body, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }), MAX_VEHICLES);
    carDetailMesh = new THREE.InstancedMesh(mergedGeometry(details), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }), MAX_VEHICLES);
    [carBodyMesh, carDetailMesh].forEach(mesh => { mesh.castShadow = true; mesh.frustumCulled = false; mesh.count = 0; scene.add(mesh); });
}

// ---- road + junction + signal rendering ----
const builtMeshes = [];

function buildGround() {
    const b = network.bounds;
    const w = (b.maxX - b.minX) * 2 + 200;
    const d = (b.maxZ - b.minZ) * 2 + 200;
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshStandardMaterial({ color: 0x2d5a27 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.minX + b.maxX) / 2, -0.05, (b.minZ + b.maxZ) / 2);
    ground.receiveShadow = true;
    scene.add(ground);
    builtMeshes.push(ground);
}

// A flat ribbon following a polyline, offset laterally and at height y. Used
// for asphalt, centre lines, and edge lines. Returns a BufferGeometry.
function ribbonGeometry(points, halfWidth, y, lateralOffset = 0) {
    const verts = [], idx = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
        const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
        const nx = -dz / len, nz = dx / len; // right normal
        const cx = points[i].x + nx * lateralOffset, cz = points[i].z + nz * lateralOffset;
        verts.push(cx - nx * halfWidth, y, cz - nz * halfWidth);
        verts.push(cx + nx * halfWidth, y, cz + nz * halfWidth);
    }
    for (let i = 0; i < points.length - 1; i++) {
        const o = i * 2;
        idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return geo;
}

function addRibbon(points, halfWidth, color, y, lateralOffset, basic) {
    const mat = basic
        ? new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
        : new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(ribbonGeometry(points, halfWidth, y, lateralOffset), mat);
    mesh.receiveShadow = !basic;
    scene.add(mesh);
    builtMeshes.push(mesh);
    return mesh;
}

// Collected dash + crosswalk quads, drawn as one instanced mesh (with yaw)
const markQuads = []; // { x, z, sx, sz, yaw, color }

function buildRoadGeometry() {
    for (const seg of network.segments) {
        const halfW = (seg.lanesAB + seg.lanesBA) * LANE_WIDTH / 2;
        const pts = seg.points;

        // Asphalt
        addRibbon(pts, halfW, seg.klass === 'arterial' ? 0x44464c : 0x3c3e44, 0.02, 0, false);
        // Solid white edge lines
        addRibbon(pts, 0.18, 0xf0f0f0, 0.04, halfW - 0.3, true);
        addRibbon(pts, 0.18, 0xf0f0f0, 0.04, -(halfW - 0.3), true);
        // Yellow centre line dividing the two travel directions
        addRibbon(pts, 0.22, 0xffcc00, 0.04, 0, true);
        // Dashed white dividers between same-direction lanes (2+ lanes/dir)
        if (seg.lanesAB >= 2) addLaneDashes(pts, LANE_WIDTH);
        if (seg.lanesBA >= 2) addLaneDashes(pts, -LANE_WIDTH);
    }

    // Junction pads cover the box up to the stop lines (node.radius)
    for (const node of network.nodes.values()) {
        const r = node.radius + 1;
        const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 24), new THREE.MeshStandardMaterial({ color: 0x3a3c42 }));
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(node.pos.x, 0.03, node.pos.z);
        pad.receiveShadow = true;
        scene.add(pad);
        builtMeshes.push(pad);
        if (node.control === 'signal') addCrosswalks(node, node.radius);
    }

    buildMarkInstances();
}

// Dashed lane divider along a polyline, offset to one side of centre
function addLaneDashes(points, lateralOffset) {
    const dashLen = 3, gap = 3;
    for (let i = 0; i < points.length - 1; i++) {
        const ax = points[i].x, az = points[i].z, bx = points[i + 1].x, bz = points[i + 1].z;
        const dx = bx - ax, dz = bz - az, segLen = Math.hypot(dx, dz) || 1;
        const ux = dx / segLen, uz = dz / segLen;        // along
        const nx = -dz / segLen, nz = dx / segLen;       // right normal (right-hand)
        const yaw = Math.atan2(ux, uz);
        // Stay clear of the junctions at each end
        for (let d = 6; d < segLen - 6; d += dashLen + gap) {
            const cx = ax + ux * (d + dashLen / 2) + nx * lateralOffset;
            const cz = az + uz * (d + dashLen / 2) + nz * lateralOffset;
            markQuads.push({ x: cx, z: cz, sx: 0.2, sz: dashLen, yaw, color: 0xf0f0f0 });
        }
    }
}

// Crosswalk stripes across each approach at a signalized node
function addCrosswalks(node, halfW) {
    for (const seg of node.segments) {
        // Direction from the node out along this segment
        const other = seg.a === node ? seg.points[1] : seg.points[seg.points.length - 2];
        const dx = other.x - node.pos.x, dz = other.z - node.pos.z, len = Math.hypot(dx, dz) || 1;
        const ux = dx / len, uz = dz / len, nx = -dz / len, nz = dx / len;
        const yaw = Math.atan2(ux, uz);
        const w = (seg.lanesAB + seg.lanesBA) * LANE_WIDTH / 2;
        const base = halfW + 1.5; // just outside the junction pad
        const stripes = Math.max(3, Math.round(w / 1.2));
        for (let s = 0; s < stripes; s++) {
            const off = (s / (stripes - 1) - 0.5) * (w * 1.6);
            markQuads.push({
                x: node.pos.x + ux * base + nx * off,
                z: node.pos.z + uz * base + nz * off,
                sx: 0.5, sz: 2.4, yaw, color: 0xffffff
            });
        }
    }
}

function buildMarkInstances() {
    if (markQuads.length === 0) return;
    const mesh = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ vertexColors: false, color: 0xffffff }),
        markQuads.length
    );
    const d = new THREE.Object3D();
    const col = new THREE.Color();
    const flat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const up = new THREE.Vector3(0, 1, 0);
    const yawQ = new THREE.Quaternion();
    markQuads.forEach((m, i) => {
        d.position.set(m.x, 0.038, m.z);
        // Lay flat (normal +Y), then yaw about world up so local X = across
        // the road, local Y = along the road
        yawQ.setFromAxisAngle(up, m.yaw);
        d.quaternion.copy(yawQ).multiply(flat);
        d.scale.set(m.sx, m.sz, 1);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
        mesh.setColorAt(i, col.setHex(m.color));
    });
    mesh.frustumCulled = false;
    scene.add(mesh);
    builtMeshes.push(mesh);
    markQuads.length = 0;
}

// ---- signals: cluster each signalized node's approaches into 2 phase groups ----
const signalNodes = [];

function initSignals() {
    for (const node of network.nodes.values()) {
        if (node.control !== 'signal' || node.incoming.length === 0) continue;
        const ref = approachHeading(node.incoming[0]);
        for (const lane of node.incoming) {
            const h = approachHeading(lane);
            const aligned = Math.abs(Math.cos(h - ref)) > 0.5; // parallel/antiparallel
            lane.phaseGroup = aligned ? 0 : 1;
        }
        const cycle = { nsGreen: 6, ewGreen: 6, yellow: 2, allRed: 1 };
        const sig = { node, t: Math.random() * 20, group0State: 'green', group1State: 'red', timings: cycle, indicators: [] };
        // simple visual: a colored marker per approach, at the stop line
        for (const lane of node.incoming) {
            const end = lanePointAt(lane, lane.length - Math.min(lane.toNode.radius, lane.length * 0.4));
            const marker = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
            marker.position.set(end.x, 3, end.z);
            scene.add(marker);
            builtMeshes.push(marker);
            sig.indicators.push({ lane, marker });
        }
        signalNodes.push(sig);
    }
}

function approachHeading(lane) {
    const a = lanePointAt(lane, Math.max(0, lane.length - 2));
    const b = lanePointAt(lane, lane.length);
    return Math.atan2(b.x - a.x, b.z - a.z);
}

function laneSignalState(lane) {
    const node = lane.toNode;
    if (node.control !== 'signal') return 'green';
    const sig = signalNodes.find(s => s.node === node);
    if (!sig) return 'green';
    return lane.phaseGroup === 0 ? sig.group0State : sig.group1State;
}

export function updateSignals(delta) {
    for (const sig of signalNodes) {
        const t = sig.timings;
        const cycle = t.nsGreen + t.ewGreen + (t.yellow + t.allRed) * 2;
        sig.t = (sig.t + delta) % cycle;
        const ct = sig.t;
        let g0 = 'red', g1 = 'red';
        if (ct < t.nsGreen) g0 = 'green';
        else if (ct < t.nsGreen + t.yellow) g0 = 'yellow';
        else if (ct >= t.nsGreen + t.yellow + t.allRed) {
            if (ct < t.nsGreen + t.yellow + t.allRed + t.ewGreen) g1 = 'green';
            else if (ct < cycle - t.allRed) g1 = 'yellow';
        }
        sig.group0State = g0; sig.group1State = g1;
        const colorOf = s => s === 'green' ? 0x00ff00 : s === 'yellow' ? 0xffff00 : 0xff0000;
        for (const ind of sig.indicators) {
            ind.marker.material.color.setHex(colorOf(ind.lane.phaseGroup === 0 ? g0 : g1));
        }
    }
}

// ---- lifecycle ----
export function initGraphTraffic(sceneInstance, net) {
    scene = sceneInstance;
    network = net;
    vehicles = [];
    signalNodes.length = 0;
    initCarMeshes();
    buildGround();
    buildRoadGeometry();
    initSignals();
}

export function disposeGraphTraffic() {
    if (!scene) return;
    for (const v of vehicles) { /* instanced, nothing per-car */ }
    for (const m of builtMeshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    builtMeshes.length = 0;
    [carBodyMesh, carDetailMesh].forEach(m => { if (m) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); } });
    carBodyMesh = carDetailMesh = null;
    vehicles = [];
    signalNodes.length = 0;
}

// ---- spatial hash ----
const grid = new Map();
function key(x, z) { return (Math.floor(x / CELL_SIZE) + 512) * 1024 + (Math.floor(z / CELL_SIZE) + 512); }
function buildGrid() {
    grid.clear();
    for (const v of vehicles) {
        if (v.waitingToEnter) continue;
        const k = key(v.position.x, v.position.z);
        let cell = grid.get(k); if (!cell) { cell = []; grid.set(k, cell); }
        cell.push(v);
    }
}
function laneClear(x, z, fx, fz, ahead, behind, lat = 2.4, exclude = null) {
    const r = Math.max(ahead, behind) + lat;
    const minCX = Math.floor((x - r) / CELL_SIZE), maxCX = Math.floor((x + r) / CELL_SIZE);
    const minCZ = Math.floor((z - r) / CELL_SIZE), maxCZ = Math.floor((z + r) / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx++) for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = grid.get((cx + 512) * 1024 + (cz + 512)); if (!cell) continue;
        for (const o of cell) {
            if (o === exclude) continue;
            const dx = o.position.x - x, dz = o.position.z - z;
            const along = fx * dx + fz * dz, latd = Math.abs(-fz * dx + fx * dz);
            if (latd < lat && along > -behind && along < ahead) return false;
        }
    }
    return true;
}

const aheadResult = { dist: Infinity, stopped: false, speed: 0 };
function checkAhead(v, desperate) {
    const px = v.position.x, pz = v.position.z, fx = v.dirX, fz = v.dirZ;
    let closest = Infinity, closeStopped = false, closeSpeed = 0;
    const r = AHEAD_RADIUS, rSq = r * r;
    const minCX = Math.floor((px - r) / CELL_SIZE), maxCX = Math.floor((px + r) / CELL_SIZE);
    const minCZ = Math.floor((pz - r) / CELL_SIZE), maxCZ = Math.floor((pz + r) / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx++) for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = grid.get((cx + 512) * 1024 + (cz + 512)); if (!cell) continue;
        for (const o of cell) {
            if (o === v) continue;
            const dx = o.position.x - px, dz = o.position.z - pz, dSq = dx * dx + dz * dz;
            if (dSq >= rSq || dSq >= closest) continue;
            if (fx * dx + fz * dz <= 0) continue; // behind
            // Wedged cars push through anything not travelling roughly with them,
            // so knots always dissolve (one-sided, so no new deadlock)
            if (desperate && (fx * o.dirX + fz * o.dirZ) < 0.7) continue;
            const lat = Math.abs(-fz * dx + fx * dz);
            const limit = o.turning ? LANE_WIDTH * 1.4 : LANE_WIDTH * 0.7;
            if (lat < limit) {
                closest = dSq; closeStopped = o.stopped;
                // Only the along-track component closes the gap (for Δv)
                closeSpeed = o.speed * (fx * o.dirX + fz * o.dirZ);
            }
        }
    }
    aheadResult.dist = closest === Infinity ? Infinity : Math.sqrt(closest);
    aheadResult.stopped = closeStopped;
    aheadResult.speed = closest === Infinity ? 0 : Math.max(0, closeSpeed);
    return aheadResult;
}

// Should we hold at the line rather than enter the junction? Only when a
// STOPPED car sits in the landing zone — entering then would wedge us in the
// box. Moving traffic ahead is fine; car-following handles the catch-up.
function landingClear(lane, self) {
    const p = lanePointAt(lane, entryDist(lane)); // the far box edge we'd land on
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    const ahead = 11, lat = 2.4, r = ahead + lat;
    const minCX = Math.floor((p.x - r) / CELL_SIZE), maxCX = Math.floor((p.x + r) / CELL_SIZE);
    const minCZ = Math.floor((p.z - r) / CELL_SIZE), maxCZ = Math.floor((p.z + r) / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx++) for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = grid.get((cx + 512) * 1024 + (cz + 512)); if (!cell) continue;
        for (const o of cell) {
            if (o === self || !o.stopped) continue;
            const dx = o.position.x - p.x, dz = o.position.z - p.z;
            const along = fx * dx + fz * dz, latd = Math.abs(-fz * dx + fx * dz);
            if (latd < lat && along > -2 && along < ahead) return false;
        }
    }
    return true;
}

// ---- vehicle creation / routing ----
function pickType() {
    const r = Math.random();
    return r < 0.2 ? VEHICLE_TYPES.AGGRESSIVE : r > 0.8 ? VEHICLE_TYPES.CAUTIOUS : VEHICLE_TYPES.NORMAL;
}
function randomSink() { return network.sinks[Math.floor(Math.random() * network.sinks.length)]; }

function makeVehicle(type) {
    return {
        position: new THREE.Vector3(), rotationY: 0, dirX: 0, dirZ: 1,
        speed: 0,
        maxSpeed: CONFIG.VEHICLE.MAX_SPEED * 2 * type.max, // road limit usually governs
        accelMax: CONFIG.VEHICLE.ACCELERATION * type.accel, // IDM max acceleration
        comfortDecel: type.comfortDecel,                    // IDM comfortable braking
        timeHeadway: type.headway,                          // IDM desired time gap
        jamGap: type.jam,                                   // IDM standstill bumper gap
        reactionTime: type.react,                           // sim-seconds between decisions
        reactTimer: Math.random() * type.react,             // staggered so cars don't sync
        accelCmd: 0,                                         // last decided acceleration
        lane: null, laneDist: 0, lateral: 0, // lateral = offset while changing lanes
        turning: false, turn: null,
        destSink: null,
        stopped: false, stuckTime: 0, spawnIndex: 0, waitingToEnter: false
    };
}

function placeOnLane(v, lane, dist) {
    v.lane = lane; v.laneDist = dist; v.lateral = 0;
    const p = lanePointAt(lane, dist);
    v.position.set(p.x, 0, p.z);
    v.rotationY = p.heading;
}

export function spawnVehicles(count) {
    count = Math.min(count, MAX_VEHICLES);
    vehicles = [];
    const drivable = network.lanes;
    let attempts = 0, spawned = 0;
    while (spawned < count && attempts < count * 6) {
        attempts++;
        const lane = drivable[Math.floor(Math.random() * drivable.length)];
        if (lane.length < 12) continue;
        const dist = 4 + Math.random() * (lane.length - 8);
        const p = lanePointAt(lane, dist);
        if (!isSpotFree(p.x, p.z)) continue;
        const v = makeVehicle(pickType());
        placeOnLane(v, lane, dist);
        v.destSink = randomSink();
        vehicles.push(v);
        spawned++;
    }
    // queued entrants if the network is full
    while (vehicles.length < count) {
        const v = makeVehicle(pickType());
        v.waitingToEnter = true; v.position.set(0, 0, 100000);
        v.destSink = randomSink();
        vehicles.push(v);
    }
    const color = new THREE.Color();
    vehicles.forEach((v, i) => {
        v.spawnIndex = i;
        const t = typeOf(v);
        color.setHex(t.colors[Math.floor(Math.random() * t.colors.length)]);
        carBodyMesh.setColorAt(i, color);
    });
    if (carBodyMesh.instanceColor) carBodyMesh.instanceColor.needsUpdate = true;
    refreshRoutes();
    routeTimer = 0;
    syncInstances();
}
function typeOf(v) {
    return v.maxSpeed > CONFIG.VEHICLE.MAX_SPEED * 2 ? VEHICLE_TYPES.AGGRESSIVE
        : v.maxSpeed < CONFIG.VEHICLE.MAX_SPEED * 1.8 ? VEHICLE_TYPES.CAUTIOUS : VEHICLE_TYPES.NORMAL;
}
function isSpotFree(x, z) {
    for (const v of vehicles) {
        if (v.waitingToEnter) continue;
        if ((v.position.x - x) ** 2 + (v.position.z - z) ** 2 < 36) return false;
    }
    return true;
}

function nodeCongestion() {
    const map = new Map();
    for (const v of vehicles) {
        if (v.waitingToEnter || !v.stopped || !v.lane) continue;
        const n = v.lane.toNode;
        map.set(n.id, (map.get(n.id) || 0) + 1);
    }
    return map;
}
function refreshRoutes() {
    const cong = nodeCongestion();
    routes = buildNetworkRoutes(network, id => cong.get(id) || 0);
}

// Classify a movement (incoming lane → outgoing lane) by heading change.
function movementType(inLane, outLane) {
    const hIn = approachHeading(inLane);
    const hOut = lanePointAt(outLane, Math.min(3, outLane.length)).heading;
    let d = hOut - hIn;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) < 0.5) return 'straight';
    return d > 0 ? 'left' : 'right';
}

function routeCostOf(v, out, cost) {
    const c = cost ? cost.get(out.toNode.id) : 0;
    if (c == null || !Number.isFinite(c)) return Infinity;
    return out.segment.length / Math.max(out.speedLimit, 0.01) + c;
}

// Lane discipline: left turns only from the innermost lane (index 0), right
// turns only from the curb lane (highest index); straight from any. Single-lane
// roads allow everything. Pick the cheapest route-appropriate movement; fall
// back to the cheapest legal-but-disallowed one only if nothing else (avoids
// freezing), which is rare.
function laneAllows(v, out) {
    const count = v.lane.segment.lanesByDir[v.lane.dir].length;
    const mv = movementType(v.lane, out);
    if (mv === 'straight') return true;
    if (mv === 'left') return v.lane.index === 0;
    return v.lane.index === count - 1; // right
}

function chooseNextLane(v) {
    const cost = routes.get(v.destSink.id);
    let best = null, bestVal = Infinity, fallback = null, fbVal = Infinity;
    for (const out of v.lane.next) {
        const val = routeCostOf(v, out, cost) + Math.random() * 0.5;
        if (!Number.isFinite(val)) continue;
        if (val < fbVal) { fbVal = val; fallback = out; }
        if (laneAllows(v, out) && val < bestVal) { bestVal = val; best = out; }
    }
    return best || fallback || v.lane.next[0] || null;
}

// The lane index the car should be in for its intended route movement:
// inner for a left, curb for a right, current for straight.
function intendedLaneIndex(v) {
    const cost = routes.get(v.destSink.id);
    let best = null, bestVal = Infinity;
    for (const out of v.lane.next) {
        const val = routeCostOf(v, out, cost);
        if (val < bestVal) { bestVal = val; best = out; }
    }
    if (!best) return v.lane.index;
    const mv = movementType(v.lane, best);
    if (mv === 'left') return 0;
    if (mv === 'right') return v.lane.segment.lanesByDir[v.lane.dir].length - 1;
    return v.lane.index;
}

// Move to the adjacent same-direction lane (one step toward newIndex) if the
// target spot is clear, carrying current position as a lateral offset that
// then eases to the new lane centre (smooth, no sideways teleport).
function changeLaneToward(v, newIndex) {
    const lanesArr = v.lane.segment.lanesByDir[v.lane.dir];
    const step = Math.sign(newIndex - v.lane.index);
    if (step === 0) return;
    const ni = v.lane.index + step;
    if (ni < 0 || ni >= lanesArr.length) return;
    const target = lanesArr[ni];
    const td = Math.min(v.laneDist, target.length - 0.1);
    const p = lanePointAt(target, td);
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
    if (!laneClear(p.x, p.z, fx, fz, 8, 6, 2.4, v)) return;
    const nx = -Math.cos(p.heading), nz = Math.sin(p.heading); // right normal
    v.lateral = (v.position.x - p.x) * nx + (v.position.z - p.z) * nz;
    v.lane = target; v.laneDist = td;
}

function tryEnterMap(v) {
    const sinks = [...network.sinks].sort(() => Math.random() - 0.5);
    for (const s of sinks) {
        for (const lane of s.outgoing) {
            const p = lanePointAt(lane, 0);
            const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
            if (!laneClear(p.x, p.z, fx, fz, 8, 2)) continue;
            placeOnLane(v, lane, 0);
            v.destSink = randomSink();
            v.turning = false; v.turn = null; v.stopped = false; v.stuckTime = 0;
            v.speed = Math.min(lane.speedLimit, v.maxSpeed) * 0.4;
            v.waitingToEnter = false;
            const k = key(v.position.x, v.position.z);
            let cell = grid.get(k); if (!cell) { cell = []; grid.set(k, cell); } cell.push(v);
            return true;
        }
    }
    return false;
}

function startTurn(v, nextLane) {
    const p0 = v.position.clone(); p0.y = 0;
    // Cross the whole intersection: land on the far box edge of the next lane
    const entry = entryDist(nextLane);
    const start = lanePointAt(nextLane, entry);
    const p1 = new THREE.Vector3(start.x, 0, start.z);
    const h0 = v.rotationY, h1 = start.heading;

    // Control point = intersection of the entry tangent (through p0 along h0)
    // and the exit tangent (through p1 along h1), so the bezier is tangent to
    // both lanes → a smooth rounded turn. Fall back to the midpoint when the
    // lines are near-parallel (straight) or the solution is degenerate.
    const ex = Math.sin(h0), ez = Math.cos(h0);
    const xx = Math.sin(h1), xz = Math.cos(h1);
    const det = ex * (-xz) - (-xx) * ez; // p0 + a·e = p1 + c·x
    let ctrl;
    if (Math.abs(det) > 0.05) {
        const a = ((p1.x - p0.x) * (-xz) - (-xx) * (p1.z - p0.z)) / det;
        if (a > 0.5 && a < p0.distanceTo(p1) * 2) {
            ctrl = new THREE.Vector3(p0.x + ex * a, 0, p0.z + ez * a);
        }
    }
    if (!ctrl) ctrl = new THREE.Vector3((p0.x + p1.x) / 2, 0, (p0.z + p1.z) / 2);

    v.turning = true;
    v.turn = { p0, p1, ctrl, exitHeading: h1, nextLane, entry, length: p0.distanceTo(ctrl) + ctrl.distanceTo(p1), t: 0 };
}

// Intelligent Driver Model acceleration toward free speed v0, made more
// restrictive by each obstacle in `leaders` ({ gap, speed }). Returns accel
// in engine units (speed change per engine-time-step h).
function idmAccel(v, v0, leaders) {
    const a = v.accelMax;
    const r = v.speed / v0;
    const speedTerm = r * r * r * r; // (v/v0)^4
    let accel = a * (1 - speedTerm); // free road
    const denom = 2 * Math.sqrt(a * v.comfortDecel);
    for (const L of leaders) {
        const s = Math.max(0.3, L.gap);
        const dv = v.speed - L.speed; // closing rate
        const sStar = v.jamGap + Math.max(0, v.speed * v.timeHeadway + (v.speed * dv) / denom);
        const interaction = a * (1 - speedTerm - (sStar / s) * (sStar / s));
        if (interaction < accel) accel = interaction;
    }
    return accel;
}

// Does the car need to stop at the junction line ahead (red/yellow, or a
// blocked landing that would wedge it)? Used to add a virtual stop-line leader.
function needStopAtLine(v, distToEnd, desperate) {
    if (v.turning || !v.lane || desperate) return false;
    const st = laneSignalState(v.lane);
    if (st === 'red' || (st === 'yellow' && distToEnd > 3)) return true;
    if (distToEnd < 15) {
        const node = v.lane.toNode;
        if (node !== v.destSink) {
            const next = chooseNextLane(v);
            if (next && !landingClear(next, v)) return true;
        }
    }
    return false;
}

// Unprotected left turn: yield to oncoming MOVING through-traffic (opposite
// heading) in or approaching the box. Other turners are excluded — opposing
// lefts pass each other without crossing, and excluding them avoids deadlock;
// stopped cars are excluded so we don't wait forever.
function leftTurnYield(v, node) {
    const fx = Math.sin(v.rotationY), fz = Math.cos(v.rotationY);
    const range = node.radius + 18, rSq = range * range;
    const minCX = Math.floor((node.pos.x - range) / CELL_SIZE), maxCX = Math.floor((node.pos.x + range) / CELL_SIZE);
    const minCZ = Math.floor((node.pos.z - range) / CELL_SIZE), maxCZ = Math.floor((node.pos.z + range) / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx++) for (let cz = minCZ; cz <= maxCZ; cz++) {
        const cell = grid.get((cx + 512) * 1024 + (cz + 512)); if (!cell) continue;
        for (const o of cell) {
            if (o === v || o.waitingToEnter || o.turning || o.speed < 0.05) continue;
            if (fx * o.dirX + fz * o.dirZ > -0.5) continue; // must be oncoming (opposite)
            const dx = o.position.x - node.pos.x, dz = o.position.z - node.pos.z;
            if (dx * dx + dz * dz < rSq) return true;
        }
    }
    return false;
}

// Stop-line setback from the node centre (so cars wait at the box edge), and
// the matching entry distance on the lane being entered (the far box edge).
function stopSetback(lane) { return Math.min(lane.toNode.radius, lane.length * 0.4); }
function entryDist(lane) { return Math.min(lane.fromNode.radius, lane.length * 0.4); }

// ---- main update ----
export function updateVehicles(delta) {
    if (!network) return;
    buildGrid();
    routeTimer += delta;
    if (routeTimer >= ROUTE_REFRESH_INTERVAL) { routeTimer = 0; refreshRoutes(); }

    for (const v of vehicles) {
        if (v.waitingToEnter) { tryEnterMap(v); continue; }

        v.dirX = Math.sin(v.rotationY); v.dirZ = Math.cos(v.rotationY);
        const desperate = v.stuckTime > 6; // stuck-relief valve
        const ahead = checkAhead(v, desperate);
        const h = delta * 60; // engine time-step

        const roadLimit = v.lane ? v.lane.speedLimit : v.maxSpeed;
        const v0 = Math.max(0.01, Math.min(v.maxSpeed, roadLimit));

        if (v.speed < 0.02) v.stuckTime += delta; else if (v.speed > 0.05) v.stuckTime = 0;

        // Stop line sits back from the node centre by the junction radius, so a
        // waiting car holds at the box edge and the centre stays clear.
        const setback = (!v.turning && v.lane) ? stopSetback(v.lane) : 0;
        const distToStop = v.lane ? (v.lane.length - setback) - v.laneDist : Infinity;

        // Reaction time: re-decide the IDM acceleration only every τ seconds,
        // holding it in between. This lags both starting and stopping, so cars
        // launch in sequence at greens and brake with a human delay.
        v.reactTimer -= delta;
        if (v.reactTimer <= 0) {
            v.reactTimer += v.reactionTime;
            const leaders = [];
            if (ahead.dist < Infinity) leaders.push({ gap: ahead.dist - CAR_LENGTH, speed: ahead.speed });
            if (needStopAtLine(v, distToStop, desperate)) leaders.push({ gap: Math.max(0.3, distToStop), speed: 0 });
            v.accelCmd = idmAccel(v, v0, leaders);
        }

        // Integrate the decided acceleration
        v.speed = Math.max(0, Math.min(v0, v.speed + v.accelCmd * h));

        // Per-frame safety floor (independent of reaction lag): never let the
        // bumper gap collapse — emergency-brake regardless of the held accel.
        const gap = ahead.dist - CAR_LENGTH;
        if (gap < v.jamGap) {
            v.speed = Math.max(0, v.speed - EMERGENCY_DECEL * h);
            if (gap < 0.5) v.speed = 0;
        }
        v.stopped = v.speed < 0.01;

        let step = v.speed * delta * 60;
        // Never advance into the car ahead, even mid-reaction: cap the move to
        // the available bumper gap (straight travel only; turns are gated by
        // landingClear and their own following check).
        if (!v.turning && ahead.dist < Infinity) {
            step = Math.min(step, Math.max(0, ahead.dist - CAR_LENGTH - 0.3));
        }

        if (v.turning) {
            const tn = v.turn;
            tn.t = Math.min(1, tn.t + step / Math.max(tn.length, 0.01));
            const t = tn.t, mt = 1 - t;
            v.position.set(
                mt * mt * tn.p0.x + 2 * mt * t * tn.ctrl.x + t * t * tn.p1.x, 0,
                mt * mt * tn.p0.z + 2 * mt * t * tn.ctrl.z + t * t * tn.p1.z);
            const dx = mt * (tn.ctrl.x - tn.p0.x) + t * (tn.p1.x - tn.ctrl.x);
            const dz = mt * (tn.ctrl.z - tn.p0.z) + t * (tn.p1.z - tn.ctrl.z);
            v.rotationY = Math.atan2(dx, dz);
            if (tn.t >= 1) { v.turning = false; placeOnLane(v, tn.nextLane, tn.entry); v.turn = null; }
        } else if (v.lane) {
            const stopAt = v.lane.length - setback; // box-edge stop line
            // Get into the correct turn lane as soon as we're on the segment
            // (just clear of the box) — not only in the last stretch.
            if (v.lateral === 0 && distToStop > 10) {
                const want = intendedLaneIndex(v);
                if (want !== v.lane.index) changeLaneToward(v, want);
            }
            if (v.laneDist + step >= stopAt) {
                const node = v.lane.toNode;
                if (node === v.destSink) { arrive(v); continue; }
                const next = chooseNextLane(v);
                if (!next) { arrive(v); continue; } // dead end: treat as arrival
                // Don't enter on red, and not unless there's room to land (so we
                // never wedge mid-turn). Desperate cars push on to break knots.
                const sig = laneSignalState(v.lane);
                let blocked = (sig === 'red' || sig === 'yellow') || !landingClear(next, v);
                // Unprotected left turns yield to oncoming through-traffic
                if (!blocked && movementType(v.lane, next) === 'left' && leftTurnYield(v, node)) blocked = true;
                if (!desperate && blocked) {
                    v.laneDist = stopAt; // hold at the box edge, not the centre
                    const p = lanePointAt(v.lane, v.laneDist);
                    v.position.set(p.x, 0, p.z); v.rotationY = p.heading;
                    v.speed = 0; v.stopped = true;
                } else {
                    startTurn(v, next);
                }
            } else {
                v.laneDist += step;
                const p = lanePointAt(v.lane, v.laneDist);
                // Ease any lane-change lateral offset back to the lane centre
                if (v.lateral !== 0) {
                    const rate = Math.max(0.08, step * 0.5);
                    v.lateral = Math.abs(v.lateral) <= rate ? 0 : v.lateral - Math.sign(v.lateral) * rate;
                }
                const nx = -Math.cos(p.heading), nz = Math.sin(p.heading); // right normal
                v.position.set(p.x + nx * v.lateral, 0, p.z + nz * v.lateral);
                v.rotationY = p.heading;
            }
        }

        if (v.speed > 0.1 && Math.random() < 0.1) createExhaust(v.position, v.rotationY);
    }
    syncInstances();
}

function arrive(v) {
    GameManager.arrivedVehicles++;
    v.waitingToEnter = true;
    v.position.set(0, 0, 100000);
    v.speed = 0; v.stopped = false; v.lane = null; v.turning = false; v.turn = null;
}

function syncInstances() {
    for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        v.dirX = Math.sin(v.rotationY); v.dirZ = Math.cos(v.rotationY);
        dummy.position.set(v.position.x, 0, v.position.z);
        dummy.rotation.set(0, v.rotationY, 0);
        dummy.scale.setScalar(v.waitingToEnter ? 0.0001 : 1);
        dummy.updateMatrix();
        carBodyMesh.setMatrixAt(i, dummy.matrix);
        carDetailMesh.setMatrixAt(i, dummy.matrix);
    }
    carBodyMesh.count = vehicles.length;
    carDetailMesh.count = vehicles.length;
    carBodyMesh.instanceMatrix.needsUpdate = true;
    carDetailMesh.instanceMatrix.needsUpdate = true;
}
