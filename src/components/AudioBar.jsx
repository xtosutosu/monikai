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

      const barWidth = 4;
      const gap = 4;
      const totalBars = Math.floor(width / (barWidth + gap));
      const center = width / 2;

      // Glow effect
      ctx.shadowBlur = 8;
      ctx.shadowColor = "rgba(255, 255, 255, 0.4)";

      for (let i = 0; i < totalBars / 2; i++) {
        const value = audioData[i % audioData.length] || 0;
        let percent = value / 255;
        
        // Dampen low values (noise gate) to make it less sensitive
        percent = percent < 0.12 ? 0 : Math.pow(percent, 2.2);

        const barHeight = Math.max(4, percent * (height - 12));

        // White-only, dynamic opacity
        const alpha = 0.2 + percent * 0.8;
        ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;

        const y = (height - barHeight) / 2;
        const radius = barWidth / 2;

        // Right
        const xRight = center + i * (barWidth + gap);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(xRight, y, barWidth, barHeight, radius);
        else ctx.rect(xRight, y, barWidth, barHeight);
        ctx.fill();

        // Left
        const xLeft = center - (i + 1) * (barWidth + gap);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(xLeft, y, barWidth, barHeight, radius);
        else ctx.rect(xLeft, y, barWidth, barHeight);
        ctx.fill();
      }
    };

    const frameId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameId);
  }, [audioData]);

  return (
    <canvas
      ref={canvasRef}
      width={320}
      height={60}
      className="opacity-100"
    />
  );
};

export default AudioBar;