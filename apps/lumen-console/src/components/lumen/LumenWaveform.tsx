import { useEffect, useRef } from "react";

export interface LumenWaveformProps {
  stream?: MediaStream | null;
  audioBlob?: Blob | null;
  className?: string;
  height?: number;
  lineColor?: string;
  idleColor?: string;
  backgroundColor?: string;
  ariaLabel?: string;
}

type AudioContextConstructor = new () => AudioContext;

interface CanvasSize {
  width: number;
  height: number;
}

const DEFAULT_HEIGHT = 112;

function getAudioContextConstructor(): AudioContextConstructor | undefined {
  const browserWindow = window as typeof window & { webkitAudioContext?: AudioContextConstructor };
  return window.AudioContext ?? browserWindow.webkitAudioContext;
}

function hasLiveAudio(stream: MediaStream | null | undefined): stream is MediaStream {
  return Boolean(stream?.getAudioTracks().some((track) => track.readyState === "live"));
}

function prepareCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  fallbackHeight: number,
  backgroundColor: string
): CanvasSize {
  const bounds = canvas.getBoundingClientRect();
  const width = Math.max(1, bounds.width || canvas.clientWidth || 640);
  const height = Math.max(1, bounds.height || canvas.clientHeight || fallbackHeight);
  const density = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
  const pixelWidth = Math.round(width * density);
  const pixelHeight = Math.round(height * density);

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  context.setTransform(density, 0, 0, density, 0, 0);
  context.clearRect(0, 0, width, height);
  if (backgroundColor !== "transparent") {
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, width, height);
  }

  return { width, height };
}

function drawIdleLine(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  height: number,
  color: string,
  backgroundColor: string
): void {
  const size = prepareCanvas(canvas, context, height, backgroundColor);
  context.beginPath();
  context.moveTo(0, size.height / 2);
  context.lineTo(size.width, size.height / 2);
  context.strokeStyle = color;
  context.lineWidth = 1.5;
  context.stroke();
}

function drawLiveSignal(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  signal: Uint8Array<ArrayBuffer>,
  height: number,
  color: string,
  backgroundColor: string
): void {
  const size = prepareCanvas(canvas, context, height, backgroundColor);
  const center = size.height / 2;
  const amplitude = size.height * 0.42;

  context.beginPath();
  for (let index = 0; index < signal.length; index += 1) {
    const x = (index / Math.max(1, signal.length - 1)) * size.width;
    const normalized = (signal[index] - 128) / 128;
    const y = center + normalized * amplitude;
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  }
  context.strokeStyle = color;
  context.lineWidth = 2.25;
  context.lineJoin = "round";
  context.lineCap = "round";
  context.stroke();
}

function drawDecodedSignal(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  samples: Float32Array<ArrayBufferLike>,
  height: number,
  color: string,
  backgroundColor: string
): void {
  if (samples.length === 0) {
    drawIdleLine(canvas, context, height, color, backgroundColor);
    return;
  }

  const size = prepareCanvas(canvas, context, height, backgroundColor);
  const columns = Math.max(1, Math.floor(size.width));
  const samplesPerColumn = Math.max(1, samples.length / columns);
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) peak = Math.max(peak, Math.abs(samples[index]));
  const gain = peak > 0 ? Math.min(8, 0.92 / peak) : 1;
  const center = size.height / 2;
  const amplitude = size.height * 0.46;

  context.beginPath();
  for (let column = 0; column < columns; column += 1) {
    const start = Math.floor(column * samplesPerColumn);
    const end = Math.min(samples.length, Math.max(start + 1, Math.floor((column + 1) * samplesPerColumn)));
    let minimum = 1;
    let maximum = -1;
    for (let index = start; index < end; index += 1) {
      minimum = Math.min(minimum, samples[index]);
      maximum = Math.max(maximum, samples[index]);
    }
    context.moveTo(column, center + minimum * gain * amplitude);
    context.lineTo(column, center + maximum * gain * amplitude);
  }
  context.strokeStyle = color;
  context.lineWidth = 1;
  context.stroke();
}

