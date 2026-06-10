import * as THREE from 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.module.js';

let scene;
const particles = [];
const particleGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3); // Low poly cubes
const particleMat = new THREE.MeshBasicMaterial({ color: 0xaaaaaa, transparent: true, opacity: 0.8 });

export function initParticleSystem(sceneInstance) {
    scene = sceneInstance;
}

export function createExhaust(position, direction) {
    if (!scene) return;

    const mesh = new THREE.Mesh(particleGeo, particleMat.clone());

    // Position at the back of the car, slightly randomized
    const offset = new THREE.Vector3(0, 0, -2.2); // Behind car
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), direction);

    mesh.position.copy(position).add(offset);
    mesh.position.y = 0.5; // Exhaust height

    // Add some randomness
    mesh.position.x += (Math.random() - 0.5) * 0.2;
    mesh.position.z += (Math.random() - 0.5) * 0.2;

    mesh.rotation.x = Math.random() * Math.PI;
    mesh.rotation.y = Math.random() * Math.PI;

    scene.add(mesh);

    particles.push({
        mesh,
        life: 1.0, // 1 second life
        velocity: new THREE.Vector3(0, 0.5 + Math.random() * 0.5, 0) // Float up
    });
}

export function updateParticles(delta) {
    for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= delta;

        if (p.life <= 0) {
            scene.remove(p.mesh);
            p.mesh.material.dispose();
            particles.splice(i, 1);
        } else {
            // Move up
            p.mesh.position.add(p.velocity.clone().multiplyScalar(delta));
            // Fade out
            p.mesh.material.opacity = p.life;
            // Shrink
            const scale = p.life;
            p.mesh.scale.set(scale, scale, scale);
        }
    }
}
