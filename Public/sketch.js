// sketch.js - Client Game Logic for Shadows of the Forgotten Relic

// --- GLOBAL CLIENT STATE ---
let socket;
let myPlayerId;
let players = new Map(); 
let relic;
let scores = {};

let exploredTiles = new Set(); 

let lastClientMoveTime = 0;
const MOVEMENT_UPDATE_INTERVAL = 16; 

let networkLag = 0; 

// DEBUG: Visual key press indicator
let debugKeys = { w: false, a: false, s: false, d: false };
let debugMoveCount = 0; 

// --- FOG OF WAR CONSTANTS AND BUFFERS ---
let mapGraphics;
const VISUAL_RANGE_NORMAL = 150;
const VISUAL_RANGE_RELIC = 400;
const TILE_SIZE = 50; 
const MAX_PLAYER_SPEED = 5; 

// --- HARDCODED BASE POSITIONS (Must match server) ---
const BASE_POSITIONS = {
    player1: { x: 100, y: 100, color: '#3498db', name: 'BLUE BASE' },
    player2: { x: 900, y: 900, color: '#2ecc71', name: 'GREEN BASE' },
    player3: { x: 900, y: 100, color: '#e74c3c', name: 'RED BASE' },
    player4: { x: 100, y: 900, color: '#f39c12', name: 'YELLOW BASE' }
};
const BASE_SIZE = 100;

// --- PARTICLES FOR RELIC TRAIL ---
let particles = [];

const MAX_SCORE = 3; 

function preload() {
    // Load assets here if needed
}

function setup() {
    let canvas = createCanvas(1000, 1000);
    canvas.parent('canvasContainer');
    
    mapGraphics = createGraphics(width, height); 
    mapGraphics.background(15, 15, 20);

    socket = io(); 
    
    socket.on('connect', () => {
        myPlayerId = socket.id; 
        console.log('Connected with ID:', myPlayerId);
        
        players.set(myPlayerId, {
            id: myPlayerId,
            x: 500, 
            y: 500,
            targetX: 500,
            targetY: 500,
            hasRelic: false,
            name: 'Connecting...',
            color: '#ffffff',
            baseColor: '#ffffff'
        });

        socket.emit('joinGame', { name: 'Player' });
    });
    
    socket.on('playerUpdate', (serverPlayers) => {
        const serverTime = serverPlayers[0]?.timestamp || Date.now();
        networkLag = Date.now() - serverTime; 
        updatePingIndicator(networkLag);

        serverPlayers.forEach(pData => {
            if (players.has(pData.id)) {
                let player = players.get(pData.id);
                if (pData.id !== myPlayerId) {
                    player.targetX = pData.x;
                    player.targetY = pData.y;
                    player.hasRelic = pData.hasRelic;
                } else {
                    player.x = pData.x;
                    player.y = pData.y;
                    player.targetX = pData.x;
                    player.targetY = pData.y;
                    player.hasRelic = pData.hasRelic;
                }
            }
        });
    });

    socket.on('relicStatus', (status) => {
        relic = status;
        if (!relic.isHeld) {
            relic.x = status.position.x; 
            relic.y = status.position.y;
        }
        
        if (status.isHeld && status.holderId === myPlayerId) {
            showNotification('You grabbed the relic!', '#f39c12');
        } else if (status.isHeld) {
            let holderName = players.get(status.holderId)?.name || 'Someone';
            showNotification(`${holderName} grabbed the relic!`, '#e74c3c');
        } else {
            showNotification('Relic dropped!', '#95a5a6');
        }
    });

    socket.on('scoreUpdate', (update) => {
        scores = update.scoreMap;
        updateScoreboard();
        
        if (update.winningPlayer) {
            let winnerName = players.get(update.winningPlayer)?.name || 'Unknown';
            showNotification(`🏆 ${winnerName} WINS! 🏆`, '#f1c40f', 10000);
        } else if (update.scoringPlayer) {
            let scorerName = players.get(update.scoringPlayer)?.name || 'Someone';
            showNotification(`${scorerName} scored!`, '#2ecc71');
        }
    });

    socket.on('newPlayer', (pData) => {
        if (!players.has(pData.id)) {
            players.set(pData.id, {
                id: pData.id,
                name: pData.name,
                x: pData.x,
                y: pData.y,
                targetX: pData.x, 
                targetY: pData.y,
                hasRelic: false,
                color: pData.color,
                baseColor: pData.baseColor
            });
            showNotification(`${pData.name} joined`, '#3498db', 2000);
        }
    });

    socket.on('gameStart', (state) => {
        console.log('Game started with state:', state);
        state.allPlayers.forEach(pData => {
            players.set(pData.id, { 
                ...pData, 
                targetX: pData.x, 
                targetY: pData.y
            });
        });
        relic = state.relicState;
        scores = state.scoreMap;
        state.exploredTiles.forEach(tile => exploredTiles.add(tile));
        updateScoreboard();
    });

    socket.on('playerDisconnected', (data) => {
        let playerName = players.get(data.id)?.name || 'Player';
        players.delete(data.id);
        showNotification(`${playerName} left`, '#95a5a6', 2000);
    });
    
    socket.on('playerChat', (data) => {
        appendChat(data.id, data.message);
    });
}

