/**
 * CanvasSync - Collaborative Whiteboard Client Script
 * Implements real-time stroke streaming, live cursors, sticky notes, touch eraser, undo, and offline sync.
 */

// --- Application State ---
const state = {
  boardId: 'default',
  role: 'editor', // 'editor' | 'viewer'
  user: {
    id: null,
    name: localStorage.getItem('cs_name') || `User_${Math.floor(100 + Math.random() * 900)}`,
    color: localStorage.getItem('cs_color') || ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4'][Math.floor(Math.random() * 6)],
  },
  tool: 'pen', // 'pen' | 'eraser' | 'sticky' | 'select' | 'laser'
  penColor: '#1e293b',
  penWidth: 5,
  scale: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  isDrawing: false,
  isLasering: false,
  laserTrail: [], // { x, y, timestamp, color }
  remoteLaserTrails: new Map(), // clientId -> [ { x, y, timestamp, color } ]
  panStart: { x: 0, y: 0 },
  currentStroke: null,
  activeRemoteStrokes: new Map(), // clientId -> in-progress stroke
  strokes: [], // committed strokes array
  stickies: {}, // id -> sticky object
  remoteCursors: new Map(), // clientId -> { element, timeout }
  offlineQueue: [], // queued actions when disconnected
  isConnected: false,
  latency: 0,
};

// --- Parse URL Parameters (Room & Role) ---
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get('board')) {
  state.boardId = urlParams.get('board');
} else {
  // auto-assign a friendly room or use default
  state.boardId = 'planning-room';
  const newUrl = new URL(window.location);
  newUrl.searchParams.set('board', state.boardId);
  window.history.replaceState({}, '', newUrl);
}

if (urlParams.get('role') === 'viewer') {
  state.role = 'viewer';
}

// --- DOM References ---
const canvas = document.getElementById('whiteboardCanvas');
const ctx = canvas.getContext('2d');
const viewport = document.getElementById('viewport');
const canvasWorld = document.getElementById('canvasWorld');
const stickyLayer = document.getElementById('stickyLayer');
const cursorLayer = document.getElementById('cursorLayer');

const statusPill = document.getElementById('connectionStatus');
const statusText = document.getElementById('statusText');
const latencyPill = document.getElementById('latencyValue');
const presenceCount = document.getElementById('presenceCount');
const boardTag = document.getElementById('boardTag');
const roleSelect = document.getElementById('roleSelect');
const offlineToast = document.getElementById('offlineToast');

const userProfileBtn = document.getElementById('userProfileBtn');
const userNameDisplay = document.getElementById('userNameDisplay');
const userColorDot = document.getElementById('userColorDot');
const profileModal = document.getElementById('profileModal');
const closeProfileModal = document.getElementById('closeProfileModal');
const saveProfileBtn = document.getElementById('saveProfileBtn');
const userNameInput = document.getElementById('userNameInput');
const userColorGrid = document.getElementById('userColorGrid');

const shareBtn = document.getElementById('shareBtn');
const shareModal = document.getElementById('shareModal');
const closeShareModal = document.getElementById('closeShareModal');
const shareUrlInput = document.getElementById('shareUrlInput');
const copyShareUrlBtn = document.getElementById('copyShareUrlBtn');
const openPartnerTabBtn = document.getElementById('openPartnerTabBtn');

const themeToggle = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

const zoomLevel = document.getElementById('zoomLevel');
const zoomInBtn = document.getElementById('zoomIn');
const zoomOutBtn = document.getElementById('zoomOut');
const zoomResetBtn = document.getElementById('zoomReset');

const btnUndo = document.getElementById('btnUndo');
const btnClear = document.getElementById('btnClear');
const btnExport = document.getElementById('btnExport');

// --- Initialize UI state ---
boardTag.textContent = `Board: ${state.boardId}`;
userNameDisplay.textContent = state.user.name;
userColorDot.style.background = state.user.color;
roleSelect.value = state.role;

