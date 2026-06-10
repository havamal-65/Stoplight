import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import { CONFIG } from './Config.js';

export let scene, camera, renderer;
export let ambientLight, sunLight;
let isNight = false;

export function initRenderer() {
    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    scene.fog = new THREE.Fog(0x87ceeb, 150, 400);

    // Camera
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(80, 100, 120);
    camera.lookAt(0, 0, 0);

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.body.appendChild(renderer.domElement);

    // Lights
    // Hemisphere light for nice sky/ground color blend
    const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6);
    hemiLight.position.set(0, 200, 0);
    scene.add(hemiLight);

    // Directional light (Sun)
    sunLight = new THREE.DirectionalLight(0xffffff, 0.8);
    sunLight.position.set(100, 150, 50);
    sunLight.castShadow = true;

    // Optimize shadow map
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 500;

    // Widen shadow camera to cover city
    const d = 150;
    sunLight.shadow.camera.left = -d;
    sunLight.shadow.camera.right = d;
    sunLight.shadow.camera.top = d;
    sunLight.shadow.camera.bottom = -d;

    // Soften shadows slightly
    sunLight.shadow.bias = -0.0005;
    scene.add(sunLight);

    ambientLight = hemiLight; // Keep reference for day/night toggle

    // Event listeners
    window.addEventListener('resize', onWindowResize);
}

export function toggleDayNight() {
    isNight = !isNight;
    if (isNight) {
        scene.background = new THREE.Color(0x0a0a20);
        scene.fog.color = new THREE.Color(0x0a0a20);
        ambientLight.intensity = 0.15;
        sunLight.intensity = 0.1;
        sunLight.color.setHex(0x4444aa);
    } else {
        scene.background = new THREE.Color(0x87ceeb);
        scene.fog.color = new THREE.Color(0x87ceeb);
        ambientLight.intensity = 0.6;
        sunLight.intensity = 0.8;
        sunLight.color.setHex(0xffffff);
    }
    return isNight;
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
