import { createRoadNetwork } from '../RoadNetwork.js';

// Hand-authored varied city as a RoadNetwork. A non-uniform 3x3 arterial
// lattice gives redundant routes (no single chokepoint), while still
// exercising what a uniform grid can't:
//   - arterials (wide, fast) vs local streets (narrow, slow) → speed limits
//     and time-based routing that prefers the fast perimeter over the slow centre
//   - unequal block sizes (columns at -100/0/110, rows at -90/0/100)
//   - T-junctions at the corners (3 approaches)
//   - a diagonal arterial (J00–J11) → genuine non-90° turns
// Speed limits are world-units/tick to match CONFIG.VEHICLE.MAX_SPEED.
const ART = { lanesAB: 2, lanesBA: 2, speedLimit: 0.45, class: 'arterial' };
const LOCAL = { lanesAB: 1, lanesBA: 1, speedLimit: 0.22, class: 'local' };

const COLS = [-100, 0, 110];
const ROWS = [-90, 0, 100];
const J = (c, r) => `J${c}${r}`;

export function buildNewCity() {
    const nodes = [];
    const segments = [];

    // Lattice junctions (signalized)
    for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 3; r++) {
            nodes.push({ id: J(c, r), x: COLS[c], z: ROWS[r], control: 'signal' });
        }
    }

    // Horizontal + vertical arterials between adjacent junctions.
    // The centre row (r=1) is local/slow so routing prefers the fast perimeter.
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 2; c++) {
            segments.push({ a: J(c, r), b: J(c + 1, r), ...(r === 1 ? LOCAL : ART) });
        }
    }
    for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 2; r++) {
            segments.push({ a: J(c, r), b: J(c, r + 1), ...ART });
        }
    }

    // Diagonal arterial across the lattice → non-90° turns at J00 and J11
    segments.push({ a: J(0, 0), b: J(1, 1), ...ART });

    // Perimeter sinks (sources/destinations) with connector arterials
    const edge = [
        ['N0', -100, -160, J(0, 0)], ['N1', 0, -160, J(1, 0)], ['N2', 110, -160, J(2, 0)],
        ['S0', -100, 170, J(0, 2)], ['S1', 0, 170, J(1, 2)], ['S2', 110, 170, J(2, 2)],
        ['W', -190, 0, J(0, 1)], ['E', 200, 0, J(2, 1)]
    ];
    for (const [id, x, z, j] of edge) {
        nodes.push({ id, x, z, sink: true });
        segments.push({ a: id, b: j, ...ART });
    }

    return createRoadNetwork({ nodes, segments });
}
