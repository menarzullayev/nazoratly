"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { smooth, type SceneProps } from "../types";
import { ANCHORS, flowPoint } from "./path";

const N = 140;
const at = (v: readonly [number, number, number]): [number, number, number] => [v[0], v[1], v[2]];

function Stream({ progress, accent }: SceneProps) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  useFrame(({ clock }) => {
    const m = mesh.current;
    if (!m) return;
    const reach = Math.min(1, progress.current * 1.15);
    for (let i = 0; i < N; i++) {
      const base = (i / N + clock.elapsedTime * 0.08) % 1;
      const p = flowPoint(base * reach);
      const wobble = Math.sin(clock.elapsedTime * 2 + i) * 0.06;
      dummy.position.set(p[0], p[1] + wobble, p[2]);
      dummy.scale.setScalar(reach > 0.02 ? 0.05 + 0.05 * Math.sin(base * Math.PI) : 0.0001);
      dummy.updateMatrix();
      m.setMatrixAt(i, dummy.matrix);
    }
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial color={accent} />
    </instancedMesh>
  );
}

function Sheet() {
  const rows = [0, 1, 2, 3, 4];
  return (
    <group position={at(ANCHORS.sheet)}>
      <mesh>
        <boxGeometry args={[2.6, 3.2, 0.12]} />
        <meshStandardMaterial color="#e9eef3" roughness={0.7} />
      </mesh>
      {rows.map((r) => (
        <mesh key={r} position={[0, 1.2 - r * 0.6, 0.07]}>
          <boxGeometry args={[2.2, 0.08, 0.02]} />
          <meshStandardMaterial color="#9fb0c0" />
        </mesh>
      ))}
    </group>
  );
}

function Bot({ progress, accent }: SceneProps) {
  const ref = useRef<THREE.Mesh>(null);
  useFrame(({ clock }) => {
    if (!ref.current) return;
    ref.current.rotation.y = clock.elapsedTime * 0.6;
    ref.current.rotation.x = clock.elapsedTime * 0.3;
    ref.current.scale.setScalar(1 + 0.15 * smooth((progress.current - 0.35) / 0.2));
  });
  return (
    <mesh ref={ref} position={at(ANCHORS.bot)}>
      <icosahedronGeometry args={[0.8, 1]} />
      <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.5} wireframe />
    </mesh>
  );
}

function Phone({ progress, accent }: SceneProps) {
  const card = useRef<THREE.Mesh>(null);
  useFrame(() => {
    if (!card.current) return;
    const a = smooth((progress.current - 0.82) / 0.15);
    card.current.scale.set(a, a, 1);
  });
  return (
    <group position={at(ANCHORS.phone)} rotation={[0, -0.25, 0]}>
      <mesh>
        <boxGeometry args={[1.7, 3.3, 0.14]} />
        <meshStandardMaterial color="#0d141c" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh ref={card} position={[0, 0.2, 0.09]}>
        <planeGeometry args={[1.35, 1.1]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.6} />
      </mesh>
    </group>
  );
}

function Rig({ progress }: SceneProps) {
  useFrame(({ camera }) => {
    const p = smooth(progress.current);
    camera.position.x = -1.5 + p * 3;
    camera.position.z = 11 - p * 1.5;
    camera.lookAt(0, 0.8, 0);
  });
  return null;
}

export default function FlowScene(props: SceneProps) {
  return (
    <Canvas dpr={[1, 2]} camera={{ position: [-1.5, 1, 11], fov: 42 }} gl={{ antialias: true, alpha: true }}>
      <ambientLight intensity={0.9} />
      <directionalLight position={[3, 5, 6]} intensity={1.4} />
      <Sheet />
      <Bot {...props} />
      <Phone {...props} />
      <Stream {...props} />
      <Rig {...props} />
    </Canvas>
  );
}
