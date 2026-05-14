'use client';
import { toast } from 'sonner';
import { useItineraryStore } from '@/store/useItineraryStore';
import type { Event } from '@/types';

export default function AddItineraryButton({ event }: { event: Event }) {
  const { plannedEvents, addEvent, removeEvent } = useItineraryStore();
  const isAdded = plannedEvents.some(e => e.id === event.id);

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isAdded) {
      removeEvent(event.id);
      toast('已從行程移除', { description: event.title });
    } else {
      addEvent(event);
      toast('✓ 已加入行程', { description: event.title });
    }
  };

  return (
    <button
      onClick={handleClick}
      className={`mt-4 w-full py-2.5 text-sm tracking-wider transition-all active:scale-95 border ${
        isAdded
          ? 'border-stone-300 text-stone-400 bg-transparent'
          : 'border-teal-800 text-teal-800 hover:bg-teal-800 hover:text-white'
      }`}
    >
      {isAdded ? '✓ 已加入行程' : '+ 加入行程'}
    </button>
  );
}
