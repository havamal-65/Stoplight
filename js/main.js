import { initRenderer, scene, camera, renderer } from './Renderer.js';
import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';
import * as Grid from './TrafficSystem.js';
import * as Graph from './GraphTraffic.js';
import { buildNewCity } from './cities/newCity.js';
import { initInput } from './InputManager.js';
import { GameManager } from './GameManager.js';
import { initParticleSystem, updateParticles } from './ParticleSystem.js';
import { initStatsOverlay, updateStatsOverlay } from './StatsOverlay.js';

let simTime = 0;
window.simSpeed = 1; // Global for access in InputManager

// Which city to run is chosen by URL (?city=new); switching reloads the page,
// so each load builds exactly one engine and the grid path is unchanged.
const cityMode = new URLSearchParams(location.search).get('city') === 'new' ? 'new' : 'grid';

let stepEngine;      // (delta) => void   advances the active simulation
let respawn;         // (count) => void   rebuilds the vehicle fleet
let getVehicles;     // () => vehicle[]   for GameManager stats

function init() {
    initRenderer();
    initParticleSystem(scene);

    if (cityMode === 'new') {
        const net = buildNewCity();
        Graph.initGraphTraffic(scene, net);
        Graph.spawnVehicles(40);
        // Frame the wider varied city (grid camera default is too tight) and
        // push the fog back so the far side isn't washed out
        camera.position.set(0, 150, 200);
        camera.lookAt(0, 0, 0);
        scene.fog = new THREE.Fog(scene.fog.color.getHex(), 300, 750);
        stepEngine = (d) => { Graph.updateSignals(d); Graph.updateVehicles(d); };
        respawn = (n) => Graph.spawnVehicles(n);
        getVehicles = () => Graph.vehicles;
    } else {
        Grid.initTrafficSystem(scene);
        Grid.createGround();
        Grid.createCityGrid();
        Grid.spawnVehicles(30);
        stepEngine = (d) => { Grid.updateTrafficLights(d); Grid.updateVehicles(d); };
        respawn = (n) => Grid.spawnVehicles(n);
        getVehicles = () => Grid.vehicles;
    }

    initInput(renderer, scene, camera, { cityMode });
    if (cityMode === 'grid') initStatsOverlay(camera);
    GameManager.init();

    window.addEventListener('resetSimulation', () => {
        simTime = 0;
        respawn(parseInt(document.getElementById('density').value));
    });
    document.getElementById('density').addEventListener('change', (e) => {
        respawn(parseInt(e.target.value));
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

    stepEngine(delta);
    updateParticles(delta);
    if (cityMode === 'grid') updateStatsOverlay(delta);
    GameManager.update(delta, getVehicles());
    renderer.render(scene, camera);
}

init();

function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
