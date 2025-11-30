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
        STOP_DISTANCE: 8
    }
};
