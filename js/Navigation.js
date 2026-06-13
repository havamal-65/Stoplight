import { CONFIG } from './Config.js';

// ============================================
// NAVIGATION
// The street grid is a graph: nodes are intersections (gridI, gridJ),
// edges join adjacent intersections. For each exit we keep a routing
// field — the congestion-weighted shortest-path cost from every node to
// that exit — recomputed periodically so cars steer around jams.
// ============================================

const GS = CONFIG.GRID_SIZE;
const N = GS + 1;
const NODES = N * N;

// How strongly queued cars at an intersection inflate the cost of routing
// through it. 0 = ignore congestion (pure distance); higher = detour more.
const CONG_WEIGHT = 0.7;

function idx(i, j) { return i * N + j; }

// Precomputed 4-neighborhood for every node
const neighbors = [];
for (let i = 0; i <= GS; i++) {
    for (let j = 0; j <= GS; j++) {
        const list = [];
        if (i > 0) list.push(idx(i - 1, j));
        if (i < GS) list.push(idx(i + 1, j));
        if (j > 0) list.push(idx(i, j - 1));
        if (j < GS) list.push(idx(i, j + 1));
        neighbors[idx(i, j)] = list;
    }
}

// dist[exitIdx][nodeIdx] = cost from node to that exit
let dist = CONFIG.EXITS.map(() => new Float32Array(NODES));

export function exitCount() {
    return CONFIG.EXITS.length;
}

// Border node and outward heading for an exit. Heading convention matches
// TrafficSystem: 0 = +z (south), π = -z (north), π/2 = +x (east),
// 3π/2 = -x (west); gridI grows east, gridJ grows south.
export function exitTarget(exitIdx) {
    const e = CONFIG.EXITS[exitIdx];
    switch (e.side) {
        case 'north': return { i: e.index, j: 0, outHeading: Math.PI };
        case 'south': return { i: e.index, j: GS, outHeading: 0 };
        case 'east': return { i: GS, j: e.index, outHeading: Math.PI / 2 };
        case 'west': return { i: 0, j: e.index, outHeading: Math.PI * 1.5 };
    }
}

// Recompute every exit's routing field. `queueOf(nodeIdx)` supplies the
// current congestion (stopped cars) at each intersection. Dijkstra over
// 36 nodes x a handful of exits — a few microseconds.
export function buildRoutes(queueOf) {
    // enter[n] = cost to move INTO node n (1 block + congestion there)
    const enter = new Float32Array(NODES);
    for (let n = 0; n < NODES; n++) enter[n] = 1 + CONG_WEIGHT * (queueOf(n) || 0);

    for (let e = 0; e < CONFIG.EXITS.length; e++) {
        const t = exitTarget(e);
        const dest = idx(t.i, t.j);
        const d = dist[e];
        d.fill(Infinity);
        const settled = new Uint8Array(NODES);
        d[dest] = 0;

        for (let iter = 0; iter < NODES; iter++) {
            // Settle the nearest unsettled node (tiny graph, linear scan)
            let u = -1, best = Infinity;
            for (let n = 0; n < NODES; n++) {
                if (!settled[n] && d[n] < best) { best = d[n]; u = n; }
            }
            if (u === -1) break;
            settled[u] = 1;
            // Reaching dest from a neighbor v via u costs enter(u) + d[u]
            const step = enter[u] + d[u];
            for (const v of neighbors[u]) {
                if (!settled[v] && step < d[v]) d[v] = step;
            }
        }
    }
}

// Cost from intersection (i, j) to the given exit (lower = closer/faster)
export function routeDist(exitIdx, i, j) {
    if (i < 0 || i > GS || j < 0 || j > GS) return Infinity;
    return dist[exitIdx][idx(i, j)];
}