function draw() {
    background(5, 5, 10);
    
    if (!players.has(myPlayerId)) {
        fill(255);
        textAlign(CENTER, CENTER);
        textSize(32);
        text('Connecting to Server...', width/2, height/2);
        textSize(16);
        text('Shadows of the Forgotten Relic', width/2, height/2 + 40);
        return; 
    }
    
    let localPlayer = players.get(myPlayerId);
    
    // CAMERA CENTERING: Center view on player
    push();
    translate(width/2 - localPlayer.x, height/2 - localPlayer.y);
    
    handleLocalMovement(localPlayer); 
    reportExploration(localPlayer); 
    
    drawMap(localPlayer); 
    drawMapObjects(localPlayer); 
    drawFogOfWarAndObjects(localPlayer);
    
    updateParticles();
    
    pop(); // End camera transform
    
    // UI elements drawn in screen space (not affected by camera)
    if (frameCount < 300) {
        drawInstructions();
    }
    
    drawMiniMap(localPlayer);
    drawDebugInfo(localPlayer); // NEW: Show debug info
}

function drawMapObjects(localPlayer) {
    for (const id in BASE_POSITIONS) {
        const base = BASE_POSITIONS[id];
        
        if (checkVisibility({x: base.x, y: base.y}, localPlayer)) {
            push();
            rectMode(CENTER);
            
            // Convert hex color to p5 color object
            let baseColor = color(base.color);
            
            noStroke();
            fill(red(baseColor), green(baseColor), blue(baseColor), 32); // 20 in hex is ~32 in alpha
            for (let i = 3; i > 0; i--) {
                rect(base.x, base.y, BASE_SIZE + i * 15, BASE_SIZE + i * 15);
            }
            
            stroke(baseColor);
            strokeWeight(4);
            fill(red(baseColor), green(baseColor), blue(baseColor), 48); // 30 in hex is ~48 in alpha
            rect(base.x, base.y, BASE_SIZE, BASE_SIZE);
            
            fill(baseColor);
            noStroke();
            textAlign(CENTER, CENTER);
            textSize(14);
            textStyle(BOLD);
            text(base.name, base.x, base.y);
            
            pop();
        }
    }

    const obstacles = [
        { x: 300, y: 300, w: 80, h: 80 },
        { x: 700, y: 700, w: 120, h: 60 },
        { x: 500, y: 200, w: 60, h: 100 },
        { x: 200, y: 700, w: 100, h: 50 }
    ];
    
    obstacles.forEach(obs => {
        if (checkVisibility(obs, localPlayer)) {
            push();
            fill(30, 30, 40);
            stroke(60, 60, 80);
            strokeWeight(2);
            rectMode(CENTER);
            rect(obs.x, obs.y, obs.w, obs.h);
            pop();
        }
    });
}

function checkVisibility(obj, localPlayer) {
    const currentVisualRange = localPlayer.hasRelic ? VISUAL_RANGE_RELIC : VISUAL_RANGE_NORMAL;
    return getDistance(obj, localPlayer) < currentVisualRange;
}

function drawMap(localPlayer) {
    fill(15, 15, 20); 
    noStroke();
    rect(0, 0, width, height);
    
    image(mapGraphics, 0, 0); 
    
    mapGraphics.noStroke();
    mapGraphics.fill(25, 35, 45);
    
    exploredTiles.forEach(tileKey => {
        const parts = tileKey.split(',');
        const x = parseInt(parts[0].split(':')[1]) * TILE_SIZE;
        const y = parseInt(parts[1].split(':')[1]) * TILE_SIZE;
        mapGraphics.rect(x, y, TILE_SIZE, TILE_SIZE);
    });
    
    const currentVisualRange = localPlayer.hasRelic ? VISUAL_RANGE_RELIC : VISUAL_RANGE_NORMAL;
    mapGraphics.fill(25, 35, 45);
    mapGraphics.ellipse(localPlayer.x, localPlayer.y, currentVisualRange * 2, currentVisualRange * 2); 
}

