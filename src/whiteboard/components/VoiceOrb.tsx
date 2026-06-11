import { useEffect, useRef } from "react";
import * as THREE from "three";

export type OrbState = "idle" | "listening" | "thinking" | "speaking";

export interface VoiceOrbProps {
  state?: OrbState;
  audioLevel?: number;
  size?: number;
}

interface StateTarget {
  turbulence: number;
  rotSpeed:   number;
  glowMult:   number;
  pulseAmp:   number;
  audioMult:  number;
}

const TARGETS: Record<OrbState, StateTarget> = {
  idle:      { turbulence: 0.68, rotSpeed: 0.92, glowMult: 0.95, pulseAmp: 0.12, audioMult: 0.0  },
  listening: { turbulence: 1.18, rotSpeed: 1.35, glowMult: 1.08, pulseAmp: 0.24, audioMult: 1.6  },
  thinking:  { turbulence: 1.70, rotSpeed: 1.55, glowMult: 1.14, pulseAmp: 0.30, audioMult: 0.35 },
  speaking:  { turbulence: 1.42, rotSpeed: 1.85, glowMult: 1.24, pulseAmp: 0.42, audioMult: 2.6  },
};

const PARTICLE_COUNT = 6400;

const VERT = /* glsl */`
uniform float uTime;
uniform float uAudioLevel;
uniform float uTurbulence;
uniform float uRotSpeed;
uniform float uGlowMult;
uniform float uPulseAmp;
uniform float uSzMult;

attribute float aLayer;
attribute float aRadius;
attribute float aPhase;
attribute float aSpeed;

varying float vBright;
varying float vFade;
varying float vCurrent;
varying vec3 vCol;

float hash(float n){ return fract(sin(n)*43758.5453); }
mat3 rotX(float a){
  float s=sin(a), c=cos(a);
  return mat3(1,0,0, 0,c,-s, 0,s,c);
}
mat3 rotY(float a){
  float s=sin(a), c=cos(a);
  return mat3(c,0,s, 0,1,0, -s,0,c);
}
mat3 rotZ(float a){
  float s=sin(a), c=cos(a);
  return mat3(c,-s,0, s,c,0, 0,0,1);
}

void main(){
  vec3 base = position;
  float baseLen = max(length(base), 0.001);
  vec3 dir = base/baseLen;
  vec3 up = abs(dir.y)<0.96 ? vec3(0.0,1.0,0.0) : vec3(1.0,0.0,0.0);
  vec3 tangent = normalize(cross(dir, up));
  vec3 bitangent = cross(dir, tangent);

  float stream = sin(uTime*(0.92+0.24*aSpeed)+aPhase*2.9+aRadius*9.0);
  float crossStream = cos(uTime*(0.70+0.18*aSpeed)+aPhase*4.1-aRadius*7.0);
  float orbit = uTime*uRotSpeed*(0.42+0.34*aSpeed)+aPhase;
  float pulse = uPulseAmp*sin(uTime*1.55+aPhase*3.8);
  float audioPush = uAudioLevel*(0.06+0.035*stream);
  float swirlAmp = (0.060+0.034*uTurbulence)*(1.12-aRadius*0.56);

  vec3 bandA = normalize(rotY(uTime*0.22)*rotX(0.72)*vec3(0.35,0.88,0.32));
  vec3 bandB = normalize(rotZ(uTime*0.18)*rotY(1.05)*vec3(-0.74,0.28,0.61));
  vec3 bandC = normalize(rotX(uTime*0.16)*rotZ(0.55)*vec3(0.50,-0.62,0.60));
  float laneA = abs(dot(dir, bandA)-sin(uTime*0.42+aPhase*0.09)*0.22);
  float laneB = abs(dot(dir, bandB)-cos(uTime*0.36+aPhase*0.07)*0.28);
  float laneC = abs(dot(dir, bandC)-sin(uTime*0.31+aPhase*0.11)*0.18);
  float currentA = 1.0-smoothstep(0.016,0.096,laneA);
  float currentB = 1.0-smoothstep(0.014,0.088,laneB);
  float currentC = 1.0-smoothstep(0.012,0.076,laneC);

  vec3 clusterA = normalize(vec3(sin(uTime*0.62), cos(uTime*0.41), sin(uTime*0.49+1.7)));
  vec3 clusterB = normalize(vec3(cos(uTime*0.37+2.0), sin(uTime*0.54+0.4), cos(uTime*0.46)));
  float hotA = pow(max(dot(dir, clusterA), 0.0), 56.0);
  float hotB = pow(max(dot(dir, clusterB), 0.0), 68.0);
  float shellWeight = smoothstep(0.36, 0.88, aRadius);
  float current = clamp(currentA*0.78 + currentB*0.64 + currentC*0.42 + (hotA+hotB)*shellWeight*1.05, 0.0, 1.25);

  vec3 pos = base;
  pos += tangent*sin(orbit+stream*0.9)*swirlAmp;
  pos += bitangent*cos(orbit*0.77+crossStream)*swirlAmp;
  pos += normalize(cross(bandA, dir)+0.001)*currentA*(0.030+0.018*uTurbulence);
  pos += normalize(cross(bandB, dir)+0.001)*currentB*(0.026+0.016*uTurbulence);
  pos += normalize(cross(bandC, dir)+0.001)*currentC*(0.020+0.012*uTurbulence);
  pos += normalize(clusterA-dir*dot(clusterA, dir)+0.001)*hotA*shellWeight*0.056;
  pos += normalize(clusterB-dir*dot(clusterB, dir)+0.001)*hotB*shellWeight*0.048;
  pos = normalize(pos)*clamp(baseLen*(1.0+pulse*0.10+audioPush), 0.06, 0.985);

  float yaw = uTime*uRotSpeed*0.24;
  float pitch = sin(uTime*0.36)*0.20;
  float roll = cos(uTime*0.29)*0.12;
  pos = rotY(yaw)*rotX(pitch)*rotZ(roll)*pos;

  float edgeFade = 1.0-smoothstep(0.94, 1.02, length(pos.xy));
  float depthShade = mix(0.48, 1.0, smoothstep(-0.88, 0.76, pos.z));
  float layerFade = aLayer<0.5 ? 0.74 : (aLayer<1.5 ? 0.90 : 0.76);
  vCurrent = current;
  vFade = edgeFade*layerFade*(0.62+0.26*hash(aPhase*17.1)+0.34*current);
  vBright = clamp(uGlowMult*depthShade*(0.74+0.10*stream+0.08*crossStream+current*0.54+uAudioLevel*0.46), 0.36, 1.08);
  vec3 deepBlue = vec3(0.0,0.18,0.56);
  vec3 primaryBlue = vec3(0.0,0.305882,0.807843);
  vec3 electricBlue = vec3(0.08,0.56,1.0);
  vCol = mix(deepBlue, primaryBlue, smoothstep(0.22,0.98,depthShade));
  vCol = mix(vCol, electricBlue, smoothstep(0.28,1.05,current)*0.55);

  vec4 mv = modelViewMatrix*vec4(pos,1.0);
  gl_Position = projectionMatrix*mv;
  float sz = (aLayer<0.5?3.20:(aLayer<1.5?2.68:2.02))+current*1.65+uAudioLevel*3.8+abs(pulse)*1.30;
  gl_PointSize = max(1.0, sz*uSzMult*(3.15/-mv.z));
}
`;