export function LumenWaveform({
  stream,
  audioBlob,
  className,
  height = DEFAULT_HEIGHT,
  lineColor = "#2F9E6E",
  idleColor = "#CFE4D9",
  backgroundColor = "transparent",
  ariaLabel
}: LumenWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = hasLiveAudio(stream);
  const state = live ? "live" : audioBlob ? "loaded" : "idle";
  const accessibleLabel =
    ariaLabel ??
    (live
      ? "Forma de onda del audio del micrófono en tiempo real"
      : audioBlob
        ? "Forma de onda del audio cargado"
        : "Audio en reposo");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    let disposed = false;
    let frameId: number | undefined;
    let audioContext: AudioContext | undefined;
    let source: MediaStreamAudioSourceNode | undefined;
    let analyser: AnalyserNode | undefined;
    let decodedSamples: Float32Array<ArrayBufferLike> | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const trackedAudioTracks = stream?.getAudioTracks() ?? [];

    const drawCurrentState = () => {
      if (decodedSamples) {
        drawDecodedSignal(canvas, context, decodedSamples, height, lineColor, backgroundColor);
      } else {
        drawIdleLine(canvas, context, height, idleColor, backgroundColor);
      }
    };

    const handleResize = () => drawCurrentState();
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener("resize", handleResize);
    }

    const stopLiveRendering = () => {
      if (frameId !== undefined) {
        window.cancelAnimationFrame(frameId);
        frameId = undefined;
      }
      drawIdleLine(canvas, context, height, idleColor, backgroundColor);
    };

    if (hasLiveAudio(stream)) {
      const AudioContextClass = getAudioContextConstructor();
      if (AudioContextClass) {
        try {
          audioContext = new AudioContextClass();
          analyser = audioContext.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.72;
          source = audioContext.createMediaStreamSource(stream);
          source.connect(analyser);
          const signal = new Uint8Array(analyser.fftSize);

          const render = () => {
            if (disposed || !analyser) return;
            if (!hasLiveAudio(stream)) {
              stopLiveRendering();
              return;
            }
            analyser.getByteTimeDomainData(signal);
            drawLiveSignal(canvas, context, signal, height, lineColor, backgroundColor);
            frameId = window.requestAnimationFrame(render);
          };

          void audioContext.resume().catch(() => undefined);
          frameId = window.requestAnimationFrame(render);
          trackedAudioTracks.forEach((track) => track.addEventListener("ended", stopLiveRendering));
        } catch {
          drawIdleLine(canvas, context, height, idleColor, backgroundColor);
        }
      } else {
        drawIdleLine(canvas, context, height, idleColor, backgroundColor);
      }
    } else if (audioBlob) {
      const AudioContextClass = getAudioContextConstructor();
      if (!AudioContextClass) {
        drawIdleLine(canvas, context, height, idleColor, backgroundColor);
      } else {
        const decodeContext = new AudioContextClass();
        audioContext = decodeContext;
        void (async () => {
          try {
            const encodedAudio = await audioBlob.arrayBuffer();
            const decodedAudio = await decodeContext.decodeAudioData(encodedAudio.slice(0));
            if (disposed) return;
            decodedSamples = decodedAudio.getChannelData(0);
            drawCurrentState();
          } catch {
            if (!disposed) drawIdleLine(canvas, context, height, idleColor, backgroundColor);
          } finally {
            if (decodeContext.state !== "closed") await decodeContext.close().catch(() => undefined);
            if (audioContext === decodeContext) audioContext = undefined;
          }
        })();
      }
    } else {
      drawIdleLine(canvas, context, height, idleColor, backgroundColor);
    }

    return () => {
      disposed = true;
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener("resize", handleResize);
      trackedAudioTracks.forEach((track) => track.removeEventListener("ended", stopLiveRendering));
      source?.disconnect();
      analyser?.disconnect();
      if (audioContext && audioContext.state !== "closed") void audioContext.close();
      // The stream belongs to the caller. Its tracks must remain alive after this component unmounts.
    };
  }, [audioBlob, backgroundColor, height, idleColor, lineColor, stream]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      data-waveform-state={state}
      role="img"
      aria-label={accessibleLabel}
      style={{ display: "block", width: "100%", height }}
    >
      {accessibleLabel}
    </canvas>
  );
}