function drawFogOfWarAndObjects(localPlayer) {
    push();
    fill(0, 0, 0, 230);
    noStroke();
    rect(0, 0, width, height); 
    
    blendMode(REMOVE);
    const currentVisualRange = localPlayer.hasRelic ? VISUAL_RANGE_RELIC : VISUAL_RANGE_NORMAL;
    
    fill(0, 0, 0, 255);
    ellipse(localPlayer.x, localPlayer.y, currentVisualRange * 2, currentVisualRange * 2);
    
    fill(0, 0, 0, 180);
    ellipse(localPlayer.x, localPlayer.y, currentVisualRange * 2.1, currentVisualRange * 2.1);
    
    pop();
    
    drawRelic();
    drawParticles();
    drawPlayers(localPlayer); 
}

function drawPlayers(localPlayer) {
    players.forEach(p => {
        if (p.id !== myPlayerId) {
            p.x = lerp(p.x, p.targetX, 0.3); 
            p.y = lerp(p.y, p.targetY, 0.3);
        }
        
        if (p.id === myPlayerId || checkVisibility(p, localPlayer)) {
            push();
            
            if (p.hasRelic) {
                noStroke();
                let glowAlpha = 150 + sin(frameCount * 0.15) * 100;
                fill(255, 215, 0, glowAlpha);
                ellipse(p.x, p.y, 60, 60);
                
                if (frameCount % 3 === 0) {
                    particles.push({
                        x: p.x + random(-15, 15),
                        y: p.y + random(-15, 15),
                        vx: random(-1, 1),
                        vy: random(-2, 0),
                        life: 255,
                        size: random(3, 8)
                    });
                }
            }
            
            // Convert hex color to p5 color
            let playerColor = color(p.color || '#ffffff');
            fill(playerColor);
            stroke(255);
            strokeWeight(3);
            ellipse(p.x, p.y, 35, 35);
            
            noStroke();
            fill(255);
            ellipse(p.x, p.y - 10, 6, 6);
            
            fill(255);
            stroke(0);
            strokeWeight(3);
            textAlign(CENTER, CENTER);
            textSize(13);
            textStyle(BOLD);
            text(p.name, p.x, p.y - 35);
            
            pop();
        }
    });
}

function drawRelic() {
    if (!relic) return;
    
    if (relic.isHeld && players.has(relic.holderId)) {
        let holder = players.get(relic.holderId);
        relic.x = holder.x;
        relic.y = holder.y;
        return;
    }

    let localPlayer = players.get(myPlayerId);
    if (localPlayer && checkVisibility(relic, localPlayer)) {
        push();
        
        noStroke();
        let glowSize = 70 + sin(frameCount * 0.1) * 20;
        fill(255, 215, 0, 150);
        ellipse(relic.x, relic.y, glowSize, glowSize);
        
        fill(255, 215, 0, 80);
        ellipse(relic.x, relic.y, glowSize * 1.5, glowSize * 1.5);
        
        fill(255, 215, 0);
        stroke(255, 165, 0);
        strokeWeight(4);
        rectMode(CENTER);
        
        push();
        translate(relic.x, relic.y);
        rotate(frameCount * 0.02);
        rect(0, 0, 30, 30);
        
        rotate(frameCount * -0.04);
        stroke(255, 215, 0);
        strokeWeight(2);
        noFill();
        rect(0, 0, 20, 20);
        pop();
        
        fill(255, 165, 0);
        noStroke();
        ellipse(relic.x, relic.y, 10, 10);
        
        for (let i = 0; i < 3; i++) {
            let angle = frameCount * 0.05 + (i * TWO_PI / 3);
            let px = relic.x + cos(angle) * 25;
            let py = relic.y + sin(angle) * 25;
            fill(255, 215, 0, 200);
            ellipse(px, py, 5, 5);
        }
        
        pop();
    } else if (localPlayer && !relic.isHeld) {
        drawRelicIndicator(localPlayer);
    }
}

