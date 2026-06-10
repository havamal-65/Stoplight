import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { CONFIG } from './Config.js';
import { GameManager } from './GameManager.js';
import { createExhaust } from './ParticleSystem.js';

let scene; // Module-level scope

export function initTrafficSystem(sceneInstance) {
    scene = sceneInstance;
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

    scene.add(mesh);
    buildingWindows.length = 0;
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
            createIntersection(x, z);
        }
    }

    // Create city blocks with buildings
    for (let i = 0; i < CONFIG.GRID_SIZE; i++) {
        for (let j = 0; j < CONFIG.GRID_SIZE; j++) {
            const x = -halfGrid + CONFIG.STREET_WIDTH / 2 + CONFIG.BLOCK_SIZE / 2 + i * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
            const z = -halfGrid + CONFIG.STREET_WIDTH / 2 + CONFIG.BLOCK_SIZE / 2 + j * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH);
            createCityBlock(x, z);
        }
    }

    // Batch all collected markings/windows into single draw calls
    buildMarkingInstances();
    buildWindowInstances();
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

function createIntersection(x, z) {
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
        yellow: CONFIG.LIGHT_DURATION.YELLOW
    };
    const cycle = timings.nsGreen + timings.ewGreen + (timings.yellow + CONFIG.LIGHT_DURATION.ALL_RED) * 2;
    const intData = {
        x, z,
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

function createTrafficLight(x, z, rotY) {
    const group = new THREE.Group();

    // Pole
    const poleGeo = new THREE.CylinderGeometry(0.15, 0.15, 5);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const pole = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 2.5;
    pole.castShadow = true;
    group.add(pole);

    // Light housing
    const housingGeo = new THREE.BoxGeometry(0.8, 2.4, 0.6);
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const housing = new THREE.Mesh(housingGeo, housingMat);
    housing.position.y = 5.5;
    housing.castShadow = true;
    group.add(housing);

    // Visor
    const visorGeo = new THREE.BoxGeometry(1, 0.3, 0.8);
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x111111 });

    // Light bulbs
    const bulbGeo = new THREE.CircleGeometry(0.25, 16);
    const lights = {};

    const colors = [
        { name: 'red', y: 6.2, color: 0xff0000 },
        { name: 'yellow', y: 5.5, color: 0xffff00 },
        { name: 'green', y: 4.8, color: 0x00ff00 }
    ];

    colors.forEach(({ name, y, color }) => {
        // Visor for each light
        const visor = new THREE.Mesh(visorGeo, visorMat);
        visor.position.set(0, y + 0.4, 0.4);
        group.add(visor);

        // Light bulb (off)
        const offMat = new THREE.MeshBasicMaterial({ color: 0x330000 });
        if (name === 'yellow') offMat.color.setHex(0x333300);
        if (name === 'green') offMat.color.setHex(0x003300);

        const bulb = new THREE.Mesh(bulbGeo, offMat.clone());
        bulb.position.set(0, y, 0.31);
        bulb.userData.onColor = color;
        bulb.userData.offColor = offMat.color.getHex();
        group.add(bulb);
        lights[name] = bulb;
    });

    group.position.set(x, 0, z);
    group.rotation.y = rotY;
    scene.add(group);
    return { lights, mesh: group, state: 'red' };
}

function createLowPolyTree(x, z) {
    const group = new THREE.Group();

    // Trunk
    const trunkGeo = new THREE.CylinderGeometry(0.2, 0.3, 1.5, 5);
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8B4513, flatShading: true });
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.75;
    trunk.castShadow = true;
    group.add(trunk);

    // Leaves (Layered Cones)
    const leavesMat = new THREE.MeshStandardMaterial({ color: 0x2d5a27, flatShading: true });

    const l1 = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2, 6), leavesMat);
    l1.position.y = 2;
    l1.castShadow = true;
    group.add(l1);

    const l2 = new THREE.Mesh(new THREE.ConeGeometry(1, 1.8, 6), leavesMat);
    l2.position.y = 3;
    l2.castShadow = true;
    group.add(l2);

    const l3 = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.5, 6), leavesMat);
    l3.position.y = 3.8;
    l3.castShadow = true;
    group.add(l3);

    group.position.set(x, 0, z);
    const scale = 0.8 + Math.random() * 0.4;
    group.scale.set(scale, scale, scale);
    scene.add(group);
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
    for (const vehicle of vehicles) {
        const dx = vehicle.mesh.position.x - x;
        const dz = vehicle.mesh.position.z - z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < radius) return false;
    }
    return true;
}

