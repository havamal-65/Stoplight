export const CONFIG = {
    GRID_SIZE: 5,           // 5x5 grid of city blocks
    BLOCK_SIZE: 40,         // Size of each city block
    STREET_WIDTH: 12,       // Width of streets
    SIDEWALK_WIDTH: 2,      // Width of sidewalks
    LANE_WIDTH: 3,          // Width of each lane

    LIGHT_DURATION: {
        GREEN: 8,       // Default green time per direction
        YELLOW: 2,
        ALL_RED: 1      // Clearance interval between direction changes
    },

    VEHICLE: {
        MAX_SPEED: 0.25,
        ACCELERATION: 0.008,
        DECELERATION: 0.015,
        SAFE_DISTANCE: 6,
        STOP_DISTANCE: 8
    }
};
