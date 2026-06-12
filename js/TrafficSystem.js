import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { CONFIG } from './Config.js';
import { GameManager } from './GameManager.js';
import { createExhaust } from './ParticleSystem.js';

let scene; // Module-level scope

export function initTrafficSystem(sceneInstance) {
    scene = sceneInstance;
    initVehicleMeshes();
}

export let vehicles = [];
export let intersections = [];

// Road markings and building windows are batched into InstancedMeshes after
// the city is built — thousands of individual meshes otherwise.
const markings = []; // { x, z, sx, sz, color }
const buildingWindows = []; // { x, y, z, rotY }

function addMarking(x, z, sx, sz, color) {
    markings.push({ x, z, sx, sz, color });
}

function buildMarkingInstances() {
    if (markings.length === 0) return;
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(geo, mat, markings.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();

    markings.forEach((m, i) => {
        dummy.position.set(m.x, 0.02, m.z);
        dummy.rotation.set(-Math.PI / 2, 0, 0);
        dummy.scale.set(m.sx, m.sz, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        mesh.setColorAt(i, color.setHex(m.color));
    });

    mesh.frustumCulled = false; // Instances span the whole map
    scene.add(mesh);
    markings.length = 0;
}

function buildWindowInstances() {
    if (buildingWindows.length === 0) return;
    const geo = new THREE.BoxGeometry(0.6, 0.6, 0.1);
    const mat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const mesh = new THREE.InstancedMesh(geo, mat, buildingWindows.length);
    const dummy = new THREE.Object3D();

    buildingWindows.forEach((w, i) => {
        dummy.position.set(w.x, w.y, w.z);
        dummy.rotation.set(0, w.rotY, 0);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    });

    mesh.frustumCulled = false; // Instances span the whole map
    scene.add(mesh);
    buildingWindows.length = 0;
}

// Merge simple transformed box/cylinder parts into one vertex-colored
// geometry, so a whole model becomes a single InstancedMesh entry.
function buildMergedGeometry(parts) {
    const positions = [];
    const normals = [];
    const colors = [];
    const color = new THREE.Color();
    const matrix = new THREE.Matrix4();

    for (const part of parts) {
        const g = part.geo.toNonIndexed();
        if (part.rotZ) matrix.makeRotationZ(part.rotZ);
        else matrix.identity();
        matrix.setPosition(part.x || 0, part.y || 0, part.z || 0);
        g.applyMatrix4(matrix);

        const pos = g.attributes.position;
        const nor = g.attributes.normal;
        color.setHex(part.color);
        for (let i = 0; i < pos.count; i++) {
            positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
            normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
            colors.push(color.r, color.g, color.b);
        }
        g.dispose();
        part.geo.dispose();
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return geo;
}

// ============================================
// INSTANCED VEHICLE RENDERING
// All cars are drawn with two InstancedMeshes: a body (tinted per car via
// instance color, so vertices are white) and the dark details.
// ============================================
export const MAX_VEHICLES = 1200;
let carBodyMesh = null;
let carDetailMesh = null;
const instanceDummy = new THREE.Object3D();

function initVehicleMeshes() {
    const bodyGeo = buildMergedGeometry([
        { geo: new THREE.BoxGeometry(2.2, 1, 4.2), y: 0.7, color: 0xffffff },                 // Body
        { geo: new THREE.BoxGeometry(1.8, 0.8, 2.2), y: 1.4, z: -0.2, color: 0xffffff }       // Cabin
    ]);

    const detailParts = [
        // Windows (dark glass)
        { geo: new THREE.BoxGeometry(1.6, 0.6, 0.1), y: 1.4, z: 0.91, color: 0x333333 },
        { geo: new THREE.BoxGeometry(1.6, 0.6, 0.1), y: 1.4, z: -1.31, color: 0x333333 },
        { geo: new THREE.BoxGeometry(0.1, 0.5, 1.8), x: 0.91, y: 1.4, z: -0.2, color: 0x333333 },
        { geo: new THREE.BoxGeometry(0.1, 0.5, 1.8), x: -0.91, y: 1.4, z: -0.2, color: 0x333333 },
        // Headlights / taillights
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: -0.7, y: 0.8, z: 2.11, color: 0xffffcc },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: 0.7, y: 0.8, z: 2.11, color: 0xffffcc },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: -0.7, y: 0.8, z: -2.11, color: 0xff4444 },
        { geo: new THREE.BoxGeometry(0.3, 0.3, 0.1), x: 0.7, y: 0.8, z: -2.11, color: 0xff4444 }
    ];
    // Wheels
    for (const wx of [-1.1, 1.1]) {
        for (const wz of [-1.2, 1.2]) {
            detailParts.push({
                geo: new THREE.CylinderGeometry(0.4, 0.4, 0.4, 8),
                rotZ: Math.PI / 2, x: wx, y: 0.4, z: wz, color: 0x222222
            });
        }
    }
    const detailGeo = buildMergedGeometry(detailParts);

    carBodyMesh = new THREE.InstancedMesh(
        bodyGeo,
        new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }),
        MAX_VEHICLES
    );
    carDetailMesh = new THREE.InstancedMesh(
        detailGeo,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4 }),
        MAX_VEHICLES
    );
    [carBodyMesh, carDetailMesh].forEach(m => {
        m.castShadow = true;
        m.frustumCulled = false; // Instances span the whole map
        m.count = 0;
        scene.add(m);
    });
}

function syncVehicleInstances() {
    for (let i = 0; i < vehicles.length; i++) {
        const v = vehicles[i];
        v.dirX = Math.sin(v.rotationY); // Cached for neighbor checks
        v.dirZ = Math.cos(v.rotationY);
        instanceDummy.position.set(v.position.x, 0, v.position.z);
        instanceDummy.rotation.set(0, v.rotationY, 0);
        instanceDummy.scale.setScalar(v.waitingToEnter ? 0.0001 : 1);
        instanceDummy.updateMatrix();
        carBodyMesh.setMatrixAt(i, instanceDummy.matrix);
        carDetailMesh.setMatrixAt(i, instanceDummy.matrix);
    }
    carBodyMesh.count = vehicles.length;
    carDetailMesh.count = vehicles.length;
    carBodyMesh.instanceMatrix.needsUpdate = true;
    carDetailMesh.instanceMatrix.needsUpdate = true;
}

// ============================================
// CITY CONSTRUCTION
// ============================================
export function createGround() {
    const totalSize = CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH) + CONFIG.STREET_WIDTH;

    // Base ground
    const groundGeo = new THREE.PlaneGeometry(totalSize * 2, totalSize * 2);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.1;
    ground.receiveShadow = true;
    scene.add(ground);
}

