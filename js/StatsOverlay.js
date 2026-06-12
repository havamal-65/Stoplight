import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { intersections, vehicles } from './TrafficSystem.js';

let camera;
let container;
let labels = [];
let visible = false;
let refreshTimer = 0;

const QUEUE_RADIUS = 24;   // Vehicles stopped within this range count as queued
const RECOUNT_INTERVAL = 0.25;

export function initStatsOverlay(cameraInstance) {
    camera = cameraInstance;

    container = document.createElement('div');
    container.id = 'statsOverlay';
    container.style.display = 'none';
    document.body.appendChild(container);

    intersections.forEach(() => {
        const el = document.createElement('div');
        el.className = 'int-stat';
        container.appendChild(el);
        labels.push(el);
    });
}

export function toggleStatsOverlay() {
    visible = !visible;
    container.style.display = visible ? 'block' : 'none';
    refreshTimer = 0; // Recount immediately when shown
    return visible;
}

const worldPos = new THREE.Vector3();

export function updateStatsOverlay(delta) {
    if (!visible) return;

    // Queue counts refresh a few times a second; positions track every frame
    refreshTimer -= delta;
    const recount = refreshTimer <= 0;
    if (recount) refreshTimer = RECOUNT_INTERVAL;

    intersections.forEach((intersection, i) => {
        const el = labels[i];

        if (recount) {
            let waiting = 0;
            for (const v of vehicles) {
                if (!v.stopped || v.waitingToEnter) continue;
                const dx = v.position.x - intersection.x;
                const dz = v.position.z - intersection.z;
                if (dx * dx + dz * dz < QUEUE_RADIUS * QUEUE_RADIUS) waiting++;
            }
            el.textContent = `🚗 ${waiting}`;
            el.classList.toggle('warn', waiting >= 2 && waiting < 5);
            el.classList.toggle('bad', waiting >= 5);
        }

        worldPos.set(intersection.x, 3, intersection.z);
        const dist = camera.position.distanceTo(worldPos);
        worldPos.project(camera);

        // Hide labels behind the camera or outside the viewport
        if (worldPos.z > 1 || Math.abs(worldPos.x) > 1.05 || Math.abs(worldPos.y) > 1.05) {
            el.style.display = 'none';
            return;
        }

        el.style.display = 'block';
        el.style.left = ((worldPos.x + 1) / 2 * window.innerWidth) + 'px';
        el.style.top = ((-worldPos.y + 1) / 2 * window.innerHeight) + 'px';

        // Shrink with distance for a sense of depth
        const scale = Math.max(0.55, Math.min(1.1, 160 / dist));
        el.style.transform = `translate(-50%, -110%) scale(${scale})`;
    });
}
