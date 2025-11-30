import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { CONFIG } from './Config.js';
import { intersections, trafficLights } from './TrafficSystem.js';

let camera, scene, renderer;
let isDragging = false;
let previousMousePosition = { x: 0, y: 0 };
let raycaster = new THREE.Raycaster();
let mouse = new THREE.Vector2();
let selectionRing;

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
        // Rotate around Y axis (orbit)
        // Simple implementation: rotate camera parent or move camera
        // Here we'll just move camera in a circle around 0,0

        const radius = Math.sqrt(camera.position.x * camera.position.x + camera.position.z * camera.position.z);
        let theta = Math.atan2(camera.position.x, camera.position.z);

        theta -= deltaMove.x * rotateSpeed;

        camera.position.x = radius * Math.sin(theta);
        camera.position.z = radius * Math.cos(theta);
        camera.lookAt(0, 0, 0);

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

        camera.position.add(right.multiplyScalar(-deltaMove.x * panSpeed));
        camera.position.add(forward.multiplyScalar(deltaMove.y * panSpeed));
    }

    previousMousePosition = { x: event.clientX, y: event.clientY };
}

function onMouseUp(event) {
    isDragging = false;
}

function onWheel(event) {
    const zoomSpeed = 0.1;
    const minZoom = 10;
    const maxZoom = 100;

    // Move camera forward/backward
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);

    if (event.deltaY < 0) {
        // Zoom in
        if (camera.position.y > minZoom) {
            camera.position.add(forward.multiplyScalar(zoomSpeed * 20));
        }
    } else {
        // Zoom out
        if (camera.position.y < maxZoom) {
            camera.position.add(forward.multiplyScalar(-zoomSpeed * 20));
        }
    }
}

function selectIntersection(data) {
    const editor = document.getElementById('editorPanel');
    editor.style.display = 'block';

    // Position selection ring
    selectionRing.position.set(data.x, 0.5, data.z);
    selectionRing.visible = true;

    // Update UI values
    document.getElementById('greenTime').value = data.timings.green;
    document.getElementById('greenVal').textContent = data.timings.green;
    document.getElementById('redTime').value = data.timings.red;
    document.getElementById('redVal').textContent = data.timings.red;

    // Store current intersection for updates
    window.selectedIntersection = data;
}

function closeIntersectionEditor() {
    document.getElementById('editorPanel').style.display = 'none';
    selectionRing.visible = false;
    window.selectedIntersection = null;
}

function setupUI() {
    // Sim Speed
    document.getElementById('simSpeed').addEventListener('input', (e) => {
        window.simSpeed = parseFloat(e.target.value);
    });

    // Toggle Day/Night
    document.getElementById('toggleTime').addEventListener('click', () => {
        // Simple toggle for now, can be expanded
        const isNight = scene.background.getHex() === 0x000000;
        if (isNight) {
            scene.background = new THREE.Color(0x87CEEB);
            scene.fog.color.setHex(0x87CEEB);
        } else {
            scene.background = new THREE.Color(0x000000);
            scene.fog.color.setHex(0x000000);
        }
    });

    // Reset
    document.getElementById('resetSim').addEventListener('click', () => {
        window.dispatchEvent(new Event('resetSimulation'));
    });

    // Editor Controls
    document.getElementById('greenTime').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        document.getElementById('greenVal').textContent = val;
        if (window.selectedIntersection) {
            window.selectedIntersection.timings.green = val;
        }
    });

    document.getElementById('redTime').addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        document.getElementById('redVal').textContent = val;
        if (window.selectedIntersection) {
            window.selectedIntersection.timings.red = val;
        }
    });

    document.getElementById('closeEditor').addEventListener('click', closeIntersectionEditor);
}