export function createCityGrid() {
    const halfGrid = (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH)) / 2;

    // Create streets and intersections
    for (let i = 0; i <= CONFIG.GRID_SIZE; i++) {
        const pos = -halfGrid + i * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);

        // Horizontal street
        createStreet(0, pos, CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH) + CONFIG.STREET_WIDTH, CONFIG.STREET_WIDTH, 'horizontal');

        // Vertical street
        createStreet(pos, 0, CONFIG.STREET_WIDTH, CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH) + CONFIG.STREET_WIDTH, 'vertical');
    }

    // Create intersections with traffic lights
    for (let i = 0; i <= CONFIG.GRID_SIZE; i++) {
        for (let j = 0; j <= CONFIG.GRID_SIZE; j++) {
            const x = -halfGrid + i * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
            const z = -halfGrid + j * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
            createIntersection(x, z, i, j);
        }
    }

    // Exit ramps and barricades at the street ends
    createMapEdges();

    // Create city blocks with buildings
    for (let i = 0; i < CONFIG.GRID_SIZE; i++) {
        for (let j = 0; j < CONFIG.GRID_SIZE; j++) {
            const x = -halfGrid + CONFIG.STREET_WIDTH / 2 + CONFIG.BLOCK_SIZE / 2 + i * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
            const z = -halfGrid + CONFIG.STREET_WIDTH / 2 + CONFIG.BLOCK_SIZE / 2 + j * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
            createCityBlock(x, z);
        }
    }

    // Batch all collected markings/windows/trees into single draw calls
    buildMarkingInstances();
    buildWindowInstances();
    buildTreeInstances();
}

function createStreet(x, z, width, depth, direction) {
    // Asphalt
    const streetGeo = new THREE.PlaneGeometry(width, depth);
    const streetMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const street = new THREE.Mesh(streetGeo, streetMat);
    street.rotation.x = -Math.PI / 2;
    street.position.set(x, 0.01, z);
    street.receiveShadow = true;
    scene.add(street);

    // Lane markings
    const dashLength = 3;
    const dashGap = 2;

    if (direction === 'horizontal') {
        // Center line (yellow)
        addMarking(x, z, width - CONFIG.STREET_WIDTH, 0.2, 0xffcc00);

        // Dashed white lines
        for (let offset of [-CONFIG.LANE_WIDTH, CONFIG.LANE_WIDTH]) {
            for (let d = -width / 2 + CONFIG.STREET_WIDTH; d < width / 2 - CONFIG.STREET_WIDTH; d += dashLength + dashGap) {
                addMarking(x + d, z + offset, dashLength, 0.15, 0xffffff);
            }
        }
    } else {
        // Center line (yellow)
        addMarking(x, z, 0.2, depth - CONFIG.STREET_WIDTH, 0xffcc00);

        // Dashed white lines
        for (let offset of [-CONFIG.LANE_WIDTH, CONFIG.LANE_WIDTH]) {
            for (let d = -depth / 2 + CONFIG.STREET_WIDTH; d < depth / 2 - CONFIG.STREET_WIDTH; d += dashLength + dashGap) {
                addMarking(x + offset, z + d, 0.15, dashLength, 0xffffff);
            }
        }
    }

    // Sidewalks
    const sidewalkHeight = 0.15;
    const sidewalkMat = new THREE.MeshStandardMaterial({ color: 0x999999 });

    if (direction === 'horizontal') {
        // Top sidewalk
        const sw1Geo = new THREE.BoxGeometry(width, sidewalkHeight, CONFIG.SIDEWALK_WIDTH);
        const sw1 = new THREE.Mesh(sw1Geo, sidewalkMat);
        sw1.position.set(x, sidewalkHeight / 2, z - CONFIG.STREET_WIDTH / 2 - CONFIG.SIDEWALK_WIDTH / 2);
        sw1.receiveShadow = true;
        sw1.castShadow = true;
        scene.add(sw1);

        // Bottom sidewalk
        const sw2 = new THREE.Mesh(sw1Geo, sidewalkMat);
        sw2.position.set(x, sidewalkHeight / 2, z + CONFIG.STREET_WIDTH / 2 + CONFIG.SIDEWALK_WIDTH / 2);
        sw2.receiveShadow = true;
        sw2.castShadow = true;
        scene.add(sw2);
    } else {
        // Left sidewalk
        const sw1Geo = new THREE.BoxGeometry(CONFIG.SIDEWALK_WIDTH, sidewalkHeight, depth);
        const sw1 = new THREE.Mesh(sw1Geo, sidewalkMat);
        sw1.position.set(x - CONFIG.STREET_WIDTH / 2 - CONFIG.SIDEWALK_WIDTH / 2, sidewalkHeight / 2, z);
        sw1.receiveShadow = true;
        sw1.castShadow = true;
        scene.add(sw1);

        // Right sidewalk
        const sw2 = new THREE.Mesh(sw1Geo, sidewalkMat);
        sw2.position.set(x + CONFIG.STREET_WIDTH / 2 + CONFIG.SIDEWALK_WIDTH / 2, sidewalkHeight / 2, z);
        sw2.receiveShadow = true;
        sw2.castShadow = true;
        scene.add(sw2);
    }
}

