/**
 * Messages Widget – Shows unread messages (mock data).
 * Inspired by Screenshot 2 "Messages" section.
 */
import React from 'react';
import type { WidgetProps, WidgetDefinition } from '../types/widget';
import { mockMessages } from '../utils/mockData';

const MessagesComponent: React.FC<WidgetProps> = () => {
  const unreadCount = mockMessages.filter((m) => m.unread).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Unread badge */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginBottom: 14,
      }}>
        <div style={{
          fontSize: 'var(--font-size-xl)',
          fontWeight: 'var(--font-weight-bold)',
          color: 'var(--text-primary)',
          border: '2px solid var(--border-color)',
          borderRadius: 'var(--radius-md)',
          padding: '6px 14px',
          minWidth: 50,
          textAlign: 'center',
        }}>
          {unreadCount}
        </div>
        <div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', fontWeight: 'var(--font-weight-medium)' }}>UNREAD</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{mockMessages.length} Nachrichten</div>
        </div>
      </div>

      {/* Message list */}
      <div style={{ flex: 1, overflow: 'auto' }}>
        {mockMessages.map((msg) => (
          <div key={msg.id} style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            padding: '8px 0',
            borderBottom: '1px solid var(--border-color)',
          }}>
            {/* Avatar placeholder */}
            <div style={{
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: 'var(--bg-tertiary)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-secondary)',
              flexShrink: 0,
            }}>
              {msg.sender.charAt(0)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 'var(--font-size-xs)',
              }}>
                <span style={{
                  fontWeight: msg.unread ? 'var(--font-weight-bold)' : 'var(--font-weight-regular)',
                  color: 'var(--text-primary)',
                }}>
                  {msg.sender}
                </span>
                <span style={{ color: 'var(--text-tertiary)', flexShrink: 0 }}>{msg.time}</span>
              </div>
              <div style={{
                fontSize: 'var(--font-size-xs)',
                color: 'var(--text-tertiary)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                marginTop: 2,
              }}>
                {msg.preview}
              </div>
            </div>
            {msg.unread && (
              <div style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: 'var(--accent-color)',
                flexShrink: 0,
                marginTop: 6,
              }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export const messagesWidgetDef: WidgetDefinition = {
  manifest: {
    id: 'messages',
    name: 'Nachrichten',
    description: 'Ungelesene Nachrichten',
    version: '1.0.0',
    author: 'SlateDesk',
    minWidth: 2,
    minHeight: 2,
    defaultWidth: 3,
    defaultHeight: 3,
    permissions: ['messages.read'],
  },
  component: MessagesComponent,
};