// Setup profile modal colors
const COLOR_PRESETS = ['#3b82f6', '#ec4899', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#f43f5e', '#6366f1'];
COLOR_PRESETS.forEach(color => {
  const c = document.createElement('div');
  c.className = `user-color-circle ${color === state.user.color ? 'selected' : ''}`;
  c.style.backgroundColor = color;
  c.onclick = () => {
    document.querySelectorAll('.user-color-circle').forEach(el => el.classList.remove('selected'));
    c.classList.add('selected');
    state.user.color = color;
  };
  userColorGrid.appendChild(c);
});

// --- Theme Management ---
let isDarkTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
function updateTheme() {
  if (isDarkTheme) {
    document.body.classList.remove('theme-light');
    document.body.classList.add('theme-dark');
    themeIcon.textContent = '☀️';
  } else {
    document.body.classList.remove('theme-dark');
    document.body.classList.add('theme-light');
    themeIcon.textContent = '🌙';
  }
  redrawAll();
}
updateTheme();
themeToggle.onclick = () => {
  isDarkTheme = !isDarkTheme;
  updateTheme();
};

// --- Canvas Resizing ---
function resizeCanvas() {
  // Make canvas cover large dimensions for high-res rendering
  const width = window.innerWidth;
  const height = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  
  ctx.scale(dpr, dpr);
  redrawAll();
}
window.addEventListener('resize', resizeCanvas);

// --- World Transform Helper ---
function screenToWorld(clientX, clientY) {
  return {
    x: (clientX - state.panX) / state.scale,
    y: (clientY - state.panY) / state.scale,
  };
}

function worldToScreen(worldX, worldY) {
  return {
    x: worldX * state.scale + state.panX,
    y: worldY * state.scale + state.panY,
  };
}

function updateWorldTransform() {
  canvasWorld.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.scale})`;
  zoomLevel.textContent = `${Math.round(state.scale * 100)}%`;
  redrawAll();
}

// Zoom helpers
function setZoom(newScale, focalX = window.innerWidth / 2, focalY = window.innerHeight / 2) {
  const clampedScale = Math.min(Math.max(0.25, newScale), 3);
  const factor = clampedScale / state.scale;
  state.panX = focalX - (focalX - state.panX) * factor;
  state.panY = focalY - (focalY - state.panY) * factor;
  state.scale = clampedScale;
  updateWorldTransform();
}

zoomInBtn.onclick = () => setZoom(state.scale * 1.2);
zoomOutBtn.onclick = () => setZoom(state.scale / 1.2);
zoomResetBtn.onclick = () => {
  state.scale = 1;
  state.panX = 0;
  state.panY = 0;
  updateWorldTransform();
};

// Wheel Zoom / Pan
viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const zoomFactor = e.deltaY < 0 ? 1.1 : 0.9;
    setZoom(state.scale * zoomFactor, e.clientX, e.clientY);
  } else {
    // Pan with mouse wheel or trackpad
    state.panX -= e.deltaX;
    state.panY -= e.deltaY;
    updateWorldTransform();
  }
}, { passive: false });

// --- WebSocket Connection & Real-Time Sync ---
let socket = null;
let pingInterval = null;

function connectWS() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    state.isConnected = true;
    statusPill.className = 'connection-status connected';
    statusText.textContent = 'Live Sync';
    offlineToast.classList.remove('visible');

    // Join board room
    sendWS('join', {
      boardId: state.boardId,
      name: state.user.name,
      color: state.user.color,
      role: state.role,
    });

    // Flush offline queue if any
    if (state.offlineQueue.length > 0) {
      const queue = [...state.offlineQueue];
      state.offlineQueue = [];
      queue.forEach(item => sendWS(item.type, item.payload));
    }

    // Start latency ping loop
    clearInterval(pingInterval);
    pingInterval = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        sendWS('ping', { clientTime: Date.now() });
      }
    }, 4000);
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    } catch (e) {
      console.error('Invalid message from server:', e);
    }
  };

  socket.onclose = () => {
    state.isConnected = false;
    statusPill.className = 'connection-status disconnected';
    statusText.textContent = 'Offline';
    offlineToast.classList.add('visible');
    clearInterval(pingInterval);
    setTimeout(connectWS, 3000); // Reconnect retry
  };

  socket.onerror = (err) => {
    console.warn('WebSocket connection error:', err);
  };
}

function sendWS(type, payload) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type, payload }));
  } else {
    // Buffer actions for offline sync
    if (['stroke_end', 'sticky_create', 'sticky_update', 'sticky_delete', 'clear_board', 'erase_stroke'].includes(type)) {
      state.offlineQueue.push({ type, payload });
    }
  }
}

// --- Protocol Dispatcher ---
function handleServerMessage(msg) {
  const { type, payload } = msg;

  switch (type) {
    case 'init':
      state.user.id = payload.clientId;
      state.strokes = payload.strokes || [];
      state.stickies = payload.stickies || {};
      renderAllStickies();
      redrawAll();
      break;

    case 'presence':
      presenceCount.textContent = payload.count;
      break;

    case 'pong':
      const roundTrip = Date.now() - payload.clientTime;
      state.latency = roundTrip;
      latencyPill.textContent = `${roundTrip} ms`;
      break;

    case 'cursor':
      renderRemoteCursor(payload);
      break;

    case 'cursor_leave':
      removeRemoteCursor(payload.clientId);
      break;

    case 'stroke_start':
      state.activeRemoteStrokes.set(payload.clientId, {
        id: payload.strokeId,
        color: payload.color,
        width: payload.width,
        points: payload.points || [],
      });
      redrawAll();
      break;

    case 'stroke_chunk':
      const rStroke = state.activeRemoteStrokes.get(payload.clientId);
      if (rStroke) {
        rStroke.points.push(...payload.points);
        redrawAll();
      }
      break;

    case 'stroke_end':
      state.activeRemoteStrokes.delete(payload.clientId);
      if (payload.stroke) {
        state.strokes.push(payload.stroke);
        redrawAll();
      }
      break;

    case 'stroke_removed':
      state.strokes = state.strokes.filter(s => s.id !== payload.strokeId);
      redrawAll();
      break;

    case 'sticky_create':
    case 'sticky_update':
      state.stickies[payload.id] = payload;
      renderSticky(payload);
      break;

    case 'sticky_delete':
      delete state.stickies[payload.id];
      const stickyEl = document.getElementById(`sticky-${payload.id}`);
      if (stickyEl) stickyEl.remove();
      break;

    case 'board_cleared':
      state.strokes = [];
      state.stickies = {};
      state.activeRemoteStrokes.clear();
      stickyLayer.innerHTML = '';
      redrawAll();
      break;

    case 'reaction':
      spawnReactionAnimation(payload);
      break;

    case 'laser':
      let rLaser = state.remoteLaserTrails.get(payload.clientId);
      if (!rLaser) {
        rLaser = [];
        state.remoteLaserTrails.set(payload.clientId, rLaser);
      }
      rLaser.push({ x: payload.x, y: payload.y, color: payload.color || '#ef4444', timestamp: Date.now() });
      break;

    case 'error':
      alert(payload.message || 'Action denied.');
      break;
  }
}

// --- Live Remote Cursors ---
function renderRemoteCursor({ clientId, name, color, x, y }) {
  if (clientId === state.user.id) return;

  let cursorData = state.remoteCursors.get(clientId);
  let el = cursorData ? cursorData.element : null;

  if (!el) {
    el = document.createElement('div');
    el.className = 'remote-cursor';
    el.style.setProperty('--cursor-color', color);
    el.innerHTML = `
      <svg class="cursor-pointer" viewBox="0 0 24 24" fill="${color}" stroke="#ffffff" stroke-width="1.5">
        <polygon points="3 3 10 21 14 14 21 10 3 3"></polygon>
      </svg>
      <span class="cursor-tag">${escapeHtml(name)}</span>
    `;
    cursorLayer.appendChild(el);
    cursorData = { element: el, timeout: null };
    state.remoteCursors.set(clientId, cursorData);
  }

  // Update cursor position with world coordinates
  el.style.transform = `translate(${x}px, ${y}px)`;

  // Idle fade timeout
  clearTimeout(cursorData.timeout);
  el.style.opacity = '1';
  cursorData.timeout = setTimeout(() => {
    el.style.opacity = '0.3';
  }, 4000);
}

function removeRemoteCursor(clientId) {
  const cursorData = state.remoteCursors.get(clientId);
  if (cursorData) {
    cursorData.element.remove();
    state.remoteCursors.delete(clientId);
  }
}

// Broadcast local cursor
let lastCursorBroadcast = 0;
window.addEventListener('mousemove', (e) => {
  const now = Date.now();
  if (now - lastCursorBroadcast > 30) { // ~30 fps cursor streaming for snappy 150ms responsiveness
    lastCursorBroadcast = now;
    const worldPos = screenToWorld(e.clientX, e.clientY);
    sendWS('cursor', {
      x: worldPos.x,
      y: worldPos.y,
      timestamp: now,
    });
  }
});

// --- Canvas Drawing & Smooth Stroke Engine ---
function renderStroke(ctx, stroke) {
  if (!stroke.points || stroke.points.length === 0) return;

  ctx.save();
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  const pts = stroke.points;
  if (pts.length === 1) {
    ctx.arc(pts[0].x, pts[0].y, stroke.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke.color;
    ctx.fill();
    ctx.restore();
    return;
  }

  ctx.moveTo(pts[0].x, pts[0].y);
  // Quadratic curve smoothing between midpoints
  for (let i = 1; i < pts.length - 1; i++) {
    const xc = (pts[i].x + pts[i + 1].x) / 2;
    const yc = (pts[i].y + pts[i + 1].y) / 2;
    ctx.quadraticCurveTo(pts[i].x, pts[i].y, xc, yc);
  }
  ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  ctx.stroke();
  ctx.restore();
}

function redrawAll() {
  const width = canvas.width / (window.devicePixelRatio || 1);
  const height = canvas.height / (window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, width, height);

  ctx.save();
  // Apply zoom and pan transformations to context
  ctx.translate(state.panX, state.panY);
  ctx.scale(state.scale, state.scale);

  // 1. Draw committed strokes
  for (const stroke of state.strokes) {
    renderStroke(ctx, stroke);
  }

  // 2. Draw remote strokes in progress
  for (const [_, stroke] of state.activeRemoteStrokes) {
    renderStroke(ctx, stroke);
  }

  // 3. Draw local current stroke
  if (state.currentStroke) {
    renderStroke(ctx, state.currentStroke);
  }

  // 4. Draw Laser Trails with glowing fade-out
  const now = Date.now();
  renderLaserTrail(ctx, state.laserTrail, now);
  for (const [_, trail] of state.remoteLaserTrails) {
    renderLaserTrail(ctx, trail, now);
  }

  ctx.restore();
}

function renderLaserTrail(ctx, points, now) {
  // Prune points older than 1200ms
  while (points.length > 0 && now - points[0].timestamp > 1200) {
    points.shift();
  }
  if (points.length < 2) return;

  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1];
    const p1 = points[i];
    const age = now - p1.timestamp;
    const progress = Math.max(0, 1 - age / 1200);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
    ctx.strokeStyle = p1.color || '#ef4444';
    ctx.lineWidth = 6 * progress;
    ctx.shadowColor = p1.color || '#ef4444';
    ctx.shadowBlur = 10 * progress;
    ctx.lineCap = 'round';
    ctx.globalAlpha = progress;
    ctx.stroke();
    ctx.restore();
  }

  // Pulsing dot at current pointer
  const latest = points[points.length - 1];
  ctx.save();
  ctx.beginPath();
  ctx.arc(latest.x, latest.y, 5, 0, Math.PI * 2);
  ctx.fillStyle = latest.color || '#ef4444';
  ctx.shadowColor = latest.color || '#ef4444';
  ctx.shadowBlur = 12;
  ctx.fill();
  ctx.restore();
}

// Continuous animation loop for laser glow and smooth trail fade
function animationLoop() {
  if (state.laserTrail.length > 0 || state.remoteLaserTrails.size > 0) {
    redrawAll();
  }
  requestAnimationFrame(animationLoop);
}
requestAnimationFrame(animationLoop);

// --- Emoji Reaction Spawner ---
function spawnReactionAnimation({ emoji, x, y, name, color }) {
  const el = document.createElement('div');
  el.className = 'floating-reaction';
  
  // If coordinates provided, spawn at world coords; otherwise center bottom
  if (x !== undefined && y !== undefined) {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    canvasWorld.appendChild(el);
  } else {
    el.style.left = `${window.innerWidth / 2 + (Math.random() * 200 - 100)}px`;
    el.style.bottom = `100px`;
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <span class="reaction-icon">${emoji}</span>
    <span class="reaction-sender" style="background: ${color};">${escapeHtml(name)}</span>
  `;

  setTimeout(() => el.remove(), 2400);
}