function createIntersection(x, z, gridI, gridJ) {
    // Intersection asphalt
    const intGeo = new THREE.PlaneGeometry(CONFIG.STREET_WIDTH, CONFIG.STREET_WIDTH);
    const intMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a });
    const intersection = new THREE.Mesh(intGeo, intMat);
    intersection.rotation.x = -Math.PI / 2;
    intersection.position.set(x, 0.015, z);
    intersection.receiveShadow = true;
    scene.add(intersection);

    // Crosswalks
    const stripeWidth = 0.8;
    const stripeCount = 6;

    // North-South crosswalks
    for (let i = 0; i < stripeCount; i++) {
        const sx = x - CONFIG.STREET_WIDTH / 3 + i * (stripeWidth + 0.5);
        addMarking(sx, z - CONFIG.STREET_WIDTH / 2 + 1.5, stripeWidth, CONFIG.STREET_WIDTH * 0.3, 0xffffff);
        addMarking(sx, z + CONFIG.STREET_WIDTH / 2 - 1.5, stripeWidth, CONFIG.STREET_WIDTH * 0.3, 0xffffff);
    }

    // East-West crosswalks
    for (let i = 0; i < stripeCount; i++) {
        const sz = z - CONFIG.STREET_WIDTH / 3 + i * (stripeWidth + 0.5);
        addMarking(x - CONFIG.STREET_WIDTH / 2 + 1.5, sz, CONFIG.STREET_WIDTH * 0.3, stripeWidth, 0xffffff);
        addMarking(x + CONFIG.STREET_WIDTH / 2 - 1.5, sz, CONFIG.STREET_WIDTH * 0.3, stripeWidth, 0xffffff);
    }

    // Create traffic lights for this intersection.
    // The cycle alternates NS green and EW green, separated by yellow and a
    // short all-red clearance interval.
    const timings = {
        nsGreen: CONFIG.LIGHT_DURATION.GREEN,
        ewGreen: CONFIG.LIGHT_DURATION.GREEN,
        yellow: CONFIG.LIGHT_DURATION.YELLOW,
        allRed: CONFIG.LIGHT_DURATION.ALL_RED
    };
    const cycle = timings.nsGreen + timings.ewGreen + (timings.yellow + timings.allRed) * 2;
    const intData = {
        x, z, gridI, gridJ,
        cycleTime: Math.random() * cycle, // Random starting phase
        lights: [],
        timings,
        mesh: intersection
    };

    intersection.userData = { type: 'intersection', data: intData };

    // Four corners, each with a traffic light
    const corners = [
        { dx: -CONFIG.STREET_WIDTH / 2 + 1, dz: -CONFIG.STREET_WIDTH / 2 + 1, rotY: 0, controls: 'NS' },
        { dx: CONFIG.STREET_WIDTH / 2 - 1, dz: -CONFIG.STREET_WIDTH / 2 + 1, rotY: Math.PI / 2, controls: 'EW' },
        { dx: CONFIG.STREET_WIDTH / 2 - 1, dz: CONFIG.STREET_WIDTH / 2 - 1, rotY: Math.PI, controls: 'NS' },
        { dx: -CONFIG.STREET_WIDTH / 2 + 1, dz: CONFIG.STREET_WIDTH / 2 - 1, rotY: -Math.PI / 2, controls: 'EW' }
    ];

    corners.forEach(corner => {
        const light = createTrafficLight(x + corner.dx, z + corner.dz, corner.rotY);
        light.controls = corner.controls;
        intData.lights.push(light);
    });

    intersections.push(intData);
}

// ============================================
// INSTANCED TRAFFIC LIGHTS
// Static parts (pole, housing, visors) share one InstancedMesh; the bulbs
// share another whose per-instance colors switch with the signal state.
// ============================================
const BULB_LAYOUT = [
    { name: 'red', y: 6.2, on: 0xff0000, off: 0x330000 },
    { name: 'yellow', y: 5.5, on: 0xffff00, off: 0x333300 },
    { name: 'green', y: 4.8, on: 0x00ff00, off: 0x003300 }
];
let lightPostMesh = null;
let bulbMesh = null;
let lightPostCount = 0;
let bulbCount = 0;
let bulbColorsDirty = false;
const bulbColor = new THREE.Color();

function initTrafficLightMeshes() {
    const postCapacity = (CONFIG.GRID_SIZE + 1) * (CONFIG.GRID_SIZE + 1) * 4;

    const postParts = [
        { geo: new THREE.CylinderGeometry(0.15, 0.15, 5, 8), y: 2.5, color: 0x333333 },  // Pole
        { geo: new THREE.BoxGeometry(0.8, 2.4, 0.6), y: 5.5, color: 0x222222 }           // Housing
    ];
    BULB_LAYOUT.forEach(({ y }) => {
        postParts.push({ geo: new THREE.BoxGeometry(1, 0.3, 0.8), y: y + 0.4, z: 0.4, color: 0x111111 }); // Visor
    });

    lightPostMesh = new THREE.InstancedMesh(
        buildMergedGeometry(postParts),
        new THREE.MeshStandardMaterial({ vertexColors: true }),
        postCapacity
    );
    lightPostMesh.castShadow = true;

    bulbMesh = new THREE.InstancedMesh(
        new THREE.CircleGeometry(0.25, 12),
        new THREE.MeshBasicMaterial(),
        postCapacity * 3
    );

    [lightPostMesh, bulbMesh].forEach(m => {
        m.frustumCulled = false;
        scene.add(m);
    });
}

function createTrafficLight(x, z, rotY) {
    if (!lightPostMesh) initTrafficLightMeshes();

    instanceDummy.position.set(x, 0, z);
    instanceDummy.rotation.set(0, rotY, 0);
    instanceDummy.scale.setScalar(1);
    instanceDummy.updateMatrix();
    lightPostMesh.setMatrixAt(lightPostCount++, instanceDummy.matrix);
    lightPostMesh.count = lightPostCount;

    const bulbs = {};
    const local = new THREE.Matrix4();
    const world = new THREE.Matrix4();
    BULB_LAYOUT.forEach(({ name, y, off }) => {
        local.makeTranslation(0, y, 0.31);
        world.multiplyMatrices(instanceDummy.matrix, local);
        bulbMesh.setMatrixAt(bulbCount, world);
        bulbMesh.setColorAt(bulbCount, bulbColor.setHex(off));
        bulbs[name] = bulbCount++;
    });
    bulbMesh.count = bulbCount;

    // state starts empty so the first updateTrafficLights pass paints it
    return { bulbs, state: '' };
}

function setBulbColors(light, state) {
    BULB_LAYOUT.forEach(({ name, on, off }) => {
        bulbMesh.setColorAt(light.bulbs[name], bulbColor.setHex(name === state ? on : off));
    });
    bulbColorsDirty = true;
}

// ============================================
// MAP EDGES (exit ramps and barricades)
// ============================================
const exitSet = new Set(CONFIG.EXITS.map(e => `${e.side}:${e.index}`));

function isExit(side, index) {
    return exitSet.has(`${side}:${index}`);
}

function createMapEdges() {
    const halfGrid = (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH)) / 2;
    const endPos = halfGrid + CONFIG.STREET_WIDTH / 2;

    for (let k = 0; k <= CONFIG.GRID_SIZE; k++) {
        const streetPos = -halfGrid + k * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
        const ends = [
            { side: 'north', x: streetPos, z: -endPos, rotY: 0 },
            { side: 'south', x: streetPos, z: endPos, rotY: Math.PI },
            { side: 'west', x: -endPos, z: streetPos, rotY: Math.PI / 2 },
            { side: 'east', x: endPos, z: streetPos, rotY: -Math.PI / 2 }
        ];
        ends.forEach(end => {
            if (isExit(end.side, k)) createExitSign(end.x, end.z, end.rotY);
            else createBarrier(end.x, end.z, end.rotY);
        });
    }
}

let exitSignTexture = null;

