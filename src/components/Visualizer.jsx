import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";

/**
 * VN Visualizer: full-bleed background + character, no "card" frame.
 * Props (compatible): audioData, isListening, intensity, width, height
 * Optional: backgroundSrc, sprites, isUserSpeaking, isAssistantSpeaking, characterScale, characterY
 */
const Visualizer = ({
  audioData, // retained for compatibility (unused)
  isListening,
  intensity = 0,
  width = 800,
  height = 360,

  backgroundSrc = null,

  isUserSpeaking,
  isAssistantSpeaking,

  sprites = null,

  characterScale = 1.0,
  characterY = 10,
}) => {
  const STATE = {
    IDLE: "idle",
    USER: "user_speaking",
    MONIKA: "monika_speaking",
  };

  const USER_THRESHOLD = 0.09;
  const MONIKA_THRESHOLD = 0.05;

  const [vnState, setVnState] = useState(STATE.IDLE);

  useEffect(() => {
    const x = Number(intensity) || 0;
    const listening = Boolean(isListening);

    const userNow =
      typeof isUserSpeaking === "boolean"
        ? isUserSpeaking
        : listening && x > USER_THRESHOLD;

    const monikaNow =
      typeof isAssistantSpeaking === "boolean"
        ? isAssistantSpeaking
        : !listening && x > MONIKA_THRESHOLD;

    setVnState(userNow ? STATE.USER : monikaNow ? STATE.MONIKA : STATE.IDLE);
  }, [isListening, intensity, isUserSpeaking, isAssistantSpeaking]);

  // talk frames cycling (png-tuber vibe)
  const talkFrames = useMemo(() => {
    if (!sprites?.talk) return [];
    return Array.isArray(sprites.talk) ? sprites.talk.filter(Boolean) : [sprites.talk];
  }, [sprites]);

  const [frameIdx, setFrameIdx] = useState(0);
  const frameTimerRef = useRef(null);

  useEffect(() => {
    const shouldCycle = vnState === STATE.MONIKA && talkFrames.length > 1;

    if (!shouldCycle) {
      if (frameTimerRef.current) clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
      setFrameIdx(0);
      return;
    }

    if (frameTimerRef.current) clearInterval(frameTimerRef.current);

    frameTimerRef.current = setInterval(() => {
      setFrameIdx((i) => (i + 1) % talkFrames.length);
    }, 500);

    return () => {
      if (frameTimerRef.current) clearInterval(frameTimerRef.current);
      frameTimerRef.current = null;
    };
  }, [vnState, talkFrames]);

  const characterSrc = useMemo(() => {
    if (!sprites) return null;
    if (vnState === STATE.USER) return sprites.listen || sprites.idle || null;
    if (vnState === STATE.MONIKA) return (talkFrames[frameIdx] || talkFrames[0]) ?? sprites.idle ?? null;
    return sprites.idle || null;
  }, [sprites, vnState, talkFrames, frameIdx]);

  // robust fallback states
  const [bgBroken, setBgBroken] = useState(false);
  const [charBroken, setCharBroken] = useState(false);

  useEffect(() => setBgBroken(false), [backgroundSrc]);
  useEffect(() => setCharBroken(false), [characterSrc]);

  // Visual tuning
  const x = Math.max(0, Math.min(1, Number(intensity) || 0));
  const auraColor =
    vnState === STATE.MONIKA
      ? `rgba(120, 255, 220, ${0.12 + x * 0.35})`
      : vnState === STATE.USER
      ? `rgba(180, 200, 255, ${0.12 + x * 0.35})`
      : `rgba(255, 255, 255, ${0.06 + x * 0.18})`;

  const sceneScale = vnState === STATE.MONIKA ? 1.012 : 1.0;

  return (
    <div
      className="relative overflow-hidden"
      style={{
        width,
        height,

        // Kluczowe: izolacja i ograniczenie paint = brak artefaktów blura w rogach
        isolation: "isolate",
        contain: "paint",

        // full-bleed, bez "karty"
        background: "transparent",
      }}
    >
      {/* Scene background */}
      <motion.div
        className="absolute inset-0"
        animate={{ scale: sceneScale }}
        transition={{ duration: 0.6 }}
        style={{ willChange: "transform" }}
      >
        {backgroundSrc && !bgBroken ? (
          <img
            src={backgroundSrc}
            alt=""
            className="absolute inset-0 w-full h-full object-cover select-none pointer-events-none"
            draggable={false}
            onError={() => setBgBroken(true)}
          />
        ) : (
          <div className="absolute inset-0">
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(255,255,255,0.08),transparent_60%)]" />
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_75%_80%,rgba(255,255,255,0.06),transparent_62%)]" />
          </div>
        )}

        {/* Vignette */}
        <div className="absolute inset-0 pointer-events-none bg-[radial-gradient(circle_at_50%_45%,transparent_35%,rgba(0,0,0,0.55)_100%)]" />
      </motion.div>

      {/* Character centered */}
      <div className="absolute inset-0 flex items-center justify-center">
        <motion.div
          className="relative"
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: vnState === STATE.MONIKA ? characterY - 2 : characterY }}
          transition={{ duration: 0.35 }}
          style={{ scale: characterScale, willChange: "transform, opacity" }}
        >
          {characterSrc && !charBroken ? (
            <img
              src={characterSrc}
              alt=""
              className="max-h-[92%] max-w-[98%] w-auto select-none pointer-events-none"
              draggable={false}
              onError={() => setCharBroken(true)}
              style={{ filter: "drop-shadow(0 28px 60px rgba(0,0,0,0.55))" }}
            />
          ) : (
            <CharacterSilhouette />
          )}

          {/* Soft rim light (bez blend mode — mniej artefaktów) */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "radial-gradient(circle at 50% 15%, rgba(255,255,255,0.10), transparent 55%)",
              opacity: 0.55,
            }}
          />
        </motion.div>
      </div>
    </div>
  );
};

const CharacterSilhouette = () => (
  <div
    className="w-[240px] h-[320px] rounded-2xl border border-white/12 bg-white/[0.03]"
    style={{ filter: "drop-shadow(0 28px 60px rgba(0,0,0,0.55))" }}
  >
    <div className="w-full h-full flex items-center justify-center">
      <svg viewBox="0 0 200 260" className="w-[70%] h-[70%] opacity-75" aria-hidden="true">
        <path
          d="M100 20c28 0 50 22 50 50s-22 50-50 50-50-22-50-50 22-50 50-50Z"
          fill="rgba(255,255,255,0.10)"
        />
        <path
          d="M40 240c8-60 42-95 60-95s52 35 60 95"
          fill="rgba(255,255,255,0.08)"
        />
      </svg>
    </div>
  </div>
);

export default Visualizer;
