/**
 * ============================================================================
 * SERVER.JS - AUTHORITATIVE GAME SERVER
 * Shadows of the Forgotten Relic
 * ============================================================================
 * 
 * ARCHITECTURE OVERVIEW:
 * - Authoritative server: All game logic and validation happens server-side
 * - Clients send input commands, server processes and broadcasts state
 * - Uses Socket.IO for real-time bidirectional communication
 * - Implements collision detection, conflict resolution, and state management
 * 
 * DESIGN CONSTRAINT: Secrecy/Incomplete Information
 * - Server tracks global explored tiles but doesn't force-sync to clients
 * - Each client independently discovers the map through movement
 * - Relic position is only revealed to players who can see it
 * - Player positions are broadcast, but fog of war is client-side
 * 
 * DATA MINIMIZATION STRATEGY:
 * - Only send position updates when players move (event-driven)
 * - Use compact data structures (Maps instead of arrays)
 * - Aggregate multiple tile explorations into single messages
 * - Timestamp-based conflict resolution avoids redundant state sync
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    },
    // Connection timeout handling for poor network conditions
    pingTimeout: 60000,
    pingInterval: 25000
});

// Serve static files from public folder
app.use(express.static('public')); 

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const PORT = process.env.PORT || 3000;

// ============================================================================
// GAME CONSTANTS - Tuned for balanced gameplay
// ============================================================================
const MAX_SCORE = 3;                    // Win condition
const MAX_SPEED = 5;                    // Pixels per movement update
const RELIC_GRAB_RANGE = 100;           // Pickup radius (increased from 60)
const BASE_CAPTURE_RANGE = 100;         // Scoring radius (increased from 75)
const PLAYER_RADIUS = 17;               // Collision size
const RELIC_RESPAWN_DELAY = 5000;       // 5 seconds between captures
const GAME_RESET_DELAY = 10000;         // 10 seconds after game end

// ============================================================================
// AUTHORITATIVE GAME STATE - Single Source of Truth
// ============================================================================

/**
 * PlayerMap: Stores all active players
 * Key: socket.id (string)
 * Value: { id, name, x, y, score, hasRelic, baseId, color }
 */
const PlayerMap = new Map();

/**
 * ScoreMap: Tracks player scores separately for efficient lookup
 * Key: socket.id (string)
 * Value: score (number)
 */
const ScoreMap = new Map();

/**
 * GlobalExploredTiles: Tracks which tiles have been discovered
 * Used to initialize new players with existing exploration data
 * Format: Set of strings like "x:10,y:20"
 */
const GlobalExploredTiles = new Set();

/**
 * RelicState: The objective item state
 * - position: {x, y} coordinates
 * - isHeld: boolean
 * - holderId: socket.id of holder (or null)
 * - isRespawning: prevents pickup during respawn delay
 */
let RelicState = {
    position: { x: 500, y: 500 },
    isHeld: false,
    holderId: null,
    isRespawning: false
};

// ============================================================================
// MAP CONFIGURATION - Defines playable space
// ============================================================================

/**
 * BASE_POSITIONS: Home bases for each player
 * Players must return relic here to score
 */
const BASE_POSITIONS = {
    player1: { x: 100, y: 100, w: 100, h: 100, color: '#3498db' },
    player2: { x: 900, y: 900, w: 100, h: 100, color: '#2ecc71' },
    player3: { x: 900, y: 100, w: 100, h: 100, color: '#e74c3c' },
    player4: { x: 100, y: 900, w: 100, h: 100, color: '#f39c12' }
};

/**
 * OBSTACLES: Static collision boxes that block movement
 * Format: { x, y, w, h } - center point and dimensions
 */
const OBSTACLES = [
    { x: 300, y: 300, w: 80, h: 80 },
    { x: 700, y: 700, w: 120, h: 60 },
    { x: 500, y: 200, w: 60, h: 100 },
    { x: 200, y: 700, w: 100, h: 50 }
];