const FRAG = /* glsl */`
varying float vBright;
varying float vFade;
varying float vCurrent;
varying vec3 vCol;
void main(){
  vec2  c=gl_PointCoord-0.5;
  float d=length(c);
  if(d>0.5) discard;
  float a=pow(1.0-d*2.0,1.78)*vFade*(0.88+0.16*smoothstep(0.30,1.0,vCurrent));
  gl_FragColor=vec4(vCol*vBright, a);
}
`;

function buildGeo(): THREE.BufferGeometry {
  const pos    = new Float32Array(PARTICLE_COUNT * 3);
  const layer  = new Float32Array(PARTICLE_COUNT);
  const radius = new Float32Array(PARTICLE_COUNT);
  const phase  = new Float32Array(PARTICLE_COUNT);
  const speed  = new Float32Array(PARTICLE_COUNT);
  const GOLDEN = Math.PI * (1 + Math.sqrt(5));
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const theta = Math.acos(1 - 2 * (i + 0.5) / PARTICLE_COUNT);
    const phi = GOLDEN * i + Math.random() * 0.035;
    const dirX = Math.sin(theta) * Math.cos(phi);
    const dirY = Math.cos(theta);
    const dirZ = Math.sin(theta) * Math.sin(phi);
    const band = Math.random();
    const radiusBase = band < 0.12
      ? 0.24 + Math.random() * 0.32
      : band < 0.72
        ? 0.58 + Math.random() * 0.27
        : 0.83 + Math.random() * 0.13;
    const jitteredRadius = Math.min(0.975, radiusBase + (Math.random() - 0.5) * 0.018);
    pos[i*3] = dirX * jitteredRadius;
    pos[i*3+1] = dirY * jitteredRadius;
    pos[i*3+2] = dirZ * jitteredRadius;
    layer[i] = band < 0.12 ? 0 : (band < 0.72 ? 1 : 2);
    radius[i] = jitteredRadius;
    phase[i] = Math.random() * Math.PI * 2;
    speed[i] = 0.58 + Math.random() * 1.52;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos,    3));
  geo.setAttribute("aLayer",   new THREE.BufferAttribute(layer,  1));
  geo.setAttribute("aRadius",  new THREE.BufferAttribute(radius, 1));
  geo.setAttribute("aPhase",   new THREE.BufferAttribute(phase,  1));
  geo.setAttribute("aSpeed",   new THREE.BufferAttribute(speed,  1));
  return geo;
}

