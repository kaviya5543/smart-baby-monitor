const socket = io();

const pinOverlay = document.getElementById('pin-overlay');
const pinInput = document.getElementById('pin-input');
const pinSubmit = document.getElementById('pin-submit');
const pinError = document.getElementById('pin-error');
const changeCodeBtn = document.getElementById('change-code-btn');
const statusBadge = document.getElementById('status-badge');

let authenticated = false;

// Authenticate with the server
pinSubmit.addEventListener('click', () => {
    const code = pinInput.value;
    if (code.length === 4) {
        socket.emit('authenticate', code);
    } else {
        showPinError("Please enter a 4-digit code.");
    }
});

pinInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') pinSubmit.click();
});

function showPinError(msg) {
    pinError.textContent = msg;
    pinError.classList.remove('hidden');
    setTimeout(() => pinError.classList.add('hidden'), 3000);
}

socket.on('authenticated', (data) => {
    if (data.success) {
        console.log("Successfully authenticated with server.");
        authenticated = true;
        pinOverlay.classList.add('hidden');
        if (statusBadge) {
            statusBadge.classList.replace('bg-orange', 'bg-green');
            statusBadge.innerHTML = '<span class="pulse-dot"></span> System Active';
        }
    } else {
        console.error("Authentication failed:", data.message);
        showPinError(data.message || "Invalid access code.");
    }
});

socket.on('baby_status', (data) => {
    console.log("Baby status changed:", data);
    const badge = document.getElementById('status-badge');
    if (data.online) {
        badge.classList.remove('bg-red', 'bg-orange');
        badge.classList.add('bg-green');
        badge.innerHTML = '<span class="pulse-dot"></span> Baby Monitor Online';
    } else {
        badge.classList.remove('bg-green', 'bg-orange');
        badge.classList.add('bg-red');
        badge.innerHTML = 'Baby Monitor Offline';
    }
});

socket.on('access_code_updated', (data) => {
    alert(data.message + "\nYou will need to use the new PIN next time.");
});

changeCodeBtn.addEventListener('click', () => {
    const newCode = prompt("Enter new 4-digit Parent PIN:");
    if (newCode && newCode.length === 4 && /^\d+$/.test(newCode)) {
        socket.emit('update_access_code', newCode);
    } else if (newCode) {
        alert("Invalid PIN. Must be 4 digits.");
    }
});

// UI Elements

const alertsBody = document.getElementById('alerts-body');
const alertCountSpan = document.getElementById('alert-count');
const emptyState = document.getElementById('empty-state');
const alertSound = document.getElementById('alert-sound');
const liveFeed = document.getElementById('live-feed');

const latestAlert = document.getElementById('latest-alert');
const alertTitle = document.getElementById('alert-title');
const alertMessage = document.getElementById('alert-message');
const expressionMessage = document.getElementById('expression-message');
const dismissAlertBtn = document.getElementById('dismiss-alert');
const deleteHistoryBtn = document.getElementById('delete-history-btn');

let alertsHistory = [];

// Socket connections
socket.on('initial_alerts', (alerts) => {
    alertsHistory = alerts;
    renderTable();
});

socket.on('history_deleted', () => {
    console.log('Event received: history_deleted');
    alertsHistory = [];
    renderTable();
});

socket.on('delete_status', (data) => {
    if (data.success) {
        alert('Alert history cleared successfully.');
    } else {
        alert('Failed to clear history: ' + (data.message || 'Unknown error'));
    }
});

socket.on('new_alert', (alertData) => {
    alertsHistory.push(alertData);
    
    // Play sound on a new alert
    playSound();
    
    // Show banner notification
    showBanner(alertData);
    
    // Update table
    renderTable(true);
});

socket.on('new_expression', (expressionData) => {
    console.log('New expression received:', expressionData);
    if (expressionMessage) {
        expressionMessage.textContent = `Facial Expression: ${expressionData.reason}`;
        expressionMessage.classList.remove('hidden');
        
        // Find the latest cry alert in history and attach this info if it's very recent
        const now = Date.now();
        const latestCryIndex = alertsHistory.findLastIndex(a => a.type === 'Baby Cry' && (now - a.timestamp < 10000));
        if (latestCryIndex !== -1) {
            alertsHistory[latestCryIndex].expressionReason = expressionData.reason;
            renderTable();
        }
    }
});

socket.on('video_frame', (frame) => {
    if (liveFeed) {
        liveFeed.src = frame;
    }
});

