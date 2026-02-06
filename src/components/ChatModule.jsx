import React, { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, X, Maximize2, Minimize2, MessageSquare, Send, Brain, Minus, ChevronUp } from "lucide-react";
import AudioBar from "./AudioBar";
import { useLanguage } from '../contexts/LanguageContext';

const MAX_FILES = 6;
const MAX_FILE_BYTES = 12 * 1024 * 1024; // 12 MB per file
const MAX_TOTAL_BYTES = 30 * 1024 * 1024; // 30 MB total
const MAX_RENDER_MESSAGES = 800; // safety cap for very long conversations

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fileToAttachmentPayload(file) {
  const buf = await file.arrayBuffer();
  const b64 = bytesToBase64(new Uint8Array(buf));
  return {
    name: file.name,
    mime_type: file.type || "application/octet-stream",
    data: b64,
    size: file.size,
  };
}

function sanitizeUrl(url) {
  try {
    const u = new URL(url, window.location.origin);
    const ok = ["http:", "https:", "mailto:", "tel:"].includes(u.protocol);
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseInlineMarkdown(text) {
  if (!text) return null;

  // Tokenize a small, safe subset:
  // - **bold**
  // - `code`
  // - [label](url)
  const tokenRe = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^\s)]+\))/g;
  const parts = [];
  let last = 0;
  let m;

  while ((m = tokenRe.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "text", value: text.slice(last, m.index) });

    const tok = m[0];
    if (tok.startsWith("**") && tok.endsWith("**")) {
      parts.push({ type: "bold", value: tok.slice(2, -2) });
    } else if (tok.startsWith("`") && tok.endsWith("`")) {
      parts.push({ type: "code", value: tok.slice(1, -1) });
    } else if (tok.startsWith("[")) {
      const closeBracket = tok.indexOf("](");
      const label = tok.slice(1, closeBracket);
      const url = tok.slice(closeBracket + 2, -1);
      parts.push({ type: "link", label, url });
    } else {
      parts.push({ type: "text", value: tok });
    }

    last = m.index + tok.length;
  }

  if (last < text.length) parts.push({ type: "text", value: text.slice(last) });

  return parts.map((p, idx) => {
    if (p.type === "bold") {
      return (
        <strong key={idx} className="font-semibold">
          {p.value}
        </strong>
      );
    }

    if (p.type === "code") {
      return (
        <code
          key={idx}
          className="px-1 py-0.5 rounded-md bg-black/30 border border-white/10 font-mono text-[0.95em]"
        >
          {p.value}
        </code>
      );
    }

    if (p.type === "link") {
      const safe = sanitizeUrl(p.url);
      if (!safe) return <span key={idx}>{`${p.label} (${p.url})`}</span>;
      return (
        <a
          key={idx}
          href={safe}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 text-white/90 hover:text-white"
        >
          {p.label}
        </a>
      );
    }

    return <span key={idx}>{p.value}</span>;
  });
}

