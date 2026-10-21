# CanvasSync — Collaborative Whiteboard with Live Cursors

Built according to **PRD: Collaborative Whiteboard with Live Cursors**.

---

## 🚀 Key Features Implemented

### 1. Instant Link-Based Rooms & Zero-Friction Join
- Create or jump into any room with a URL parameter: `http://localhost:3000/?board=planning-session`
- No signup, installs, or mandatory logins required. Facilitators (Maya) can share a single link to start collaborating immediately.

### 2. Live Cursors with Names & Colors
- Every teammate's cursor streams in real-time with smooth quadratic trajectory updates and user name badges.
- Cursors fade gracefully when participants go idle or leave.

### 3. Real-Time Freehand Drawing Engine
- Interactive pen tool with curated color palette and 3 thickness settings (Fine, Medium, Thick).
- **Chunked stroke streaming**: strokes render on peers' canvases while being drawn, not only after mouse release.
- Quadratic curve midpoint interpolation for 60fps buttery-smooth lines.

### 4. Interactive Sticky Notes
- Drop sticky notes on the infinite canvas.
- Real-time text sync, multi-color themes (Canary, Mint, Blue, Rose, Orange), and drag-and-drop repositioning across all connected peers.

### 5. Touch Eraser & Undo
- Touch eraser accurately calculates distance to stroke segments and removes intersected strokes.
- Undo button (and `Ctrl+Z` / `Cmd+Z`) removes your own latest stroke speculatively and syncs removal to the room.

### 6. Continuous Persistence
- Server debounces and saves room strokes and sticky notes into `data/board_<boardId>.json`.
- Edits persist and restore automatically when participants reconnect or refresh.

### 7. Graceful Degradation & Offline Buffer
- If the WebSocket disconnects, the UI displays an offline badge and automatically caches local strokes and note changes in an offline queue, re-syncing them seamlessly upon reconnection.

### 8. Role Permissions & Moderation
- **Editor**: Full drawing, sticky creation/dragging, and board clear capabilities.
- **Viewer**: Read-only observation with live cursor streaming. Clear-board and draw actions are restricted.
- One-click share link generator with toggle between Editor and Viewer permission links.

### 9. Pan, Infinite Zoom & Export
- Canvas zoom (25% to 300%) with mouse wheel (`Ctrl+Scroll`) or zoom controls.
- Canvas panning with Middle-Click, Spacebar drag, or Pan tool (`V`).
- One-click PNG image export with rendered strokes and sticky notes.

### 10. Light & Dark Themes
- Automatically adapts to system preference or toggles manually with the header button.

---

## 🏃 Running the Application

1. Open a terminal in the project directory:
   ```bash
   cd "C:\Users\Devanshi Singh\.gemini\antigravity-ide\scratch\collaborative-whiteboard"
   node server.js
   ```
2. Open your browser to:
   - Primary user (Facilitator Maya): [http://localhost:3000/?board=team-sync](http://localhost:3000/?board=team-sync)
   - Secondary participant (Contributor Arjun): Click the **"Share"** button in the header and click **"Open Partner Tab"**, or open an Incognito window to [http://localhost:3000/?board=team-sync](http://localhost:3000/?board=team-sync)

---

## 📂 File Architecture
- [server.js](file:///C:/Users/Devanshi%20Singh/.gemini/antigravity-ide/scratch/collaborative-whiteboard/server.js) — Express & WebSocket server with room state broadcasting and persistence
- [public/index.html](file:///C:/Users/Devanshi%20Singh/.gemini/antigravity-ide/scratch/collaborative-whiteboard/public/index.html) — Modern semantic structure and responsive canvas world
- [public/style.css](file:///C:/Users/Devanshi%20Singh/.gemini/antigravity-ide/scratch/collaborative-whiteboard/public/style.css) — Design system with glassmorphism, floating dock, and animations
- [public/app.js](file:///C:/Users/Devanshi%20Singh/.gemini/antigravity-ide/scratch/collaborative-whiteboard/public/app.js) — Real-time drawing engine, sticky notes, live cursors, and touch eraser
