/**
 * Client-side media helpers for chat attachments:
 *  - downscaleImage: shrink an image file to a <=maxDim JPEG data URL
 *  - sampleVideoFrames: extract N evenly-spaced frames from a video file
 *  - readTextFile: read a markdown/text file, capped at a char budget
 *
 * All processing happens in the browser — no server upload, no ffmpeg.
 */

export interface FrameSample {
  dataUrl: string;
  timeSeconds: number;
}

const MAX_IMAGE_DIM = 1024;
const MAX_FRAME_DIM = 768;
export const FRAMES_PER_VIDEO = 8;
const JPEG_QUALITY = 0.72;
export const MAX_TEXT_CHARS = 12_000;

function drawToDataUrl(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxDim: number,
): string {
  const scale = Math.min(1, maxDim / Math.max(width, height, 1));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(source, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/** Downscale an image file to a JPEG data URL (<= maxDim px on the long edge). */
export async function downscaleImage(
  file: File,
  maxDim: number = MAX_IMAGE_DIM,
): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("could not decode image"));
      el.src = url;
    });
    return drawToDataUrl(img, img.naturalWidth, img.naturalHeight, maxDim);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Resolve a usable duration. MediaRecorder-captured blobs (and some webms)
 * report `duration: null`/Infinity until played — try, in order: the
 * seekable range, then a seek-past-end probe (browsers clamp currentTime to
 * the real end), then a conservative 10s.
 */
async function resolveDuration(video: HTMLVideoElement): Promise<number> {
  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }
  try {
    if (video.seekable.length > 0) {
      const end = video.seekable.end(video.seekable.length - 1);
      if (Number.isFinite(end) && end > 0) return end;
    }
  } catch {
    // seekable can throw on some elements — fall through
  }
  // Seek far past the end: the browser clamps currentTime to the real end
  const probed = await new Promise<number>((resolve) => {
    const timer = setTimeout(() => resolve(0), 2_000);
    const onSeeked = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      resolve(video.currentTime);
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = 1e6;
  });
  if (Number.isFinite(probed) && probed > 0.5) {
    video.currentTime = 0;
    return probed;
  }
  return 10;
}

/** Seek a video element to an exact time and wait for the frame to be ready. */
function seekTo(video: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      reject(new Error("frame seek timeout"));
    }, 10_000);
    const onSeeked = () => {
      clearTimeout(timer);
      video.removeEventListener("seeked", onSeeked);
      resolve();
    };
    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = t;
  });
}

/**
 * Extract `count` evenly-spaced frames from a video file as JPEG data URLs.
 * Frames are taken at (i + 0.5) / count of the duration so first/last frames
 * aren't black.
 */
export async function sampleVideoFrames(
  file: File,
  count: number = FRAMES_PER_VIDEO,
): Promise<FrameSample[]> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;

  const frames: FrameSample[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("video metadata timeout")),
        15_000,
      );
      video.onloadedmetadata = () => {
        clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        clearTimeout(timer);
        reject(new Error("could not decode video"));
      };
    });

    const duration = await resolveDuration(video);
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error("video has no duration");
    }
    if (!video.videoWidth || !video.videoHeight) {
      throw new Error("no video track found (audio only?)");
    }

    for (let i = 0; i < count; i++) {
      const t = Math.min(duration - 0.05, ((i + 0.5) / count) * duration);
      await seekTo(video, t);
      frames.push({
        dataUrl: drawToDataUrl(
          video,
          video.videoWidth,
          video.videoHeight,
          MAX_FRAME_DIM,
        ),
        timeSeconds: t,
      });
    }
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
  return frames;
}

/** Read a text/markdown file, capped at maxChars with a truncation flag. */
export async function readTextFile(
  file: File,
  maxChars: number = MAX_TEXT_CHARS,
): Promise<{ text: string; truncated: boolean; totalChars: number }> {
  const text = await file.text();
  const truncated = text.length > maxChars;
  return {
    text: truncated ? text.slice(0, maxChars) : text,
    truncated,
    totalChars: text.length,
  };
}
