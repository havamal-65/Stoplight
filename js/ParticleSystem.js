import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';

// Exhaust puffs live in a fixed-size InstancedMesh pool: one draw call,
// no per-particle scene objects or material clones.
const MAX_PARTICLES = 600;

let mesh = null;
const particles = [];
const dummy = new THREE.Object3D();

export function initParticleSystem(sceneInstance) {
    const geo = new THREE.BoxGeometry(0.3, 0.3, 0.3); // Low poly cubes
    const mat = new THREE.MeshBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.6, depthWrite: false });
    mesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    mesh.frustumCulled = false;
    mesh.count = 0;
    sceneInstance.add(mesh);
}

export function createExhaust(position, direction) {
    if (!mesh || particles.length >= MAX_PARTICLES) return;

    particles.push({
        // Behind the car, slightly randomized
        x: position.x - Math.sin(direction) * 2.2 + (Math.random() - 0.5) * 0.2,
        y: 0.5, // Exhaust height
        z: position.z - Math.cos(direction) * 2.2 + (Math.random() - 0.5) * 0.2,
        rotX: Math.random() * Math.PI,
        rotY: Math.random() * Math.PI,
        life: 1.0, // 1 second life
        velocityY: 0.5 + Math.random() * 0.5 // Float up
    });
}

export function updateParticles(delta) {
    if (!mesh) return;

    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= delta;
        if (p.life <= 0) {
            // Swap-remove keeps the array dense
            particles[i] = particles[particles.length - 1];
            particles.pop();
        } else {
            p.y += p.velocityY * delta;
        }
    }

    for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        dummy.position.set(p.x, p.y, p.z);
        dummy.rotation.set(p.rotX, p.rotY, 0);
        dummy.scale.setScalar(Math.max(p.life, 0.01)); // Shrink as it fades
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
    }
    mesh.count = particles.length;
    mesh.instanceMatrix.needsUpdate = true;
}
