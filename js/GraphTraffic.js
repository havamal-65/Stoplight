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
const MIN_GAP = 4.5;
const ROUTE_REFRESH_INTERVAL = 1.5;

let scene = null;
let network = null;
export let vehicles = [];
let routes = new Map();
let routeTimer = 0;

// ---- instanced car rendering (mirrors the grid engine's approach) ----
let carBodyMesh = null, carDetailMesh = null;
const dummy = new THREE.Object3D();

const VEHICLE_TYPES = {
    NORMAL: { max: 1.0, accel: 1.0, safe: 1.0, colors: [0x4ecdc4, 0x45b7d1, 0xff9f43, 0x54a0ff, 0x5f27cd] },
    AGGRESSIVE: { max: 1.15, accel: 1.4, safe: 0.7, colors: [0xff0000, 0xff4400, 0x333333] },
    CAUTIOUS: { max: 0.85, accel: 0.8, safe: 1.4, colors: [0xeeeeee, 0xcccccc, 0xaaddff] }
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

function buildRoadGeometry() {
    for (const seg of network.segments) {
        const halfW = (seg.lanesAB + seg.lanesBA) * LANE_WIDTH / 2;
        const left = [], right = [];
        const pts = seg.points;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
            const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
            const nx = dz / len, nz = -dx / len; // right normal
            left.push([pts[i].x - nx * halfW, pts[i].z - nz * halfW]);
            right.push([pts[i].x + nx * halfW, pts[i].z + nz * halfW]);
        }
        const verts = [], idx = [];
        for (let i = 0; i < pts.length; i++) {
            verts.push(left[i][0], 0.02, left[i][1]);
            verts.push(right[i][0], 0.02, right[i][1]);
        }
        for (let i = 0; i < pts.length - 1; i++) {
            const o = i * 2;
            idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const color = seg.klass === 'arterial' ? 0x3a3a3a : 0x333333;
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
        mesh.receiveShadow = true;
        scene.add(mesh);
        builtMeshes.push(mesh);
    }
    // Junction pads
    for (const node of network.nodes.values()) {
        const r = Math.max(LANE_WIDTH * 1.5, 6);
        const pad = new THREE.Mesh(new THREE.CircleGeometry(r, 20), new THREE.MeshStandardMaterial({ color: 0x2a2a2a }));
        pad.rotation.x = -Math.PI / 2;
        pad.position.set(node.pos.x, 0.025, node.pos.z);
        pad.receiveShadow = true;
        scene.add(pad);
        builtMeshes.push(pad);
    }
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
        // simple visual: a colored marker per approach
        for (const lane of node.incoming) {
            const end = lanePointAt(lane, lane.length);
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

const aheadResult = { dist: Infinity, stopped: false };
function checkAhead(v, desperate) {
    const px = v.position.x, pz = v.position.z, fx = v.dirX, fz = v.dirZ;
    let closest = Infinity, closeStopped = false;
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
            if (lat < limit) { closest = dSq; closeStopped = o.stopped; }
        }
    }
    aheadResult.dist = closest === Infinity ? Infinity : Math.sqrt(closest);
    aheadResult.stopped = closeStopped;
    return aheadResult;
}

// Should we hold at the line rather than enter the junction? Only when a
// STOPPED car sits in the landing zone — entering then would wedge us in the
// box. Moving traffic ahead is fine; car-following handles the catch-up.
function landingClear(lane, self) {
    const p = lanePointAt(lane, 0);
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
        acceleration: CONFIG.VEHICLE.ACCELERATION * type.accel,
        safeDistance: CONFIG.VEHICLE.SAFE_DISTANCE * type.safe,
        targetSpeed: 0,
        lane: null, laneDist: 0,
        turning: false, turn: null,
        destSink: null,
        stopped: false, stuckTime: 0, spawnIndex: 0, waitingToEnter: false
    };
}

