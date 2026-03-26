/**
 * Widget Registration
 * 
 * All widgets are registered here. To add a new widget:
 * 1. Create the widget component in src/widgets/YourWidget.tsx
 * 2. Export a WidgetDefinition from it
 * 3. Import and register it below
 */
import { registerWidget } from '../utils/widgetRegistry';
import { clockWidgetDef } from './ClockWidget';
import { calendarWidgetDef } from './CalendarWidget';
import { weatherWidgetDef } from './WeatherWidget';
import { messagesWidgetDef } from './MessagesWidget';
import { todoWidgetDef } from './TodoWidget';

export const initializeWidgets = () => {
  registerWidget(clockWidgetDef);
  registerWidget(calendarWidgetDef);
  registerWidget(weatherWidgetDef);
  registerWidget(messagesWidgetDef);
  registerWidget(todoWidgetDef);
};
