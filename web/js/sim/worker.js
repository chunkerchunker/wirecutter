// Runs the carving simulation off the main thread.
import { simulate } from './carve.js';

self.onmessage = ({ data }) => {
  const { id, moves, stock } = data;
  const { grid, removedAt } = simulate(moves, stock);
  self.postMessage({ id, grid, removedAt }, [removedAt.buffer]);
};