function createExitSign(x, z, rotY) {
    if (!exitSignTexture) {
        const canvas = document.createElement('canvas');
        canvas.width = 256;
        canvas.height = 96;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#1e7e34';
        ctx.fillRect(0, 0, 256, 96);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 5;
        ctx.strokeRect(8, 8, 240, 80);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 52px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('EXIT', 128, 52);
        exitSignTexture = new THREE.CanvasTexture(canvas);
    }

    const group = new THREE.Group();

    // Gantry posts on the sidewalk edges
    const postGeo = new THREE.CylinderGeometry(0.15, 0.15, 6);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x444444 });
    for (const px of [-CONFIG.STREET_WIDTH / 2 + 0.5, CONFIG.STREET_WIDTH / 2 - 0.5]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(px, 3, 0);
        post.castShadow = true;
        group.add(post);
    }

    // Overhead green panel, facing inbound traffic
    const panel = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 3),
        new THREE.MeshBasicMaterial({ map: exitSignTexture, side: THREE.DoubleSide })
    );
    panel.position.set(0, 5, 0);
    group.add(panel);

    group.position.set(x, 0, z);
    group.rotation.y = rotY;
    scene.add(group);
}

let barrierTexture = null;

function createBarrier(x, z, rotY) {
    if (!barrierTexture) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 16;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#cc2222';
        ctx.fillRect(0, 0, 128, 16);
        ctx.fillStyle = '#ffffff';
        for (let sx = 0; sx < 128; sx += 32) ctx.fillRect(sx, 0, 16, 16);
        barrierTexture = new THREE.CanvasTexture(canvas);
    }

    const group = new THREE.Group();

    const postGeo = new THREE.BoxGeometry(0.3, 1, 0.3);
    const postMat = new THREE.MeshStandardMaterial({ color: 0x666666 });
    for (const px of [-CONFIG.STREET_WIDTH / 2 + 0.6, 0, CONFIG.STREET_WIDTH / 2 - 0.6]) {
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(px, 0.5, 0);
        post.castShadow = true;
        group.add(post);
    }

    // Striped crossbar spanning the street
    const bar = new THREE.Mesh(
        new THREE.BoxGeometry(CONFIG.STREET_WIDTH, 0.7, 0.25),
        new THREE.MeshBasicMaterial({ map: barrierTexture })
    );
    bar.position.set(0, 1.1, 0);
    group.add(bar);

    group.position.set(x, 0, z);
    group.rotation.y = rotY;
    scene.add(group);
}

// Trees are collected during city construction and drawn as one InstancedMesh
const treeInstances = []; // { x, z, scale }

function createLowPolyTree(x, z) {
    treeInstances.push({ x, z, scale: 0.8 + Math.random() * 0.4 });
}

function buildTreeInstances() {
    if (treeInstances.length === 0) return;

    const treeGeo = buildMergedGeometry([
        { geo: new THREE.CylinderGeometry(0.2, 0.3, 1.5, 5), y: 0.75, color: 0x8B4513 }, // Trunk
        { geo: new THREE.ConeGeometry(1.2, 2, 6), y: 2, color: 0x2d5a27 },               // Leaves
        { geo: new THREE.ConeGeometry(1, 1.8, 6), y: 3, color: 0x2d5a27 },
        { geo: new THREE.ConeGeometry(0.8, 1.5, 6), y: 3.8, color: 0x2d5a27 }
    ]);
    const mesh = new THREE.InstancedMesh(
        treeGeo,
        new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true }),
        treeInstances.length
    );
    treeInstances.forEach((t, i) => {
        instanceDummy.position.set(t.x, 0, t.z);
        instanceDummy.rotation.set(0, 0, 0);
        instanceDummy.scale.setScalar(t.scale);
        instanceDummy.updateMatrix();
        mesh.setMatrixAt(i, instanceDummy.matrix);
    });
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    scene.add(mesh);
    treeInstances.length = 0;
}

function createCityBlock(x, z) {
    // Ground for the block
    const groundGeo = new THREE.BoxGeometry(CONFIG.BLOCK_SIZE - 1, 0.5, CONFIG.BLOCK_SIZE - 1);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x90a4ae }); // Concrete sidewalk color
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.position.set(x, 0.25, z);
    ground.receiveShadow = true;
    scene.add(ground);

    // Buildings
    const numBuildings = Math.floor(Math.random() * 3) + 2;

    // Building Colors (Pastels)
    const colors = [0xffadad, 0xffd6a5, 0xfdffb6, 0xcaffbf, 0x9bf6ff, 0xa0c4ff, 0xbdb2ff, 0xffc6ff];

    for (let i = 0; i < numBuildings; i++) {
        const bx = x + (Math.random() - 0.5) * (CONFIG.BLOCK_SIZE - 6);
        const bz = z + (Math.random() - 0.5) * (CONFIG.BLOCK_SIZE - 6);

        const width = 4 + Math.random() * 4;
        const depth = 4 + Math.random() * 4;
        const height = 6 + Math.random() * 10;

        const geometry = new THREE.BoxGeometry(width, height, depth);
        const color = colors[Math.floor(Math.random() * colors.length)];
        const material = new THREE.MeshStandardMaterial({ color: color, flatShading: true });

        const building = new THREE.Mesh(geometry, material);
        building.position.set(bx, height / 2 + 0.5, bz);
        building.castShadow = true;
        building.receiveShadow = true;
        scene.add(building);

        // Windows (collected for instanced rendering)
        for (let wy = 2; wy < height - 1; wy += 2) {
            for (let wx = -width / 2 + 1; wx < width / 2 - 1; wx += 1.5) {
                buildingWindows.push({ x: bx + wx, y: wy, z: bz + depth / 2, rotY: 0 }); // Front
                buildingWindows.push({ x: bx + wx, y: wy, z: bz - depth / 2, rotY: 0 }); // Back
            }
            for (let wz = -depth / 2 + 1; wz < depth / 2 - 1; wz += 1.5) {
                buildingWindows.push({ x: bx + width / 2, y: wy, z: bz + wz, rotY: Math.PI / 2 }); // Right
                buildingWindows.push({ x: bx - width / 2, y: wy, z: bz + wz, rotY: Math.PI / 2 }); // Left
            }
        }
    }

    // Trees
    const numTrees = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < numTrees; i++) {
        const tx = x + (Math.random() - 0.5) * (CONFIG.BLOCK_SIZE - 2);
        const tz = z + (Math.random() - 0.5) * (CONFIG.BLOCK_SIZE - 2);
        createLowPolyTree(tx, tz);
    }
}

