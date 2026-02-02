import React, { useState, useEffect, useMemo } from 'react';
import { X, Calendar, Clock, Bell, Plus, Trash2, RefreshCw, ChevronLeft, ChevronRight, AlignLeft, Check, AlertCircle, Mic, MapPin, Edit2 } from 'lucide-react';
import { useLanguage } from '../contexts/LanguageContext';

const RemindersWindow = ({ socket, onClose, position, onMouseDown, activeDragElement, zIndex }) => {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState('list'); // 'list', 'month'
  const [isCreating, setIsCreating] = useState(false);
  const [createType, setCreateType] = useState('reminder'); // 'reminder', 'event'

  const [reminders, setReminders] = useState([]);
  const [events, setEvents] = useState([]);
  const [currentDate, setCurrentDate] = useState(new Date()); // For calendar view navigation
  const [selectedDate, setSelectedDate] = useState(new Date());
  const [editingItem, setEditingItem] = useState(null); // { id, type, text }

  // Form State
  const [formData, setFormData] = useState({
    message: '',
    date: new Date().toISOString().split('T')[0],
    time: new Date().toTimeString().slice(0, 5),
    duration: 60,
    speak: true,
    alert: true,
    allDay: false
  });

  useEffect(() => {
    socket.emit('list_reminders');
    socket.emit('list_calendar');

    const onRemindersList = (data) => setReminders(data.reminders || []);
    const onCalendarData = (data) => setEvents(data || []);

    socket.on('reminders_list', onRemindersList);
    socket.on('calendar_data', onCalendarData);

    return () => {
      socket.off('reminders_list', onRemindersList);
      socket.off('calendar_data', onCalendarData);
    };
  }, [socket]);

  const mergedItems = useMemo(() => {
    const mappedReminders = reminders.map(r => ({
      type: 'reminder',
      id: r.id,
      title: r.message,
      time: new Date(r.when_iso),
      original: r
    }));
    const mappedEvents = events.map(e => ({
      type: 'event',
      id: e.id,
      title: e.summary,
      time: new Date(e.start_iso),
      endTime: new Date(e.end_iso),
      original: e
    }));
    return [...mappedReminders, ...mappedEvents].sort((a, b) => a.time - b.time);
  }, [reminders, events]);

  const handleDelete = (item) => {
    if (item.type === 'reminder') {
      socket.emit('cancel_reminder', { id: item.id });
    } else {
      socket.emit('delete_event', { id: item.id });
    }
  };

  const handleUpdate = (item, newText) => {
    if (!newText.trim()) return;
    if (item.type === 'reminder') {
      socket.emit('update_reminder', { id: item.id, message: newText });
    } else {
      socket.emit('update_event', { id: item.id, summary: newText });
    }
    setEditingItem(null);
  };

  const handleCreate = () => {
    if (!formData.message) return;

    if (createType === 'reminder') {
      socket.emit('create_reminder', {
        message: formData.message,
        at: `${formData.date} ${formData.time}`,
        speak: formData.speak,
        alert: formData.alert
      });
    } else {
      let start, end;
      if (formData.allDay) {
        start = new Date(`${formData.date}T00:00:00`);
        end = new Date(`${formData.date}T23:59:59`);
      } else {
        start = new Date(`${formData.date} ${formData.time}`);
        end = new Date(start.getTime() + formData.duration * 60000);
      }

      socket.emit('create_event', {
        summary: formData.message,
        start_iso: start.toISOString(),
        end_iso: end.toISOString(),
        description: ''
      });
    }
    setIsCreating(false);
    setFormData(prev => ({ ...prev, message: '' }));
  };

  // Calendar Helpers
  const getDaysInMonth = (date) => {
    const year = date.getFullYear();
    const month = date.getMonth();
    const days = new Date(year, month + 1, 0).getDate();
    const firstDay = new Date(year, month, 1).getDay();
    return { days, firstDay };
  };

  const renderCalendar = () => {
    const { days, firstDay } = getDaysInMonth(currentDate);
    const blanks = Array(firstDay).fill(null);
    const dayNumbers = Array.from({ length: days }, (_, i) => i + 1);
    const allCells = [...blanks, ...dayNumbers];

    return (
      <div className="grid grid-cols-7 gap-1 text-center text-xs">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => (
          <div key={d} className="text-white/40 py-1">{d}</div>
        ))}
        {allCells.map((day, i) => {
          if (!day) return <div key={i} className="aspect-square" />;
          
          const cellDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day);
          const isToday = new Date().toDateString() === cellDate.toDateString();
          const isSelected = selectedDate.toDateString() === cellDate.toDateString();
          const hasItems = mergedItems.some(item => item.time.toDateString() === cellDate.toDateString());

          return (
            <div 
              key={i} 
              onClick={() => setSelectedDate(cellDate)}
              className={`aspect-square flex flex-col items-center justify-center rounded-lg relative group hover:bg-white/10 transition-colors cursor-pointer ${isSelected ? 'bg-white text-black shadow-lg shadow-white/20' : isToday ? 'bg-white/20 text-white border border-white/30' : 'text-white/80'}`}
            >
              <span>{day}</span>
              {hasItems && <div className={`w-1 h-1 rounded-full mt-1 ${isSelected ? 'bg-black' : 'bg-white'}`} />}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div
      id="reminders"
      className={`absolute flex flex-col transition-[box-shadow,border-color] duration-200
        backdrop-blur-2xl bg-black/50 border border-white/[0.14] shadow-2xl overflow-hidden rounded-xl
        ${activeDragElement === 'reminders' ? 'ring-1 ring-white/50 border-white/30' : ''}
      `}
      style={{
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -50%)',
        width: '400px',
        height: '550px',
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
          <Clock size={18} className="text-white" />
          <span className="text-sm font-medium tracking-wider text-white/90 uppercase">{t('schedule.title')}</span>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => { socket.emit('list_reminders'); socket.emit('list_calendar'); }}
            className="p-1.5 hover:bg-white/10 rounded-lg text-white/50 hover:text-white transition-colors"
          >
            <RefreshCw size={14} />
          </button>
          <button 
            onClick={onClose}
            className="p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-lg text-white/50 transition-colors"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Tabs & Actions */}
      <div className="p-3 flex gap-2 shrink-0">
        <div className="flex-1 bg-white/5 p-1 rounded-lg flex gap-1">
          <button
            onClick={() => setActiveTab('list')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === 'list' ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <AlignLeft size={14} />
            {t('schedule.list_view')}
          </button>
          <button
            onClick={() => setActiveTab('month')}
            className={`flex-1 flex items-center justify-center gap-2 py-1.5 rounded-md text-xs font-medium transition-all ${
              activeTab === 'month' ? 'bg-white/10 text-white shadow-sm' : 'text-white/40 hover:text-white/70'
            }`}
          >
            <Calendar size={14} />
            {t('schedule.month_view')}
          </button>
        </div>
        <button
          onClick={() => setIsCreating(!isCreating)}
          className={`px-3 rounded-lg border transition-all flex items-center justify-center ${
            isCreating 
              ? 'bg-white/20 border-white/50 text-white' 
              : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white'
          }`}
        >
          <Plus size={18} className={isCreating ? 'rotate-45 transition-transform' : 'transition-transform'} />
        </button>
      </div>

      {/* Creation Panel */}
      {isCreating && (
        <div className="px-4 pb-4 shrink-0 animate-in slide-in-from-top-2 duration-200">
          <div className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-3">
            <div className="flex gap-2 mb-2">
              {['reminder', 'event'].map(type => (
                <button
                  key={type}
                  onClick={() => setCreateType(type)}
                  className={`flex-1 text-xs py-1 rounded border transition-colors ${
                    createType === type 
                      ? 'bg-white/20 border-white/50 text-white' 
                      : 'border-transparent text-white/40 hover:bg-white/5'
                  }`}
                >
                  {type === 'reminder' ? t('schedule.reminder') : t('schedule.event')}
                </button>
              ))}
            </div>

            <input
              type="text"
              placeholder={t('schedule.msg_required')}
              value={formData.message}
              onChange={e => setFormData({ ...formData, message: e.target.value })}
              className="w-full bg-black/50 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:border-white/50"
            />

            <div className="flex gap-2">
              <input
                type="date"
                value={formData.date}
                onChange={e => setFormData({ ...formData, date: e.target.value })}
                className="flex-1 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-white/50"
              />
              {!formData.allDay && (
                <input
                  type="time"
                  value={formData.time}
                  onChange={e => setFormData({ ...formData, time: e.target.value })}
                  className="w-24 bg-black/50 border border-white/10 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:border-white/50"
                />
              )}
            </div>

            {createType === 'event' && (
              <div className="flex items-center justify-between mt-1">
                <label className="flex items-center gap-2 text-xs text-white/60 cursor-pointer select-none">
                  <div className={`w-3 h-3 border rounded flex items-center justify-center transition-colors ${formData.allDay ? 'bg-white border-white' : 'border-white/30 bg-black/30'}`}>
                    {formData.allDay && <Check size={10} className="text-white" />}
                  </div>
                  <input 
                    type="checkbox" 
                    checked={formData.allDay} 
                    onChange={e => setFormData({...formData, allDay: e.target.checked})}
                    className="hidden"
                  />
                  <span>{t('schedule.all_day') || 'All Day'}</span>
                </label>

                {!formData.allDay && (
                  <div className="flex items-center gap-2 text-xs text-white/60">
                    <span>{t('schedule.duration')}:</span>
                    <input
                      type="number"
                      value={formData.duration}
                      onChange={e => setFormData({ ...formData, duration: parseInt(e.target.value) || 0 })}
                      className="w-16 bg-black/50 border border-white/10 rounded px-2 py-1 text-white focus:outline-none focus:border-white/50"
                    />
                    <span>min</span>
                  </div>
                )}
              </div>
            )}

            {createType === 'reminder' && (
              <div className="flex gap-2">
                <button
                  onClick={() => setFormData({ ...formData, speak: !formData.speak })}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border text-xs transition-colors ${
                    formData.speak ? 'bg-white/10 border-white/20 text-white' : 'border-transparent text-white/40'
                  }`}
                >
                  <Mic size={12} />
                  {t('schedule.speak')}
                </button>
                <button
                  onClick={() => setFormData({ ...formData, alert: !formData.alert })}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded border text-xs transition-colors ${
                    formData.alert ? 'bg-white/10 border-white/20 text-white' : 'border-transparent text-white/40'
                  }`}
                >
                  <Bell size={12} />
                  {t('schedule.alert')}
                </button>
              </div>
            )}

            <button
              onClick={handleCreate}
              className="w-full bg-white/20 hover:bg-white/30 text-white py-2 rounded-lg text-xs font-medium tracking-wide transition-colors"
            >
              {t('schedule.create')}
            </button>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 pt-0">
        {activeTab === 'list' ? (
          <div className="space-y-4">
            {mergedItems.filter(item => {
              const now = new Date();
              now.setHours(0, 0, 0, 0);
              const nextWeek = new Date(now);
              nextWeek.setDate(now.getDate() + 7);
              return item.time >= now && item.time <= nextWeek;
            }).length === 0 ? (
              <div className="flex flex-col items-center justify-center h-40 text-white/30 space-y-2">
                <Clock size={32} />
                <span className="text-xs">{t('schedule.no_items')}</span>
              </div>
            ) : (
              <>
                {/* Group items by day roughly or just list them */}
                {mergedItems.filter(item => {
                  const now = new Date();
                  now.setHours(0, 0, 0, 0);
                  const nextWeek = new Date(now);
                  nextWeek.setDate(now.getDate() + 7);
                  return item.time >= now && item.time <= nextWeek;
                }).map((item, idx) => {
                  const isPast = item.time < new Date();
                  const isToday = item.time.toDateString() === new Date().toDateString();
                  
                  return (
                    <div 
                      key={`${item.type}-${item.id}`} 
                      className={`group relative pl-4 border-l-2 ${isPast ? 'border-white/10 opacity-60' : isToday ? 'border-white' : 'border-white/30'} py-1 transition-all hover:bg-white/5 rounded-r-lg pr-2`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className={`text-xs font-mono ${isToday ? 'text-white' : 'text-white/50'}`}>
                              {item.time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                            {item.type === 'event' && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/60">
                                {Math.round((item.endTime - item.time) / 60000)}m
                              </span>
                            )}
                          </div>
                          
                          {editingItem?.id === item.id ? (
                            <input
                              autoFocus
                              type="text"
                              value={editingItem.text}
                              onChange={(e) => setEditingItem({ ...editingItem, text: e.target.value })}
                              onBlur={() => handleUpdate(item, editingItem.text)}
                              onKeyDown={(e) => e.key === 'Enter' && handleUpdate(item, editingItem.text)}
                              className="w-full bg-black/50 border border-white/50 rounded px-1 py-0.5 text-sm text-white focus:outline-none"
                            />
                          ) : (
                            <p className="text-sm text-white/90 truncate">{t(item.title)}</p>
                          )}

                          <p className="text-[10px] text-white/40">
                            {item.time.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                        
                        {!item.id.startsWith('holiday-') && (
                          <button
                            onClick={() => setEditingItem({ id: item.id, type: item.type, text: item.title })}
                            className="opacity-0 group-hover:opacity-100 p-1.5 text-white/30 hover:text-white transition-all"
                          >
                            <Edit2 size={14} />
                          </button>
                        )}

                        <button
                          onClick={() => handleDelete(item)}
                          className="opacity-0 group-hover:opacity-100 p-1.5 text-white/30 hover:text-red-400 transition-all"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* Calendar Header */}
            <div className="flex items-center justify-between mb-4">
              <button 
                onClick={() => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() - 1)))}
                className="p-1 hover:bg-white/10 rounded text-white/50 hover:text-white"
              >
                <ChevronLeft size={16} />
              </button>
              <span className="text-sm font-medium text-white/90">
                {currentDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </span>
              <button 
                onClick={() => setCurrentDate(new Date(currentDate.setMonth(currentDate.getMonth() + 1)))}
                className="p-1 hover:bg-white/10 rounded text-white/50 hover:text-white"
              >
                <ChevronRight size={16} />
              </button>
            </div>

            {renderCalendar()}

            {/* Selected Day Preview (Simple list of items for the month) */}
            <div className="mt-6 pt-4 border-t border-white/10">
              <h4 className="text-xs font-medium text-white/50 uppercase tracking-wider mb-3">
                {t('schedule.event_label')}s ({selectedDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })})
              </h4>
              <div className="space-y-2">
                {mergedItems
                  .filter(i => i.time.toDateString() === selectedDate.toDateString())
                  .slice(0, 5)
                  .map(item => (
                    <div key={item.id} className="flex items-center gap-3 text-xs">
                      <div className={`w-1.5 h-1.5 rounded-full ${item.type === 'reminder' ? 'bg-white' : 'bg-white/50'}`} />
                      <span className="text-white/40 font-mono">
                        {item.time.getDate()}/{item.time.getMonth()+1}
                      </span>
                      <span className="text-white/80 truncate flex-1">{item.title}</span>
                    </div>
                  ))
                }
                {mergedItems.filter(i => i.time.toDateString() === selectedDate.toDateString()).length === 0 && (
                  <span className="text-xs text-white/30 italic">{t('schedule.no_items_day')}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default RemindersWindow;