export function createVehicle(type = VehicleType.NORMAL) {
    const group = new THREE.Group();

    // Car body colors based on type
    const bodyColor = type.colorPalette[Math.floor(Math.random() * type.colorPalette.length)];

    // Main body (Chunky)
    const bodyGeo = new THREE.BoxGeometry(2.2, 1, 4.2);
    const bodyMat = new THREE.MeshStandardMaterial({ color: bodyColor, flatShading: true });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.y = 0.7;
    body.castShadow = true;
    group.add(body);

    // Cabin (Rounded top feel via smaller box)
    const cabinGeo = new THREE.BoxGeometry(1.8, 0.8, 2.2);
    const cabinMat = new THREE.MeshStandardMaterial({ color: bodyColor, flatShading: true });
    const cabin = new THREE.Mesh(cabinGeo, cabinMat);
    cabin.position.set(0, 1.4, -0.2);
    cabin.castShadow = true;
    group.add(cabin);

    // Windows (Dark glass)
    const windowMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.2 });

    // Windshield
    const frontWin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.1), windowMat);
    frontWin.position.set(0, 1.4, 0.91);
    group.add(frontWin);

    // Rear window
    const backWin = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.6, 0.1), windowMat);
    backWin.position.set(0, 1.4, -1.31);
    group.add(backWin);

    // Side windows
    const sideWinGeo = new THREE.BoxGeometry(0.1, 0.5, 1.8);
    const leftWin = new THREE.Mesh(sideWinGeo, windowMat);
    leftWin.position.set(0.91, 1.4, -0.2);
    group.add(leftWin);

    const rightWin = new THREE.Mesh(sideWinGeo, windowMat);
    rightWin.position.set(-0.91, 1.4, -0.2);
    group.add(rightWin);

    // Wheels (Cylinders)
    const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.4, 12);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x222222 });

    const wheelPositions = [
        { x: -1.1, z: 1.2 }, { x: 1.1, z: 1.2 },
        { x: -1.1, z: -1.2 }, { x: 1.1, z: -1.2 }
    ];

    wheelPositions.forEach(pos => {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(pos.x, 0.4, pos.z);
        wheel.castShadow = true;
        group.add(wheel);
    });

    // Headlights (Yellow squares)
    const headlightGeo = new THREE.BoxGeometry(0.3, 0.3, 0.1);
    const headlightMat = new THREE.MeshBasicMaterial({ color: 0xffffcc });

    const hl1 = new THREE.Mesh(headlightGeo, headlightMat);
    hl1.position.set(-0.7, 0.8, 2.11);
    group.add(hl1);

    const hl2 = new THREE.Mesh(headlightGeo, headlightMat);
    hl2.position.set(0.7, 0.8, 2.11);
    group.add(hl2);

    // Taillights (Red squares)
    const taillightMat = new THREE.MeshBasicMaterial({ color: 0xff4444 });
    const tl1 = new THREE.Mesh(headlightGeo, taillightMat);
    tl1.position.set(-0.7, 0.8, -2.11);
    group.add(tl1);

    const tl2 = new THREE.Mesh(headlightGeo, taillightMat);
    tl2.position.set(0.7, 0.8, -2.11);
    group.add(tl2);

    scene.add(group);
    return group;
}

export function spawnVehicles(count) {
    // Remove existing vehicles and free their GPU resources
    vehicles.forEach(v => {
        scene.remove(v.mesh);
        v.mesh.traverse(obj => {
            if (obj.isMesh) {
                obj.geometry.dispose();
                obj.material.dispose();
            }
        });
    });
    vehicles.length = 0; // Clear array

    const halfGrid = (CONFIG.GRID_SIZE * (CONFIG.BLOCK_SIZE + CONFIG.STREET_WIDTH)) / 2;
    let attempts = 0;
    let spawned = 0;

    while (spawned < count && attempts < count * 5) {
        attempts++;

        // Determine vehicle type
        const rand = Math.random();
        let type = VehicleType.NORMAL;
        if (rand < 0.2) type = VehicleType.AGGRESSIVE;
        else if (rand > 0.8) type = VehicleType.CAUTIOUS;

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

        // Check for collision
        if (!isPositionFree(x, z)) continue;

        const mesh = createVehicle(type);
        mesh.position.set(x, 0, z);
        mesh.rotation.y = heading;

        const vehicle = {
            mesh,
            type: type.id,
            speed: 0,
            maxSpeed: CONFIG.VEHICLE.MAX_SPEED * type.maxSpeedMultiplier * (0.9 + Math.random() * 0.2),
            acceleration: CONFIG.VEHICLE.ACCELERATION * type.accelerationMultiplier,
            safeDistance: CONFIG.VEHICLE.SAFE_DISTANCE * type.safeDistanceMultiplier,
            targetSpeed: CONFIG.VEHICLE.MAX_SPEED,
            direction: isHorizontal ? 'horizontal' : 'vertical',
            heading,                                  // Exact cardinal yaw in [0, 2π)
            laneCoord: isHorizontal ? z : x,          // Fixed lateral coordinate of the lane
            turning: false,
            turn: null,
            inIntersection: null,
            stopped: false
        };

        vehicles.push(vehicle);
        spawned++;
    }
}

