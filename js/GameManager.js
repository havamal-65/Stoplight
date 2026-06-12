export const GameManager = {
    score: 0,
    efficiency: 100,
    level: 1,
    totalVehicles: 0,
    arrivedVehicles: 0,
    stoppedTime: 0,
    state: 'playing', // playing, gameover, levelcomplete

    init: function () {
        const btn = document.getElementById('modalButton');
        if (btn) btn.addEventListener('click', () => this.reset());
    },

    update: function (delta, vehicles) {
        if (this.state !== 'playing') return;

        // Single pass over the fleet; cars queued at the ramps don't count
        let active = 0;
        let stoppedCount = 0;
        let speedSum = 0;
        for (const v of vehicles) {
            if (v.waitingToEnter) continue;
            active++;
            speedSum += v.speed;
            if (v.stopped) stoppedCount++;
        }
        const total = active || 1;

        // Decay efficiency if traffic is stopped
        if (stoppedCount > 0) {
            this.efficiency -= (stoppedCount / total) * delta * 2;
        } else {
            this.efficiency += delta * 0.5;
        }

        this.efficiency = Math.max(0, Math.min(100, this.efficiency));

        // Update UI
        const effEl = document.getElementById('efficiencyValue');
        if (effEl) effEl.textContent = Math.round(this.efficiency) + '%';

        const arrEl = document.getElementById('arrivedCount');
        if (arrEl) arrEl.textContent = this.arrivedVehicles;

        const countEl = document.getElementById('vehicleCount');
        if (countEl) countEl.textContent = active;

        const stoppedEl = document.getElementById('stoppedCount');
        if (stoppedEl) stoppedEl.textContent = stoppedCount;

        const avgEl = document.getElementById('avgSpeed');
        if (avgEl) avgEl.textContent = Math.round((speedSum / total) * 100);

        // Color code efficiency
        if (effEl) {
            if (this.efficiency > 80) effEl.style.color = '#4caf50';
            else if (this.efficiency > 50) effEl.style.color = '#ffeb3b';
            else effEl.style.color = '#f44336';
        }

        // Win/Loss conditions removed for endless mode
        /*
        if (this.efficiency <= 0) {
            this.gameOver();
        } else if (this.arrivedVehicles >= 20) {
            this.levelComplete();
        }
        */
    },

    gameOver: function () {
        this.state = 'gameover';
        showModal('Traffic Jam!', 'The city is gridlocked. Try again!', 'Retry Level');
    },

    levelComplete: function () {
        this.state = 'levelcomplete';
        showModal('Level Complete!', `You transported ${this.arrivedVehicles} vehicles with ${Math.round(this.efficiency)}% efficiency.`, 'Next Level');
    },

    reset: function () {
        this.score = 0;
        this.efficiency = 100;
        this.arrivedVehicles = 0;
        this.state = 'playing';

        const overlay = document.getElementById('modalOverlay');
        if (overlay) overlay.style.display = 'none';

        // main.js listens for this: resets the clock and respawns vehicles
        window.dispatchEvent(new CustomEvent('resetSimulation'));
    }
};

function showModal(title, message, buttonText) {
    const titleEl = document.getElementById('modalTitle');
    const msgEl = document.getElementById('modalMessage');
    const btnEl = document.getElementById('modalButton');
    const overlay = document.getElementById('modalOverlay');

    if (titleEl) titleEl.textContent = title;
    if (msgEl) msgEl.textContent = message;
    if (btnEl) btnEl.textContent = buttonText;
    if (overlay) overlay.style.display = 'flex';
}
