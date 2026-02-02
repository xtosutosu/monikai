import React, { useState, useEffect, useMemo } from 'react';
import dayjs from 'dayjs';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { CalendarDays, X, Trash2, ChevronLeft, ChevronRight } from 'lucide-react';
import 'dayjs/locale/pl';

dayjs.extend(localizedFormat);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);
dayjs.locale('pl');

const CalendarWindow = ({ socket, isVisible, onClose, position, onMouseDown, zIndex, activeDragElement }) => {
  const [events, setEvents] = useState([]);
  const [currentDate, setCurrentDate] = useState(dayjs());
  const [selectedDate, setSelectedDate] = useState(dayjs());

  // Fetch events for the currently viewed month
  useEffect(() => {
    if (!socket || !isVisible) return;

    const handleCalendarUpdate = (data) => {
      console.log("Received local calendar data:", data);
      if (Array.isArray(data)) {
        setEvents(data);
      }
    };

    socket.on('calendar_data', handleCalendarUpdate);
    
    // Request events for the current month when the component becomes visible or the month changes
    const startOfMonth = currentDate.startOf('month').toISOString();
    const endOfMonth = currentDate.endOf('month').toISOString();
    socket.emit('user_input', { text: `pokaż wydarzenia od ${startOfMonth} do ${endOfMonth}` });

    return () => {
      socket.off('calendar_data', handleCalendarUpdate);
    };
  }, [socket, isVisible, currentDate]);

  const handleDeleteEvent = (eventId) => {
    if (socket) {
      socket.emit('user_input', { text: `usuń wydarzenie o ID ${eventId}` });
    }
  };

  const generateCalendarGrid = () => {
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
  };

  const calendarGrid = useMemo(generateCalendarGrid, [currentDate]);

  const eventDates = useMemo(() => {
    return new Set(events.map(e => dayjs(e.start_iso).format('YYYY-MM-DD')));
  }, [events]);

  const eventsForSelectedDay = useMemo(() => {
    return events
      .filter(e => dayjs(e.start_iso).isSame(selectedDate, 'day'))
      .sort((a, b) => new Date(a.start_iso) - new Date(b.start_iso));
  }, [events, selectedDate]);

  if (!isVisible) {
    return null;
  }

  const formatEventTime = (event) => {
    const start = dayjs(event.start_iso);
    const end = dayjs(event.end_iso);
    if (start.isSame(end, 'day')) {
      return `${start.format('HH:mm')} - ${end.format('HH:mm')}`;
    }
    return `${start.format('HH:mm')} - ${end.format('D MMM HH:mm')}`;
  };

  const weekdays = ['Nd', 'Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So'];

  return (
    <div
      id="calendar"
      onMouseDown={onMouseDown}
      style={{
        position: 'absolute',
        left: position.x,
        top: position.y,
        transform: 'translate(-50%, -50%)',
        width: '420px', // A bit wider to accommodate the calendar
        zIndex: zIndex
      }}
      className={`pointer-events-auto flex flex-col gap-2 p-4 rounded-2xl backdrop-blur-xl bg-black/70 border border-indigo-500/30 select-none shadow-[0_0_20px_rgba(129,140,248,0.1)] transition-shadow ${
        activeDragElement === 'calendar' ? 'shadow-[0_0_35px_rgba(129,140,248,0.25)] ring-2 ring-indigo-400/60' : ''
      }`}
    >
      {/* Header */}
      <div data-drag-handle className="flex items-center justify-between pb-2 border-b border-white/10 mb-2 cursor-grab active:cursor-grabbing">
        <div className="flex items-center gap-2">
          <CalendarDays size={16} className="text-indigo-400" />
          <h3 className="font-bold text-indigo-300 tracking-wider text-sm">Lokalny Kalendarz</h3>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors text-white/50 hover:text-white" title="Zamknij">
          <X size={16} />
        </button>
      </div>

      {/* Calendar Body */}
      <div className="flex-1 overflow-y-auto max-h-[500px] scrollbar-hide">
        {/* Month Navigation */}
        <div className="flex items-center justify-between mb-3 px-2">
          <button onClick={() => setCurrentDate(currentDate.subtract(1, 'month'))} className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors">
            <ChevronLeft size={18} />
          </button>
          <h4 className="font-bold text-lg text-white/90 capitalize">
            {currentDate.format('MMMM YYYY')}
          </h4>
          <button onClick={() => setCurrentDate(currentDate.add(1, 'month'))} className="p-1.5 rounded-full hover:bg-white/10 text-white/60 hover:text-white transition-colors">
            <ChevronRight size={18} />
          </button>
        </div>

        {/* Weekday Headers */}
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-white/40 mb-2">
          {weekdays.map(day => <div key={day}>{day}</div>)}
        </div>

        {/* Day Grid */}
        <div className="grid grid-cols-7 gap-1">
          {calendarGrid.map((day, index) => {
            const isToday = day.isSame(dayjs(), 'day');
            const isSelected = day.isSame(selectedDate, 'day');
            const isCurrentMonth = day.isSame(currentDate, 'month');
            const hasEvents = eventDates.has(day.format('YYYY-MM-DD'));

            return (
              <div
                key={index}
                className={`relative h-10 flex items-center justify-center rounded-lg cursor-pointer transition-colors
                  ${isCurrentMonth ? 'text-white/80' : 'text-white/30'}
                  ${isSelected ? 'bg-indigo-500/40 border border-indigo-400' : 'hover:bg-white/10'}
                  ${isToday && !isSelected ? 'border border-white/20' : ''}
                `}
                onClick={() => setSelectedDate(day)}
              >
                <span>{day.format('D')}</span>
                {hasEvents && (
                  <div className="absolute bottom-1.5 w-1.5 h-1.5 bg-indigo-400 rounded-full"></div>
                )}
              </div>
            );
          })}
        </div>

        {/* Events for selected day */}
        <div className="mt-4 pt-4 border-t border-white/10">
          <h5 className="font-bold text-white/80 mb-2 px-2">
            Wydarzenia na {selectedDate.format('D MMMM')}
          </h5>
          {eventsForSelectedDay.length === 0 ? (
            <p className="p-3 text-sm text-gray-400 text-center">Brak wydarzeń na ten dzień.</p>
          ) : (
            <ul className="list-none p-0 m-0 space-y-2">
              {eventsForSelectedDay.map(event => (
                <li key={event.id} className="p-2.5 bg-white/5 rounded-lg text-sm group hover:bg-indigo-500/10 transition-colors flex justify-between items-center">
                  <div>
                    <div className="font-bold text-gray-200 truncate">{event.summary}</div>
                    <div className="text-gray-400 text-xs mt-1">{formatEventTime(event)}</div>
                  </div>
                  <button onClick={() => handleDeleteEvent(event.id)} className="ml-2 p-1 text-xs text-red-400/60 hover:text-red-400 hover:bg-red-500/20 rounded opacity-0 group-hover:opacity-100 transition-opacity" title="Usuń wydarzenie">
                      <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};

export default CalendarWindow;