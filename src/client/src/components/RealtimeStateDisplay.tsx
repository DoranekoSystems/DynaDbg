import React from 'react';
import { Box, Typography, Chip, Paper } from '@mui/material';
import { useAppState } from '../hooks/useAppState';

/**
 * Real-time state display component for debugging
 */
export const RealtimeStateDisplay: React.FC = () => {
  // Monitor state with new unified system
  const { system, ui } = useAppState();
  
  const serverConnected = system.serverConnected;
  const debuggerConnected = system.debuggerConnected;
  const attachedProcess = system.attachedProcess?.processname || 'None';
  const isInBreakState = system.isInBreakState;
  const currentThreadId = system.currentThreadId;
  const activeBreakpointsCount = system.activeBreakpoints.length;
  const watchpointsCount = system.watchpoints.length;
  const currentMode = ui.currentMode;
  const lastUpdate = new Date(Math.max(system.lastUpdate, ui.lastUpdate)).toLocaleTimeString();

  return (
    <Paper 
      elevation={2} 
      sx={{ 
        p: 2, 
        mb: 2, 
        backgroundColor: 'rgba(0, 0, 0, 0.7)',
        border: '1px solid #333'
      }}
    >
      <Typography variant="h6" gutterBottom color="primary">
        Real-time State Monitor
      </Typography>
      
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
        <Chip 
          label={`Server: ${serverConnected ? 'CONNECTED' : 'DISCONNECTED'}`}
          color={serverConnected ? 'success' : 'error'}
          size="small"
        />
        <Chip 
          label={`Debugger: ${debuggerConnected ? 'CONNECTED' : 'DISCONNECTED'}`}
          color={debuggerConnected ? 'success' : 'error'}
          size="small"
        />
        <Chip 
          label={`Process: ${attachedProcess}`}
          color={attachedProcess !== 'None' ? 'info' : 'default'}
          size="small"
        />
      </Box>

      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mb: 2 }}>
        <Chip 
          label={`Break State: ${isInBreakState ? 'ACTIVE' : 'INACTIVE'}`}
          color={isInBreakState ? 'warning' : 'default'}
          size="small"
        />
        <Chip 
          label={`Thread ID: ${currentThreadId || 'N/A'}`}
          color="info"
          size="small"
        />
        <Chip 
          label={`Breakpoints: ${activeBreakpointsCount}`}
          color="secondary"
          size="small"
        />
        <Chip 
          label={`Watchpoints: ${watchpointsCount}`}
          color="secondary"
          size="small"
        />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Mode: <strong>{currentMode}</strong>
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Last Update: {lastUpdate}
        </Typography>
      </Box>
    </Paper>
  );
};
