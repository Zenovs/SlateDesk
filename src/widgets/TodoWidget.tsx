/**
 * Todo Widget – Simple task list (mock data).
 * Inspired by Screenshot 2 "Any Do" section.
 */
import React, { useState } from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { mockTodos } from '../utils/mockData';
import type { TodoItem } from '../utils/mockData';

const TodoComponent: React.FC<WidgetProps> = () => {
  const [todos, setTodos] = useState<TodoItem[]>(mockTodos);

  const toggleTodo = (id: string) => {
    setTodos((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
  };

  const categories: { key: TodoItem['category']; label: string }[] = [
    { key: 'today', label: 'HEUTE' },
    { key: 'tomorrow', label: 'MORGEN' },
    { key: 'later', label: 'SPÄTER' },
  ];

  return (
    <div style={{ height: '100%', overflow: 'auto' }}>
      {categories.map((cat) => {
        const items = todos.filter((t) => t.category === cat.key);
        if (items.length === 0) return null;
        return (
          <div key={cat.key} style={{ marginBottom: 14 }}>
            <div style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--text-accent)',
              fontWeight: 'var(--font-weight-bold)',
              letterSpacing: 1,
              marginBottom: 6,
            }}>
              {cat.label}
            </div>
            {items.map((todo) => (
              <div
                key={todo.id}
                onClick={() => toggleTodo(todo.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '6px 0',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border-color)',
                }}
              >
                <div style={{
                  width: 16,
                  height: 16,
                  borderRadius: 4,
                  border: `2px solid ${todo.done ? 'var(--success)' : 'var(--border-color-hover)'}`,
                  background: todo.done ? 'var(--success)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'all 150ms',
                }}>
                  {todo.done && <span style={{ color: '#fff', fontSize: 10, lineHeight: 1 }}>✓</span>}
                </div>
                <span style={{
                  fontSize: 'var(--font-size-sm)',
                  color: todo.done ? 'var(--text-tertiary)' : 'var(--text-primary)',
                  textDecoration: todo.done ? 'line-through' : 'none',
                  transition: 'color 150ms',
                }}>
                  {todo.text}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};

export const todoWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'todo',
    name: 'Aufgaben',
    description: 'Aufgabenliste',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 4,
    defaultHeight: 3,
    permissions: [],
  },
  component: TodoComponent,
};