console.log("Main.js loaded");
import { initRenderer, scene, camera, renderer } from './Renderer.js';
import { createGround, createCityGrid, spawnVehicles, updateTrafficLights, updateVehicles, vehicles, initTrafficSystem } from './TrafficSystem.js';
import { initInput } from './InputManager.js';
import { GameManager } from './GameManager.js';
import { initParticleSystem, updateParticles } from './ParticleSystem.js';

let simTime = 0;
window.simSpeed = 1; // Global for access in InputManager

function init() {
    console.log("Init started");
    try {
        console.log("Calling initRenderer...");
        initRenderer();
        console.log("initRenderer done");

        // Initialize Traffic System with the scene
        console.log("Calling initTrafficSystem...");
        initTrafficSystem(scene);
        console.log("initTrafficSystem done");

        console.log("Calling initParticleSystem...");
        initParticleSystem(scene);
        console.log("initParticleSystem done");

        console.log("Creating ground...");
        createGround();
        console.log("Creating city grid...");
        createCityGrid();
        console.log("Spawning vehicles...");
        spawnVehicles(50);
        console.log("Initializing input...");
        initInput(renderer, scene, camera);
        console.log("Input initialized");

        // Listen for reset event
        window.addEventListener('resetSimulation', () => {
            simTime = 0;
            const density = document.getElementById('density').value;
            spawnVehicles(parseInt(density));
        });

        // Density slider
        const densityInput = document.getElementById('density');
        densityInput.addEventListener('change', (e) => {
            const count = parseInt(e.target.value);
            console.log("Updating traffic density to:", count);
            spawnVehicles(count);
        });

        console.log("Starting animation loop...");
        animate();
    } catch (e) {
        console.error("Initialization Error:", e);
    }
}

let lastTime = 0;
let frameCount = 0;
function animate(time = 0) {
    frameCount++;
    if (frameCount % 60 === 0) console.log("Frame:", frameCount, "Time:", time);
    requestAnimationFrame(animate);

    const delta = Math.min((time - lastTime) / 1000, 0.1) * window.simSpeed;
    lastTime = time;

    simTime += delta;
    document.getElementById('simTime').innerText = formatTime(simTime);

    try {
        updateTrafficLights(delta, simTime);
        updateVehicles(delta);
        updateParticles(delta);
        GameManager.update(delta, vehicles);
        renderer.render(scene, camera);
    } catch (e) {
        console.error("Animation Error:", e);
    }
}

init();

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
