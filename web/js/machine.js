// Machine constants shared by the control UI and the simulator.

// Platform rotation is driven differentially by the Y and A motors:
// rotation (degrees) = (A - Y) / MM_PER_DEG, where A and Y are motor positions in mm.
export const MM_PER_DEG = (11 * Math.PI / 360) * (108 / 20);

export const MAX_FEED = 6500;  // mm/min, per-axis max rate in config.yaml