// ============================================
// Vehicle Types and Behaviors
const VehicleType = {
    AGGRESSIVE: {
        id: 'AGGRESSIVE',
        maxSpeedMultiplier: 1.2,
        accelerationMultiplier: 1.5,
        safeDistanceMultiplier: 0.7,
        colorPalette: [0xff0000, 0xff4400, 0x333333, 0x000000] // Red, Orange, Black
    },
    CAUTIOUS: {
        id: 'CAUTIOUS',
        maxSpeedMultiplier: 0.8,
        accelerationMultiplier: 0.8,
        safeDistanceMultiplier: 1.5,
        colorPalette: [0xeeeeee, 0xcccccc, 0xaaddff, 0xccffcc] // White, Grey, Light Blue, Light Green
    },
    NORMAL: {
        id: 'NORMAL',
        maxSpeedMultiplier: 1.0,
        accelerationMultiplier: 1.0,
        safeDistanceMultiplier: 1.0,
        colorPalette: [0x4ecdc4, 0x45b7d1, 0xff9f43, 0x54a0ff, 0x5f27cd] // Vibrant standard colors
    }
};

function isPositionFree(x, z, radius = 4) {
    const radiusSq = radius * radius;
    for (const vehicle of vehicles) {
        if (vehicle.waitingToEnter) continue;
        const dx = vehicle.position.x - x;
        const dz = vehicle.position.z - z;
        if (dx * dx + dz * dz < radiusSq) return false;
    }
    return true;
}

// ============================================
// SPATIAL HASH GRID
// Rebuilt each frame so neighbor queries are O(1) instead of scanning
// every vehicle — the difference between 60 and 1000 cars.
// ============================================
const CELL_SIZE = 12; // = the max look-ahead radius, so 3x3 cells suffice
const spatialGrid = new Map();

function cellKey(x, z) {
    return (Math.floor(x / CELL_SIZE) + 512) * 1024 + (Math.floor(z / CELL_SIZE) + 512);
}

function insertIntoGrid(vehicle) {
    const key = cellKey(vehicle.position.x, vehicle.position.z);
    let cell = spatialGrid.get(key);
    if (!cell) {
        cell = [];
        spatialGrid.set(key, cell);
    }
    cell.push(vehicle);
}

function buildSpatialGrid() {
    spatialGrid.clear();
    for (const vehicle of vehicles) {
        if (!vehicle.waitingToEnter) insertIntoGrid(vehicle);
    }
}

// Is a circle around (x, z) free of active vehicles? Grid-accelerated.
function isAreaFreeInGrid(x, z, radius) {
    const radiusSq = radius * radius;
    const minCX = Math.floor((x - radius) / CELL_SIZE);
    const maxCX = Math.floor((x + radius) / CELL_SIZE);
    const minCZ = Math.floor((z - radius) / CELL_SIZE);
    const maxCZ = Math.floor((z + radius) / CELL_SIZE);
    for (let cx = minCX; cx <= maxCX; cx++) {
        for (let cz = minCZ; cz <= maxCZ; cz++) {
            const cell = spatialGrid.get((cx + 512) * 1024 + (cz + 512));
            if (!cell) continue;
            for (const other of cell) {
                const dx = other.position.x - x;
                const dz = other.position.z - z;
                if (dx * dx + dz * dz < radiusSq) return false;
            }
        }
    }
    return true;
}

// O(1) lookup of the intersection nearest to a position (regular grid)
function intersectionNear(x, z) {
    const spacing = CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH;
    const halfGrid = (CONFIG.GRID_SIZE * spacing) / 2;
    const i = Math.round((x + halfGrid) / spacing);
    const j = Math.round((z + halfGrid) / spacing);
    if (i < 0 || i > CONFIG.GRID_SIZE || j < 0 || j > CONFIG.GRID_SIZE) return null;
    return intersections[i * (CONFIG.GRID_SIZE + 1) + j];
}

function makeVehicle(type) {
    return {
        position: new THREE.Vector3(0, 0, 0),
        rotationY: 0,
        dirX: 0,
        dirZ: 1,
        type: type.id,
        speed: 0,
        maxSpeed: CONFIG.VEHICLE.MAX_SPEED * type.maxSpeedMultiplier * (0.9 + Math.random() * 0.2),
        acceleration: CONFIG.VEHICLE.ACCELERATION * type.accelerationMultiplier,
        safeDistance: CONFIG.VEHICLE.SAFE_DISTANCE * type.safeDistanceMultiplier,
        targetSpeed: CONFIG.VEHICLE.MAX_SPEED,
        direction: 'vertical',
        heading: 0,            // Exact cardinal yaw in [0, 2π)
        laneCoord: 0,          // Fixed lateral coordinate of the lane
        turning: false,
        turn: null,
        inIntersection: null,
        stopped: false,
        stuckTime: 0,
        spawnIndex: 0,
        waitingToEnter: false
    };
}

function pickVehicleType() {
    const rand = Math.random();
    if (rand < 0.2) return VehicleType.AGGRESSIVE;
    if (rand > 0.8) return VehicleType.CAUTIOUS;
    return VehicleType.NORMAL;
}

export function spawnVehicles(count) {
    count = Math.min(count, MAX_VEHICLES);
    vehicles.length = 0;

    const halfGrid = (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH)) / 2;
    let attempts = 0;
    let spawned = 0;

    while (spawned < count && attempts < count * 5) {
        attempts++;

        const type = pickVehicleType();

        // Random starting position on a road
        const isHorizontal = Math.random() > 0.5;
        const streetIndex = Math.floor(Math.random() * (CONFIG.GRID_SIZE + 1));
        const streetPos = -halfGrid + streetIndex * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);

        // Position along the street
        const alongStreet = (Math.random() - 0.5) * (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH));

        // Travel direction along the street (-1 or 1)
        const laneDirection = Math.random() > 0.5 ? 1 : -1;
        const laneOffsetMag = CONFIG.LANE_WIDTH * 0.75;

        // Right-hand traffic: lane offset sits on the right side of the
        // heading (offset = heading rotated -90°), matching startTurn().
        let x, z, heading;
        if (isHorizontal) {
            x = alongStreet;
            z = streetPos + laneDirection * laneOffsetMag;
            heading = laneDirection > 0 ? Math.PI / 2 : Math.PI * 1.5;
        } else {
            x = streetPos - laneDirection * laneOffsetMag;
            z = alongStreet;
            heading = laneDirection > 0 ? 0 : Math.PI;
        }

        // Check for collision (leave a workable gap so traffic can move)
        if (!isPositionFree(x, z, 5.5)) continue;

        const vehicle = makeVehicle(type);
        vehicle.position.set(x, 0, z);
        vehicle.rotationY = heading;
        vehicle.heading = heading;
        vehicle.direction = isHorizontal ? 'horizontal' : 'vertical';
        vehicle.laneCoord = isHorizontal ? z : x;

        vehicles.push(vehicle);
        spawned++;
    }

    // When the streets are too full, queue the remainder at the on-ramps;
    // they enter as space opens up
    while (vehicles.length < count) {
        const vehicle = makeVehicle(pickVehicleType());
        vehicle.waitingToEnter = true;
        vehicle.position.set(0, 0, 100000); // Far off-map until activated
        vehicles.push(vehicle);
    }

    // Assign instance colors by vehicle type
    const color = new THREE.Color();
    vehicles.forEach((vehicle, i) => {
        vehicle.spawnIndex = i;
        const palette = VehicleType[vehicle.type].colorPalette;
        color.setHex(palette[Math.floor(Math.random() * palette.length)]);
        carBodyMesh.setColorAt(i, color);
    });
    if (carBodyMesh.instanceColor) carBodyMesh.instanceColor.needsUpdate = true;
    syncVehicleInstances();
}