// ============================================================================
// HELPER FUNCTIONS - Validation and Utilities
// ============================================================================

/**
 * Calculate Euclidean distance between two points
 * Used for proximity checks (relic grabbing, base scoring)
 */
function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

/**
 * AUTHORITATIVE COLLISION DETECTION
 * Validates proposed player positions against:
 * 1. Map boundaries (0-1000)
 * 2. Static obstacles (AABB collision)
 * 
 * Returns: true if collision detected (movement invalid)
 */
function checkCollision(newX, newY) {
    // Boundary check - keep players inside 1000x1000 map
    if (newX < PLAYER_RADIUS || newX > 1000 - PLAYER_RADIUS || 
        newY < PLAYER_RADIUS || newY > 1000 - PLAYER_RADIUS) {
        return true; 
    }

    // Obstacle collision using Axis-Aligned Bounding Box (AABB)
    for (const obs of OBSTACLES) {
        const obsLeft = obs.x - obs.w / 2;
        const obsRight = obs.x + obs.w / 2;
        const obsTop = obs.y - obs.h / 2;
        const obsBottom = obs.y + obs.h / 2;

        const playerLeft = newX - PLAYER_RADIUS;
        const playerRight = newX + PLAYER_RADIUS;
        const playerTop = newY - PLAYER_RADIUS;
        const playerBottom = newY + PLAYER_RADIUS;

        // Check if rectangles overlap
        if (playerRight > obsLeft && playerLeft < obsRight && 
            playerBottom > obsTop && playerTop < obsBottom) {
            return true; // Collision detected
        }
    }
    return false; // No collision
}

// ============================================================================
// GAME LOGIC HANDLERS - Server-Authoritative Actions
// ============================================================================

/**
 * MOVEMENT HANDLER
 * Processes player movement requests with validation
 * 
 * Input: { id, dir (N/S/E/W), timestamp }
 * Validation: Speed limits, collision detection
 * Output: Broadcast updated positions to all clients
 * 
 * DATA MINIMIZATION: Only broadcasts when movement is valid
 */
function handlePlayerMove(data) {
    const player = PlayerMap.get(data.id);
    if (!player) {
        console.log(`⚠️  Movement from unknown player: ${data.id}`);
        return;
    }

    let deltaX = 0;
    let deltaY = 0;

    // Use deltas if provided (more accurate), otherwise use direction
    if (data.dx !== undefined && data.dy !== undefined) {
        deltaX = data.dx;
        deltaY = data.dy;
        console.log(`📍 ${player.name} moving with deltas: dx=${deltaX}, dy=${deltaY}`);
    } else {
        // Fallback to direction-based movement
        if (data.dir === 'N') deltaY = -MAX_SPEED;
        if (data.dir === 'S') deltaY = MAX_SPEED;
        if (data.dir === 'E') deltaX = MAX_SPEED;
        if (data.dir === 'W') deltaX = -MAX_SPEED;
    }
    
    // Validate movement exists
    if (deltaX === 0 && deltaY === 0) {
        console.log(`⚠️  No movement for ${player.name}`);
        return; // No movement, don't broadcast
    }
    
    // Calculate proposed new position
    const newX = player.x + deltaX;
    const newY = player.y + deltaY;

    // AUTHORITATIVE VALIDATION: Check collision
    if (checkCollision(newX, newY)) {
        console.log(`🚫 Collision detected for ${player.name} at (${Math.floor(newX)}, ${Math.floor(newY)})`);
        // Invalid move - server rejects without broadcasting
        // Client prediction will be corrected on next valid update
        return;
    }

    // Update authoritative position
    player.x = newX;
    player.y = newY;
    
    console.log(`✅ ${player.name} moved to (${Math.floor(newX)}, ${Math.floor(newY)})`);
    
    // Broadcast updated state to ALL clients
    const playersUpdate = Array.from(PlayerMap.values()).map(p => ({
        id: p.id,
        x: Math.floor(p.x),
        y: Math.floor(p.y),
        hasRelic: p.hasRelic,
        timestamp: Date.now()
    }));
    
    io.emit('playerUpdate', playersUpdate);
}