function drawRelicIndicator(localPlayer) {
    push();
    
    let angle = atan2(relic.y - localPlayer.y, relic.x - localPlayer.x);
    let distance = getDistance(localPlayer, relic);
    
    let indicatorDist = 80;
    let ix = localPlayer.x + cos(angle) * indicatorDist;
    let iy = localPlayer.y + sin(angle) * indicatorDist;
    
    let pulseSize = 15 + sin(frameCount * 0.1) * 5;
    
    translate(ix, iy);
    rotate(angle);
    
    fill(255, 215, 0, 200);
    stroke(255, 165, 0);
    strokeWeight(2);
    
    triangle(pulseSize, 0, -pulseSize/2, -pulseSize/2, -pulseSize/2, pulseSize/2);
    
    fill(255);
    noStroke();
    textAlign(CENTER, CENTER);
    textSize(10);
    text(Math.floor(distance), -pulseSize * 1.5, 0);
    
    pop();
}

function updateParticles() {
    for (let i = particles.length - 1; i >= 0; i--) {
        let p = particles[i];
        p.x += p.vx;
        p.y += p.vy;
        p.life -= 5;
        
        if (p.life <= 0) {
            particles.splice(i, 1);
        }
    }
}

function drawParticles() {
    particles.forEach(p => {
        push();
        noStroke();
        fill(255, 215, 0, p.life);
        ellipse(p.x, p.y, p.size, p.size);
        pop();
    });
}

function reportExploration(localPlayer) {
    const newlyExplored = [];
    const radius = (localPlayer.hasRelic ? VISUAL_RANGE_RELIC : VISUAL_RANGE_NORMAL);
    
    const minTileX = floor((localPlayer.x - radius) / TILE_SIZE);
    const maxTileX = floor((localPlayer.x + radius) / TILE_SIZE);
    const minTileY = floor((localPlayer.y - radius) / TILE_SIZE);
    const maxTileY = floor((localPlayer.y + radius) / TILE_SIZE);

    for (let x = minTileX; x <= maxTileX; x++) {
        for (let y = minTileY; y <= maxTileY; y++) {
            if (x >= 0 && y >= 0 && x * TILE_SIZE < width && y * TILE_SIZE < height) {
                const tileKey = `x:${x},y:${y}`;
                const tileCenterX = x * TILE_SIZE + TILE_SIZE / 2;
                const tileCenterY = y * TILE_SIZE + TILE_SIZE / 2;
                
                if (getDistance({x: localPlayer.x, y: localPlayer.y}, {x: tileCenterX, y: tileCenterY}) <= radius) {
                    if (!exploredTiles.has(tileKey)) {
                        exploredTiles.add(tileKey);
                        newlyExplored.push({ x: x, y: y, state: true }); 
                    }
                }
            }
        }
    }
    
    if (newlyExplored.length > 0) {
        socket.emit('mapExplored', { 
            tiles: newlyExplored, 
            timestamp: Date.now() 
        });
    }
}

function handleLocalMovement(player) {
    let dx = 0;
    let dy = 0;
    const speed = MAX_PLAYER_SPEED;

    // Check vertical movement
    if (keyIsDown(UP_ARROW) || keyIsDown(87)) { // W
        dy = -speed;
        debugKeys.w = true;
    } else {
        debugKeys.w = false;
    }
    
    if (keyIsDown(DOWN_ARROW) || keyIsDown(83)) { // S
        dy = speed;
        debugKeys.s = true;
    } else {
        debugKeys.s = false;
    }
    
    // Check horizontal movement
    if (keyIsDown(LEFT_ARROW) || keyIsDown(65)) { // A
        dx = -speed;
        debugKeys.a = true;
    } else {
        debugKeys.a = false;
    }
    
    if (keyIsDown(RIGHT_ARROW) || keyIsDown(68)) { // D
        dx = speed;
        debugKeys.d = true;
    } else {
        debugKeys.d = false;
    }
    
    // Normalize diagonal movement
    if (dx !== 0 && dy !== 0) {
        dx *= 0.707;
        dy *= 0.707;
    }
    
    // Only send update if actually moving
    if (dx !== 0 || dy !== 0) {
        if (millis() - lastClientMoveTime > MOVEMENT_UPDATE_INTERVAL) {
            lastClientMoveTime = millis();
            debugMoveCount++; // Count moves sent
            
            // CLIENT-SIDE PREDICTION: Update immediately for responsive feel
            player.x += dx;
            player.y += dy;
            player.targetX = player.x;
            player.targetY = player.y;
            
            // Determine primary direction for server
            let dir = 'N'; // Default
            if (Math.abs(dx) > Math.abs(dy)) {
                dir = dx > 0 ? 'E' : 'W';
            } else {
                dir = dy > 0 ? 'S' : 'N';
            }
            
            // Send to server
            socket.emit('playerMove', { 
                id: myPlayerId, 
                dir: dir,
                dx: dx,
                dy: dy,
                timestamp: Date.now() 
            }); 
        }
    }
}