// ============================================
// TRAFFIC LOGIC
// ============================================
export function updateTrafficLights(delta) {
    const allRed = CONFIG.LIGHT_DURATION.ALL_RED;

    intersections.forEach(intersection => {
        const t = intersection.timings;

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

        intersection.lights.forEach(light => {
            const state = light.controls === 'NS' ? nsState : ewState;

            // Update light visuals
            Object.keys(light.lights).forEach(color => {
                const bulb = light.lights[color];
                if (color === state) {
                    bulb.material.color.setHex(bulb.userData.onColor);
                } else {
                    bulb.material.color.setHex(bulb.userData.offColor);
                }
            });

            light.state = state;
        });
    });
}

function getTrafficLightState(vehicle) {
    const pos = vehicle.mesh.position;
    const checkDistance = CONFIG.VEHICLE.STOP_DISTANCE;

    // Get forward direction based on vehicle rotation
    const forward = new THREE.Vector3(0, 0, 1);
    forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.mesh.rotation.y);

    for (const intersection of intersections) {
        const dx = intersection.x - pos.x;
        const dz = intersection.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < checkDistance + CONFIG.STREET_WIDTH / 2) {
            // Check if we're approaching (not already in) the intersection
            const dotProduct = forward.x * dx + forward.z * dz;
            if (dotProduct > 0 && dist > CONFIG.STREET_WIDTH / 2 - 2) {
                // Find the relevant traffic light
                for (const light of intersection.lights) {
                    const isRelevant = (vehicle.direction === 'vertical' && light.controls === 'NS') ||
                        (vehicle.direction === 'horizontal' && light.controls === 'EW');
                    if (isRelevant) {
                        return { state: light.state, distance: dist - CONFIG.STREET_WIDTH / 2 };
                    }
                }
            }
        }
    }
    return null;
}

function checkVehicleAhead(vehicle) {
    const pos = vehicle.mesh.position;
    const forward = new THREE.Vector3(0, 0, 1);
    forward.applyAxisAngle(new THREE.Vector3(0, 1, 0), vehicle.mesh.rotation.y);

    let closestDist = Infinity;

    for (const other of vehicles) {
        if (other === vehicle) continue;

        const dx = other.mesh.position.x - pos.x;
        const dz = other.mesh.position.z - pos.z;
        const dist = Math.sqrt(dx * dx + dz * dz);

        if (dist < CONFIG.VEHICLE.SAFE_DISTANCE * 2) {
            // Check if other vehicle is ahead
            const dotProduct = forward.x * dx + forward.z * dz;
            if (dotProduct > 0) {
                // Check if in same lane (roughly). Turning vehicles sweep
                // across lanes, so treat them as wider obstacles.
                const perpDist = Math.abs(-forward.z * dx + forward.x * dz);
                const perpLimit = other.turning ? CONFIG.LANE_WIDTH * 1.8 : CONFIG.LANE_WIDTH;
                if (perpDist < perpLimit) {
                    closestDist = Math.min(closestDist, dist);
                }
            }
        }
    }

    return closestDist;
}