// Distance from point to line segment (for Touch Eraser)
function distToSegment(p, v, w) {
  const l2 = (w.x - v.x) ** 2 + (w.y - v.y) ** 2;
  if (l2 === 0) return Math.hypot(p.x - v.x, p.y - v.y);
  let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (v.x + t * (w.x - v.x)), p.y - (v.y + t * (w.y - v.y)));
}

function eraseStrokesAt(worldX, worldY, radius = 15) {
  if (state.role === 'viewer') return;
  const p = { x: worldX, y: worldY };
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    const stroke = state.strokes[i];
    let hit = false;
    for (let j = 0; j < stroke.points.length - 1; j++) {
      if (distToSegment(p, stroke.points[j], stroke.points[j + 1]) < (radius + stroke.width / 2)) {
        hit = true;
        break;
      }
    }
    if (hit) {
      const removedId = stroke.id;
      state.strokes.splice(i, 1);
      redrawAll();
      sendWS('erase_stroke', { strokeId: removedId });
      break;
    }
  }
}

// --- Pointer Events for Freehand & Panning ---
viewport.addEventListener('pointerdown', (e) => {
  // If clicked on an interactive UI or sticky note, don't draw
  if (e.target.closest('.sticky-note') || e.target.closest('.floating-dock') || e.target.closest('.app-header') || e.target.closest('.zoom-controls') || e.target.closest('.modal-backdrop')) {
    return;
  }

  // Middle click or Space key panning
  if (e.button === 1 || state.tool === 'select' || e.spaceKey) {
    state.isPanning = true;
    state.panStart = { x: e.clientX - state.panX, y: e.clientY - state.panY };
    viewport.style.cursor = 'grabbing';
    return;
  }

  if (e.button !== 0) return; // Only primary button for drawing/erasing

  const worldPos = screenToWorld(e.clientX, e.clientY);

  if (state.tool === 'eraser') {
    eraseStrokesAt(worldPos.x, worldPos.y);
    return;
  }

  if (state.tool === 'sticky') {
    if (state.role === 'viewer') {
      alert('Viewers cannot create sticky notes.');
      return;
    }
    createStickyAt(worldPos.x, worldPos.y);
    setTool('select');
    return;
  }

  if (state.tool === 'laser') {
    state.isLasering = true;
    const pt = { x: worldPos.x, y: worldPos.y, timestamp: Date.now(), color: state.user.color };
    state.laserTrail.push(pt);
    sendWS('laser', { x: worldPos.x, y: worldPos.y });
    return;
  }

  if (state.tool === 'pen') {
    if (state.role === 'viewer') {
      alert('You have view-only access on this board.');
      return;
    }
    state.isDrawing = true;
    const strokeId = `s_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
    state.currentStroke = {
      id: strokeId,
      clientId: state.user.id,
      color: state.penColor,
      width: state.penWidth,
      points: [worldPos],
    };

    redrawAll();

    // Stream stroke start to others
    sendWS('stroke_start', {
      strokeId,
      color: state.penColor,
      width: state.penWidth,
      points: [worldPos],
    });
  }
});

let strokeChunkBuffer = [];
window.addEventListener('pointermove', (e) => {
  if (state.isPanning) {
    state.panX = e.clientX - state.panStart.x;
    state.panY = e.clientY - state.panStart.y;
    updateWorldTransform();
    return;
  }

  const worldPos = screenToWorld(e.clientX, e.clientY);

  if (state.tool === 'laser' && (e.buttons === 1 || state.isLasering)) {
    const pt = { x: worldPos.x, y: worldPos.y, timestamp: Date.now(), color: state.user.color };
    state.laserTrail.push(pt);
    sendWS('laser', { x: worldPos.x, y: worldPos.y });
    return;
  }

  if (state.tool === 'eraser' && (e.buttons === 1)) {
    eraseStrokesAt(worldPos.x, worldPos.y);
    return;
  }

  if (state.isDrawing && state.currentStroke) {
    state.currentStroke.points.push(worldPos);
    strokeChunkBuffer.push(worldPos);

    redrawAll();

    // Batch chunk emissions every 2 points for smooth real-time streaming without flooding socket
    if (strokeChunkBuffer.length >= 2) {
      sendWS('stroke_chunk', {
        strokeId: state.currentStroke.id,
        points: strokeChunkBuffer,
      });
      strokeChunkBuffer = [];
    }
  }
});

window.addEventListener('pointerup', () => {
  state.isLasering = false;
  if (state.isPanning) {
    state.isPanning = false;
    viewport.style.cursor = 'default';
  }

  if (state.isDrawing && state.currentStroke) {
    // Flush remaining buffer
    if (strokeChunkBuffer.length > 0) {
      sendWS('stroke_chunk', {
        strokeId: state.currentStroke.id,
        points: strokeChunkBuffer,
      });
      strokeChunkBuffer = [];
    }

    const stroke = state.currentStroke;
    state.strokes.push(stroke);
    state.currentStroke = null;
    state.isDrawing = false;
    redrawAll();

    // Emit stroke_end to finalize
    sendWS('stroke_end', {
      strokeId: stroke.id,
      stroke: stroke,
    });
  }
});

// Spacebar drag pan support
let isSpacePressed = false;
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !isSpacePressed && document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
    isSpacePressed = true;
    viewport.style.cursor = 'grab';
  }
  // Undo shortcut: Ctrl+Z or Cmd+Z
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault();
    handleUndo();
  }
  // Hotkeys: P, E, S, V, L
  if (document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
    if (e.key.toLowerCase() === 'p') setTool('pen');
    if (e.key.toLowerCase() === 'e') setTool('eraser');
    if (e.key.toLowerCase() === 's') setTool('sticky');
    if (e.key.toLowerCase() === 'v') setTool('select');
    if (e.key.toLowerCase() === 'l') setTool('laser');
  }
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') {
    isSpacePressed = false;
    viewport.style.cursor = 'default';
  }
});

// --- Sticky Notes System ---
const STICKY_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa'];

function createStickyAt(x, y) {
  const stickyId = `st_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const sticky = {
    id: stickyId,
    x: x - 105,
    y: y - 80,
    text: '',
    color: STICKY_COLORS[Math.floor(Math.random() * STICKY_COLORS.length)],
  };
  state.stickies[stickyId] = sticky;
  renderSticky(sticky);
  sendWS('sticky_create', sticky);

  // Auto focus newly created sticky
  setTimeout(() => {
    const textarea = document.getElementById(`sticky-txt-${stickyId}`);
    if (textarea) textarea.focus();
  }, 50);
}

function renderAllStickies() {
  stickyLayer.innerHTML = '';
  for (const id in state.stickies) {
    renderSticky(state.stickies[id]);
  }
}

function renderSticky(sticky) {
  let el = document.getElementById(`sticky-${sticky.id}`);
  if (!el) {
    el = document.createElement('div');
    el.id = `sticky-${sticky.id}`;
    el.className = 'sticky-note';
    stickyLayer.appendChild(el);
    setupStickyInteractions(el, sticky.id);
  }

  el.style.left = `${sticky.x}px`;
  el.style.top = `${sticky.y}px`;
  el.style.backgroundColor = sticky.color || '#fef08a';

  const isViewer = state.role === 'viewer';

  el.innerHTML = `
    <div class="sticky-header">
      <span class="sticky-color-dot" style="background: currentColor;"></span>
      ${!isViewer ? `<button class="sticky-delete-btn" title="Delete note">&times;</button>` : ''}
    </div>
    <textarea class="sticky-textarea" id="sticky-txt-${sticky.id}" placeholder="Type idea..." ${isViewer ? 'readonly' : ''}>${escapeHtml(sticky.text || '')}</textarea>
    ${!isViewer ? `
      <div class="sticky-footer">
        ${STICKY_COLORS.map(c => `<div class="sticky-color-pick" data-c="${c}" style="background: ${c};"></div>`).join('')}
      </div>
    ` : ''}
  `;

  // Delete listener
  const delBtn = el.querySelector('.sticky-delete-btn');
  if (delBtn) {
    delBtn.onclick = (e) => {
      e.stopPropagation();
      delete state.stickies[sticky.id];
      el.remove();
      sendWS('sticky_delete', { id: sticky.id });
    };
  }

  // Color pick listener
  el.querySelectorAll('.sticky-color-pick').forEach(cp => {
    cp.onclick = (e) => {
      e.stopPropagation();
      const newColor = cp.getAttribute('data-c');
      sticky.color = newColor;
      el.style.backgroundColor = newColor;
      sendWS('sticky_update', sticky);
    };
  });

  // Text sync listener
  const textarea = el.querySelector('.sticky-textarea');
  if (textarea) {
    textarea.oninput = () => {
      sticky.text = textarea.value;
      sendWS('sticky_update', sticky);
    };
  }
}

function setupStickyInteractions(el, stickyId) {
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };

  const header = el.querySelector('.sticky-header');
  el.addEventListener('pointerdown', (e) => {
    // Only drag from non-textarea elements
    if (e.target.tagName === 'TEXTAREA' || e.target.classList.contains('sticky-color-pick') || e.target.classList.contains('sticky-delete-btn')) {
      return;
    }
    if (state.role === 'viewer') return;

    isDragging = true;
    el.classList.add('dragging');
    const sticky = state.stickies[stickyId];
    const mouseWorld = screenToWorld(e.clientX, e.clientY);
    dragOffset = { x: mouseWorld.x - sticky.x, y: mouseWorld.y - sticky.y };
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const mouseWorld = screenToWorld(e.clientX, e.clientY);
    const sticky = state.stickies[stickyId];
    sticky.x = mouseWorld.x - dragOffset.x;
    sticky.y = mouseWorld.y - dragOffset.y;
    el.style.left = `${sticky.x}px`;
    el.style.top = `${sticky.y}px`;
    sendWS('sticky_update', sticky);
  });

  const stopDrag = (e) => {
    if (isDragging) {
      isDragging = false;
      el.classList.remove('dragging');
      const sticky = state.stickies[stickyId];
      sendWS('sticky_update', sticky);
    }
  };

  el.addEventListener('pointerup', stopDrag);
  el.addEventListener('pointercancel', stopDrag);
}

// --- Toolbar & Controls Handlers ---
function setTool(toolName) {
  state.tool = toolName;
  document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tool') === toolName);
  });
  if (toolName === 'select') {
    viewport.style.cursor = 'grab';
  } else if (toolName === 'eraser') {
    viewport.style.cursor = 'cell';
  } else if (toolName === 'laser') {
    viewport.style.cursor = 'crosshair';
  } else {
    viewport.style.cursor = 'crosshair';
  }
}

