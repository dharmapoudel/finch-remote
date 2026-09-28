import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

/* ------------------------------------------------------------------ */
/* BloomArt: album art that "blooms" on track change                    */
/*                                                                      */
/* A <=256px WebGL canvas renders the art once per track (no per-frame */
/* JS) with a fragment shader: chromatic aberration scaled by distance  */
/* from center + a soft radial glow. If WebGL or anything else fails,   */
/* it falls back to a plain <img> + animated radial glow.              */
/* ------------------------------------------------------------------ */

const BLOOM_VERT = `
attribute vec2 a_pos;
attribute vec2 a_uv;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const BLOOM_FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform sampler2D u_tex;
void main() {
  vec2 c = vec2(0.5);
  vec2 d = v_uv - c;
  float dist = length(d);
  vec2 dir = dist > 0.0001 ? d / dist : vec2(0.0);
  // chromatic aberration grows with distance from center
  float ab = dist * 0.012;
  vec3 col;
  col.r = texture2D(u_tex, v_uv + dir * ab).r;
  col.g = texture2D(u_tex, v_uv).g;
  col.b = texture2D(u_tex, v_uv - dir * ab).b;
  // soft radial glow lifting the edges
  float glow = smoothstep(0.2, 1.0, dist);
  col += glow * vec3(0.06, 0.05, 0.04);
  gl_FragColor = vec4(col, 1.0);
}
`;

function compileBloomShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  try {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  } catch {
    return null;
  }
}

function linkBloomProgram(
  gl: WebGLRenderingContext,
  vs: WebGLShader,
  fs: WebGLShader,
): WebGLProgram | null {
  try {
    const prog = gl.createProgram();
    if (!prog) return null;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      gl.deleteProgram(prog);
      return null;
    }
    return prog;
  } catch {
    return null;
  }
}

/** Uploads img as a texture and draws it once. Returns false on any failure. */
function renderBloomOnce(
  gl: WebGLRenderingContext,
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
): boolean {
  try {
    const MAX = 256;
    const longest = Math.max(img.naturalWidth, img.naturalHeight, 1);
    const scale = Math.min(1, MAX / longest);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);

    const vs = compileBloomShader(gl, gl.VERTEX_SHADER, BLOOM_VERT);
    const fs = compileBloomShader(gl, gl.FRAGMENT_SHADER, BLOOM_FRAG);
    if (!vs || !fs) return false;
    const prog = linkBloomProgram(gl, vs, fs);
    if (!prog) {
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.useProgram(prog);

    // fullscreen quad: (x, y, u, v) x4 as a triangle strip
    const buf = gl.createBuffer();
    if (!buf) {
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    const aPos = gl.getAttribLocation(prog, "a_pos");
    const aUv = gl.getAttribLocation(prog, "a_uv");
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    const tex = gl.createTexture();
    if (!tex) {
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return false;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.uniform1i(gl.getUniformLocation(prog, "u_tex"), 0);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.deleteTexture(tex);
    gl.deleteBuffer(buf);
    gl.deleteProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return true;
  } catch {
    return false;
  }
}

function BloomLayer({ src, alt }: { src: string; alt: string }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);

  // Runs only when src changes: load, upload, render once. No per-frame JS.
  useEffect(() => {
    let cancelled = false;
    let loseExt: { loseContext(): void } | null = null;
    const canvas = canvasRef.current;

    let gl: WebGLRenderingContext | null = null;
    try {
      gl =
        canvas?.getContext("webgl", {
          antialias: false,
          alpha: false,
          preserveDrawingBuffer: false,
        }) ?? null;
    } catch {
      gl = null;
    }
    if (!gl || !canvas) {
      setFailed(true);
      return;
    }
    const activeGl = gl;
    try {
      loseExt = activeGl.getExtension("WEBGL_lose_context");
    } catch {
      loseExt = null;
    }

    const fail = () => {
      if (!cancelled) setFailed(true);
    };
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (!renderBloomOnce(activeGl, canvas, img)) fail();
    };
    img.onerror = fail;
    try {
      // src is a blob: URL — no crossOrigin needed, and the caller owns it
      // (we never revoke it here).
      img.src = src;
    } catch {
      fail();
    }

    return () => {
      cancelled = true;
      try {
        loseExt?.loseContext();
      } catch {
        /* ignored */
      }
    };
  }, [src]);

  if (failed) {
    return (
      <>
        <img src={src} alt={alt} className="h-full w-full object-cover" />
        <div className="fx-bloom-fallback" aria-hidden="true" />
      </>
    );
  }
  return <canvas ref={canvasRef} className="h-full w-full object-cover" />;
}

export function BloomArt({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt?: string;
  className?: string;
}): JSX.Element {
  if (src == null) {
    // placeholder: dark panel, no art to bloom
    return (
      <div
        className={`relative h-full w-full overflow-hidden bg-zinc-950 ${className ?? ""}`}
      />
    );
  }
  return (
    <div
      className={`relative h-full w-full overflow-hidden ${className ?? ""}`}
    >
      {/* keyed by src: a track change remounts and replays the bloom */}
      <div key={src} className="animate-bloom h-full w-full">
        <BloomLayer src={src} alt={alt ?? ""} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* GlassPanel: liquid-glass treatment for sheets/panels                */
/* Static — no per-frame JS. The SVG filter defs are injected once     */
/* per document.                                                       */
/* ------------------------------------------------------------------ */

let glassDefsInjected = false;

function ensureGlassDefs(): void {
  if (glassDefsInjected) return;
  if (typeof document === "undefined") return;
  if (document.getElementById("fx-glass-wobble")) {
    glassDefsInjected = true;
    return;
  }
  try {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.style.cssText =
      "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;";
    host.innerHTML =
      '<svg width="0" height="0" aria-hidden="true" style="position:absolute">' +
      "<defs>" +
      '<filter id="fx-glass-wobble">' +
      '<feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="2" result="n"></feTurbulence>' +
      '<feDisplacementMap in="SourceGraphic" in2="n" scale="18"></feDisplacementMap>' +
      "</filter>" +
      "</defs>" +
      "</svg>";
    document.body.appendChild(host);
    glassDefsInjected = true;
  } catch {
    /* ignored — the panel still renders without the wobble filter */
  }
}

export function GlassPanel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    ensureGlassDefs();
  }, []);

  return (
    <div
      className={className}
      style={{
        position: "relative",
        overflow: "hidden",
        backdropFilter: "blur(22px) saturate(1.6)",
        WebkitBackdropFilter: "blur(22px) saturate(1.6)",
        background:
          "linear-gradient(160deg, rgba(255,255,255,.10), rgba(255,255,255,.03) 40%, rgba(255,255,255,.08))",
        border: "1px solid rgba(255,255,255,.14)",
      }}
    >
      {/* specular highlight, warped by the injected SVG filter */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(115deg, transparent 30%, rgba(255,255,255,.14) 45%, transparent 60%)",
          filter: "url(#fx-glass-wobble)",
        }}
      />
      {children}
    </div>
  );
}
