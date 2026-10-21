const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory boards cache: boardId -> { strokes: [], stickies: {}, lastModified: Date }
const boards = new Map();

function getBoardFile(boardId) {
  return path.join(DATA_DIR, `board_${boardId.replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

function loadBoard(boardId) {
  if (boards.has(boardId)) {
    return boards.get(boardId);
  }
  const filePath = getBoardFile(boardId);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      boards.set(boardId, data);
      return data;
    } catch (e) {
      console.error(`Error loading board ${boardId}:`, e);
    }
  }
  const initial = { strokes: [], stickies: {}, version: 1 };
  boards.set(boardId, initial);
  return initial;
}

let saveTimeouts = new Map();
function saveBoardDebounced(boardId) {
  if (saveTimeouts.has(boardId)) return;
  saveTimeouts.set(boardId, setTimeout(() => {
    saveTimeouts.delete(boardId);
    const board = boards.get(boardId);
    if (board) {
      fs.writeFile(getBoardFile(boardId), JSON.stringify(board), (err) => {
        if (err) console.error(`Error saving board ${boardId}:`, err);
      });
    }
  }, 1000));
}

// Room management
// rooms: boardId -> Set of ws clients
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', activeRooms: rooms.size, timestamp: Date.now() });
});

wss.on('connection', (ws) => {
  let currentRoom = null;
  let clientInfo = {
    id: Math.random().toString(36).substring(2, 9),
    name: 'Anonymous',
    color: '#3b82f6',
    role: 'editor', // 'editor' or 'viewer'
  };

  ws.on('message', (messageRaw) => {
    let msg;
    try {
      msg = JSON.parse(messageRaw.toString());
    } catch (err) {
      return;
    }

    const { type, payload } = msg;

    if (type === 'join') {
      const { boardId, name, color, role } = payload;
      currentRoom = boardId;
      clientInfo.name = name || 'Anonymous';
      clientInfo.color = color || '#3b82f6';
      clientInfo.role = role === 'viewer' ? 'viewer' : 'editor';

      if (!rooms.has(currentRoom)) {
        rooms.set(currentRoom, new Set());
      }
      rooms.get(currentRoom).add(ws);

      const boardState = loadBoard(currentRoom);

      // Send initial board state & participant's assigned id
      ws.send(JSON.stringify({
        type: 'init',
        payload: {
          clientId: clientInfo.id,
          role: clientInfo.role,
          strokes: boardState.strokes,
          stickies: boardState.stickies,
        }
      }));

      // Broadcast presence list update
      broadcastPresence(currentRoom);
      return;
    }

    if (!currentRoom) return;

    // Handle cursor broadcast (low latency)
    if (type === 'cursor') {
      broadcastToRoom(currentRoom, ws, {
        type: 'cursor',
        payload: {
          clientId: clientInfo.id,
          name: clientInfo.name,
          color: clientInfo.color,
          x: payload.x,
          y: payload.y,
          timestamp: payload.timestamp
        }
      });
      return;
    }

    // Live Emoji Reactions
    if (type === 'reaction') {
      broadcastToRoom(currentRoom, null, {
        type: 'reaction',
        payload: {
          emoji: payload.emoji,
          x: payload.x,
          y: payload.y,
          name: clientInfo.name,
          color: clientInfo.color,
          id: Math.random().toString(36).substring(2, 8)
        }
      });
      return;
    }

    // Ephemeral Laser Pointer
    if (type === 'laser') {
      broadcastToRoom(currentRoom, ws, {
        type: 'laser',
        payload: {
          clientId: clientInfo.id,
          x: payload.x,
          y: payload.y,
          color: clientInfo.color,
        }
      });
      return;
    }

    // Role-restricted actions
    if (clientInfo.role === 'viewer') {
      if (['stroke_start', 'stroke_chunk', 'stroke_end', 'sticky_create', 'sticky_update', 'sticky_delete', 'clear_board', 'undo'].includes(type)) {
        ws.send(JSON.stringify({
          type: 'error',
          payload: { message: 'You have view-only access on this board.' }
        }));
        return;
      }
    }

    // Freehand stroke streaming
    if (type === 'stroke_start' || type === 'stroke_chunk' || type === 'stroke_end') {
      broadcastToRoom(currentRoom, ws, {
        type,
        payload: {
          ...payload,
          clientId: clientInfo.id
        }
      });

      if (type === 'stroke_end' && payload.stroke) {
        const board = loadBoard(currentRoom);
        board.strokes.push(payload.stroke);
        saveBoardDebounced(currentRoom);
      }
      return;
    }

    // Sticky note events
    if (type === 'sticky_create' || type === 'sticky_update') {
      const board = loadBoard(currentRoom);
      board.stickies[payload.id] = payload;
      saveBoardDebounced(currentRoom);

      broadcastToRoom(currentRoom, ws, {
        type,
        payload: { ...payload, updatedBy: clientInfo.id }
      });
      return;
    }

    if (type === 'sticky_delete') {
      const board = loadBoard(currentRoom);
      delete board.stickies[payload.id];
      saveBoardDebounced(currentRoom);

      broadcastToRoom(currentRoom, ws, {
        type: 'sticky_delete',
        payload: { id: payload.id }
      });
      return;
    }

    // Undo last stroke by this user
    if (type === 'undo') {
      const board = loadBoard(currentRoom);
      // Find last stroke by this client
      let removedIndex = -1;
      for (let i = board.strokes.length - 1; i >= 0; i--) {
        if (board.strokes[i].clientId === clientInfo.id) {
          removedIndex = i;
          break;
        }
      }
      if (removedIndex !== -1) {
        const removed = board.strokes.splice(removedIndex, 1)[0];
        saveBoardDebounced(currentRoom);
        broadcastToRoom(currentRoom, null, {
          type: 'stroke_removed',
          payload: { strokeId: removed.id }
        });
      }
      return;
    }

    // Touch erase a stroke
    if (type === 'erase_stroke') {
      const board = loadBoard(currentRoom);
      const prevLen = board.strokes.length;
      board.strokes = board.strokes.filter(s => s.id !== payload.strokeId);
      if (board.strokes.length !== prevLen) {
        saveBoardDebounced(currentRoom);
        broadcastToRoom(currentRoom, null, {
          type: 'stroke_removed',
          payload: { strokeId: payload.strokeId }
        });
      }
      return;
    }

    // Clear board (Editors only)
    if (type === 'clear_board') {
      const board = loadBoard(currentRoom);
      board.strokes = [];
      board.stickies = {};
      saveBoardDebounced(currentRoom);

      broadcastToRoom(currentRoom, null, {
        type: 'board_cleared',
        payload: { clearedBy: clientInfo.name }
      });
      return;
    }

    // Update user info
    if (type === 'update_profile') {
      if (payload.name) clientInfo.name = payload.name;
      if (payload.color) clientInfo.color = payload.color;
      broadcastPresence(currentRoom);
      return;
    }

    // Heartbeat ping/pong for latency measurement
    if (type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong', payload: { clientTime: payload.clientTime, serverTime: Date.now() } }));
      return;
    }
  });

  ws.on('close', () => {
    if (currentRoom && rooms.has(currentRoom)) {
      rooms.get(currentRoom).delete(ws);
      if (rooms.get(currentRoom).size === 0) {
        rooms.delete(currentRoom);
      } else {
        broadcastPresence(currentRoom);
        broadcastToRoom(currentRoom, null, {
          type: 'cursor_leave',
          payload: { clientId: clientInfo.id }
        });
      }
    }
  });
});

function broadcastToRoom(room, senderWs, data) {
  const clients = rooms.get(room);
  if (!clients) return;
  const msg = JSON.stringify(data);
  for (const client of clients) {
    if (client !== senderWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function broadcastPresence(room) {
  const clients = rooms.get(room);
  if (!clients) return;
  const count = clients.size;
  const msg = JSON.stringify({
    type: 'presence',
    payload: { count }
  });
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
