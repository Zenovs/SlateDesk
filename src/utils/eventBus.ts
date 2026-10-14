/**
 * Global Event Bus for inter-widget communication.
 * Widgets can emit and listen to events without direct coupling.
 * 
 * Usage:
 *   eventBus.on('calendar:updated', handler);
 *   eventBus.emit('calendar:updated', data);
 *   eventBus.off('calendar:updated', handler);
 */

type EventHandler = (data?: unknown) => void;

class EventBus {
  private listeners: Map<string, Set<EventHandler>> = new Map();

  on(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;
    handlers.delete(handler);
    // Per-instance event names would otherwise pile up over weeks of adding
    // and removing widgets on the 24/7 kiosk.
    if (handlers.size === 0) this.listeners.delete(event);
  }

  emit(event: string, data?: unknown): void {
    this.listeners.get(event)?.forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        console.error(`EventBus error in handler for "${event}":`, err);
      }
    });
  }

  clear(): void {
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();
