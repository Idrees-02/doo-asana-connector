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
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });

    /*
     * Cap the pixel ratio at 1.5 rather than 2. On a Retina display the
     * difference is invisible at this size, and the cost is not: a 2x buffer is
     * 1.8x the fragments of a 1.5x one, every frame, forever. This was the
     * single largest source of jank on the page.
     */
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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

        /*
         * X and Z must sit on the rotation axis or the post wobbles instead of
         * spinning. Y is free, and it is set in `fit` below — the base is
         * planted on the bottom of the frame, so the post stands on the page
         * rather than floating in the middle of it.
         */
        const axisX = -sphere.center.x * scale;
        const axisZ = -sphere.center.z * scale;
        const footY = box.min.y * scale;
        const modelHeight = (box.max.y - box.min.y) * scale;

        turntable.add(model);

        /*
         * Fit BOTH axes, and take whichever is more demanding. The signs sweep
         * out past the post as it turns, so a fit that only satisfied height
         * pushed them off the frame — the object has to fit the narrow axis
         * too, at every angle of the turn, which is what the bounding sphere
         * guarantees.
         */
        /*
         * Frame the post the way a photograph of one would be framed: standing
         * on the ground, filling most of the height.
         *
         * Solved from the height directly rather than from a bounding sphere.
         * The sphere includes the signs' horizontal reach, so fitting it put
         * the post at a fraction of the frame and left the impression that
         * nothing was there. Here the column occupies a fixed share of the
         * height whatever the viewport, and its base sits a tenth of the way up
         * from the bottom, which is where a pavement would be.
         */
        // Under two thirds of the frame, standing well clear of the bottom
        // edge: at 0.85 it dominated the page, and a base planted on the very
        // edge reads as cut off rather than as standing on something.
        const HEIGHT_SHARE = 0.58;
        const GROUND_SHARE = 0.31;

        fit = () => {
          const vFov = (camera.fov * Math.PI) / 180;
          const distance = modelHeight / (HEIGHT_SHARE * 2 * Math.tan(vFov / 2));

          camera.position.set(0, 0, distance);
          camera.lookAt(0, 0, 0);

          const visibleHeight = 2 * distance * Math.tan(vFov / 2);
          const ground = -visibleHeight / 2 + visibleHeight * GROUND_SHARE;
          model.position.set(axisX, ground - footY, axisZ);
        };

        resize();
      },
      undefined,
      () => setFailed(true),
    );

    const clock = new THREE.Clock();

    /*
     * Rendered at 36fps, not at the display's refresh rate. The object turns
     * once every 22 seconds; nobody can tell 36 from 120 at that speed, and the
     * frames saved are frames the browser can spend on scrolling, which people
     * absolutely can tell.
     */
    const FRAME_MS = 1000 / 36;
    let last = 0;

    const tick = (now = 0): void => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;

      // Frame-rate independent: the same speed whatever the cadence.
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
        last = 0;
        tick();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    /*
     * Stop entirely when the post is scrolled out of view. It is fixed, so this
     * mostly matters on the sections below the fold at narrow-but-visible
     * widths — and a renderer that runs while off-screen is pure waste.
     */
    const visibility = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting === true) {
        if (raf === 0) {
          clock.getDelta();
          last = 0;
          tick();
        }
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    });
    visibility.observe(node);

    resize();
    tick();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      visibility.disconnect();
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
