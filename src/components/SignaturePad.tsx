import React, { useRef, useEffect, useState } from 'react';
import { RotateCcw, PenTool } from 'lucide-react';

interface SignaturePadProps {
  value?: string;
  onChange: (dataUrl: string) => void;
  label?: string;
  height?: number;
  placeholder?: string;
}

export default function SignaturePad({
  value = '',
  onChange,
  label = 'Draw Signature',
  height = 110,
  placeholder = 'Sign here with mouse, stylus, or finger',
}: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const hasStrokeRef = useRef(false);
  const [hasContent, setHasContent] = useState(Boolean(value));

  // Sync external value onto canvas when cleared or initialized
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const displayWidth = canvas.clientWidth || 320;
    const displayHeight = height;

    if (canvas.width !== Math.floor(displayWidth * dpr) || canvas.height !== Math.floor(displayHeight * dpr)) {
      canvas.width = Math.floor(displayWidth * dpr);
      canvas.height = Math.floor(displayHeight * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    ctx.clearRect(0, 0, displayWidth, displayHeight);

    if (value) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, displayWidth, displayHeight);
        ctx.drawImage(img, 0, 0, displayWidth, displayHeight);
        hasStrokeRef.current = true;
        setHasContent(true);
      };
      img.src = value;
    } else {
      hasStrokeRef.current = false;
      setHasContent(false);
    }
  }, [value, height]);

  const getPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const displayWidth = canvas.clientWidth || 320;
    if (canvas.width !== Math.floor(displayWidth * dpr)) {
      canvas.width = Math.floor(displayWidth * dpr);
      canvas.height = Math.floor(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    canvas.setPointerCapture(e.pointerId);
    const pt = getPoint(e);
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(pt.x, pt.y);
    isDrawingRef.current = true;
    hasStrokeRef.current = true;
    setHasContent(true);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pt = getPoint(e);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
  };

  const finishStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {}
    if (hasStrokeRef.current) {
      onChange(canvas.toDataURL('image/png'));
    }
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    hasStrokeRef.current = false;
    setHasContent(false);
    onChange('');
  };

  return (
    <div className="flex flex-col gap-1.5 w-full">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[9px] text-slate-500 font-bold uppercase tracking-wider flex items-center gap-1">
          <PenTool size={10} className="text-indigo-600" />
          {label}
        </span>
        {hasContent && (
          <button
            type="button"
            onClick={handleClear}
            className="text-[9px] text-rose-600 hover:text-rose-800 font-extrabold uppercase inline-flex items-center gap-1 cursor-pointer"
          >
            <RotateCcw size={9} />
            Clear Signature
          </button>
        )}
      </div>

      <div className="relative w-full rounded-lg border-2 border-dashed border-slate-300 bg-white overflow-hidden">
        {!hasContent && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none px-3 text-center">
            <span className="text-[10px] font-semibold text-slate-400">{placeholder}</span>
          </div>
        )}
        <canvas
          ref={canvasRef}
          style={{ height: `${height}px`, touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
          className="w-full block cursor-crosshair"
        />
        <div className="absolute bottom-2 left-3 right-3 border-b border-slate-200 pointer-events-none" />
      </div>
    </div>
  );
}
