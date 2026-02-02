import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Globe, X, Send, Terminal } from "lucide-react";
import { useLanguage } from '../contexts/LanguageContext';

const BrowserWindow = ({ imageSrc, logs = [], onClose, socket, position, onMouseDown, activeDragElement, zIndex }) => {
  const { t } = useLanguage();
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
    <div
      id="browser"
      className={`absolute flex flex-col transition-[box-shadow,border-color] duration-200
        backdrop-blur-2xl bg-black/50 border border-white/[0.14] shadow-2xl overflow-hidden rounded-xl
        ${activeDragElement === 'browser' ? 'ring-1 ring-white/50 border-white/30' : ''}
      `}
      style={{
        left: position?.x,
        top: position?.y,
        transform: 'translate(-50%, -50%)',
        width: '600px',
        height: '450px',
        pointerEvents: 'auto',
        zIndex: zIndex
      }}
      onMouseDown={onMouseDown}
    >
      {/* Header */}
      <div 
        className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5 shrink-0 cursor-grab active:cursor-grabbing"
        data-drag-handle
      >
        <div className="flex items-center gap-3">
          <Globe size={18} className="text-white" />
          <span className="text-sm font-medium tracking-wider text-white/90 uppercase">{t('browser.title')}</span>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-lg text-white/50 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Browser Content */}
      <div className="relative flex-1 bg-black/50 flex items-center justify-center overflow-hidden group">
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
              {t('browser.waiting')}
            </div>
          </div>
        )}

        {/* Logs Overlay (Bottom of image area) */}
        <div
          ref={logsBoxRef}
          className="absolute bottom-0 left-0 right-0 h-32 bg-black/80 backdrop-blur-sm border-t border-white/10 px-3 py-2 font-mono text-[10px] overflow-y-auto text-white/70 transition-transform translate-y-full group-hover:translate-y-0 duration-300"
        >
          <div className="flex items-center gap-2 mb-2 text-white/30 uppercase tracking-wider text-[9px] sticky top-0 bg-black/80 pb-1 border-b border-white/5">
            <Terminal size={10} /> Agent Logs
          </div>
          {decoratedLogs.map((log) => (
            <div key={log.id} className="mb-1 last:mb-0 break-words">
              <span className="text-white/50 mr-2">{">"}</span>
              {log.text}
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>
      </div>

      {/* Input Bar */}
      <div className="p-3 border-t border-white/10 bg-white/5 flex items-center gap-2 shrink-0">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('browser.placeholder')}
          className="flex-1 bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 font-mono"
        />

        <button
          onClick={handleSend}
          disabled={!canSend}
          className={[
            "p-2 rounded-lg border transition-all",
            canSend
              ? "bg-white/20 border-white/50 text-white hover:bg-white/30"
              : "bg-white/5 border-white/10 text-white/30 cursor-not-allowed",
          ].join(" ")}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
};

export default BrowserWindow;
