import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';

// ============================================
// ROAD NETWORK
// A geometry-agnostic description of a city: nodes (junctions at arbitrary
// positions) joined by segments (roads with a polyline, lane counts per
// direction, a speed limit, and a class). Derived lanes are directed
// center-lines; per-node turn movements connect an incoming lane to the
// outgoing lanes it may continue onto. This is what a hand-authored city
// produces now and what an OSM importer will produce later.
// ============================================

export const LANE_WIDTH = 3;

// Heading convention matches the grid engine: position advances by
// (sin(h), cos(h)), so heading 0 = +z. "Right of" a travel direction d is
// (d.z, -d.x): for d = +z that's +x. Right-hand traffic offsets each lane
// to the right of its travel direction.
function headingOf(dx, dz) {
    return Math.atan2(dx, dz);
}

let _idCounter = 0;
function uid(prefix) { return `${prefix}${_idCounter++}`; }

// Build a network from a spec:
//   nodes:    [{ id, x, z, control?: 'signal'|'none', sink?: bool }]
//   segments: [{ a, b, lanesAB, lanesBA, speedLimit, class?, points?: [{x,z}] }]
// `points`, if given, is the full polyline from a to b (inclusive); omitted
// means a straight segment between the two node positions.
export function createRoadNetwork(spec) {
    _idCounter = 0;
    const nodes = new Map();
    const segments = [];
    const lanes = [];

    for (const n of spec.nodes) {
        nodes.set(n.id, {
            id: n.id,
            pos: new THREE.Vector3(n.x, 0, n.z),
            control: n.control || 'none',
            sink: !!n.sink,
            incoming: [],   // lanes ending here
            outgoing: [],   // lanes starting here
            segments: []    // segments touching this node
        });
    }

    for (const s of spec.segments) {
        const a = nodes.get(s.a);
        const b = nodes.get(s.b);
        const pts = (s.points && s.points.length >= 2)
            ? s.points.map(p => new THREE.Vector3(p.x, 0, p.z))
            : [a.pos.clone(), b.pos.clone()];

        const seg = {
            id: uid('seg'),
            a, b, points: pts,
            lanesAB: s.lanesAB != null ? s.lanesAB : 1,
            lanesBA: s.lanesBA != null ? s.lanesBA : 1,
            speedLimit: s.speedLimit,
            klass: s.class || 'local',
            lanesByDir: { 1: [], '-1': [] },
            length: polylineLength(pts)
        };
        segments.push(seg);
        a.segments.push(seg);
        b.segments.push(seg);

        // Forward (a→b) and backward (b→a) lanes
        buildLanesForDirection(seg, 1, seg.lanesAB, lanes);
        buildLanesForDirection(seg, -1, seg.lanesBA, lanes);
    }

    // Register lane endpoints on their nodes
    for (const lane of lanes) {
        lane.fromNode.outgoing.push(lane);
        lane.toNode.incoming.push(lane);
    }

    // Turn movements: an incoming lane may continue onto any outgoing lane
    // that leaves the node on a different segment (no immediate U-turn).
    for (const lane of lanes) {
        const node = lane.toNode;
        lane.next = node.outgoing.filter(o => o.segment !== lane.segment);
    }

    const sinks = [...nodes.values()].filter(n => n.sink);

    return {
        nodes, segments, lanes, sinks,
        laneById: id => lanes.find(l => l.id === id),
        bounds: computeBounds(nodes)
    };
}

function polylineLength(pts) {
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
    return len;
}

// Offset a directed polyline to the right of travel by `offset`, producing a
// lane center-line. Straight-segment friendly; vertices on a polyline are
// offset along each adjacent edge's right normal (averaged at joints).
function offsetPolyline(points, dir, offset) {
    const ordered = dir === 1 ? points : [...points].reverse();
    const rights = [];
    for (let i = 0; i < ordered.length - 1; i++) {
        const dx = ordered[i + 1].x - ordered[i].x;
        const dz = ordered[i + 1].z - ordered[i].z;
        const len = Math.hypot(dx, dz) || 1;
        rights.push({ x: dz / len, z: -dx / len }); // right of travel
    }
    return ordered.map((p, i) => {
        const r1 = rights[Math.min(i, rights.length - 1)];
        const r0 = rights[Math.max(0, i - 1)];
        const nx = (r0.x + r1.x), nz = (r0.z + r1.z);
        const nl = Math.hypot(nx, nz) || 1;
        return new THREE.Vector3(p.x + (nx / nl) * offset, 0, p.z + (nz / nl) * offset);
    });
}