function placeOnLane(v, lane, dist) {
    v.lane = lane; v.laneDist = dist;
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

// Pick the outgoing lane at a junction that minimizes time-to-destination
function chooseNextLane(v) {
    const node = v.lane.toNode;
    const cost = routes.get(v.destSink.id);
    if (!cost) return v.lane.next[0] || null;
    let best = null, bestVal = Infinity;
    for (const out of v.lane.next) {
        const c = cost.get(out.toNode.id);
        if (c == null || !Number.isFinite(c)) continue;
        const edge = out.segment.length / Math.max(out.speedLimit, 0.01);
        const val = edge + c + Math.random() * 0.5;
        if (val < bestVal) { bestVal = val; best = out; }
    }
    return best || v.lane.next[0] || null;
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
    const start = lanePointAt(nextLane, 0);
    const p1 = new THREE.Vector3(start.x, 0, start.z);
    // tangent control point: where the two headings' lines roughly cross
    const h0 = v.rotationY, h1 = start.heading;
    const d = p0.distanceTo(p1);
    const ctrl = new THREE.Vector3(
        p0.x + Math.sin(h0) * d * 0.5,
        0,
        p0.z + Math.cos(h0) * d * 0.5
    );
    v.turning = true;
    v.turn = { p0, p1, ctrl, exitHeading: h1, nextLane, length: p0.distanceTo(ctrl) + ctrl.distanceTo(p1), t: 0 };
}

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
        let shouldStop = false;

        // Signal check on approach to the junction at the end of the lane
        if (!v.turning && v.lane) {
            const distToEnd = v.lane.length - v.laneDist;
            if (distToEnd < CONFIG.VEHICLE.STOP_DISTANCE && !desperate) {
                const st = laneSignalState(v.lane);
                if (st === 'red' || (st === 'yellow' && distToEnd > 3)) shouldStop = true;
            }
        }

        // Car-following speed target
        const roadLimit = v.lane ? v.lane.speedLimit : v.maxSpeed;
        const cruiseSpeed = Math.min(v.maxSpeed, roadLimit);
        if (ahead.dist < MIN_GAP) shouldStop = true;
        else v.targetSpeed = cruiseSpeed * Math.min(1, (ahead.dist - MIN_GAP) / Math.max(v.safeDistance, 0.1));

        if (v.speed < 0.02) v.stuckTime += delta; else if (v.speed > 0.05) v.stuckTime = 0;

        if (shouldStop) { v.speed = Math.max(0, v.speed - CONFIG.VEHICLE.DECELERATION * delta * 60); v.stopped = v.speed < 0.01; }
        else {
            if (v.speed < v.targetSpeed) v.speed = Math.min(v.targetSpeed, v.speed + v.acceleration * delta * 60);
            else v.speed = Math.max(v.targetSpeed, v.speed - CONFIG.VEHICLE.DECELERATION * delta * 60);
            v.stopped = v.speed < 0.01;
        }

        const step = v.speed * delta * 60;

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
            if (tn.t >= 1) { v.turning = false; placeOnLane(v, tn.nextLane, 0); v.turn = null; }
        } else if (v.lane) {
            if (v.laneDist + step >= v.lane.length) {
                const node = v.lane.toNode;
                if (node === v.destSink) { arrive(v); continue; }
                const next = chooseNextLane(v);
                if (!next) { arrive(v); continue; } // dead end: treat as arrival
                // Only enter the junction if there's room to land — otherwise
                // hold at the line so we never wedge mid-turn (desperate cars push on)
                if (!desperate && !landingClear(next, v)) {
                    v.laneDist = v.lane.length;
                    const p = lanePointAt(v.lane, v.laneDist);
                    v.position.set(p.x, 0, p.z); v.rotationY = p.heading;
                    v.speed = 0; v.stopped = true;
                } else {
                    startTurn(v, next);
                }
            } else {
                v.laneDist += step;
                const p = lanePointAt(v.lane, v.laneDist);
                v.position.set(p.x, 0, p.z);
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
