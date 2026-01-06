import React, { useMemo } from 'react';
import { Box, Typography, Paper } from '@mui/material';
import { useAppState } from '../hooks/useAppState';

// Utility function to truncate arrays to max 3 elements
const truncateArrays = (obj: any, maxArrayLength = 3): any => {
  if (Array.isArray(obj)) {
    if (obj.length <= maxArrayLength) {
      return obj.map(item => truncateArrays(item, maxArrayLength));
    }
    return [
      ...obj.slice(0, maxArrayLength).map(item => truncateArrays(item, maxArrayLength)),
      `...${obj.length - maxArrayLength} more items`
    ];
  } else if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = truncateArrays(value, maxArrayLength);
    }
    return result;
  }
  return obj;
};

/**
 * State Panel Component - Displays full app state as formatted JSON
 * With sidebar support and array truncation
 */
export const StatePanel: React.FC = () => {
  // Get entire app state from new unified system
  const { system, ui } = useAppState();

  // Create formatted JSON with array truncation
  const formattedState = useMemo(() => {
    // Combine system and UI state for display
    const combinedState = {
      system: system,
      ui: ui,
    };
    
    // Apply array truncation to the entire state
    const truncatedState = truncateArrays(combinedState);
    
    return JSON.stringify(truncatedState, null, 2);
  }, [system, ui]);

  // Syntax highlighting function for JSON
  const syntaxHighlight = (json: string) => {
    return json.replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      (match) => {
        let cls = 'json-number';
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = 'json-key';
          } else {
            cls = 'json-string';
          }
        } else if (/true|false/.test(match)) {
          cls = 'json-boolean';
        } else if (/null/.test(match)) {
          cls = 'json-null';
        }
        return `<span class="${cls}">${match}</span>`;
      }
    );
  };

  return (
    <Box
      sx={{
        height: '100%',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'background.default',
      }}
    >
      {/* Header */}
      <Box sx={{ p: 2, pb: 1 }}>
        <Typography variant="h4" gutterBottom color="primary">
          Global State Monitor
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Real-time JSON view of all application state
        </Typography>
      </Box>

      {/* JSON Content */}
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, pb: 2 }}>
        <Paper
          elevation={2}
          sx={{
            p: 3,
            height: '100%',
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            border: '1px solid #333',
            overflow: 'auto',
          }}
        >
          <pre
            style={{
              margin: 0,
              fontFamily: 'Monaco, Consolas, "Courier New", monospace',
              fontSize: '13px',
              lineHeight: '1.4',
              color: '#e0e0e0',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
            dangerouslySetInnerHTML={{
              __html: syntaxHighlight(formattedState)
            }}
          />
        </Paper>
      </Box>

      {/* CSS for syntax highlighting */}
      <style>
        {`
          .json-key {
            color: #92c5f7;
            font-weight: bold;
          }
          .json-string {
            color: #ce9178;
          }
          .json-number {
            color: #b5cea8;
          }
          .json-boolean {
            color: #569cd6;
            font-weight: bold;
          }
          .json-null {
            color: #569cd6;
            font-weight: bold;
          }
        `}
      </style>
    </Box>
  );
};