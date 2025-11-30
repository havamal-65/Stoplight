export const CONFIG = {
    GRID_SIZE: 5,           // 5x5 grid of city blocks
    BLOCK_SIZE: 40,         // Size of each city block
    STREET_WIDTH: 12,       // Width of streets
    SIDEWALK_WIDTH: 2,      // Width of sidewalks
    LANE_WIDTH: 3,          // Width of each lane

    LIGHT_DURATION: {
        GREEN: 8,
        YELLOW: 2,
        RED: 10
    },

    VEHICLE: {
        MAX_SPEED: 0.25,
        ACCELERATION: 0.008,
        DECELERATION: 0.015,
        SAFE_DISTANCE: 6,
        STOP_DISTANCE: 8,
        TURN_PROBABILITY: 0.004,  // Increased from 0.001 for more frequent turns
        LANE_CHANGE_PROBABILITY: 0.002  // New: chance to change lanes
    },

    TRAFFIC: {
        DEFAULT_DENSITY: 50,     // Increased from 30
        MIN_DENSITY: 10,
        MAX_DENSITY: 120         // Increased from 60
    }
};
