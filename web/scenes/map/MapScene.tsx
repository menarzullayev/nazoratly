"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { lerp, smooth, type SceneProps } from "../types";
import { buildCenter, type Student } from "./layout";

const DEBT = "#ff5d5d";
const LATE = "#fbbf24";

function Center({ accent }: { accent: string }) {
  const center = useMemo(() => buildCenter(6, 8), []);
  const debtors = useRef<(THREE.Mesh | null)[]>([]);
  const debtIdx = useMemo(() => center.students.map((s, i) => (s.status === "debt" ? i : -1)).filter((i) => i >= 0), [center]);
  useFrame(({ clock }) => {
    const pulse = 1 + Math.sin(clock.elapsedTime * 3) * 0.25;
    debtors.current.forEach((m) => m?.scale.setScalar(pulse));
  });
  const colorOf = (s: Student) => (s.status === "paid" ? accent : s.status === "debt" ? DEBT : LATE);
  return (
    <group>
      {center.rooms.map((r, i) => (
        <mesh key={i} position={[r.x, -0.06, r.z]}>
          <boxGeometry args={[r.size, 0.12, r.size]} />
          <meshStandardMaterial color="#14202b" roughness={0.8} />
        </mesh>
      ))}
      {center.students.map((s, i) => {
        const di = debtIdx.indexOf(i);
        return (
          <mesh
            key={i}
            position={[s.x, 0.22, s.z]}
            ref={
              di >= 0
                ? (el) => {
                    debtors.current[di] = el;
                  }
                : undefined
            }
          >
            <sphereGeometry args={[0.2, 20, 20]} />
            <meshStandardMaterial color={colorOf(s)} emissive={colorOf(s)} emissiveIntensity={s.status === "paid" ? 0.35 : 0.8} />
          </mesh>
        );
      })}
    </group>
  );
}

function Rig({ progress }: SceneProps) {
  useFrame(({ camera }) => {
    const p = smooth(progress.current);
    const cam = camera as THREE.OrthographicCamera;
    const sweep = lerp(-4, 4, p);
    cam.position.set(10 + sweep, 10, 10 - sweep * 0.5);
    cam.zoom = lerp(48, 78, p);
    cam.lookAt(sweep, 0, -sweep * 0.5);
    cam.updateProjectionMatrix();
  });
  return null;
}

export default function MapScene(props: SceneProps) {
  return (
    <Canvas dpr={[1, 2]} orthographic camera={{ position: [10, 10, 10], zoom: 48, near: -50, far: 100 }} gl={{ antialias: true, alpha: true }}
      onCreated={({ gl }) => gl.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); props.onLost?.(); })}
    >
      <ambientLight intensity={0.9} />
      <directionalLight position={[6, 10, 4]} intensity={1.5} />
      <Center accent={props.accent} />
      <Rig {...props} />
    </Canvas>
  );
}