function keyPressed() {
    if (keyCode === 69) {
        let localPlayer = players.get(myPlayerId);
        if (!localPlayer) return;
        
        if (localPlayer.hasRelic) {
            socket.emit('baseAttempt', { id: myPlayerId, timestamp: Date.now() });
        } else {
            socket.emit('relicAttempt', { id: myPlayerId, timestamp: Date.now() });
        }
    }
    
    if (keyCode === 84) {
        const chatInput = select('#chatInput');
        if (chatInput) {
            if (chatInput.style('display') === 'none') {
                chatInput.style('display', 'block');
                chatInput.elt.focus();
            } else {
                if (chatInput.value().trim() !== '') {
                    socket.emit('playerChat', {
                        id: myPlayerId,
                        message: chatInput.value(),
                        timestamp: Date.now()
                    });
                    chatInput.value('');
                }
                chatInput.style('display', 'none');
            }
            return false;
        }
    }
    
    const chatInput = select('#chatInput');
    if (keyCode === ENTER && chatInput && chatInput.style('display') === 'block') {
        if (chatInput.value().trim() !== '') {
            socket.emit('playerChat', {
                id: myPlayerId,
                message: chatInput.value(),
                timestamp: Date.now()
            });
            chatInput.value('');
        }
        chatInput.style('display', 'none');
        return false;
    }
}

function drawMiniMap(localPlayer) {
    push();
    
    let mmSize = 150;
    let mmX = 20;
    let mmY = 20;
    let scale = mmSize / 1000;
    
    fill(0, 0, 0, 180);
    stroke(52, 152, 219);
    strokeWeight(2);
    rect(mmX, mmY, mmSize, mmSize);
    
    noStroke();
    fill(25, 35, 45, 150);
    rect(mmX, mmY, mmSize, mmSize);
    
    for (const id in BASE_POSITIONS) {
        const base = BASE_POSITIONS[id];
        fill(base.color);
        let bx = mmX + base.x * scale;
        let by = mmY + base.y * scale;
        rect(bx - 5, by - 5, 10, 10);
    }
    
    if (relic && !relic.isHeld) {
        fill(255, 215, 0);
        noStroke();
        let rx = mmX + relic.x * scale;
        let ry = mmY + relic.y * scale;
        ellipse(rx, ry, 8, 8);
        
        noFill();
        stroke(255, 215, 0, 150);
        strokeWeight(2);
        let pulseSize = 10 + sin(frameCount * 0.15) * 5;
        ellipse(rx, ry, pulseSize, pulseSize);
    }
    
    players.forEach(p => {
        // Convert hex color to RGB
        let c = color(p.color || '#ffffff');
        fill(c);
        stroke(255);
        strokeWeight(1);
        let px = mmX + p.x * scale;
        let py = mmY + p.y * scale;
        
        if (p.id === myPlayerId) {
            ellipse(px, py, 8, 8);
            
            noFill();
            stroke(c);
            strokeOpacity = 100;
            let viewRange = p.hasRelic ? VISUAL_RANGE_RELIC : VISUAL_RANGE_NORMAL;
            ellipse(px, py, viewRange * scale * 2, viewRange * scale * 2);
        } else {
            ellipse(px, py, 6, 6);
        }
    });
    
    noStroke();
    fill(52, 152, 219);
    textAlign(LEFT, TOP);
    textSize(10);
    text('MAP', mmX + 5, mmY + mmSize + 5);
    
    pop();
}

function drawInstructions() {
    push();
    fill(0, 0, 0, 150);
    noStroke();
    rectMode(CENTER);
    rect(width/2, 50, 600, 80, 10);
    
    fill(255);
    textAlign(CENTER, CENTER);
    textSize(16);
    textStyle(BOLD);
    text('Grab the RELIC and return it to your BASE!', width/2, 30);
    textSize(12);
    textStyle(NORMAL);
    text('WASD/Arrows: Move  |  E: Pickup/Score  |  T: Chat', width/2, 55);
    text('First to 3 captures wins!', width/2, 75);
    pop();
}

