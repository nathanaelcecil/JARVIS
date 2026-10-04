import { useEffect, useRef, useState, useCallback } from "react";
import { Camera, X } from "lucide-react";

interface CameraPanelProps {
  active: boolean;
  onClose: () => void;
  onCapture: (imageData: string) => void;
}

export function CameraPanel({ active, onClose, onCapture }: CameraPanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) {
      // Stop camera when deactivated
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      return;
    }

    const startCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 320, height: 240 },
        });
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
        setError(null);
      } catch (err) {
        setError("Camera access denied or unavailable.");
        console.error("Camera error:", err);
      }
    };

    startCamera();

    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    };
  }, [active]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;

    canvas.width = video.videoWidth || 320;
    canvas.height = video.videoHeight || 240;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    onCapture(dataUrl);
  }, [onCapture]);

  if (!active) return null;

  return (
    <div className="absolute bottom-24 right-4 z-20 border border-hud-edge/60 bg-black/80 backdrop-blur-sm">
      <div className="flex items-center justify-between px-2 py-1 border-b border-hud-line/30">
        <span className="hud-mono text-[9px] tracking-wider text-hud-dim">
          CAMERA FEED
        </span>
        <button
          onClick={onClose}
          className="text-hud-dim hover:text-hud transition-colors"
        >
          <X size={12} />
        </button>
      </div>
      <div className="relative">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="w-[160px] h-[120px] object-cover"
        />
        <canvas ref={canvasRef} className="hidden" />
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <p className="hud-mono text-[9px] text-hud-dim px-2 text-center">
              {error}
            </p>
          </div>
        )}
      </div>
      <button
        onClick={captureFrame}
        className="w-full flex items-center justify-center gap-1 py-1 border-t border-hud-line/30 hud-mono text-[9px] tracking-wider text-hud-dim hover:text-hud hover:bg-hud-fill transition-colors"
      >
        <Camera size={10} />
        CAPTURE FRAME
      </button>
    </div>
  );
}