export function VoiceOrb({ state = "idle", audioLevel = 0, size = 500 }: VoiceOrbProps) {
  const hostRef  = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  const audioRef = useRef(audioLevel);
  stateRef.current = state;
  audioRef.current = audioLevel;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(54, 1, 0.1, 100);
    camera.position.z = 2.95;

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      premultipliedAlpha: false,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.setClearAlpha(0);
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = "100%";
    renderer.domElement.style.background = "transparent";

    const resize = () => {
      const nextSize = Math.max(1, Math.floor(host.clientWidth || size));
      renderer.setSize(nextSize, nextSize, false);
      camera.aspect = 1;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const uTime       = { value: 0 };
    const uAudioLevel = { value: 0 };
    const uTurbulence = { value: TARGETS.idle.turbulence };
    const uRotSpeed   = { value: TARGETS.idle.rotSpeed   };
    const uGlowMult   = { value: TARGETS.idle.glowMult   };
    const uPulseAmp   = { value: TARGETS.idle.pulseAmp   };
    const sharedU = { uTime, uAudioLevel, uTurbulence, uRotSpeed, uGlowMult, uPulseAmp };

    const geo = buildGeo();
    const mat = new THREE.ShaderMaterial({
      vertexShader:   VERT,
      fragmentShader: FRAG,
      uniforms:       { ...sharedU, uSzMult: { value: 1.0 } },
      blending:       THREE.NormalBlending,
      depthWrite:     false,
      depthTest:      false,
      transparent:    true,
    });
    scene.add(new THREE.Points(geo, mat));

    const cur: StateTarget = { ...TARGETS.idle };
    let smoothAudio = 0;
    const start = performance.now();
    let prev = start;
    let lastFrame = 0;
    let rafId = 0;
    const IDLE_INTERVAL = 1000 / 60;

    function lerp(a: number, b: number, k: number) { return a + (b - a) * k; }

    function frame(now: number) {
      rafId = requestAnimationFrame(frame);
      if (document.hidden) return;
      const isIdle = stateRef.current === "idle" && smoothAudio < 0.01;
      if (isIdle && now - lastFrame < IDLE_INTERVAL) return;
      lastFrame = now;

      const t  = (now - start) * 0.001;
      const dt = Math.min(0.05, (now - prev) * 0.001);
      prev = now;

      smoothAudio = lerp(smoothAudio, audioRef.current, 1 - Math.exp(-8 * dt));
      const tgt = TARGETS[stateRef.current];
      const k   = 1 - Math.exp(-2.5 * dt);
      cur.turbulence = lerp(cur.turbulence, tgt.turbulence, k);
      cur.rotSpeed   = lerp(cur.rotSpeed,   tgt.rotSpeed,   k);
      cur.glowMult   = lerp(cur.glowMult,   tgt.glowMult,   k);
      cur.pulseAmp   = lerp(cur.pulseAmp,   tgt.pulseAmp,   k);
      cur.audioMult  = lerp(cur.audioMult,  tgt.audioMult,  k);

      uTime.value       = t;
      uAudioLevel.value = smoothAudio * cur.audioMult;
      uTurbulence.value = cur.turbulence;
      uRotSpeed.value   = cur.rotSpeed;
      uGlowMult.value   = cur.glowMult;
      uPulseAmp.value   = cur.pulseAmp;

      renderer.render(scene, camera);
    }

    rafId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      geo.dispose();
      mat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [size]);

  return (
    <div
      ref={hostRef}
      className="cv-voice-orb"
      style={{
        width: `min(${size}px, calc(100vw - 48px), calc(100vh - 220px))`,
        aspectRatio: "1 / 1",
        flexShrink: 0,
      }}
    />
  );
}