function renderMarkdown(text) {
  const lines = String(text || "").split("\n");
  return (
    <>
      {lines.map((line, i) => (
        <span key={i}>
          {parseInlineMarkdown(line)}
          {i < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </>
  );
}

const ChatModule = ({
  messages,
  inputValue,
  setInputValue,
  handleSend,
  socket,
  isModularMode,
  activeDragElement,
  position,
  width = 720,
  height = 420,
  onMouseDown,
  zIndex = 50,
  userSpeaking,
  micAudioData,
}) => {
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const { t } = useLanguage();

  const [attachments, setAttachments] = useState([]); // [{ id, file, previewUrl? }]
  const [attachError, setAttachError] = useState("");
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const [showThoughts, setShowThoughts] = useState(false);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, historyExpanded]);

  useEffect(() => {
    if (!historyExpanded) return;
    const onKey = (e) => {
      if (e.key === "Escape") setHistoryExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyExpanded]);

  useEffect(() => {
    if (!socket) return;
    const onSettings = (data) => {
      if (data && typeof data.show_internal_thoughts !== "undefined") {
        setShowThoughts(data.show_internal_thoughts);
      }
    };
    socket.on("settings", onSettings);
    socket.emit("get_settings");
    return () => socket.off("settings", onSettings);
  }, [socket]);

  const toggleThoughts = () => {
    if (!socket) return;
    const next = !showThoughts;
    setShowThoughts(next);
    socket.emit("update_settings", { show_internal_thoughts: next });
  };

  const isActive = isModularMode && activeDragElement === "chat";


  const visibleMessages = useMemo(() => {
    let list = Array.isArray(messages) ? messages : [];

    // Filter out thoughts if the toggle is off
    if (!showThoughts) {
      list = list.filter(m => !String(m?.sender || "").includes("(Thought)"));
    }

    if (historyExpanded) {
      return list.slice(Math.max(0, list.length - MAX_RENDER_MESSAGES));
    }
    return list.slice(-18);
  }, [messages, historyExpanded, showThoughts]);

  const canSend = Boolean((inputValue || "").trim().length) || attachments.length > 0;
  const canNote = Boolean((inputValue || "").trim().length) && !attachments.length;

  const totalAttachBytes = useMemo(
    () => attachments.reduce((sum, a) => sum + (a?.file?.size || 0), 0),
    [attachments]
  );

  const addFiles = (fileList) => {
    setAttachError("");

    const incoming = Array.from(fileList || []);
    if (!incoming.length) return;

    setAttachments((prev) => {
      const next = [...prev];

      for (const f of incoming) {
        if (next.length >= MAX_FILES) {
          setAttachError(t('chat.attachment_limit', { max: MAX_FILES }));
          break;
        }

        if (f.size > MAX_FILE_BYTES) {
          setAttachError(t('chat.file_too_large', { name: f.name, size: 12 }));
          continue;
        }

        const already = next.some(
          (x) =>
            x.file &&
            x.file.name === f.name &&
            x.file.size === f.size &&
            x.file.lastModified === f.lastModified
        );
        if (already) continue;

        const isImage = (f.type || "").startsWith("image/");
        const previewUrl = isImage ? URL.createObjectURL(f) : null;

        next.push({
          id: `${f.name}-${f.size}-${f.lastModified}-${Math.random().toString(16).slice(2)}`,
          file: f,
          previewUrl,
        });
      }

      const nextTotal = next.reduce((sum, a) => sum + (a?.file?.size || 0), 0);
      if (nextTotal > MAX_TOTAL_BYTES) {
        setAttachError(t('chat.total_size_exceeded', { size: 30 }));
        // cofamy dodawanie: zostawiamy poprzedni stan
        next.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
        return prev;
      }

      return next;
    });
  };

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const item = prev.find((x) => x.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((x) => x.id !== id);
    });
  };

  const clearAttachments = () => {
    setAttachments((prev) => {
      prev.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
      return [];
    });
    setAttachError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onPickFiles = () => fileInputRef.current?.click();

  const sendMessage = async () => {
    if (!canSend) return;

    let payloadAttachments = [];
    if (attachments.length) {
      try {
        payloadAttachments = await Promise.all(attachments.map((a) => fileToAttachmentPayload(a.file)));
      } catch {
        setAttachError(t('chat.prepare_failed'));
        return;
      }
    }

    // handleSend w App.jsx może czytać event.attachments
    handleSend({ key: "Enter", attachments: payloadAttachments });

    // UX
    clearAttachments();
    textareaRef.current?.focus();
  };

  const onKeyDown = async (e) => {
    // Enter = wyślij, Shift+Enter = nowa linia
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      await sendMessage();
    }
  };

  const onClickSend = async () => {
    await sendMessage();
  };

  const onClickNote = () => {
    if (!socket) return;
    const text = (inputValue || "").trim();
    if (!text) return;
    socket.emit("memory_append_page", { path: "notes.md", content: text });
    setInputValue("");
    textareaRef.current?.focus();
  };

  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
  };

  const onDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // History expansion: grow UPWARDS (anchor bottom)
  const baseHeight = height;
  const expandedHeight = useMemo(() => {
    const vh = typeof window !== "undefined" ? window.innerHeight : 900;
    const maxH = Math.max(baseHeight, Math.floor(vh * 0.84));
    // keep some headroom for OS chrome; cap to avoid ridiculous windows
    return Math.min(maxH, 980);
  }, [baseHeight]);

  const effectiveHeight = isMinimized ? 60 : (historyExpanded ? expandedHeight : baseHeight);
  const baseTop = position?.y ?? 200;
  const deltaH = effectiveHeight - baseHeight;
  const effectiveTop = Math.max(14, baseTop - deltaH);

  return (
    <div
      id="chat"
      onDrop={onDrop}
      onDragOver={onDragOver}
      className={`absolute flex flex-col transition-[box-shadow,border-color,height,top,left,width] duration-200
        backdrop-blur-2xl bg-black/50 border border-white/[0.14] shadow-2xl overflow-hidden rounded-xl
        ${isModularMode && isActive ? 'ring-1 ring-white/50 border-white/30' : ''}
      `}
      style={{
        left: position?.x ?? window.innerWidth / 2,
        top: effectiveTop,
        transform: "translate(-50%, 0)",
        width,
        height: effectiveHeight,
        zIndex: historyExpanded ? Math.max(zIndex, 90) : zIndex,
      }}
    >
      {/* Header */}
      <div 
        className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5 shrink-0"
        onMouseDown={onMouseDown}
      >
        <div className="flex items-center gap-3">
          <MessageSquare size={18} className="text-white" />
          <span className="text-sm font-medium tracking-wider text-white/90 uppercase">{t('chat.title')}</span>
        </div>
        <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={toggleThoughts}
              className={`p-1.5 rounded-lg transition-colors ${showThoughts ? 'bg-white/20 text-cyan-300' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
              title={showThoughts ? "Hide Internal Thoughts" : "Show Internal Thoughts"}
            >
              <Brain size={16} />
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryExpanded((v) => !v);
                setIsMinimized(false);
              }}
              className={`p-1.5 rounded-lg transition-colors ${historyExpanded ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
              title={historyExpanded ? t('chat.collapse_history') : t('chat.expand_history')}
            >
              {historyExpanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
            </button>
            <button
              type="button"
              onClick={() => setIsMinimized((v) => !v)}
              className={`p-1.5 rounded-lg transition-colors ${isMinimized ? 'bg-white/10 text-white' : 'text-white/50 hover:text-white hover:bg-white/10'}`}
              title={isMinimized ? (t('chat.restore') || "Restore") : (t('chat.minimize') || "Minimize")}
            >
              {isMinimized ? <ChevronUp size={16} /> : <Minus size={16} />}
            </button>
        </div>
      </div>

      {/* Messages Area */}
      {!isMinimized && (
        <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-4 relative bg-black/20">
            {visibleMessages.map((msg, i) => {
              const sender = String(msg?.sender || "");
              const lower = sender.toLowerCase();
              const isUser = lower === "ty" || lower === "you";
              const isThought = sender.includes("(Thought)");

              return (
                <div key={i} className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className={`text-[10px] uppercase tracking-wider font-bold ${
                        isUser ? 'text-white' : isThought ? 'text-gray-500' : 'text-purple-400'
                      }`}
                    >
                      {isThought ? t('chat.monika_thought') : (sender || "…")}
                    </span>
                    {msg?.time ? (
                      <span className="text-[10px] text-white/30 font-mono">{msg.time}</span>
                    ) : null}
                  </div>

                  <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap break-words border ${
                    isUser 
                      ? 'bg-white/10 border-white/20 text-white rounded-tr-sm' 
                      : isThought
                        ? 'bg-white/[0.02] border-white/5 text-white/50 italic rounded-tl-sm border-dashed'
                        : 'bg-white/5 border-white/10 text-white/90 rounded-tl-sm'
                  }`}>
                    {renderMarkdown(msg?.text)}
                  </div>
                </div>
              );
            })}
            <div ref={messagesEndRef} />
        </div>
      )}

      {/* Input Area */}
      {!isMinimized && (
        <div className="p-4 border-t border-white/10 bg-white/5 relative shrink-0">
          {/* Background Visualizer - always visible when speaking */}
          {userSpeaking && (
            <div className="absolute inset-0 flex justify-center items-center opacity-20 pointer-events-none">
              <AudioBar audioData={micAudioData} />
            </div>
          )}

          {/* Foreground Content - always visible */}
          <div className="relative z-10 flex flex-col gap-3">
            <textarea
              ref={textareaRef}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t('chat.placeholder')}
              rows={1}
              className="w-full bg-black/50 border border-white/10 rounded-xl px-4 py-3 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/50 resize-none custom-scrollbar"
              style={{ minHeight: '50px' }}
            />

            {/* Attachments preview */}
            {attachments.length ? (
              <div className="flex flex-wrap gap-2">
                {attachments.map((a) => {
                  const isImage = (a.file?.type || "").startsWith("image/");
                  return (
                    <div
                      key={a.id}
                      className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl border border-white/12 bg-white/[0.05]"
                      title={`${a.file?.name} (${Math.round((a.file?.size || 0) / 1024)} KB)`}
                    >
                      {isImage && a.previewUrl ? (
                        <img
                          src={a.previewUrl}
                          alt={a.file?.name}
                          className="h-7 w-7 rounded-lg object-cover border border-white/10"
                        />
                      ) : (
                        <div className="h-7 w-7 rounded-lg bg-black/30 border border-white/10 flex items-center justify-center text-[10px] text-white/50">
                          FILE
                        </div>
                      )}
                      <div className="max-w-[240px] truncate text-[12px] text-white/75">
                        {a.file?.name}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        className="text-white/35 hover:text-white/70 transition"
                        title="Usuń"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {attachError ? <div className="mt-2 text-[11px] text-red-300/80">{attachError}</div> : null}

            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-white/35">
                {t('chat.shift_enter')}
                {attachments.length ? (
                  <span className="ml-2 text-white/25">
                    · {t('chat.attachments')}: {attachments.length}/{MAX_FILES} · {Math.round(totalAttachBytes / 1024)} KB
                  </span>
                ) : null}
              </div>

              <div className="flex items-center gap-2">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept="image/*,.txt,.md,.json,.csv,.log,.pdf"
                  onChange={(e) => addFiles(e.target.files)}
                  className="hidden"
                />

                <button
                  type="button"
                  onClick={onPickFiles}
                  className="p-2 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-white/70 transition-colors"
                  title={t('chat.attach')}
                >
                  <Paperclip size={16} />
                </button>

                <button
                  type="button"
                  onClick={onClickSend}
                  disabled={!canSend}
                  className={[
                    "p-2 rounded-lg border transition-all",
                    canSend
                      ? "bg-white/20 border-white/50 text-white hover:bg-white/30"
                      : "bg-white/5 border-white/10 text-white/30 cursor-not-allowed",
                  ].join(" ")}
                  title={t('chat.send')}
                >
                  <Send size={16} />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatModule;