// Reaction button click dispatch
document.querySelectorAll('.reaction-btn').forEach(btn => {
  btn.onclick = () => {
    const emoji = btn.getAttribute('data-emoji');
    // Spawn locally & broadcast
    sendWS('reaction', { emoji });
  };
});

document.querySelectorAll('.tool-btn[data-tool]').forEach(btn => {
  btn.onclick = () => setTool(btn.getAttribute('data-tool'));
});

// Color Picker swatches
document.querySelectorAll('.color-swatch').forEach(swatch => {
  swatch.onclick = () => {
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    swatch.classList.add('active');
    state.penColor = swatch.getAttribute('data-color');
    if (state.tool !== 'pen') setTool('pen');
  };
});

// Thickness buttons
document.querySelectorAll('.thickness-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.thickness-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.penWidth = parseInt(btn.getAttribute('data-width'), 10);
  };
});

// Undo Stroke
function handleUndo() {
  if (state.role === 'viewer') return;
  // Local speculative removal of user's last stroke
  for (let i = state.strokes.length - 1; i >= 0; i--) {
    if (state.strokes[i].clientId === state.user.id) {
      state.strokes.splice(i, 1);
      redrawAll();
      break;
    }
  }
  sendWS('undo', {});
}
btnUndo.onclick = handleUndo;