// --- Live Audio Playback --- //
let mediaSource = null;
let sourceBuffer = null;
let queue = [];
const audioEl = new Audio();

function initAudio() {
    if (mediaSource) return;
    
    mediaSource = new MediaSource();
    audioEl.src = URL.createObjectURL(mediaSource);
    
    mediaSource.addEventListener('sourceopen', () => {
        console.log("MediaSource opened");
        try {
            sourceBuffer = mediaSource.addSourceBuffer('audio/webm;codecs=opus');
            sourceBuffer.addEventListener('updateend', () => {
                if (queue.length > 0 && !sourceBuffer.updating) {
                    sourceBuffer.appendBuffer(queue.shift());
                }
            });
        } catch (e) {
            console.error("Error adding SourceBuffer:", e);
        }
    });

    audioEl.play().catch(e => console.warn("Auto-play blocked, wait for interaction", e));
}

// Initialize audio on first user click to satisfy browser policy
document.addEventListener('click', initAudio, { once: true });

socket.on('audio_chunk', (chunk) => {
    if (!authenticated) return;
    
    if (sourceBuffer && !sourceBuffer.updating) {
        sourceBuffer.appendBuffer(chunk);
    } else {
        queue.push(chunk);
    }
    
    // Auto-play if paused
    if (audioEl.paused && mediaSource.readyState === 'open') {
        audioEl.play().catch(() => {});
    }
});

// UI Event Listeners
dismissAlertBtn.addEventListener('click', () => {
    latestAlert.classList.remove('show');
});

deleteHistoryBtn.addEventListener('click', () => {
    console.log('Delete History button clicked');
    if (confirm('Are you sure you want to delete all alert history? This cannot be undone.')) {
        console.log('Emitting delete_history event');
        socket.emit('delete_history');
    }
});

// Helper Functions
function playSound() {
    // Some browsers block autoplay, ensure we catch exceptions
    try {
        alertSound.currentTime = 0;
        alertSound.play().catch(e => console.warn('Audio playback prevented by browser:', e));
    } catch(e) {
        console.error('Audio play failed', e);
    }
}

function showBanner(alert) {
    alertTitle.textContent = `${alert.type} Detected!`;
    let displayMsg = `${alert.type} detected at ${alert.time} | ${alert.date}`;
    if (expressionMessage) expressionMessage.classList.add('hidden'); // Clear old expression info
    if (alert.subType) {
        displayMsg += `\nType: ${alert.subType}`;
    }
    alertMessage.textContent = displayMsg;
    
    // Custom styling based on type
    if (alert.type === 'Baby Cry') {
        latestAlert.style.borderLeftColor = 'var(--alert-red)';
        alertTitle.style.color = 'var(--alert-red)';
    } else {
        latestAlert.style.borderLeftColor = 'var(--alert-orange)';
        alertTitle.style.color = 'var(--alert-orange)';
    }

    latestAlert.classList.remove('hidden');
    // small timeout to allow display:block to apply before animating opacity/transform via class
    setTimeout(() => {
        latestAlert.classList.add('show');
    }, 10);

    // Auto dismiss after 10s
    setTimeout(() => {
        latestAlert.classList.remove('show');
    }, 10000);
}

function renderTable(isNew = false) {
    // Sort reverse chronological
    const sortedAlerts = [...alertsHistory].sort((a, b) => b.timestamp - a.timestamp);
    
    alertCountSpan.textContent = `${sortedAlerts.length} Alert${sortedAlerts.length !== 1 ? 's' : ''}`;
    
    if (sortedAlerts.length === 0) {
        alertsBody.innerHTML = `<tr id="empty-state"><td colspan="3" class="empty-cell">No alerts recorded yet.</td></tr>`;
        return;
    }

    alertsBody.innerHTML = '';
    
    sortedAlerts.forEach((alert, index) => {
        const tr = document.createElement('tr');
        
        // If this is the newest alert and it was just added, animate it
        if (isNew && index === 0) {
            tr.classList.add('new-row');
        }

        const typeClass = alert.type === 'Baby Cry' ? 'type-cry' : 'type-move';
        
        let displayType = alert.type;
        if (alert.subType) {
            displayType += ` <br><small>Sound: ${alert.subType}</small>`;
        }
        if (alert.expressionReason) {
            displayType += `<br><small>Face: ${alert.expressionReason}</small>`;
        }

        tr.innerHTML = `
            <td class="${typeClass}">${displayType}</td>
            <td>${alert.date}</td>
            <td>${alert.time}</td>
        `;
        alertsBody.appendChild(tr);
    });
}
