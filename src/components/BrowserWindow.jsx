import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Globe, X } from "lucide-react";

const BrowserWindow = ({ imageSrc, logs = [], onClose, socket }) => {
  const [input, setInput] = useState("");
  const logsBoxRef = useRef(null);
  const logsEndRef = useRef(null);

  // Stabilna lista logów z timestampem "w momencie pojawienia się"
  // (jeśli backend nie wysyła czasu, to jest najlepszy lokalny kompromis)
  const [decoratedLogs, setDecoratedLogs] = useState([]);

  useEffect(() => {
    // dopisuj tylko nowe wpisy
    setDecoratedLogs((prev) => {
      const prevLen = prev.length;
      const nextLen = logs.length;
      if (nextLen <= prevLen) {
        // backend czasem może przyciąć logi -> zsynchronizuj
        return logs.map((text, idx) => ({
          id: `${idx}-${String(text).slice(0, 24)}`,
          text: String(text ?? ""),
          ts: prev[idx]?.ts ?? Date.now(),
        }));
      }

      const appended = logs.slice(prevLen).map((text, i) => ({
        id: `${prevLen + i}-${String(text).slice(0, 24)}`,
        text: String(text ?? ""),
        ts: Date.now(),
      }));

      return [...prev, ...appended].slice(-200); // twardy limit, żeby nie puchło
    });
  }, [logs]);

  // Auto-scroll tylko jeśli user jest blisko dołu (nie psuje ręcznego scrollowania)
  const shouldAutoScroll = useCallback(() => {
    const el = logsBoxRef.current;
    if (!el) return true;
    const threshold = 48; // px
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return distanceFromBottom < threshold;
  }, []);

  useEffect(() => {
    if (!logsEndRef.current) return;
    if (shouldAutoScroll()) {
      logsEndRef.current.scrollIntoView({ behavior: "auto" });
    }
  }, [decoratedLogs, shouldAutoScroll]);

  const canSend = input.trim().length > 0;

  const handleSend = useCallback(() => {
    const prompt = input.trim();
    if (!prompt) return;

    if (socket?.emit) {
      socket.emit("prompt_web_agent", { prompt });
    }

    setInput("");
  }, [input, socket]);

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (canSend) handleSend();
    }
  };

  const imgSrc = useMemo(() => {
    if (!imageSrc) return null;
    // jeśli backend już wysyła "data:image/..." to nie doklejaj drugi raz
    if (String(imageSrc).startsWith("data:image")) return String(imageSrc);
    return `data:image/jpeg;base64,${imageSrc}`;
  }, [imageSrc]);

  return (
    <div className="w-full h-full relative overflow-hidden flex flex-col rounded-2xl border border-white/12 bg-black/50 backdrop-blur-xl shadow-[0_20px_80px_rgba(0,0,0,0.55)]">
      {/* subtle noise (spójnie z resztą UI) */}
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-[0.06] pointer-events-none mix-blend-overlay" />

      {/* Header Bar - Drag Handle */}
      <div
        data-drag-handle
        className="relative z-10 h-9 border-b border-white/10 bg-black/35 flex items-center justify-between px-3 shrink-0 cursor-grab active:cursor-grabbing select-none"
      >
        <div className="flex items-center gap-2 text-white/70 text-xs font-mono tracking-wider">
          <Globe size={14} className="text-white/60" />
          <span>WEB_AGENT_VIEW</span>
        </div>

        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white/85 transition-colors"
          title="Zamknij"
        >
          <X size={14} />
        </button>
      </div>

      {/* Browser Content */}
      <div className="relative z-10 flex-1 bg-black flex items-center justify-center overflow-hidden">
        {imgSrc ? (
          <img
            src={imgSrc}
            alt="Browser View"
            className="max-w-full max-h-full object-contain"
            draggable={false}
            loading="eager"
          />
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="text-white/35 text-xs font-mono animate-pulse">
              Waiting for browser stream...
            </div>
          </div>
        )}
      </div>

      {/* Input Bar */}
      <div className="relative z-10 border-t border-white/10 bg-black/35 px-3 py-2 flex items-center gap-2">
        <span className="text-white/55 font-mono text-xs select-none">{">"}</span>

        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Command for Web Agent…"
          className="flex-1 bg-transparent border-none outline-none text-white/80 text-sm font-mono placeholder:text-white/30"
        />

        <button
          onClick={handleSend}
          disabled={!canSend}
          className={[
            "px-3 py-1.5 rounded-xl text-xs font-semibold tracking-wider",
            "border transition-colors select-none",
            canSend
              ? "border-white/18 bg-white/[0.06] hover:bg-white/[0.10] text-white/80"
              : "border-white/10 bg-white/[0.03] text-white/30 cursor-not-allowed",
          ].join(" ")}
        >
          SEND
        </button>
      </div>

      {/* Logs Overlay (Bottom) */}
      <div
        ref={logsBoxRef}
        className="relative z-10 h-28 border-t border-white/10 bg-black/60 backdrop-blur px-3 py-2 font-mono text-[11px] overflow-y-auto text-white/70"
      >
        {decoratedLogs.map((log) => {
          const time = new Date(log.ts).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });

          return (
            <div key={log.id} className="mb-1.5 last:mb-0 border-l-2 border-white/10 pl-2 break-words">
              <span className="opacity-35 mr-2">[{time}]</span>
              {log.text}
            </div>
          );
        })}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
};

export default BrowserWindow;
