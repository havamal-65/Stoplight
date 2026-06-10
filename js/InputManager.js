import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { CONFIG } from './Config.js';
import { toggleDayNight } from './Renderer.js';
import { GameManager } from './GameManager.js';

let camera, scene, renderer;
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let selectionRing;
let selectedIntersection = null;

// Point the camera orbits around; moves when panning
const cameraTarget = new THREE.Vector3(0, 0, 0);

// Touch gesture state
let touchMode = null; // 'rotate' (one finger) | 'gesture' (two fingers: pan + pinch)
let lastTouch = { x: 0, y: 0 };
let lastPinchDist = 0;
let lastPinchMid = { x: 0, y: 0 };
let touchStart = { x: 0, y: 0, time: 0 };
let touchMoved = false;

export function initInput(rendererInstance, sceneInstance, cameraInstance) {
    renderer = rendererInstance;
    scene = sceneInstance;
    camera = cameraInstance;

    // Create selection ring
    const ringGeo = new THREE.TorusGeometry(CONFIG.STREET_WIDTH / 2 + 1, 0.3, 16, 100);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffff00, transparent: true, opacity: 0.8 });
    selectionRing = new THREE.Mesh(ringGeo, ringMat);
    selectionRing.rotation.x = -Math.PI / 2;
    selectionRing.visible = false;
    scene.add(selectionRing);

    // Event Listeners
    const canvas = renderer.domElement;
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Touch controls: one-finger drag rotates, two-finger drag pans,
    // pinch zooms, tap selects. passive: false lets us preventDefault
    // so the browser doesn't consume the gestures.
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: false });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: false });

    // UI Controls
    setupUI();
}

// ============================================
// CAMERA ACTIONS (shared by mouse and touch)
// ============================================
function rotateCamera(deltaX) {
    const rotateSpeed = 0.005;

    // Orbit around the camera target (preserves panning)
    const offset = camera.position.clone().sub(cameraTarget);
    const radius = Math.sqrt(offset.x * offset.x + offset.z * offset.z);
    let theta = Math.atan2(offset.x, offset.z);

    theta -= deltaX * rotateSpeed;

    offset.x = radius * Math.sin(theta);
    offset.z = radius * Math.cos(theta);
    camera.position.copy(cameraTarget).add(offset);
    camera.lookAt(cameraTarget);
}

function panCamera(deltaX, deltaY) {
    const panSpeed = 0.1;

    // Forward/Right vectors relative to camera
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    forward.y = 0;
    forward.normalize();

    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    right.y = 0;
    right.normalize();

    const pan = new THREE.Vector3();
    pan.add(right.multiplyScalar(-deltaX * panSpeed));
    pan.add(forward.multiplyScalar(deltaY * panSpeed));

    camera.position.add(pan);
    cameraTarget.add(pan);
}

function zoomCamera(factor) {
    const minDistance = 15;
    const maxDistance = 300;

    // Move camera toward/away from the target
    const offset = camera.position.clone().sub(cameraTarget);
    const distance = Math.max(minDistance, Math.min(maxDistance, offset.length() * factor));

    camera.position.copy(cameraTarget).add(offset.normalize().multiplyScalar(distance));
}

function trySelect(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);
    const intersects = raycaster.intersectObjects(scene.children, true);

    for (let intersect of intersects) {
        // Traverse up to find the intersection group or mesh
        let obj = intersect.object;
        while (obj.parent && obj.parent !== scene) {
            obj = obj.parent;
        }

        if (obj.userData && obj.userData.type === 'intersection') {
            selectIntersection(obj.userData.data);
            return;
        }
    }

    closeIntersectionEditor();
}

// ============================================
// MOUSE INPUT
// ============================================
function onMouseDown(event) {
    isDragging = true;
    previousMousePosition = { x: event.clientX, y: event.clientY };

    if (event.button === 0) { // Left click
        trySelect(event.clientX, event.clientY);
    }
}

function onMouseMove(event) {
    if (isDragging && event.buttons === 1) { // Left click drag (Rotate)
        rotateCamera(event.clientX - previousMousePosition.x);
    } else if (isDragging && event.buttons === 2) { // Right click drag (Pan)
        panCamera(
            event.clientX - previousMousePosition.x,
            event.clientY - previousMousePosition.y
        );
    }

    previousMousePosition = { x: event.clientX, y: event.clientY };
}

