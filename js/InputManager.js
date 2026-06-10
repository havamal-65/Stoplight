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

    // UI Controls
    setupUI();
}

function onMouseDown(event) {
    isDragging = true;
    previousMousePosition = { x: event.clientX, y: event.clientY };

    // Raycasting for selection
    if (event.button === 0) { // Left click
        const rect = renderer.domElement.getBoundingClientRect();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);

        let selected = false;
        for (let intersect of intersects) {
            // Traverse up to find the intersection group or mesh
            let obj = intersect.object;
            while (obj.parent && obj.parent !== scene) {
                obj = obj.parent;
            }

            if (obj.userData && obj.userData.type === 'intersection') {
                selectIntersection(obj.userData.data);
                selected = true;
                break;
            }
        }

        if (!selected) {
            closeIntersectionEditor();
        }
    }
}

function onMouseMove(event) {
    if (isDragging && event.buttons === 1) { // Left click drag (Rotate)
        const deltaMove = {
            x: event.clientX - previousMousePosition.x,
            y: event.clientY - previousMousePosition.y
        };

        const rotateSpeed = 0.005;

        // Orbit around the camera target (preserves panning)
        const offset = camera.position.clone().sub(cameraTarget);
        const radius = Math.sqrt(offset.x * offset.x + offset.z * offset.z);
        let theta = Math.atan2(offset.x, offset.z);

        theta -= deltaMove.x * rotateSpeed;

        offset.x = radius * Math.sin(theta);
        offset.z = radius * Math.cos(theta);
        camera.position.copy(cameraTarget).add(offset);
        camera.lookAt(cameraTarget);

    } else if (isDragging && event.buttons === 2) { // Right click drag (Pan)
        const deltaMove = {
            x: event.clientX - previousMousePosition.x,
            y: event.clientY - previousMousePosition.y
        };

        const panSpeed = 0.1;

        // Forward/Right vectors relative to camera
        const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        forward.y = 0;
        forward.normalize();

        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
        right.y = 0;
        right.normalize();

        const pan = new THREE.Vector3();
        pan.add(right.multiplyScalar(-deltaMove.x * panSpeed));
        pan.add(forward.multiplyScalar(deltaMove.y * panSpeed));

        camera.position.add(pan);
        cameraTarget.add(pan);
    }

    previousMousePosition = { x: event.clientX, y: event.clientY };
}

function onMouseUp(event) {
    isDragging = false;
}

function onWheel(event) {
    event.preventDefault();

    const minDistance = 15;
    const maxDistance = 300;

    // Move camera toward/away from the target
    const offset = camera.position.clone().sub(cameraTarget);
    const factor = event.deltaY < 0 ? 0.9 : 1.1;
    const distance = Math.max(minDistance, Math.min(maxDistance, offset.length() * factor));

    camera.position.copy(cameraTarget).add(offset.normalize().multiplyScalar(distance));
}

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