// ============================================
// TRAFFIC LOGIC
// ============================================
export function updateTrafficLights(delta) {
    intersections.forEach(intersection => {
        const t = intersection.timings;
        const allRed = t.allRed;

        // Cycle: NS green | yellow | all-red | EW green | yellow | all-red
        const cycle = t.nsGreen + t.ewGreen + (t.yellow + allRed) * 2;
        intersection.cycleTime = (intersection.cycleTime + delta) % cycle;
        const ct = intersection.cycleTime;

        let nsState = 'red';
        let ewState = 'red';
        if (ct < t.nsGreen) {
            nsState = 'green';
        } else if (ct < t.nsGreen + t.yellow) {
            nsState = 'yellow';
        } else if (ct >= t.nsGreen + t.yellow + allRed) {
            if (ct < t.nsGreen + t.yellow + allRed + t.ewGreen) {
                ewState = 'green';
            } else if (ct < cycle - allRed) {
                ewState = 'yellow';
            }
        }

        // Cached for O(1) lookups by vehicles
        intersection.nsState = nsState;
        intersection.ewState = ewState;

        intersection.lights.forEach(light => {
            const state = light.controls === 'NS' ? nsState : ewState;
            if (state !== light.state) {
                light.state = state;
                setBulbColors(light, state);
            }
        });
    });

    if (bulbColorsDirty && bulbMesh.instanceColor) {
        bulbMesh.instanceColor.needsUpdate = true;
        bulbColorsDirty = false;
    }
}

function getTrafficLightState(vehicle) {
    // The grid is regular, so only the nearest intersection can be in range
    const intersection = intersectionNear(vehicle.position.x, vehicle.position.z);
    if (!intersection) return null;

    const dx = intersection.x - vehicle.position.x;
    const dz = intersection.z - vehicle.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist >= CONFIG.VEHICLE.STOP_DISTANCE + CONFIG.STREET_WIDTH / 2) return null;

    // Check if we're approaching (not already in) the intersection
    const fx = Math.sin(vehicle.rotationY);
    const fz = Math.cos(vehicle.rotationY);
    if (fx * dx + fz * dz > 0 && dist > CONFIG.STREET_WIDTH / 2 - 2) {
        const state = vehicle.direction === 'vertical' ? intersection.nsState : intersection.ewState;
        if (!state) return null; // First frame, lights not computed yet
        return { state, distance: dist - CONFIG.STREET_WIDTH / 2 };
    }
    return null;
}

const aheadResult = { dist: Infinity, isStopped: false }; // Reused, hot path

// Look-ahead must cover a full intersection plus a car so the
// don't-block-the-box rule can see whether the far side has room
const AHEAD_RADIUS = 24;

function checkVehicleAhead(vehicle) {
    const px = vehicle.position.x;
    const pz = vehicle.position.z;
    const fx = Math.sin(vehicle.rotationY);
    const fz = Math.cos(vehicle.rotationY);
    const radius = AHEAD_RADIUS;
    const radiusSq = radius * radius;

    // Unwedge valve: a car stuck for ages is physically wedged in a knot
    // (e.g. a turner trapped mid-box). It pushes through cross/oncoming
    // blockers — never same-direction queues — so knots always dissolve.
    const desperate = vehicle.stuckTime > 20;

    let closestSq = Infinity;
    let closestStopped = false;

    // Scan the 3x3 spatial-grid neighborhood instead of every vehicle
    const minCX = Math.floor((px - radius) / CELL_SIZE);
    const maxCX = Math.floor((px + radius) / CELL_SIZE);
    const minCZ = Math.floor((pz - radius) / CELL_SIZE);
    const maxCZ = Math.floor((pz + radius) / CELL_SIZE);

    for (let cx = minCX; cx <= maxCX; cx++) {
        for (let cz = minCZ; cz <= maxCZ; cz++) {
            const cell = spatialGrid.get((cx + 512) * 1024 + (cz + 512));
            if (!cell) continue;
            for (const other of cell) {
                if (other === vehicle) continue;

                const headingDot = fx * other.dirX + fz * other.dirZ;

                // Oncoming straight traffic runs in a parallel lane — never
                // an obstacle. (Turners crossing our lane still are; THEY
                // ignore us, we brake for them: one-sided, so no deadlock.)
                if (!other.turning && headingDot < -0.5) continue;

                // Wedged cars only respect same-direction traffic
                if (desperate && headingDot < 0.7) continue;

                // Tie-break for two turning cars in the same intersection:
                // the lower spawnIndex has right of way, so they can't
                // mutually block each other forever
                if (vehicle.turning && other.turning && vehicle.spawnIndex < other.spawnIndex) continue;

                const dx = other.position.x - px;
                const dz = other.position.z - pz;
                const distSq = dx * dx + dz * dz;
                if (distSq >= radiusSq || distSq >= closestSq) continue;

                // Check if other vehicle is ahead
                if (fx * dx + fz * dz > 0) {
                    // Check if in same lane (roughly). Turning vehicles sweep
                    // across lanes, so treat them as wider obstacles — unless
                    // we've been stuck so long it's clearly a gridlock knot.
                    const perpDist = Math.abs(-fz * dx + fx * dz);
                    const perpLimit = (other.turning && vehicle.stuckTime < 12)
                        ? CONFIG.LANE_WIDTH * 1.8 : CONFIG.LANE_WIDTH;
                    if (perpDist < perpLimit) {
                        closestSq = distSq;
                        closestStopped = other.stopped;
                    }
                }
            }
        }
    }

    aheadResult.dist = closestSq === Infinity ? Infinity : Math.sqrt(closestSq);
    aheadResult.isStopped = closestStopped;
    return aheadResult;
}