function onMouseUp(event) {
    isDragging = false;
}

function onWheel(event) {
    event.preventDefault();
    zoomCamera(event.deltaY < 0 ? 0.9 : 1.1);
}

// ============================================
// TOUCH INPUT
// ============================================
function onTouchStart(event) {
    event.preventDefault();

    if (event.touches.length === 1) {
        const t = event.touches[0];
        touchMode = 'rotate';
        lastTouch = { x: t.clientX, y: t.clientY };
        touchStart = { x: t.clientX, y: t.clientY, time: performance.now() };
        touchMoved = false;
    } else if (event.touches.length === 2) {
        touchMode = 'gesture';
        touchMoved = true; // Two fingers is never a tap
        const [a, b] = event.touches;
        lastPinchDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        lastPinchMid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
    }
}

function onTouchMove(event) {
    event.preventDefault();

    if (touchMode === 'rotate' && event.touches.length === 1) {
        const t = event.touches[0];
        if (Math.abs(t.clientX - touchStart.x) > 8 || Math.abs(t.clientY - touchStart.y) > 8) {
            touchMoved = true;
        }
        rotateCamera(t.clientX - lastTouch.x);
        lastTouch = { x: t.clientX, y: t.clientY };
    } else if (touchMode === 'gesture' && event.touches.length === 2) {
        const [a, b] = event.touches;
        const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const mid = { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };

        panCamera(mid.x - lastPinchMid.x, mid.y - lastPinchMid.y);
        if (dist > 0 && lastPinchDist > 0) {
            zoomCamera(lastPinchDist / dist);
        }

        lastPinchDist = dist;
        lastPinchMid = mid;
    }
}

function onTouchEnd(event) {
    event.preventDefault();

    if (event.touches.length === 0) {
        // A short, stationary single touch is a tap (select)
        const isTap = touchMode === 'rotate' && !touchMoved &&
            (performance.now() - touchStart.time) < 400;
        if (isTap) {
            trySelect(touchStart.x, touchStart.y);
        }
        touchMode = null;
    } else if (event.touches.length === 1) {
        // Dropped from two fingers to one; re-anchor as rotation
        const t = event.touches[0];
        touchMode = 'rotate';
        touchMoved = true;
        lastTouch = { x: t.clientX, y: t.clientY };
    }
}

// ============================================
// UI
// ============================================
function selectIntersection(data) {
    const editor = document.getElementById('editorPanel');
    editor.style.display = 'block';

    // Position selection ring
    selectionRing.position.set(data.x, 0.5, data.z);
    selectionRing.visible = true;

    // Update UI values
    document.getElementById('nsGreenTime').value = data.timings.nsGreen;
    document.getElementById('nsGreenVal').textContent = data.timings.nsGreen;
    document.getElementById('ewGreenTime').value = data.timings.ewGreen;
    document.getElementById('ewGreenVal').textContent = data.timings.ewGreen;

    selectedIntersection = data;
}

function closeIntersectionEditor() {
    document.getElementById('editorPanel').style.display = 'none';
    selectionRing.visible = false;
    selectedIntersection = null;
}

function setupUI() {
    // Sim Speed
    document.getElementById('simSpeed').addEventListener('input', (e) => {
        window.simSpeed = parseFloat(e.target.value);
    });

    // Toggle Day/Night
    document.getElementById('toggleTime').addEventListener('click', toggleDayNight);

    // Reset
    document.getElementById('resetSim').addEventListener('click', () => GameManager.reset());

    // Editor Controls
    document.getElementById('nsGreenTime').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        document.getElementById('nsGreenVal').textContent = val;
        if (selectedIntersection) {
            selectedIntersection.timings.nsGreen = val;
        }
    });

    document.getElementById('ewGreenTime').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        document.getElementById('ewGreenVal').textContent = val;
        if (selectedIntersection) {
            selectedIntersection.timings.ewGreen = val;
        }
    });

    document.getElementById('closeEditor').addEventListener('click', closeIntersectionEditor);
}
