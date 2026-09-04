"use client";

import { Canvas, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Color,
  ShaderMaterial,
  Uniform,
  Vector2,
  type Mesh,
} from "three";

const PIXELS = [
  1, 1.5, 2, 2.5, 3, 1, 1.5, 2, 2.5, 3, 3.5, 4, 2, 2.5, 3, 3.5, 4,
  4.5, 5, 5.5, 6, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 8.5, 9,
  20, 100,
].map((pixel) => pixel / 100);

const BLAST_TRANSITION_SECONDS = 1.75;
const LIGHT_MODE_HOLD_SECONDS = 2.5;
const DARK_MODE_HOLD_SECONDS = 1.25;

const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// This is the BackgroundSquares fragment shader extracted from float-web.
const FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uFillColor;
  uniform vec3 uFillColor2;
  uniform vec3 uActualColor;
  uniform float uProgress;
  uniform float uType;
  uniform float uPixels[36];
  uniform vec2 uTextureSize;
  uniform vec2 uElementSize;
  uniform float uRemValue;

  varying vec2 vUv;

  vec3 blendNormal(vec3 base, vec3 blend) {
    return blend;
  }

  vec3 blendNormal(vec3 base, vec3 blend, float opacity) {
    return (blendNormal(base, blend) * opacity + base * (1.0 - opacity));
  }

  float blendOverlay(float base, float blend) {
    return base < 0.5
      ? (2.0 * base * blend)
      : (1.0 - 2.0 * (1.0 - base) * (1.0 - blend));
  }

  vec3 blendOverlay(vec3 base, vec3 blend) {
    return vec3(
      blendOverlay(base.r, blend.r),
      blendOverlay(base.g, blend.g),
      blendOverlay(base.b, blend.b)
    );
  }

  vec3 blendOverlay(vec3 base, vec3 blend, float opacity) {
    return (blendOverlay(base, blend) * opacity + base * (1.0 - opacity));
  }

  float blendSubtract(float base, float blend) {
    return max(base + blend - 1.0, 0.0);
  }

  vec3 blendSubtract(vec3 base, vec3 blend) {
    return max(base + blend - vec3(1.0), vec3(0.0));
  }

  vec3 blendSubtract(vec3 base, vec3 blend, float opacity) {
    return (blendSubtract(base, blend) * opacity + base * (1.0 - opacity));
  }

  float hashwithoutsine12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }

  vec2 fade(vec2 t) {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }

  vec4 permute(vec4 x) {
    return mod(((x * 34.0) + 1.0) * x, 289.0);
  }

  vec4 taylorInvSqrt(vec4 r) {
    return 1.79284291400159 - 0.85373472095314 * r;
  }

  vec3 fade(vec3 t) {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  }

  float cnoise(vec2 P) {
    vec4 Pi = floor(P.xyxy) + vec4(0.0, 0.0, 1.0, 1.0);
    vec4 Pf = fract(P.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
    Pi = mod(Pi, 289.0);
    vec4 ix = Pi.xzxz;
    vec4 iy = Pi.yyww;
    vec4 fx = Pf.xzxz;
    vec4 fy = Pf.yyww;
    vec4 i = permute(permute(ix) + iy);
    vec4 gx = 2.0 * fract(i * 0.0243902439) - 1.0;
    vec4 gy = abs(gx) - 0.5;
    vec4 tx = floor(gx + 0.5);
    gx = gx - tx;
    vec2 g00 = vec2(gx.x, gy.x);
    vec2 g10 = vec2(gx.y, gy.y);
    vec2 g01 = vec2(gx.z, gy.z);
    vec2 g11 = vec2(gx.w, gy.w);
    vec4 norm = 1.79284291400159 - 0.85373472095314 *
      vec4(dot(g00, g00), dot(g01, g01), dot(g10, g10), dot(g11, g11));
    g00 *= norm.x;
    g01 *= norm.y;
    g10 *= norm.z;
    g11 *= norm.w;
    float n00 = dot(g00, vec2(fx.x, fy.x));
    float n10 = dot(g10, vec2(fx.y, fy.y));
    float n01 = dot(g01, vec2(fx.z, fy.z));
    float n11 = dot(g11, vec2(fx.w, fy.w));
    vec2 fade_xy = fade(Pf.xy);
    vec2 n_x = mix(vec2(n00, n01), vec2(n10, n11), fade_xy.x);
    float n_xy = mix(n_x.x, n_x.y, fade_xy.y);
    return 2.3 * n_xy;
  }

  float PristineGrid(vec2 uv, vec2 lineWidth) {
    vec4 uvDDXY = vec4(dFdx(uv), dFdy(uv));
    vec2 uvDeriv = vec2(length(uvDDXY.xz), length(uvDDXY.yw));
    bool invertLine = lineWidth.x > 0.5;
    vec2 targetWidth = invertLine ? vec2(1.0) - lineWidth : lineWidth;
    vec2 drawWidth = clamp(targetWidth, uvDeriv, vec2(0.5));
    vec2 lineAA = max(uvDeriv, 0.000001) * 5.5;
    vec2 gridUV = abs(fract(uv) * 2.0 - 1.0);
    gridUV = invertLine ? gridUV : 1.0 - gridUV;
    vec2 grid2 = smoothstep(drawWidth + lineAA, drawWidth - lineAA, gridUV);
    grid2 *= clamp(targetWidth / drawWidth, 0., 1.);
    grid2 = mix(grid2, targetWidth, clamp(uvDeriv * 2.0 - vec2(1.0), vec2(0.), vec2(1.)));
    grid2 = invertLine ? 1.0 - grid2 : grid2;
    return mix(grid2.x, 1.0, grid2.y);
  }

  float cubicOut(float t) {
    float f = t - 1.0;
    return f * f * f + 1.0;
  }

  float quadraticOut(float t) {
    return -t * (t - 2.0);
  }

  float cubicIn(float t) {
    return t * t * t;
  }

  float qinticIn(float t) {
    return pow(t, 4.0);
  }

  float map(float value, float min1, float max1, float min2, float max2) {
    float val = min2 + (value - min1) * (max2 - min2) / (max1 - min1);
    return clamp(val, min2, max2);
  }

  float cubicInOut(float t) {
    return t < 0.5
      ? 4.0 * t * t * t
      : 0.5 * pow(2.0 * t - 2.0, 3.0) + 1.0;
  }

  float quarticInOut(float t) {
    return t < 0.5
      ? +8.0 * pow(t, 4.0)
      : -8.0 * pow(t - 1.0, 4.0) + 1.0;
  }

  float quadraticInOut(float t) {
    float p = 2.0 * t * t;
    return t < 0.5 ? p : -p + (4.0 * t) - 1.0;
  }

  float parabola(float x, float k) {
    return pow(4. * x * (1. - x), k);
  }

  void main() {
    vec2 uv = vUv - vec2(0.5);
    float aspect1 = uTextureSize.x / uTextureSize.y;
    float aspect2 = uElementSize.x / uElementSize.y;

    if (aspect1 > aspect2) {
      uv *= vec2(aspect2 / aspect1, 1.);
    } else {
      uv *= vec2(1., aspect1 / aspect2);
    }
    uv += vec2(0.5);

    float uAspect = uElementSize.x / uElementSize.y * 1.0;
    float remBasedSize = uElementSize.x / (uRemValue / 4.0);
    float s = remBasedSize;
    vec2 gridSize = vec2(s, floor(s / uAspect));
    vec2 newUV = floor(vUv * gridSize);
    float x = floor(vUv.x * 10.);
    float y = floor(vUv.y * 10.);
    float pattern = hashwithoutsine12(newUV);
    float w = 0.5;
    float p0 = clamp((uProgress - 0.2 * 0.) / 0.8, 0., 1.);
    float p1 = clamp((uProgress - 0.2 * .1) / 0.8, 0., 1.);
    p0 = map(p0, 0., 1., -s, 1.);
    p0 = smoothstep(p0, p0 + s, cnoise(newUV));
    float p0_ = clamp(1. - 2. * p0 + pattern, 0., 1.);
    vec3 finalColor = mix(uFillColor, uFillColor2.rgb, p0_);
    float a = 1.0 - round(finalColor.r);
    gl_FragColor = vec4(uActualColor, a);
  }
`;

export function BackgroundSquares() {
  const [isDocumentVisible, setIsDocumentVisible] = useState(
    typeof document === "undefined" || !document.hidden,
  );
  const [dpr, setDpr] = useState(0.85);

  useEffect(() => {
    const onVisibilityChange = () => setIsDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  useEffect(() => {
    // Flow recalculates its DPR after mount from the browser's pixel ratio.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDpr(0.85 * Math.min(window.devicePixelRatio, 1));
  }, []);

  return (
    <Canvas dpr={dpr} frameloop={isDocumentVisible ? "demand" : "never"} linear orthographic flat>
      <SquaresPlane />
    </Canvas>
  );
}

function SquaresPlane() {
  const meshRef = useRef<Mesh>(null);
  const viewport = useThree((state) => state.viewport);
  const invalidate = useThree((state) => state.invalidate);
  const [rootRem, setRootRem] = useState(() =>
    typeof document === "undefined"
      ? 16
      : Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
  );

  // Flow owns one persistent shader material and updates its uniforms in place.
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader: VERTEX_SHADER,
        fragmentShader: FRAGMENT_SHADER,
        transparent: true,
        uniforms: {
          uTime: new Uniform(0),
          uFillColor: new Uniform(new Color("#ffffff")),
          uFillColor2: new Uniform(new Color("#000000")),
          uActualColor: new Uniform(new Color("#000000")),
          uProgress: new Uniform(0),
          uPixels: new Uniform(PIXELS),
          uType: new Uniform(2),
          uTexture: new Uniform(null),
          uTextureSize: new Uniform(new Vector2(1, 1)),
          uElementSize: new Uniform(new Vector2(1, 1)),
          uRemValue: new Uniform(16),
        },
      }),
    [],
  );

  useEffect(() => {
    const readRootRem = () => Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const observer = new ResizeObserver(() => setRootRem(readRootRem()));
    observer.observe(document.documentElement);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const shader = meshRef.current?.material as ShaderMaterial | undefined;
    if (!shader) return;
    shader.uniforms.uTextureSize.value.set(viewport.width, viewport.height);
    shader.uniforms.uElementSize.value.set(viewport.width, viewport.height);
    shader.uniforms.uRemValue.value = rootRem;
    invalidate();
  }, [invalidate, rootRem, viewport.height, viewport.width]);

  useEffect(() => {
    const shader = meshRef.current?.material as ShaderMaterial | undefined;
    if (!shader) return;
    const progress = shader.uniforms.uProgress;
    gsap.killTweensOf(progress);

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      gsap.set(progress, { value: 0.15 });
      invalidate();
      return;
    }

    const timeline = gsap.timeline({
      repeat: -1,
      onUpdate: invalidate,
    });
    timeline
      .set(progress, { value: 0.15 })
      .to(progress, { value: 0.15, duration: LIGHT_MODE_HOLD_SECONDS, ease: "none" })
      .to(progress, { value: 0.9, duration: BLAST_TRANSITION_SECONDS, ease: "none" })
      .to(progress, { value: 0.9, duration: DARK_MODE_HOLD_SECONDS, ease: "none" })
      .to(progress, { value: 0.15, duration: BLAST_TRANSITION_SECONDS, ease: "none" });
    invalidate();
    return () => {
      timeline.kill();
    };
  }, [invalidate]);

  useEffect(() => () => material.dispose(), [material]);

  return (
    <mesh ref={meshRef} scale={[viewport.width, viewport.height, 1]}>
      <planeGeometry />
      <primitive object={material} attach="material" />
    </mesh>
  );
}
