import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Clock, Trash2, RefreshCw, Bell, Timer, Plus, Volume2, CalendarDays, ChevronLeft, ChevronRight, LayoutList } from 'lucide-react';
import dayjs from 'dayjs';
import 'dayjs/locale/pl';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';

dayjs.extend(localizedFormat);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);
dayjs.locale('pl');

// Draggable reminders + timers window
const RemindersWindow = ({
    socket,
    position,
    onClose,
    onMouseDown,
    activeDragElement,
    zIndex = 40
}) => {
    const [reminders, setReminders] = useState([]); // [{ id, message, when_iso, speak, alert, when_epoch_ms }]
    const [events, setEvents] = useState([]); // [{ id, summary, start_iso, end_iso, description }]
    const [isLoading, setIsLoading] = useState(false);

    const [viewMode, setViewMode] = useState('list'); // 'list' | 'month'
    const [currentDate, setCurrentDate] = useState(dayjs());
    const [selectedDate, setSelectedDate] = useState(dayjs());

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
        socket.emit('list_calendar');
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

        const handleCalendarData = (data) => {
            setEvents(Array.isArray(data) ? data : []);
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
        socket.on('calendar_data', handleCalendarData);

        return () => {
            socket.off('reminders_list', handleList);
            socket.off('reminder_fired', handleFired);
            socket.off('calendar_data', handleCalendarData);
            stopBeep();
            if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
        };
    }, [socket]);

    const grouped = useMemo(() => {
        const groups = {};
        
        // Process reminders
        for (const r of reminders) {
            const d = new Date(r.when_iso);
            const key = isNaN(d.getTime()) ? (r.when_iso || 'Unknown') : d.toISOString().slice(0, 10);
            if (!groups[key]) groups[key] = [];
            groups[key].push({ ...r, _type: 'reminder', _ts: d.getTime() });
        }

        // Process calendar events
        for (const e of events) {
            const d = new Date(e.start_iso);
            const key = isNaN(d.getTime()) ? (e.start_iso || 'Unknown') : d.toISOString().slice(0, 10);
            if (!groups[key]) groups[key] = [];
            groups[key].push({ ...e, _type: 'event', _ts: d.getTime() });
        }

        for (const key of Object.keys(groups)) {
            groups[key].sort((a, b) => (a._ts || 0) - (b._ts || 0));
        }
        const sortedKeys = Object.keys(groups).sort();
        return { groups, keys: sortedKeys };
    }, [reminders, events]);

    const calendarGrid = useMemo(() => {
        const firstDayOfMonth = currentDate.startOf('month');
        const lastDayOfMonth = currentDate.endOf('month');
        const startDate = firstDayOfMonth.startOf('week');
        const endDate = lastDayOfMonth.endOf('week');

        const grid = [];
        let day = startDate;

        while (day.isSameOrBefore(endDate, 'day')) {
            grid.push(day);
            day = day.add(1, 'day');
        }
        return grid;
    }, [currentDate]);

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

    const deleteItem = (item) => {
        if (!socket || !item.id) return;
        if (item._type === 'reminder') {
            socket.emit('cancel_reminder', { id: item.id });
            setReminders(prev => prev.filter(r => r.id !== item.id));
        } else {
            socket.emit('delete_calendar_event', { id: item.id });
            setEvents(prev => prev.filter(e => e.id !== item.id));
        }
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

    const weekdays = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];

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
            className={`pointer-events-auto flex flex-col gap-4 p-4 backdrop-blur-xl bg-black/70 border border-cyan-500/30 rounded-2xl shadow-[0_0_20px_rgba(6,182,212,0.12)] select-none transition-shadow ${
                activeDragElement === 'reminders' ? 'shadow-[0_0_35px_rgba(6,182,212,0.25)] ring-2 ring-cyan-400/60' : ''
            }`}
        >
            {/* Header */}
            <div data-drag-handle className="flex items-center justify-between pb-2 border-b border-white/10 cursor-grab active:cursor-grabbing">
                <div className="flex items-center gap-2">
                    <CalendarDays size={16} className="text-white-400" />
                    <span className="text-xs font-bold tracking-widest text-white-100 uppercase">Schedule</span>
                </div>
                
                <div className="flex bg-white/5 rounded-lg p-0.5 border border-white/10">
                    <button
                        onClick={() => setViewMode('list')}
                        className={`p-1 rounded-md transition-all ${viewMode === 'list' ? 'bg-white/20 text-white' : 'text-white/40 hover:text-white/70'}`}
                        title="List View"
                    >
                        <LayoutList size={14} />
                    </button>
                    <button
                        onClick={() => setViewMode('month')}
                        className={`p-1 rounded-md transition-all ${viewMode === 'month' ? 'bg-white/20 text-white' : 'text-white/40 hover:text-white/70'}`}
                        title="Month View"
                    >
                        <CalendarDays size={14} />
                    </button>
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
                <div className="p-3 rounded-lg border border-white/10 bg-white/5">
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
            <div className="overflow-y-auto custom-scrollbar flex-1" style={{ maxHeight: '520px' }}>
                
                {/* Create Panel (Only in List Mode) */}
                {viewMode === 'list' && (
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
                )}

                {/* Month View Grid */}
                {viewMode === 'month' && (
                    <div className="mb-4">
                        {/* Month Nav */}
                        <div className="flex items-center justify-between mb-3 px-1">
                            <button onClick={() => setCurrentDate(currentDate.subtract(1, 'month'))} className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white">
                                <ChevronLeft size={16} />
                            </button>
                            <div className="font-bold text-white/90 capitalize text-sm">
                                {currentDate.format('MMMM YYYY')}
                            </div>
                            <button onClick={() => setCurrentDate(currentDate.add(1, 'month'))} className="p-1 rounded hover:bg-white/10 text-white/60 hover:text-white">
                                <ChevronRight size={16} />
                            </button>
                        </div>

                        {/* Weekdays */}
                        <div className="grid grid-cols-7 gap-1 text-center text-[10px] text-white/40 mb-2 font-bold uppercase">
                            {weekdays.map(day => <div key={day}>{day}</div>)}
                        </div>

                        {/* Grid */}
                        <div className="grid grid-cols-7 gap-1">
                            {calendarGrid.map((day, index) => {
                                const isToday = day.isSame(dayjs(), 'day');
                                const isSelected = day.isSame(selectedDate, 'day');
                                const isCurrentMonth = day.isSame(currentDate, 'month');
                                const dateKey = day.format('YYYY-MM-DD');
                                const hasItems = grouped.groups[dateKey] && grouped.groups[dateKey].length > 0;

                                return (
                                    <div
                                        key={index}
                                        onClick={() => setSelectedDate(day)}
                                        className={`
                                            relative h-9 flex items-center justify-center rounded-lg cursor-pointer transition-all text-xs
                                            ${isCurrentMonth ? 'text-white/80' : 'text-white/20'}
                                            ${isSelected ? 'bg-cyan-500/30 border border-cyan-500/50 text-white' : 'hover:bg-white/5 border border-transparent'}
                                            ${isToday && !isSelected ? 'border-white/20 bg-white/5' : ''}
                                        `}
                                    >
                                        <span>{day.format('D')}</span>
                                        {hasItems && (
                                            <div className="absolute bottom-1 w-1 h-1 bg-cyan-400 rounded-full shadow-[0_0_4px_cyan]"></div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        
                        {/* Selected Day Header */}
                        <div className="mt-4 mb-2 text-xs font-bold text-white/60 uppercase tracking-wider flex items-center gap-2">
                            <span>{selectedDate.format('D MMMM YYYY')}</span>
                            <div className="h-px flex-1 bg-white/10"></div>
                        </div>
                    </div>
                )}

                {/* List */}
                {viewMode === 'month' ? (
                    // Month View: Show items for selected date
                    <div className="space-y-2">
                        {(grouped.groups[selectedDate.format('YYYY-MM-DD')] || []).length > 0 ? (
                            (grouped.groups[selectedDate.format('YYYY-MM-DD')] || []).map(r => renderItem(r))
                        ) : (
                            <div className="text-center py-4 text-white/20 text-xs italic">No items for this day.</div>
                        )}
                    </div>
                ) : (
                    // List View: Show all items grouped
                    reminders.length === 0 && events.length === 0 ? (
                    <div className="text-center py-10 text-white/30 text-xs">
                        {isLoading ? (
                            <div className="flex flex-col items-center gap-2">
                                <RefreshCw className="animate-spin" size={20} />
                                <span>Loading schedule...</span>
                            </div>
                        ) : (
                            <div className="space-y-2">
                                <div>No items scheduled.</div>
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
                                    {grouped.groups[dateKey].map((r) => renderItem(r))}
                                </div>
                            </div>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );

    function renderItem(r) {
        return (
            <div
                key={r.id}
                className={`bg-white/5 border rounded-lg p-3 transition-all ${r._type === 'event' ? 'border-indigo-500/20 hover:border-indigo-500/40' : 'border-white/10 hover:border-white-500/30'}`}
                title={formatDateTime(r._type === 'reminder' ? r.when_iso : r.start_iso)}
            >
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${r._type === 'event' ? 'bg-indigo-500/20 text-indigo-200' : 'bg-white/5 text-white-200/80'}`}>
                                {r._type === 'reminder' 
                                    ? formatTime(r.when_iso) 
                                    : `${formatTime(r.start_iso)} - ${formatTime(r.end_iso)}`
                                }
                            </span>
                            
                            {r._type === 'reminder' ? (
                                <>
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
                                </>
                            ) : (
                                <span className="text-[10px] text-indigo-300/50 flex items-center gap-1">
                                    <CalendarDays size={10} /> event
                                </span>
                            )}
                        </div>
                        <div className="mt-1 text-sm text-white-50/90 break-words">{r._type === 'reminder' ? r.message : r.summary}</div>
                        {r._type === 'event' && r.description && <div className="mt-1 text-xs text-white/40">{r.description}</div>}
                    </div>

                    <button
                        onClick={() => deleteItem(r)}
                        className="p-1.5 rounded-full text-white/30 hover:text-red-300 hover:bg-red-500/10 transition-colors shrink-0"
                        title="Cancel"
                    >
                        <Trash2 size={14} />
                    </button>
                </div>

                <div className="mt-2 text-[12px] text-white/20 truncate">{r._type === 'reminder' ? r.when_iso : `${r.start_iso} -> ${r.end_iso}`}</div>
            </div>
        );
    }
};

export default RemindersWindow;