// Clear Board (Editor-only with confirmation)
btnClear.onclick = () => {
  if (state.role === 'viewer') {
    alert('Clear Board is restricted to editors only.');
    return;
  }
  if (confirm('Clear the entire whiteboard for all participants?')) {
    sendWS('clear_board', {});
  }
};

// Export Board to PNG image
btnExport.onclick = () => {
  // Create temporary export canvas sized to bounding box or full content
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = window.innerWidth * 2;
  exportCanvas.height = window.innerHeight * 2;
  const eCtx = exportCanvas.getContext('2d');
  eCtx.scale(2, 2);

  // Background
  eCtx.fillStyle = isDarkTheme ? '#090d16' : '#ffffff';
  eCtx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  // Draw strokes
  eCtx.save();
  eCtx.translate(state.panX, state.panY);
  eCtx.scale(state.scale, state.scale);
  for (const stroke of state.strokes) {
    renderStroke(eCtx, stroke);
  }

  // Draw sticky notes onto exported image
  for (const id in state.stickies) {
    const s = state.stickies[id];
    eCtx.fillStyle = s.color || '#fef08a';
    eCtx.fillRect(s.x, s.y, 210, 160);
    eCtx.strokeStyle = 'rgba(0,0,0,0.1)';
    eCtx.strokeRect(s.x, s.y, 210, 160);
    eCtx.fillStyle = '#1e293b';
    eCtx.font = '14px sans-serif';
    
    // Simple line wrapped text
    const lines = (s.text || '').split('\n');
    let lineY = s.y + 30;
    for (const line of lines) {
      eCtx.fillText(line.substring(0, 28), s.x + 12, lineY);
      lineY += 20;
    }
  }
  eCtx.restore();

  // Trigger download
  const link = document.createElement('a');
  link.download = `whiteboard-${state.boardId}-${Date.now()}.png`;
  link.href = exportCanvas.toDataURL('image/png');
  link.click();
};

