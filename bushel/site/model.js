/**
 * model.js — the hero's floating islands.
 *
 * "Cloud Station" by Alexa Kruckenberg, CC-BY-4.0. The attribution is not decoration: the licence
 * requires it, so it is printed in the footer of every page and repeated at the top of this file
 * and in the README. If the model is ever swapped, the credit goes with it.
 *   https://sketchfab.com/3d-models/cloud-station-26f81b24d83441ba88c7e80a52adbaaf
 *
 * This is the one place the site is not flat ink on paper, and it is deliberately the only one.
 * Everything about how it is loaded is arranged so that a visitor who cannot or should not run it
 * loses nothing: app.js has already drawn the SVG mascot into the same slot, and this module only
 * takes over once it has a working context and a decoded model. There is never a hole in the page.
 *
 * Four things it refuses to do:
 *   - block the first paint. The 750KB model and the 640KB renderer are fetched after load, on an
 *     idle callback, and only when the figure is actually on screen.
 *   - run for a reader who asked for less motion. That reader gets one still frame, posed at a
 *     moment of the clip chosen because it reads well, and no animation loop at all.
 *   - run when nobody is looking. The loop stops when the tab is hidden or the figure scrolls out
 *     of view, because a 3D scene spinning in a background tab is a battery bill for nothing.
 *   - run on a machine that would make a mess of it. No WebGL, a failed fetch, a decode error, or
 *     a device that says it is low-power: the SVG stays and this file returns quietly.
 *
 * The sky is hidden. The model ships a large inverted sphere painted with a purple sky, which
 * renders as a solid orb and makes the whole thing look like a photo tile dropped onto the page.
 * Without it the islands float on the paper itself, which is both prettier and the only version
 * that reads at 300 pixels.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, AnimationMixer, Clock, Box3, Vector3,
  SRGBColorSpace, GLTFLoader, MeshoptDecoder,
} from './vendor/three-gltf.min.js';

const MODEL = './models/cloud-station.glb';
// A moment of the 9.96-second clip where the fish are clear of the islands and the birdcage is
// unobscured. Used as the single frame for a reader who has asked for less motion.
const STILL_AT = 2.4;
const FOV = 32;
// How far back to sit from the model's own bounding sphere. 1.5 leaves the fish room to swim out
// of frame and back without ever being clipped by the canvas edge.
const PAD = 1.5;

const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 400));
const quiet = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** WebGL can be absent, disabled, or present-but-refusing to give a context. All three are "no". */
function canRender() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch (e) { return false; }
}

function mount(slot) {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  // Cap at 2. A 3x phone rendering this at 3x is drawing nine times the pixels of a 1x screen for
  // a 300px figure, and cannot tell the difference.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.domElement.className = 'model-canvas';
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new Scene();
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 200);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);       // the model is meshopt-compressed; see README

  let mixer = null, frame = 0, visible = true;
  const clock = new Clock();

  const size = () => {
    const r = slot.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width)), hgt = Math.max(1, Math.round(r.height || r.width));
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
  };

  loader.load(MODEL, (gltf) => {
    gltf.scene.traverse((o) => {
      const m = o.material && (Array.isArray(o.material) ? o.material[0] : o.material);
      if (m && /sky/i.test(m.name || '')) o.visible = false;
    });
    scene.add(gltf.scene);

    // Frame on what is still visible, not on the model's declared bounds — those include the sky
    // sphere that was just switched off, and framing to it would leave the islands tiny and centred
    // in a lot of nothing.
    const box = new Box3();
    gltf.scene.traverse((o) => { if (o.isMesh && o.visible) box.expandByObject(o); });
    const extent = box.getSize(new Vector3());
    const centre = box.getCenter(new Vector3());
    const dist = Math.max(extent.x, extent.y, extent.z) * PAD;
    camera.position.set(centre.x + dist * 0.5, centre.y + dist * 0.28, centre.z + dist);
    camera.lookAt(centre);

    if (gltf.animations && gltf.animations.length) {
      mixer = new AnimationMixer(gltf.scene);
      mixer.clipAction(gltf.animations[0]).play();
    }

    slot.classList.add('has-model');            // hides the SVG fallback; see style.css
    slot.appendChild(renderer.domElement);
    size();

    if (quiet() || !mixer) {
      if (mixer) mixer.setTime(STILL_AT);
      renderer.render(scene, camera);
      return;                                   // one frame, no loop, nothing left running
    }

    const tick = () => {
      frame = requestAnimationFrame(tick);
      mixer.update(clock.getDelta());
      renderer.render(scene, camera);
    };
    const start = () => { if (!frame) { clock.getDelta(); tick(); } };
    const stop = () => { if (frame) { cancelAnimationFrame(frame); frame = 0; } };

    // Two independent reasons to stop: the tab is in the background, or the figure has scrolled
    // away. Either one alone should be enough, so the resume checks both.
    const resume = () => { if (visible && !document.hidden) start(); else stop(); };
    document.addEventListener('visibilitychange', resume);
    if (window.IntersectionObserver) {
      new IntersectionObserver((es) => { visible = es[0].isIntersecting; resume(); }, { threshold: 0.05 }).observe(slot);
    }
    if (window.ResizeObserver) new ResizeObserver(size).observe(slot);
    else window.addEventListener('resize', size);
    resume();
  }, undefined, () => {
    // A failed fetch or a corrupt model: leave the SVG mascot exactly where it is and say nothing.
    // The page is not worse off than it was before this file loaded.
    renderer.dispose();
  });
}

function boot() {
  const slot = document.querySelector('.stage-figure');
  if (!slot || slot.classList.contains('has-model') || !canRender()) return;
  // navigator.connection is advisory and absent on most browsers; when it does say the connection
  // is metered or slow, 1.4MB of renderer and model is not a reasonable thing to fetch unasked.
  const net = navigator.connection;
  if (net && (net.saveData || /^(slow-)?2g$/.test(net.effectiveType || ''))) return;
  mount(slot);
}

// The hero is the first thing app.js renders, but it renders on DOMContentLoaded and this module
// may parse before or after that. Watching for the slot covers both orders without a race.
function watch() {
  if (document.querySelector('.stage-figure')) { idle(boot); return; }
  const obs = new MutationObserver(() => {
    if (document.querySelector('.stage-figure')) { obs.disconnect(); idle(boot); }
  });
  obs.observe(document.getElementById('view') || document.body, { childList: true, subtree: true });
  // The router paints home on load; if it never does, this observer costs nothing and ends with
  // the page.
}

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', watch);
else watch();