function updatePingIndicator(lag) {
    const indicator = select('#pingIndicator');
    const value = select('#pingValue');
    if (!indicator || !value) return;
    
    value.html(Math.round(lag) + ' ms');

    if (lag < 80) {
        indicator.style('background-color', '#2ecc71'); 
    } else if (lag < 200) {
        indicator.style('background-color', '#f39c12'); 
    } else {
        indicator.style('background-color', '#e74c3c'); 
    }
}

function updateScoreboard() {
    const scoreBoard = select('#scoreBoard');
    if (!scoreBoard) return;
    
    let scoreHtml = '<h3>📊 Scoreboard</h3>';
    
    const sortedScores = Object.entries(scores).sort(([, a], [, b]) => b - a);
    
    if (sortedScores.length === 0) {
        scoreHtml += '<p style="color: #95a5a6;">Waiting for players...</p>';
    } else {
        sortedScores.forEach(([id, score]) => {
            const player = players.get(id);
            const name = player?.name || id.substring(0, 8);
            const color = player?.color || '#ffffff';
            const isMe = id === myPlayerId ? ' 👤' : '';
            scoreHtml += `<p><span style="color: ${color};">⬤</span> ${name}${isMe}: <strong>${score}/${MAX_SCORE}</strong></p>`;
        });
    }

    scoreBoard.html(scoreHtml);
}

function showNotification(message, color = '#ffffff', duration = 3000) {
    const notifDiv = select('#notification');
    if (!notifDiv) return;
    
    notifDiv.html(message);
    notifDiv.style('background-color', color + 'dd');
    notifDiv.style('display', 'block');
    
    setTimeout(() => {
        notifDiv.style('display', 'none');
    }, duration);
}

function appendChat(id, message) {
    const chatWindow = select('#chat-window');
    if (!chatWindow) return;
    
    const player = players.get(id);
    const name = player?.name || id.substring(0, 8);
    const color = player?.color || '#ffffff';
    
    chatWindow.html(
        chatWindow.html() + 
        `<div><span style="color: ${color}; font-weight: bold;">${name}:</span> ${message}</div>`, 
        true
    );
    chatWindow.elt.scrollTop = chatWindow.elt.scrollHeight;
}

function getDistance(p1, p2) {
    return Math.sqrt(Math.pow(p1.x - p2.x, 2) + Math.pow(p1.y - p2.y, 2));
}

// NEW: Debug info display
function drawDebugInfo(localPlayer) {
    push();
    
    // Background panel
    fill(0, 0, 0, 200);
    stroke(255, 255, 0);
    strokeWeight(2);
    rect(width - 210, 10, 200, 180);
    
    // Title
    fill(255, 255, 0);
    noStroke();
    textAlign(LEFT, TOP);
    textSize(14);
    textStyle(BOLD);
    text('🔧 DEBUG INFO', width - 200, 20);
    
    textStyle(NORMAL);
    textSize(12);
    fill(255);
    
    // Player position
    text(`Position: (${Math.floor(localPlayer.x)}, ${Math.floor(localPlayer.y)})`, width - 200, 45);
    
    // Socket status
    let socketStatus = socket && socket.connected ? '✅ Connected' : '❌ Disconnected';
    fill(socket && socket.connected ? '#2ecc71' : '#e74c3c');
    text(`Socket: ${socketStatus}`, width - 200, 65);
    
    // Key presses
    fill(255);
    text('Keys Pressed:', width - 200, 85);
    
    let keyY = 105;
    fill(debugKeys.w ? '#2ecc71' : '#95a5a6');
    text(`  W: ${debugKeys.w ? 'PRESSED' : 'released'}`, width - 200, keyY);
    
    fill(debugKeys.a ? '#2ecc71' : '#95a5a6');
    text(`  A: ${debugKeys.a ? 'PRESSED' : 'released'}`, width - 200, keyY + 20);
    
    fill(debugKeys.s ? '#2ecc71' : '#95a5a6');
    text(`  S: ${debugKeys.s ? 'PRESSED' : 'released'}`, width - 200, keyY + 40);
    
    fill(debugKeys.d ? '#2ecc71' : '#95a5a6');
    text(`  D: ${debugKeys.d ? 'PRESSED' : 'released'}`, width - 200, keyY + 60);
    
    // Move count
    fill(255);
    text(`Moves Sent: ${debugMoveCount}`, width - 200, 170);
    
    pop();
}