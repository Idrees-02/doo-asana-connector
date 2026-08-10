/**
 * The signpost, as the real 3D model.
 *
 * Fixed to the viewport and turning continuously: the page scrolls past it, the
 * post does not move, it only rotates. That is the whole brief, and it is also
 * why this is worth 2.6 MB — a still image could not do it.
 *
 * The source model was 91 MB (890k vertices, three 4K PNG textures). It ships
 * at 2.6 MB: simplified to 187k vertices, textures at 1024 as JPEG, geometry
 * meshopt-compressed. Everything here is loaded lazily and the whole component
 * is skipped on small screens, so a phone never pays for any of it.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

const MODEL_URL = '/models/signpost.glb';

/** One full turn, in seconds. Slow enough to read a plate as it passes. */
const TURN_SECONDS = 22;

export function Signpost3D() {
  const mount = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = mount.current;
    if (node === null) return;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // The model is PBR; without tone mapping the purples clip to white.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    node.appendChild(renderer.domElement);

    /*
     * Three lights rather than an environment map: an HDR would be another
     * download for a scene this simple, and a key/fill/rim rig gives the metal
     * its shape just as well.
     */
    scene.add(new THREE.HemisphereLight(0xffffff, 0xd8cfe8, 2.1));

    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, 6, 4);
    scene.add(key);

    const rim = new THREE.DirectionalLight(0xc4b5fd, 1.6);
    rim.position.set(-4, 2, -3);
    scene.add(rim);

    // The turntable: the model is parented to this, and only this spins.
    const turntable = new THREE.Group();
    scene.add(turntable);

    let raf = 0;
    let disposed = false;
    // Assigned once the model is loaded and its size is known.
    let fit: (() => void) | null = null;

    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = node;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fit?.();
    };

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

    loader.load(
      MODEL_URL,
      (gltf) => {
        if (disposed) return;

        const model = gltf.scene;

        /*
         * Frame the model from its bounding sphere rather than one axis: the
         * export's orientation is not something to assume, and fitting to
         * height alone fills the screen with a close-up when the long axis
         * turns out to be X or Z.
         *
         * Centring on the sphere also matters for the turntable — a pivot that
         * is off-centre makes the model wobble instead of spin.
         */
        const box = new THREE.Box3().setFromObject(model);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const scale = 1 / Math.max(sphere.radius, 0.001);

        model.scale.setScalar(scale);
        model.position.copy(sphere.center).multiplyScalar(-scale);

        turntable.add(model);

        /*
         * Fit the post to the viewport's HEIGHT, not its width. The frame is
         * tall and narrow, so fitting the bounding sphere to width would pull
         * the camera back until the post was a toy in the middle of a mostly
         * empty column. The signs sweep wider than the post during the turn
         * and are allowed to run past the frame edge, which is what a real
         * signpost seen from the pavement does anyway.
         */
        fit = () => {
          const vFov = (camera.fov * Math.PI) / 180;
          camera.position.set(0, 0, 1.02 / Math.sin(vFov / 2));
          camera.lookAt(0, 0, 0);
        };

        resize();
      },
      undefined,
      () => setFailed(true),
    );

    const clock = new THREE.Clock();
    const tick = (): void => {
      raf = requestAnimationFrame(tick);
      // Continuous, frame-rate independent: the same speed on a 60Hz laptop
      // and a 120Hz display.
      turntable.rotation.y += (clock.getDelta() * Math.PI * 2) / TURN_SECONDS;
      renderer.render(scene, camera);
    };

    const observer = new ResizeObserver(resize);
    observer.observe(node);

    /* Pause while the tab is hidden: a spinning canvas nobody is looking at
       is pure battery cost. */
    const onVisibility = (): void => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else if (raf === 0) {
        clock.getDelta();
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    resize();
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);

      // WebGL contexts are a limited resource; releasing them matters in an
      // SPA the user navigates in and out of.
      scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry.dispose();
        for (const material of [object.material].flat()) {
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) value.dispose();
          }
          material.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  // A failed model must not leave a hole where the post should be; the page
  // simply carries on without it.
  if (failed) return null;

  return <div ref={mount} className="welcome-post3d" aria-hidden="true" />;
}
