/**
 * Mock data for Phase 1 widgets.
 * These will be replaced with real API calls in later phases.
 */
import type { CalendarEvent } from '../types/calendar';

const today = new Date();
const d = (dayOffset: number, hour: number, minute: number = 0): Date => {
  const date = new Date(today);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
};

export const mockCalendarEvents: CalendarEvent[] = [
  {
    id: '1',
    title: 'Daily Standup',
    start: d(0, 9, 0),
    end: d(0, 9, 15),
    location: 'Teams',
    isAllDay: false,
    color: '#4a9eff',
    organizer: 'Sarah M.',
    status: 'confirmed',
  },
  {
    id: '2',
    title: 'Sprint Planning',
    start: d(0, 10, 0),
    end: d(0, 11, 30),
    location: 'Raum Zürich',
    isAllDay: false,
    color: '#e8642b',
    organizer: 'Team Lead',
    status: 'confirmed',
  },
  {
    id: '3',
    title: 'Mittagessen mit Martin',
    start: d(0, 12, 0),
    end: d(0, 13, 0),
    location: 'Kantine',
    isAllDay: false,
    color: '#4caf50',
    status: 'confirmed',
  },
  {
    id: '4',
    title: 'Code Review',
    start: d(0, 14, 0),
    end: d(0, 15, 0),
    location: 'Teams',
    isAllDay: false,
    color: '#9c27b0',
    organizer: 'Alex K.',
    status: 'confirmed',
  },
  {
    id: '5',
    title: 'Deadline: Q1 Report',
    start: d(0, 17, 0),
    end: d(0, 17, 0),
    isAllDay: false,
    color: '#f44336',
    status: 'confirmed',
  },
  {
    id: '6',
    title: 'Kino – Cineplex',
    start: d(0, 20, 0),
    end: d(0, 22, 30),
    location: 'Düsseldorf Einkaufstr.',
    isAllDay: false,
    color: '#ff9800',
    status: 'confirmed',
  },
  {
    id: '7',
    title: 'Team Retro',
    start: d(1, 10, 0),
    end: d(1, 11, 0),
    location: 'Raum Bern',
    isAllDay: false,
    color: '#4a9eff',
    organizer: 'Sarah M.',
    status: 'confirmed',
  },
  {
    id: '8',
    title: '1:1 mit Manager',
    start: d(1, 14, 0),
    end: d(1, 14, 30),
    location: 'Teams',
    isAllDay: false,
    color: '#e8642b',
    status: 'tentative',
  },
  {
    id: '9',
    title: 'Workshop: UI/UX Review',
    start: d(2, 9, 0),
    end: d(2, 12, 0),
    location: 'Raum Basel',
    isAllDay: false,
    color: '#9c27b0',
    status: 'confirmed',
  },
  {
    id: '10',
    title: 'Firmenevent',
    start: d(3, 0, 0),
    end: d(3, 23, 59),
    isAllDay: true,
    color: '#ff9800',
    status: 'confirmed',
  },
];

export interface WeatherForecast {
  day: string;
  icon: string;
  tempHigh: number;
  tempLow: number;
  condition: string;
}

export const mockWeatherData: WeatherForecast[] = [
  { day: 'Heute', icon: '☀️', tempHigh: 18, tempLow: 8, condition: 'Sonnig' },
  { day: 'Do', icon: '⛅', tempHigh: 16, tempLow: 7, condition: 'Teilw. bewölkt' },
  { day: 'Fr', icon: '🌧️', tempHigh: 13, tempLow: 6, condition: 'Regen' },
  { day: 'Sa', icon: '☁️', tempHigh: 14, tempLow: 5, condition: 'Bewölkt' },
  { day: 'So', icon: '☀️', tempHigh: 19, tempLow: 9, condition: 'Sonnig' },
];

export interface Message {
  id: string;
  sender: string;
  preview: string;
  time: string;
  unread: boolean;
  avatar?: string;
}

export const mockMessages: Message[] = [
  { id: '1', sender: 'Sarah M.', preview: 'Können wir das Meeting verschieben?', time: '09:15', unread: true },
  { id: '2', sender: 'Alex K.', preview: 'PR ist ready for review', time: '08:45', unread: true },
  { id: '3', sender: 'Team Chat', preview: 'Martin: Deployment ist durch ✅', time: '08:30', unread: false },
  { id: '4', sender: 'Lisa B.', preview: 'Dokument aktualisiert', time: 'Gestern', unread: false },
];

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
  category: 'today' | 'tomorrow' | 'later';
}

export const mockTodos: TodoItem[] = [
  { id: '1', text: 'Geschenk für Tim kaufen', done: false, category: 'today' },
  { id: '2', text: 'Hausaufgaben', done: false, category: 'today' },
  { id: '3', text: 'PR Review abschliessen', done: true, category: 'today' },
  { id: '4', text: 'Arzttermin vereinbaren', done: false, category: 'tomorrow' },
  { id: '5', text: 'Präsentation vorbereiten', done: false, category: 'later' },
];