function normalizeAngle(angle) {
    return ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
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

    const p0 = vehicle.mesh.position.clone();
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
    const boundary = halfGrid + CONFIG.STREET_WIDTH;

    vehicles.forEach(vehicle => {
        // Check traffic light (skip while clearing an intersection)
        const lightInfo = vehicle.turning ? null : getTrafficLightState(vehicle);
        let shouldStop = false;

        if (lightInfo) {
            if (lightInfo.state === 'red' && lightInfo.distance < CONFIG.VEHICLE.STOP_DISTANCE) {
                shouldStop = true;
            } else if (lightInfo.state === 'yellow' && lightInfo.distance < CONFIG.VEHICLE.STOP_DISTANCE * 0.7) {
                shouldStop = true;
            }
        }

        // Check for vehicles ahead
        const distAhead = checkVehicleAhead(vehicle);

        // Dynamic safe distance based on speed
        const currentSafeDist = vehicle.safeDistance + (vehicle.speed * 10);

        if (distAhead < currentSafeDist) {
            shouldStop = true;
        } else if (distAhead < currentSafeDist * 1.5) {
            vehicle.targetSpeed = vehicle.maxSpeed * 0.5;
        } else {
            vehicle.targetSpeed = vehicle.maxSpeed;
        }

        // Update speed with easing
        if (shouldStop) {
            // Smooth braking
            vehicle.speed = Math.max(0, vehicle.speed - CONFIG.VEHICLE.DECELERATION * delta * 60);
            vehicle.stopped = vehicle.speed < 0.01;
        } else {
            // Smooth acceleration
            if (vehicle.speed < vehicle.targetSpeed) {
                vehicle.speed += vehicle.acceleration * delta * 60;
            } else {
                // Natural deceleration if over target speed
                vehicle.speed -= vehicle.acceleration * 0.5 * delta * 60;
            }
            vehicle.stopped = false;
        }

        // Decide whether to turn when entering an intersection
        let inside = null;
        for (const intersection of intersections) {
            if (Math.abs(intersection.x - vehicle.mesh.position.x) < CONFIG.STREET_WIDTH / 2 &&
                Math.abs(intersection.z - vehicle.mesh.position.z) < CONFIG.STREET_WIDTH / 2) {
                inside = intersection;
                break;
            }
        }
        if (inside && vehicle.inIntersection !== inside && !vehicle.turning) {
            const roll = Math.random();
            if (roll < 0.3) {
                startTurn(vehicle, inside, roll < 0.15 ? 1 : -1);
            }
        }
        vehicle.inIntersection = inside;

        // Move vehicle
        const step = vehicle.speed * delta * 60;

        if (vehicle.turning) {
            // Advance along the turn arc
            const turn = vehicle.turn;
            turn.t = Math.min(1, turn.t + step / turn.length);
            const t = turn.t;
            const mt = 1 - t;

            vehicle.mesh.position.set(
                mt * mt * turn.p0.x + 2 * mt * t * turn.ctrl.x + t * t * turn.p1.x,
                0,
                mt * mt * turn.p0.z + 2 * mt * t * turn.ctrl.z + t * t * turn.p1.z
            );

            // Face along the curve tangent
            const dx = mt * (turn.ctrl.x - turn.p0.x) + t * (turn.p1.x - turn.ctrl.x);
            const dz = mt * (turn.ctrl.z - turn.p0.z) + t * (turn.p1.z - turn.ctrl.z);
            vehicle.mesh.rotation.y = Math.atan2(dx, dz);

            if (turn.t >= 1) {
                vehicle.turning = false;
                vehicle.turn = null;
                vehicle.heading = turn.exitHeading;
                vehicle.mesh.rotation.y = turn.exitHeading;
                vehicle.direction = Math.abs(Math.sin(turn.exitHeading)) > 0.5 ? 'horizontal' : 'vertical';
                vehicle.laneCoord = vehicle.direction === 'horizontal' ? turn.p1.z : turn.p1.x;
            }
        } else {
            vehicle.mesh.position.x += Math.sin(vehicle.heading) * step;
            vehicle.mesh.position.z += Math.cos(vehicle.heading) * step;
            vehicle.mesh.rotation.y = vehicle.heading;

            // Keep the car centered in its lane
            if (vehicle.direction === 'horizontal') {
                vehicle.mesh.position.z = vehicle.laneCoord;
            } else {
                vehicle.mesh.position.x = vehicle.laneCoord;
            }
        }

        // Exhaust particles
        if (vehicle.speed > 0.1 && Math.random() < 0.2) {
            createExhaust(vehicle.mesh.position, vehicle.mesh.rotation.y);
        }

        // Wrap around boundaries (Arrival Logic)
        if (vehicle.mesh.position.x > boundary) {
            vehicle.mesh.position.x = -boundary;
            GameManager.arrivedVehicles++;
        }
        if (vehicle.mesh.position.x < -boundary) {
            vehicle.mesh.position.x = boundary;
            GameManager.arrivedVehicles++;
        }
        if (vehicle.mesh.position.z > boundary) {
            vehicle.mesh.position.z = -boundary;
            GameManager.arrivedVehicles++;
        }
        if (vehicle.mesh.position.z < -boundary) {
            vehicle.mesh.position.z = boundary;
            GameManager.arrivedVehicles++;
        }
    });
}
