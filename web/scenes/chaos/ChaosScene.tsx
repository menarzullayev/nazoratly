"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { clamp01, lerp, smooth, type SceneProps } from "../types";
import { layoutChaos, mulberry32 } from "./data";

const N = 48;

function Cards({ progress, accent }: SceneProps) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const { chaos, order } = useMemo(() => layoutChaos(N, 7), []);
  const spin = useMemo(() => {
    const r = mulberry32(11);
    return Array.from({ length: N }, () => [(r() - 0.5) * 2.4, (r() - 0.5) * 2.4, (r() - 0.5) * 3.2] as const);
  }, []);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useEffect(() => {
    const m = mesh.current;
    if (!m) return;
    const paper = new THREE.Color("#e9eef3");
    const mark = new THREE.Color(accent);
    for (let i = 0; i < N; i++) m.setColorAt(i, i % 5 === 0 ? mark : paper);
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [accent]);

  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const t = clock.elapsedTime;
    const p = progress.current;
    for (let i = 0; i < N; i++) {
      const e = smooth((p - 0.04 - (i / N) * 0.45) / 0.4);
      const a = chaos[i]!;
      const b = order[i]!;
      const s = spin[i]!;
      const float = (1 - e) * 0.25;
      dummy.position.set(
        lerp(a[0], b[0], e) + Math.sin(t * 0.6 + i) * float,
        lerp(a[1], b[1], e) + Math.cos(t * 0.5 + i * 1.7) * float,
        lerp(a[2], b[2], e),
      );
      dummy.rotation.set(s[0] * (1 - e), s[1] * (1 - e), s[2] * (1 - e));
      dummy.scale.setScalar(lerp(0.9, 1, e));
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]}>
      <planeGeometry args={[1.25, 0.8]} />
      <meshStandardMaterial roughness={0.65} metalness={0.05} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

function Dashboard({ progress, accent }: SceneProps) {
  const group = useRef<THREE.Group>(null);
  const bars = useRef<(THREE.Mesh | null)[]>([]);
  const heights = [0.5, 0.9, 0.7, 1.3, 1.0, 1.6];
  useFrame(() => {
    const p = progress.current;
    const a = smooth((p - 0.72) / 0.2);
    if (group.current) {
      group.current.visible = a > 0.01;
      group.current.scale.setScalar(lerp(0.92, 1, a));
      group.current.position.z = lerp(-0.6, -0.05, a);
    }
    bars.current.forEach((b, i) => {
      if (!b) return;
      const h = heights[i]! * smooth((p - 0.8 - i * 0.02) / 0.15) + 0.001;
      b.scale.y = h;
      b.position.y = -1 + h / 2;
    });
  });
  return (
    <group ref={group} position={[0, 0, -0.5]}>
      <mesh>
        <planeGeometry args={[10, 4.4]} />
        <meshStandardMaterial color="#0d141c" roughness={0.9} transparent opacity={0.92} />
      </mesh>
      {heights.map((_, i) => (
        <mesh
          key={i}
          ref={(el) => {
            bars.current[i] = el;
          }}
          position={[-3.5 + i * 1.4, -1, 0.05]}
        >
          <boxGeometry args={[0.7, 1, 0.1]} />
          <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.55} />
        </mesh>
      ))}
    </group>
  );
}

function Rig({ progress, accent }: SceneProps) {
  const light = useRef<THREE.PointLight>(null);
  useFrame(({ camera }) => {
    const p = progress.current;
    camera.position.z = lerp(10, 8, smooth(p));
    camera.position.y = lerp(0.8, 0, smooth(p));
    camera.lookAt(0, 0, 0);
    if (light.current) {
      light.current.position.x = lerp(-9, 9, clamp01((p - 0.7) / 0.3));
      light.current.intensity = 40 * smooth((p - 0.65) / 0.1);
    }
  });
  return <pointLight ref={light} color={accent} position={[-9, 2, 4]} intensity={0} distance={26} />;
}

export default function ChaosScene(props: SceneProps) {
  return (
    <Canvas dpr={[1, 2]} camera={{ position: [0, 0.8, 10], fov: 45 }} gl={{ antialias: true, alpha: true }}>
      <fog attach="fog" args={["#070b10", 9, 22]} />
      <ambientLight intensity={0.8} />
      <directionalLight position={[4, 6, 5]} intensity={1.6} />
      <Cards {...props} />
      <Dashboard {...props} />
      <Rig {...props} />
    </Canvas>
  );
}