function buildLanesForDirection(seg, dir, count, lanes) {
    const fromNode = dir === 1 ? seg.a : seg.b;
    const toNode = dir === 1 ? seg.b : seg.a;
    for (let index = 0; index < count; index++) {
        const offset = (index + 0.5) * LANE_WIDTH; // 0 = innermost (near centerline)
        const pts = offsetPolyline(seg.points, dir, offset);
        const lane = {
            id: uid('lane'),
            segment: seg,
            dir, index,
            fromNode, toNode,
            points: pts,
            length: polylineLength(pts),
            speedLimit: seg.speedLimit,
            next: []
        };
        seg.lanesByDir[dir].push(lane);
        lanes.push(lane);
    }
}

// Position + heading at distance `d` along a lane center-line
export function lanePointAt(lane, d) {
    const pts = lane.points;
    let remaining = Math.max(0, Math.min(d, lane.length));
    for (let i = 1; i < pts.length; i++) {
        const segLen = pts[i].distanceTo(pts[i - 1]);
        if (remaining <= segLen || i === pts.length - 1) {
            const t = segLen > 0 ? remaining / segLen : 0;
            const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t;
            const z = pts[i - 1].z + (pts[i].z - pts[i - 1].z) * t;
            const dx = pts[i].x - pts[i - 1].x;
            const dz = pts[i].z - pts[i - 1].z;
            return { x, z, heading: headingOf(dx, dz) };
        }
        remaining -= segLen;
    }
    const p = pts[pts.length - 1];
    return { x: p.x, z: p.z, heading: 0 };
}

function computeBounds(nodes) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const n of nodes.values()) {
        minX = Math.min(minX, n.pos.x); maxX = Math.max(maxX, n.pos.x);
        minZ = Math.min(minZ, n.pos.z); maxZ = Math.max(maxZ, n.pos.z);
    }
    return { minX, maxX, minZ, maxZ };
}

// ============================================
// ROUTING — travel-time shortest paths to each sink, congestion-weighted.
// cost[sinkId] is a Map(nodeId -> cost-to-reach-sink). Edge cost of taking a
// segment from node U toward node V = segment.length / speedLimit, plus a
// congestion penalty for V supplied by the caller.
// ============================================
export function buildNetworkRoutes(network, congestionOf) {
    const routes = new Map();
    const nodeList = [...network.nodes.values()];

    // Adjacency from outgoing lanes: node -> [{ to, time }]
    const adj = new Map();
    for (const node of nodeList) {
        const edges = [];
        for (const lane of node.outgoing) {
            const time = lane.segment.length / Math.max(lane.speedLimit, 0.01);
            edges.push({ to: lane.toNode, time });
        }
        adj.set(node.id, edges);
    }

    for (const sink of network.sinks) {
        const dist = new Map(nodeList.map(n => [n.id, Infinity]));
        const settled = new Set();
        dist.set(sink.id, 0);

        while (settled.size < nodeList.length) {
            let u = null, best = Infinity;
            for (const n of nodeList) {
                if (!settled.has(n.id) && dist.get(n.id) < best) { best = dist.get(n.id); u = n; }
            }
            if (!u) break;
            settled.add(u.id);
            // Relax reverse edges: a predecessor P reaching sink via u costs
            // edge(P->u).time + congestion(u) + dist(u)
            const cong = CONG_WEIGHT * (congestionOf(u.id) || 0);
            for (const node of nodeList) {
                if (settled.has(node.id)) continue;
                const edge = (adj.get(node.id) || []).find(e => e.to === u);
                if (!edge) continue;
                const nd = edge.time + cong + dist.get(u.id);
                if (nd < dist.get(node.id)) dist.set(node.id, nd);
            }
        }
        routes.set(sink.id, dist);
    }
    return routes;
}

const CONG_WEIGHT = 4; // Congestion penalty scale (in travel-time units)