// Role change selector
roleSelect.onchange = () => {
  state.role = roleSelect.value;
  const url = new URL(window.location);
  url.searchParams.set('role', state.role);
  window.history.replaceState({}, '', url);
  renderAllStickies();
  // Reconnect with new role
  sendWS('join', {
    boardId: state.boardId,
    name: state.user.name,
    color: state.user.color,
    role: state.role,
  });
};

// --- Share Modal ---
shareBtn.onclick = () => {
  updateShareLink();
  shareModal.classList.add('open');
};
closeShareModal.onclick = () => shareModal.classList.remove('open');
shareModal.onclick = (e) => {
  if (e.target === shareModal) shareModal.classList.remove('open');
};

function updateShareLink() {
  const shareType = document.querySelector('input[name="shareType"]:checked').value;
  const shareUrl = new URL(window.location.origin + window.location.pathname);
  shareUrl.searchParams.set('board', state.boardId);
  if (shareType === 'viewer') {
    shareUrl.searchParams.set('role', 'viewer');
  }
  shareUrlInput.value = shareUrl.toString();
}

document.querySelectorAll('input[name="shareType"]').forEach(radio => {
  radio.onchange = updateShareLink;
});

copyShareUrlBtn.onclick = () => {
  navigator.clipboard.writeText(shareUrlInput.value).then(() => {
    copyShareUrlBtn.textContent = 'Copied! ✓';
    setTimeout(() => { copyShareUrlBtn.textContent = 'Copy Link'; }, 2000);
  });
};

