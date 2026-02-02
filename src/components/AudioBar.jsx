import React, { useEffect, useRef } from "react";

const AudioBar = ({ audioData }) => {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    const draw = () => {
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      const barWidth = 3;
      const gap = 2;
      const totalBars = Math.floor(width / (barWidth + gap));
      const center = width / 2;

      for (let i = 0; i < totalBars / 2; i++) {
        const value = audioData[i % audioData.length] || 0;
        const percent = value / 255;

        const barHeight = Math.max(2, percent * height);

        // White-only, dynamic opacity
        const alpha = 0.15 + percent * 0.6;
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;

        const y = (height - barHeight) / 2;

        // Right
        ctx.fillRect(
          center + i * (barWidth + gap),
          y,
          barWidth,
          barHeight
        );

        // Left
        ctx.fillRect(
          center - (i + 1) * (barWidth + gap),
          y,
          barWidth,
          barHeight
        );
      }
    };

    requestAnimationFrame(draw);
  }, [audioData]);

  return (
    <canvas
      ref={canvasRef}
      width={300}
      height={40}
      className="opacity-90"
    />
  );
};

export default AudioBar;