function normalizeAngle(angle) {
    return ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

// Can a car leave this intersection with the given heading? Moving toward
// another intersection is always fine; moving off the map requires an exit.
function isMoveAllowed(intersection, heading) {
    const di = Math.round(Math.sin(heading));
    const dj = Math.round(Math.cos(heading));
    const ni = intersection.gridI + di;
    const nj = intersection.gridJ + dj;

    if (ni >= 0 && ni <= CONFIG.GRID_SIZE && nj >= 0 && nj <= CONFIG.GRID_SIZE) return true;
    if (ni > CONFIG.GRID_SIZE) return isExit('east', intersection.gridJ);
    if (ni < 0) return isExit('west', intersection.gridJ);
    if (nj > CONFIG.GRID_SIZE) return isExit('south', intersection.gridI);
    return isExit('north', intersection.gridI);
}

// Would a turn end on top of parked traffic? Cars must not start turns
// they can't finish — a turner stalled mid-box wedges the intersection.
function turnExitBlocked(vehicle, intersection, turnDir) {
    const exitHeading = normalizeAngle(vehicle.heading + turnDir * Math.PI / 2);
    const fx = Math.sin(exitHeading);
    const fz = Math.cos(exitHeading);
    const laneOff = CONFIG.LANE_WIDTH * 0.75;
    const laneX = intersection.x - Math.cos(exitHeading) * laneOff;
    const laneZ = intersection.z + Math.sin(exitHeading) * laneOff;
    // Two landing spots must be clear: room to land AND roll out
    const near = CONFIG.STREET_WIDTH / 2 + 2.5;
    const far = CONFIG.STREET_WIDTH / 2 + 7.5;
    return !isAreaFreeInGrid(laneX + fx * near, laneZ + fz * near, 5) ||
        !isAreaFreeInGrid(laneX + fx * far, laneZ + fz * far, 4);
}

// Pick where to go at an intersection: 0 = straight, 1/-1 = turn, null =
// wait at the line (dead end with every exit blocked). Straight is
// preferred ~70% of the time; barricaded directions are never chosen, so
// cars turn away from dead ends; blocked exit lanes are never turned into.
function getTurnChoice(vehicle, intersection) {
    const straightOk = isMoveAllowed(intersection, vehicle.heading);
    const turns = [1, -1].filter(dir =>
        isMoveAllowed(intersection, normalizeAngle(vehicle.heading + dir * Math.PI / 2)) &&
        !turnExitBlocked(vehicle, intersection, dir));

    if (straightOk && (turns.length === 0 || Math.random() > 0.3)) return 0;
    if (turns.length > 0) return turns[Math.floor(Math.random() * turns.length)];
    if (straightOk) return 0;
    return null;
}

// Spawn pose for traffic entering the map through an exit ramp
function entrancePose(side, index) {
    const halfGrid = (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH)) / 2;
    const streetPos = -halfGrid + index * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
    const edge = halfGrid + CONFIG.STREET_WIDTH / 2;
    const laneOff = CONFIG.LANE_WIDTH * 0.75;

    switch (side) {
        case 'north': return { x: streetPos - laneOff, z: -edge, heading: 0 };
        case 'south': return { x: streetPos + laneOff, z: edge, heading: Math.PI };
        case 'west': return { x: -edge, z: streetPos + laneOff, heading: Math.PI / 2 };
        case 'east': return { x: edge, z: streetPos - laneOff, heading: Math.PI * 1.5 };
    }
}

// A car that left through an exit waits (hidden) until a ramp has room,
// then re-enters there. Queuing instead of force-placing prevents pile-ups
// at the ramps when the map is crowded.
function tryEnterMap(vehicle) {
    const exits = [...CONFIG.EXITS].sort(() => Math.random() - 0.5);
    for (const exit of exits) {
        const pose = entrancePose(exit.side, exit.index);
        if (!isAreaFreeInGrid(pose.x, pose.z, 6)) continue;

        vehicle.position.set(pose.x, 0, pose.z);
        vehicle.rotationY = pose.heading;
        vehicle.heading = pose.heading;
        vehicle.direction = Math.abs(Math.sin(pose.heading)) > 0.5 ? 'horizontal' : 'vertical';
        vehicle.laneCoord = vehicle.direction === 'horizontal' ? pose.z : pose.x;
        vehicle.turning = false;
        vehicle.turn = null;
        vehicle.inIntersection = null;
        vehicle.stopped = false;
        vehicle.stuckTime = 0;
        vehicle.speed = vehicle.maxSpeed * 0.3;
        vehicle.waitingToEnter = false;
        insertIntoGrid(vehicle); // Visible to later entrants this frame
        return true;
    }
    return false;
}

// Begin a 90° turn through an intersection. The car follows a quadratic
// bezier from its entry point to the right-hand lane of the cross street,
// tangent to both lanes, so it ends exactly on the exit lane.
function startTurn(vehicle, intersection, turnDir) {
    const exitHeading = normalizeAngle(vehicle.heading + turnDir * Math.PI / 2);
    const fx = Math.sin(exitHeading);
    const fz = Math.cos(exitHeading);
    const laneOffsetMag = CONFIG.LANE_WIDTH * 0.75;
    const halfInt = CONFIG.STREET_WIDTH / 2;

    // Right-hand lane of the exit street (offset = heading rotated -90°)
    const laneX = intersection.x - Math.cos(exitHeading) * laneOffsetMag;
    const laneZ = intersection.z + Math.sin(exitHeading) * laneOffsetMag;

    const p0 = vehicle.position.clone();
    p0.y = 0;
    const p1 = new THREE.Vector3(laneX + fx * halfInt, 0, laneZ + fz * halfInt);

    // Control point: where the entry and exit lane lines cross
    const enteringAlongX = Math.abs(Math.sin(vehicle.heading)) > 0.5;
    const ctrl = enteringAlongX
        ? new THREE.Vector3(p1.x, 0, p0.z)
        : new THREE.Vector3(p0.x, 0, p1.z);

    vehicle.turning = true;
    vehicle.turn = {
        p0, p1, ctrl, exitHeading,
        length: p0.distanceTo(ctrl) + ctrl.distanceTo(p1),
        t: 0
    };
}