openPartnerTabBtn.onclick = () => {
  const partnerRole = document.querySelector('input[name="shareType"]:checked').value;
  const partnerUrl = new URL(window.location.origin + window.location.pathname);
  partnerUrl.searchParams.set('board', state.boardId);
  partnerUrl.searchParams.set('role', partnerRole);
  window.open(partnerUrl.toString(), '_blank', 'width=900,height=700');
};

// --- User Profile Modal ---
userProfileBtn.onclick = () => {
  userNameInput.value = state.user.name;
  profileModal.classList.add('open');
};
closeProfileModal.onclick = () => profileModal.classList.remove('open');
profileModal.onclick = (e) => {
  if (e.target === profileModal) profileModal.classList.remove('open');
};

saveProfileBtn.onclick = () => {
  const newName = userNameInput.value.trim() || 'Anonymous';
  state.user.name = newName;
  localStorage.setItem('cs_name', newName);
  localStorage.setItem('cs_color', state.user.color);
  userNameDisplay.textContent = newName;
  userColorDot.style.background = state.user.color;

  sendWS('update_profile', {
    name: state.user.name,
    color: state.user.color,
  });

  profileModal.classList.remove('open');
};

// Helper: Escape HTML to prevent injection
function escapeHtml(str) {
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

// --- Start App ---
resizeCanvas();
connectWS();