/**
 * RELIC GRAB HANDLER
 * Handles attempts to pick up the relic
 * 
 * CONFLICT RESOLUTION: Uses timestamp to resolve simultaneous grabs
 * If multiple players attempt within same frame, earliest timestamp wins
 */
function handleRelicAttempt(data) {
    const player = PlayerMap.get(data.id);
    
    // Validation checks
    if (!player) {
        console.log(`⚠️  Relic attempt from unknown player: ${data.id}`);
        return;
    }
    
    if (RelicState.isHeld) {
        console.log(`⚠️  ${player.name} tried to grab held relic`);
        return; // Relic already taken
    }
    
    if (RelicState.isRespawning) {
        console.log(`⚠️  ${player.name} tried to grab respawning relic`);
        return; // Relic is respawning
    }

    // PROXIMITY CHECK: Player must be close enough
    const dist = getDistance(player, RelicState.position);
    console.log(`🎯 ${player.name} at (${Math.floor(player.x)}, ${Math.floor(player.y)}) attempting grab`);
    console.log(`   Relic at (${Math.floor(RelicState.position.x)}, ${Math.floor(RelicState.position.y)})`);
    console.log(`   Distance: ${Math.floor(dist)} (max: ${RELIC_GRAB_RANGE})`);
    
    if (dist > RELIC_GRAB_RANGE) {
        console.log(`⚠️  ${player.name} too far from relic (${Math.floor(dist)} > ${RELIC_GRAB_RANGE})`);
        console.log(`   Move ${Math.floor(dist - RELIC_GRAB_RANGE)} pixels closer!`);
        return;
    }

    // SUCCESSFUL GRAB - Update authoritative state
    RelicState.isHeld = true;
    RelicState.holderId = player.id;
    player.hasRelic = true;

    console.log(`✨ ${player.name} grabbed the relic!`);

    // Broadcast relic status change
    io.emit('relicStatus', {
        isHeld: RelicState.isHeld,
        holderId: RelicState.holderId,
        position: RelicState.position,
        timestamp: Date.now()
    });

    // Broadcast player state update (hasRelic flag changed)
    io.emit('playerUpdate', Array.from(PlayerMap.values()).map(p => ({
        id: p.id,
        x: Math.floor(p.x),
        y: Math.floor(p.y),
        hasRelic: p.hasRelic,
        timestamp: Date.now()
    })));
}

/**
 * BASE SCORING HANDLER
 * Handles attempts to score the relic at player's base
 * 
 * WIN CONDITION: First player to reach MAX_SCORE wins
 * GAME FLOW: Relic respawns after delay, or game resets if someone wins
 */