export function updateVehicles(delta) {
    const halfGrid = (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH)) / 2;
    const boundary = halfGrid + CONFIG.STREET_WIDTH / 2 + 2; // Just past the street end
    const exhaustChance = 0.2 * Math.min(1, 60 / (vehicles.length || 1)); // Global budget

    buildSpatialGrid();

    vehicles.forEach(vehicle => {
        // Queued cars wait off-map for room at an on-ramp
        if (vehicle.waitingToEnter) {
            tryEnterMap(vehicle);
            return;
        }

        // Check for vehicles ahead
        const ahead = checkVehicleAhead(vehicle);
        const distAhead = ahead.dist;
        const minGap = 4.5; // Bumper-to-bumper standstill gap (car is 4.2 long)

        // Check traffic light (skip while clearing an intersection).
        // The rules only apply while approaching the line — a car already
        // inside the box never voluntarily stops there, it clears out.
        const lightInfo = vehicle.turning ? null : getTrafficLightState(vehicle);
        let shouldStop = false;

        if (lightInfo && lightInfo.distance > -1) {
            if (lightInfo.state === 'red' && lightInfo.distance < CONFIG.VEHICLE.STOP_DISTANCE) {
                shouldStop = true;
            } else if (lightInfo.state === 'yellow' && lightInfo.distance < CONFIG.VEHICLE.STOP_DISTANCE * 0.7) {
                shouldStop = true;
            } else if (lightInfo.distance < CONFIG.VEHICLE.STOP_DISTANCE && ahead.isStopped &&
                distAhead > lightInfo.distance &&
                distAhead < lightInfo.distance + CONFIG.STREET_WIDTH + minGap) {
                // Don't block the box: first car to the line waits there if a
                // STOPPED queue would trap it inside the intersection.
                // Moving queues are fine.
                shouldStop = true;
            }
        }

        // Car following: desired speed scales linearly from zero at the
        // standstill gap to full speed one safe-distance later, so release
        // waves propagate backward through queues instead of dying out
        if (distAhead < minGap) {
            shouldStop = true;
        } else {
            vehicle.targetSpeed = vehicle.maxSpeed *
                Math.min(1, (distAhead - minGap) / Math.max(vehicle.safeDistance, 0.1));
        }

        // Decide whether to turn when entering an intersection
        let inside = intersectionNear(vehicle.position.x, vehicle.position.z);
        if (inside &&
            (Math.abs(inside.x - vehicle.position.x) >= CONFIG.STREET_WIDTH / 2 ||
                Math.abs(inside.z - vehicle.position.z) >= CONFIG.STREET_WIDTH / 2)) {
            inside = null;
        }
        if (inside && vehicle.inIntersection !== inside && !vehicle.turning) {
            const turnDir = getTurnChoice(vehicle, inside);
            if (turnDir === null) {
                // Dead end with every exit lane full: hold at the line and
                // re-evaluate next frame
                shouldStop = true;
                inside = null;
            } else if (turnDir !== 0) {
                startTurn(vehicle, inside, turnDir);
            }
        }
        vehicle.inIntersection = inside;

        // Track how long we've been stuck (drives the gridlock relief
        // valve). Hysteresis: nano-creep must not reset the timer.
        if (vehicle.speed < 0.02) vehicle.stuckTime += delta;
        else if (vehicle.speed > 0.05) vehicle.stuckTime = 0;

        // Update speed with easing
        if (shouldStop) {
            // Smooth braking
            vehicle.speed = Math.max(0, vehicle.speed - CONFIG.VEHICLE.DECELERATION * delta * 60);
            vehicle.stopped = vehicle.speed < 0.01;
        } else {
            // Smooth acceleration
            if (vehicle.speed < vehicle.targetSpeed) {
                vehicle.speed = Math.min(vehicle.targetSpeed, vehicle.speed + vehicle.acceleration * delta * 60);
            } else {
                // Brake down toward the target when going too fast
                vehicle.speed = Math.max(vehicle.targetSpeed, vehicle.speed - CONFIG.VEHICLE.DECELERATION * delta * 60);
            }
            vehicle.stopped = vehicle.speed < 0.01;
        }

        // Move vehicle
        const step = vehicle.speed * delta * 60;

        if (vehicle.turning) {
            // Advance along the turn arc
            const turn = vehicle.turn;
            turn.t = Math.min(1, turn.t + step / turn.length);
            const t = turn.t;
            const mt = 1 - t;

            vehicle.position.set(
                mt * mt * turn.p0.x + 2 * mt * t * turn.ctrl.x + t * t * turn.p1.x,
                0,
                mt * mt * turn.p0.z + 2 * mt * t * turn.ctrl.z + t * t * turn.p1.z
            );

            // Face along the curve tangent
            const dx = mt * (turn.ctrl.x - turn.p0.x) + t * (turn.p1.x - turn.ctrl.x);
            const dz = mt * (turn.ctrl.z - turn.p0.z) + t * (turn.p1.z - turn.ctrl.z);
            vehicle.rotationY = Math.atan2(dx, dz);

            if (turn.t >= 1) {
                vehicle.turning = false;
                vehicle.turn = null;
                vehicle.heading = turn.exitHeading;
                vehicle.rotationY = turn.exitHeading;
                vehicle.direction = Math.abs(Math.sin(turn.exitHeading)) > 0.5 ? 'horizontal' : 'vertical';
                vehicle.laneCoord = vehicle.direction === 'horizontal' ? turn.p1.z : turn.p1.x;
            }
        } else {
            vehicle.position.x += Math.sin(vehicle.heading) * step;
            vehicle.position.z += Math.cos(vehicle.heading) * step;
            vehicle.rotationY = vehicle.heading;

            // Keep the car centered in its lane
            if (vehicle.direction === 'horizontal') {
                vehicle.position.z = vehicle.laneCoord;
            } else {
                vehicle.position.x = vehicle.laneCoord;
            }
        }

        // Exhaust particles
        if (vehicle.speed > 0.1 && Math.random() < exhaustChance) {
            createExhaust(vehicle.position, vehicle.rotationY);
        }

        // Arrival: a car driving outward past a street end has left through
        // an exit (barricades force turns everywhere else). It scores an
        // arrival and queues to re-enter at a ramp.
        const pos = vehicle.position;
        const exitedOutward =
            (pos.x > boundary && Math.sin(vehicle.heading) > 0.5) ||
            (pos.x < -boundary && Math.sin(vehicle.heading) < -0.5) ||
            (pos.z > boundary && Math.cos(vehicle.heading) > 0.5) ||
            (pos.z < -boundary && Math.cos(vehicle.heading) < -0.5);

        if (exitedOutward) {
            GameManager.arrivedVehicles++;
            vehicle.waitingToEnter = true;
            vehicle.position.set(0, 0, 100000);
            vehicle.speed = 0;
            vehicle.stopped = false;
        }
    });

    syncVehicleInstances();
}
