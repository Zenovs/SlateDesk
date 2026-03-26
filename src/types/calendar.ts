/**
 * Calendar type definitions for the Office 365 Calendar Widget.
 * Phase 1 uses mock data; Phase 2+ will integrate with real O365 API.
 */

export interface CalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  location?: string;
  description?: string;
  isAllDay: boolean;
  color?: string;
  organizer?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
}

export interface CalendarDay {
  date: Date;
  events: CalendarEvent[];
  isToday: boolean;
  isCurrentMonth: boolean;
}