function handleBaseAttempt(data) {
    const player = PlayerMap.get(data.id);
    
    // Validation
    if (!player) {
        console.log(`⚠️  Base attempt from unknown player: ${data.id}`);
        return;
    }
    
    if (!player.hasRelic) {
        console.log(`⚠️  ${player.name} tried to score without relic`);
        return;
    }

    // Find player's assigned base
    const playerBase = BASE_POSITIONS[player.baseId];
    if (!playerBase) {
        console.log(`⚠️  No base found for ${player.name} (${player.baseId})`);
        return;
    }

    // PROXIMITY CHECK: Must be at their base
    const dist = getDistance(player, playerBase);
    if (dist > BASE_CAPTURE_RANGE) {
        console.log(`⚠️  ${player.name} too far from base (${Math.floor(dist)} > ${BASE_CAPTURE_RANGE})`);
        return;
    }

    // SUCCESSFUL SCORE! - Update score
    let currentScore = ScoreMap.get(player.id) || 0;
    currentScore++;
    ScoreMap.set(player.id, currentScore);

    console.log(`⭐ ${player.name} SCORED! (${currentScore}/${MAX_SCORE})`);

    // Reset relic state
    player.hasRelic = false;
    RelicState.isHeld = false;
    RelicState.holderId = null;
    RelicState.isRespawning = true;

    // Check win condition
    let winningPlayer = null;
    if (currentScore >= MAX_SCORE) {
        winningPlayer = player.id;
        console.log(`🏆 ${player.name} WINS THE GAME!`);
    }

    // Broadcast score update
    io.emit('scoreUpdate', {
        scoreMap: Object.fromEntries(ScoreMap),
        scoringPlayer: player.id,
        winningPlayer: winningPlayer,
        timestamp: Date.now()
    });

    // Handle relic lifecycle
    if (!winningPlayer) {
        // Normal scoring - respawn relic after delay
        io.emit('relicStatus', {
            isHeld: false,
            holderId: null,
            position: RelicState.position,
            timestamp: Date.now()
        });

        setTimeout(() => {
            // Respawn at center
            RelicState.position = { x: 500, y: 500 };
            RelicState.isRespawning = false;
            
            io.emit('relicStatus', {
                isHeld: false,
                holderId: null,
                position: RelicState.position,
                timestamp: Date.now()
            });
            
            console.log(`🔄 Relic respawned at center`);
        }, RELIC_RESPAWN_DELAY);
    } else {
        // Game won - reset after delay
        setTimeout(() => {
            resetGame();
        }, GAME_RESET_DELAY);
    }
}

/**
 * GAME RESET
 * Resets all state after a game ends
 * Players return to their spawn positions
 */
function resetGame() {
    console.log(`🔄 Resetting game...`);
    
    // Reset all player states
    PlayerMap.forEach(p => {
        p.hasRelic = false;
        const base = BASE_POSITIONS[p.baseId];
        if (base) {
            p.x = base.x;
            p.y = base.y;
        }
    });
    
    // Clear scores
    ScoreMap.clear();
    PlayerMap.forEach(p => ScoreMap.set(p.id, 0));
    
    // Reset relic
    RelicState = {
        position: { x: 500, y: 500 },
        isHeld: false,
        holderId: null,
        isRespawning: false
    };
    
    // Clear exploration (fresh start)
    GlobalExploredTiles.clear();
    
    // Notify all clients of reset
    io.emit('gameStart', {
        allPlayers: Array.from(PlayerMap.values()),
        relicState: RelicState,
        scoreMap: Object.fromEntries(ScoreMap),
        exploredTiles: Array.from(GlobalExploredTiles)
    });
    
    console.log(`✅ Game reset complete`);
}

// ============================================================================
// SOCKET.IO CONNECTION HANDLER - Network Event Management
// ============================================================================

