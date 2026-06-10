import { initRenderer, scene, camera, renderer } from './Renderer.js';
import { createGround, createCityGrid, spawnVehicles, updateTrafficLights, updateVehicles, vehicles, initTrafficSystem } from './TrafficSystem.js';
import { initInput } from './InputManager.js';
import { GameManager } from './GameManager.js';
import { initParticleSystem, updateParticles } from './ParticleSystem.js';
import { initStatsOverlay, updateStatsOverlay } from './StatsOverlay.js';

let simTime = 0;
window.simSpeed = 1; // Global for access in InputManager

function init() {
    initRenderer();
    initTrafficSystem(scene);
    initParticleSystem(scene);

    createGround();
    createCityGrid();
    spawnVehicles(30);
    initInput(renderer, scene, camera);
    initStatsOverlay(camera);
    GameManager.init();

    // Listen for reset event
    window.addEventListener('resetSimulation', () => {
        simTime = 0;
        const density = document.getElementById('density').value;
        spawnVehicles(parseInt(density));
    });

    // Density slider
    const densityInput = document.getElementById('density');
    densityInput.addEventListener('change', (e) => {
        spawnVehicles(parseInt(e.target.value));
    });

    animate();
}

let lastTime = 0;
function animate(time = 0) {
    requestAnimationFrame(animate);

    const delta = Math.min((time - lastTime) / 1000, 0.1) * window.simSpeed;
    lastTime = time;

    simTime += delta;
    document.getElementById('simTime').innerText = formatTime(simTime);

    updateTrafficLights(delta);
    updateVehicles(delta);
    updateParticles(delta);
    updateStatsOverlay(delta);
    GameManager.update(delta, vehicles);
    renderer.render(scene, camera);
}

init();

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
