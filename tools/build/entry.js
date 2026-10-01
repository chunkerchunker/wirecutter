// Re-export only what web/js/sim/viewer.js uses so esbuild can tree-shake the rest.
export {
  AmbientLight,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three';
export { OrbitControls } from 'three/addons/controls/OrbitControls.js';