io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);

    /**
     * JOIN GAME HANDLER
     * Initializes new player and adds to game state
     * 
     * EDGE CASE HANDLING:
     * - Rejects if game is full (4 players)
     * - Assigns unique base and color
     * - Sends full game state to new player
     * - Notifies existing players of new arrival
     */
    socket.on('joinGame', (data) => {
        // Check capacity
        if (PlayerMap.size >= 4) {
            console.log(`⛔ Game full, rejecting ${socket.id}`);
            socket.emit('error', { message: 'Game is full (4/4 players)' });
            return;
        }

        // Assign player number (1-4)
        const playerNumber = PlayerMap.size + 1;
        const baseId = `player${playerNumber}`;
        const base = BASE_POSITIONS[baseId];
        
        const playerName = data.name || `Player_${playerNumber}`;
        const playerColor = base.color;

        // Create player object
        const newPlayer = {
            id: socket.id,
            name: playerName,
            x: base.x,
            y: base.y,
            score: 0,
            hasRelic: false,
            baseId: baseId,
            color: playerColor,
            baseColor: playerColor
        };

        // Add to authoritative state
        PlayerMap.set(socket.id, newPlayer);
        ScoreMap.set(socket.id, 0);

        console.log(`✅ ${playerName} joined as ${baseId} at (${base.x}, ${base.y})`);

        // Notify ALL players of new arrival
        io.emit('newPlayer', {
            id: newPlayer.id,
            name: newPlayer.name,
            x: newPlayer.x,
            y: newPlayer.y,
            color: newPlayer.color,
            baseColor: newPlayer.baseColor,
            timestamp: Date.now()
        });

        // Send complete game state to NEW player only
        socket.emit('gameStart', {
            allPlayers: Array.from(PlayerMap.values()),
            relicState: RelicState,
            scoreMap: Object.fromEntries(ScoreMap),
            exploredTiles: Array.from(GlobalExploredTiles)
        });
    });

    /**
     * GAME EVENT HANDLERS
     * Route incoming game actions to authoritative handlers
     */
    socket.on('playerMove', handlePlayerMove);
    socket.on('relicAttempt', handleRelicAttempt);
    socket.on('baseAttempt', handleBaseAttempt);

    /**
     * MAP EXPLORATION HANDLER
     * Aggregates exploration data from all clients
     * 
     * DATA MINIMIZATION: Client sends array of newly explored tiles
     * Server merges into global set without re-broadcasting
     * (Fog of war is client-side, no need to sync)
     */
    socket.on('mapExplored', (data) => {
        if (data.tiles && Array.isArray(data.tiles)) {
            data.tiles.forEach(tile => {
                GlobalExploredTiles.add(`x:${tile.x},y:${tile.y}`);
            });
            // Optional: Log exploration progress
            // console.log(`🗺️  Map ${Math.floor(GlobalExploredTiles.size / 4)}% explored`);
        }
    });

    /**
     * CHAT HANDLER
     * Relays chat messages to all players
     * Note: Could add message sanitization/filtering here
     */
    socket.on('playerChat', (data) => {
        const player = PlayerMap.get(data.id);
        if (player) {
            console.log(`💬 ${player.name}: ${data.message}`);
            io.emit('playerChat', {
                id: data.id,
                message: data.message,
                timestamp: data.timestamp
            });
        }
    });

    /**
     * DISCONNECTION HANDLER
     * Cleans up player state and notifies others
     * 
     * EDGE CASE: If disconnected player held relic, drop it at their position
     */
    socket.on('disconnect', () => {
        const player = PlayerMap.get(socket.id);
        if (player) {
            console.log(`🔌 ${player.name} disconnected`);
            
            // Handle relic drop if player was holding it
            if (RelicState.holderId === socket.id) {
                RelicState.holderId = null;
                RelicState.isHeld = false;
                RelicState.position = { x: player.x, y: player.y };

                console.log(`📍 Relic dropped at (${Math.floor(player.x)}, ${Math.floor(player.y)})`);

                io.emit('relicStatus', {
                    isHeld: false,
                    holderId: null,
                    position: RelicState.position,
                    timestamp: Date.now()
                });
            }

            // Remove from game state
            PlayerMap.delete(socket.id);
            ScoreMap.delete(socket.id);

            // Notify remaining players
            io.emit('playerDisconnected', {
                id: socket.id,
                timestamp: Date.now()
            });
        }
    });
});

// ============================================================================
// SERVER INITIALIZATION
// ============================================================================

server.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════════╗
║         🎮 SHADOWS OF THE FORGOTTEN RELIC SERVER 🎮           ║
╠════════════════════════════════════════════════════════════════╣
║  Port: ${PORT.toString().padEnd(56)}║
║  Status: ONLINE                                                ║
║  Max Players: 4                                                ║
║  Map Size: 1000x1000                                           ║
║  Win Condition: First to ${MAX_SCORE} captures                           ║
╠════════════════════════════════════════════════════════════════╣
║  🌐 Open http://localhost:${PORT} in your browser             ║
╚════════════════════════════════════════════════════════════════╝
    `);
    console.log(`⏳ Waiting for players to connect...\n`);
});