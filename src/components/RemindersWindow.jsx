import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Clock, Trash2, RefreshCw, Bell, Timer, Plus, Volume2 } from 'lucide-react';

// Draggable reminders + timers window
const RemindersWindow = ({
    socket,
    position,
    onClose,
    onMouseDown,
    zIndex = 40
}) => {
    const [reminders, setReminders] = useState([]); // [{ id, message, when_iso, speak, alert, when_epoch_ms }]
    const [isLoading, setIsLoading] = useState(false);

    // Create UI
    const [createTab, setCreateTab] = useState('reminder'); // 'reminder' | 'timer'
    const [message, setMessage] = useState('');
    const [dateTimeLocal, setDateTimeLocal] = useState(''); // yyyy-mm-ddThh:mm
    const [inMinutes, setInMinutes] = useState('');
    const [timerH, setTimerH] = useState('0');
    const [timerM, setTimerM] = useState('10');
    const [timerS, setTimerS] = useState('0');
    const [speak, setSpeak] = useState(true);
    const [alert, setAlert] = useState(true);
    const [submitErr, setSubmitErr] = useState('');

    // Fired alert UI
    const [fired, setFired] = useState(null); // { id, message, when_iso, speak, alert }
    const stopBeepRef = useRef(null);

    const listTimeoutRef = useRef(null);

    const requestList = () => {
        if (!socket) return;
        setIsLoading(true);
        socket.emit('list_reminders');
        if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
        listTimeoutRef.current = setTimeout(() => setIsLoading(false), 1500);
    };

    const toAtString = (dtLocal) => {
        // input: YYYY-MM-DDTHH:MM  ->  YYYY-MM-DD HH:MM
        if (!dtLocal) return null;
        return dtLocal.replace('T', ' ').slice(0, 16);
    };

    const startBeep = () => {
        // Pure WebAudio ringing (no assets). Returns stop fn.
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            const ctx = new AudioCtx();

            const master = ctx.createGain();
            master.gain.value = 0.08;
            master.connect(ctx.destination);

            const ringOnce = () => {
                const now = ctx.currentTime;
                const env = ctx.createGain();
                env.gain.setValueAtTime(0.0001, now);
                env.gain.exponentialRampToValueAtTime(1.0, now + 0.01);
                env.gain.exponentialRampToValueAtTime(0.0001, now + 1.05);
                env.connect(master);

                const o1 = ctx.createOscillator();
                const o2 = ctx.createOscillator();
                o1.type = 'sine';
                o2.type = 'triangle';
                o1.frequency.value = 880;
                o2.frequency.value = 1320;

                o1.connect(env);
                o2.connect(env);
                o1.start(now);
                o2.start(now);
                o1.stop(now + 1.1);
                o2.stop(now + 1.1);
            };

            // Resume in case AudioContext starts suspended
            if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
            }

            ringOnce();
            const interval = setInterval(ringOnce, 1500);

            const stop = () => {
                try { clearInterval(interval); } catch (e) {}
                try { ctx.close(); } catch (e) {}
            };

            return stop;
        } catch (e) {
            return null;
        }
    };

    const stopBeep = () => {
        if (stopBeepRef.current) {
            try { stopBeepRef.current(); } catch (e) {}
        }
        stopBeepRef.current = null;
    };

    const showNotification = (title, body) => {
        try {
            if (!('Notification' in window)) return;
            // In Electron this is typically already granted
            if (Notification.permission === 'granted') {
                new Notification(title, { body });
            } else if (Notification.permission === 'default') {
                Notification.requestPermission().then((perm) => {
                    if (perm === 'granted') new Notification(title, { body });
                }).catch(() => {});
            }
        } catch (e) {}
    };

    useEffect(() => {
        if (!socket) return;

        requestList();

        const handleList = (payload) => {
            const list = Array.isArray(payload) ? payload : (payload?.reminders || []);
            setReminders(list);
            setIsLoading(false);
            if (listTimeoutRef.current) {
                clearTimeout(listTimeoutRef.current);
                listTimeoutRef.current = null;
            }
        };

        const handleFired = (payload) => {
            if (!payload) return;
            setFired(payload);

            if (payload.alert) {
                stopBeep();
                stopBeepRef.current = startBeep();
                showNotification('Reminder', payload.message);
            }

            // Auto-stop alarm after ~8s
            setTimeout(() => stopBeep(), 8000);
        };

        socket.on('reminders_list', handleList);
        socket.on('reminder_fired', handleFired);

        return () => {
            socket.off('reminders_list', handleList);
            socket.off('reminder_fired', handleFired);
            stopBeep();
            if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
        };
    }, [socket]);

    const grouped = useMemo(() => {
        const groups = {};
        for (const r of reminders) {
            const d = new Date(r.when_iso);
            const key = isNaN(d.getTime()) ? (r.when_iso || 'Unknown') : d.toISOString().slice(0, 10);
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        }
        for (const key of Object.keys(groups)) {
            groups[key].sort((a, b) => (a.when_epoch_ms || 0) - (b.when_epoch_ms || 0));
        }
        const sortedKeys = Object.keys(groups).sort();
        return { groups, keys: sortedKeys };
    }, [reminders]);

    const formatGroupHeader = (yyyyMmDd) => {
        const today = new Date();
        const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
        const target = new Date(yyyyMmDd + 'T00:00:00');
        const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
        const diffDays = Math.round((startOfTarget - startOfToday) / (24 * 60 * 60 * 1000));

        if (diffDays === 0) return 'Today';
        if (diffDays === 1) return 'Tomorrow';
        return yyyyMmDd;
    };

    const formatTime = (whenIso) => {
        const d = new Date(whenIso);
        if (isNaN(d.getTime())) return whenIso;
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const formatDateTime = (whenIso) => {
        const d = new Date(whenIso);
        if (isNaN(d.getTime())) return whenIso;
        return d.toLocaleString();
    };

    const cancel = (id) => {
        if (!socket || !id) return;
        socket.emit('cancel_reminder', { id });
        setReminders(prev => prev.filter(r => r.id !== id));
    };

    const quickTimer = (mins) => {
        setCreateTab('timer');
        setTimerH('0');
        setTimerM(String(mins));
        setTimerS('0');
    };

    const submit = () => {
        if (!socket) return;
        setSubmitErr('');

        const msg = (message || '').trim();
        if (!msg) {
            setSubmitErr('Message is required.');
            return;
        }

        const payload = { message: msg, speak: !!speak, alert: !!alert };

        if (createTab === 'reminder') {
            const at = toAtString(dateTimeLocal);
            const mins = String(inMinutes).trim();

            if (at) {
                payload.at = at;
            } else if (mins) {
                const n = Number(mins);
                if (!Number.isFinite(n) || n <= 0) {
                    setSubmitErr('in-minutes must be a positive number.');
                    return;
                }
                payload.in_minutes = Math.round(n);
            } else {
                setSubmitErr('Set a date/time or in-minutes.');
                return;
            }
        } else {
            const h = Math.max(0, Math.floor(Number(timerH) || 0));
            const m = Math.max(0, Math.floor(Number(timerM) || 0));
            const s = Math.max(0, Math.floor(Number(timerS) || 0));
            const total = (h * 3600) + (m * 60) + s;
            if (!Number.isFinite(total) || total <= 0) {
                setSubmitErr('Timer duration must be > 0.');
                return;
            }
            payload.in_seconds = total;
        }

        socket.emit('create_reminder', payload);

        // Reset lighter
        setInMinutes('');
        setDateTimeLocal('');
        if (createTab === 'timer') {
            setTimerH('0');
            setTimerM('10');
            setTimerS('0');
        }
        setMessage('');

        setTimeout(() => requestList(), 250);
    };

    return (
        <div
            id="reminders"
            onMouseDown={onMouseDown}
            style={{
                position: 'absolute',
                left: position.x,
                top: position.y,
                transform: 'translate(-50%, -50%)',
                width: '420px',
                zIndex: zIndex
            }}
            className="pointer-events-auto backdrop-blur-xl bg-black/80 border border-white-500/30 rounded-2xl shadow-[0_0_30px_rgba(6,182,212,0.12)] overflow-hidden flex flex-col"
        >
            {/* Header */}
            <div data-drag-handle className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5 cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2">
                    <Clock size={16} className="text-white-400" />
                    <span className="text-xs font-bold tracking-widest text-white-100 uppercase">Reminders</span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={requestList}
                        disabled={isLoading}
                        className={`p-1.5 hover:bg-white/10 rounded-full transition-colors ${isLoading ? 'animate-spin text-white-400' : 'text-gray-400 hover:text-white-400'}`}
                        title="Refresh"
                    >
                        <RefreshCw size={14} />
                    </button>
                    <button
                        onClick={onClose}
                        className="p-1.5 hover:bg-white/10 rounded-full text-gray-400 hover:text-white transition-colors"
                        title="Close"
                    >
                        <X size={14} />
                    </button>
                </div>
            </div>

            {/* Alarm banner */}
            {fired && (
                <div className="px-4 py-3 border-b border-white/10 bg-white/5">
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <div className="text-xs font-bold tracking-widest text-white/60 uppercase">Alarm</div>
                            <div className="mt-1 text-sm text-white break-words">{fired.message}</div>
                            <div className="mt-1 text-[12px] text-white/30">{fired.when_iso}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                            <button
                                onClick={() => { stopBeep(); setFired(null); }}
                                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs text-white/80"
                                title="Dismiss"
                            >
                                Dismiss
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Content */}
            <div className="p-4 overflow-y-auto custom-scrollbar" style={{ maxHeight: '520px' }}>
                {/* Create Panel */}
                <div className="bg-white/5 border border-white/10 rounded-xl p-3 mb-4">
                    <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs font-bold tracking-widest text-white/70 uppercase">
                            <Plus size={14} className="text-white/50" />
                            Add
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setCreateTab('reminder')}
                                className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${createTab === 'reminder' ? 'bg-white/15 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                                title="Reminder"
                            >
                                <span className="inline-flex items-center gap-1"><Bell size={12} /> Reminder</span>
                            </button>
                            <button
                                onClick={() => setCreateTab('timer')}
                                className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${createTab === 'timer' ? 'bg-white/15 text-white' : 'bg-white/5 text-white/50 hover:bg-white/10'}`}
                                title="Timer"
                            >
                                <span className="inline-flex items-center gap-1"><Timer size={12} /> Timer</span>
                            </button>
                        </div>
                    </div>

                    <div className="mt-3 space-y-3">
                        <input
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder={createTab === 'timer' ? 'Timer label (e.g., "Tea")' : 'Reminder message'}
                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-sm outline-none focus:border-white/25"
                        />

                        {createTab === 'reminder' ? (
                            <div className="grid grid-cols-2 gap-2">
                                <div className="space-y-1">
                                    <div className="text-[10px] text-white/40 uppercase tracking-wider">Date/Time</div>
                                    <input
                                        type="datetime-local"
                                        value={dateTimeLocal}
                                        onChange={(e) => setDateTimeLocal(e.target.value)}
                                        className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-white/25"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <div className="text-[10px] text-white/40 uppercase tracking-wider">In minutes</div>
                                    <input
                                        value={inMinutes}
                                        onChange={(e) => setInMinutes(e.target.value)}
                                        placeholder="e.g., 15"
                                        className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-white/25"
                                    />
                                </div>
                                <div className="col-span-2 text-[11px] text-white/25">
                                    Tip: set one of them (date/time takes priority).
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div className="flex items-center justify-between">
                                    <div className="text-[10px] text-white/40 uppercase tracking-wider">Duration</div>
                                    <div className="flex items-center gap-1">
                                        {[5, 10, 15, 30, 60].map((m) => (
                                            <button
                                                key={m}
                                                onClick={() => quickTimer(m)}
                                                className="px-2 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-[11px] text-white/55"
                                                title={`${m} minutes`}
                                            >
                                                {m}m
                                            </button>
                                        ))}
                                    </div>
                                </div>
                                <div className="grid grid-cols-3 gap-2">
                                    <div>
                                        <input
                                            value={timerH}
                                            onChange={(e) => setTimerH(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-white/25"
                                        />
                                        <div className="mt-1 text-[10px] text-white/30">hours</div>
                                    </div>
                                    <div>
                                        <input
                                            value={timerM}
                                            onChange={(e) => setTimerM(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-white/25"
                                        />
                                        <div className="mt-1 text-[10px] text-white/30">minutes</div>
                                    </div>
                                    <div>
                                        <input
                                            value={timerS}
                                            onChange={(e) => setTimerS(e.target.value)}
                                            className="w-full px-3 py-2 rounded-lg bg-black/30 border border-white/10 text-white text-xs outline-none focus:border-white/25"
                                        />
                                        <div className="mt-1 text-[10px] text-white/30">seconds</div>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={() => setSpeak(v => !v)}
                                    className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${speak ? 'bg-white/10 text-white/80' : 'bg-white/5 text-white/40 hover:bg-white/10'}`}
                                    title="Speak"
                                >
                                    <span className="inline-flex items-center gap-1"><Volume2 size={12} /> {speak ? 'spoken' : 'silent'}</span>
                                </button>
                                <button
                                    onClick={() => setAlert(v => !v)}
                                    className={`px-2.5 py-1.5 rounded-lg text-xs transition-colors ${alert ? 'bg-white/10 text-white/80' : 'bg-white/5 text-white/40 hover:bg-white/10'}`}
                                    title="Ring / Notification"
                                >
                                    <span className="inline-flex items-center gap-1"><Bell size={12} /> {alert ? 'alert' : 'no alert'}</span>
                                </button>
                            </div>

                            <button
                                onClick={submit}
                                className="px-3 py-1.5 rounded-lg bg-cyan-500/20 hover:bg-cyan-500/25 text-xs text-white/90 border border-cyan-500/30"
                                title="Create"
                            >
                                Create
                            </button>
                        </div>

                        {submitErr && (
                            <div className="text-[11px] text-red-300/80">{submitErr}</div>
                        )}
                    </div>
                </div>

                {/* List */}
                {reminders.length === 0 ? (
                    <div className="text-center py-10 text-white/30 text-xs">
                        {isLoading ? (
                            <div className="flex flex-col items-center gap-2">
                                <RefreshCw className="animate-spin" size={20} />
                                <span>Loading reminders...</span>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div>No reminders scheduled.</div>
                                <div className="text-[16px] text-white/20">Create one above or by talking with your AI.</div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="space-y-4">
                        {grouped.keys.map((dateKey) => (
                            <div key={dateKey} className="space-y-2">
                                <div className="text-[16px] uppercase text-white/40 font-bold tracking-wider">
                                    {formatGroupHeader(dateKey)}
                                </div>

                                <div className="space-y-2">
                                    {grouped.groups[dateKey].map((r) => (
                                        <div
                                            key={r.id}
                                            className="bg-white/5 border border-white/10 rounded-lg p-3 hover:border-white-500/30 transition-all"
                                            title={formatDateTime(r.when_iso)}
                                        >
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-white/5 text-white-200/80">
                                                            {formatTime(r.when_iso)}
                                                        </span>
                                                        {r.speak ? (
                                                            <span className="text-[10px] text-white-400/70">spoken</span>
                                                        ) : (
                                                            <span className="text-[10px] text-white/30">silent</span>
                                                        )}
                                                        {r.alert === false ? (
                                                            <span className="text-[10px] text-white/30">no alert</span>
                                                        ) : (
                                                            <span className="text-[10px] text-white-400/70">alert</span>
                                                        )}
                                                    </div>
                                                    <div className="mt-1 text-sm text-white-50/90 break-words">{r.message}</div>
                                                </div>

                                                <button
                                                    onClick={() => cancel(r.id)}
                                                    className="p-1.5 rounded-full text-white/30 hover:text-red-300 hover:bg-red-500/10 transition-colors shrink-0"
                                                    title="Cancel"
                                                >
                                                    <Trash2 size={14} />
                                                </button>
                                            </div>

                                            <div className="mt-2 text-[12px] text-white/20 truncate">{r.when_iso}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default RemindersWindow;
