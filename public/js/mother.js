const socket = io();

// UI Elements

const alertsBody = document.getElementById('alerts-body');
const alertCountSpan = document.getElementById('alert-count');
const emptyState = document.getElementById('empty-state');
const alertSound = document.getElementById('alert-sound');
const liveFeed = document.getElementById('live-feed');

const latestAlert = document.getElementById('latest-alert');
const alertTitle = document.getElementById('alert-title');
const alertMessage = document.getElementById('alert-message');
const dismissAlertBtn = document.getElementById('dismiss-alert');
const deleteHistoryBtn = document.getElementById('delete-history-btn');
const logoutBtn = document.getElementById('logout-btn');
const loginOverlay = document.getElementById('login-overlay');
const accessCodeInput = document.getElementById('access-code');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const dashboardContent = document.getElementById('dashboard-content');
const expressionStatus = document.getElementById('expression-status');
const expressionMessage = document.getElementById('expression-message');

let alertsHistory = [];

// Authentication Logic
document.addEventListener('DOMContentLoaded', () => {
    const savedCode = localStorage.getItem('baby_monitor_code');
    if (savedCode) {
        authenticate(savedCode);
    }
});

loginBtn.addEventListener('click', () => {
    const code = accessCodeInput.value;
    authenticate(code);
});

logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('baby_monitor_code');
    location.reload();
});

function authenticate(code) {
    socket.emit('authenticate', code);
}

socket.on('authenticated', (response) => {
    if (response.success) {
        const code = accessCodeInput.value || localStorage.getItem('baby_monitor_code');
        localStorage.setItem('baby_monitor_code', code);
        loginOverlay.classList.add('hidden');
        if (dashboardContent) dashboardContent.classList.remove('hidden');
    } else {
        localStorage.removeItem('baby_monitor_code');
        loginError.classList.remove('hidden');
        loginError.textContent = response.message || 'Invalid Access Code';
    }
});

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
    console.log('Received expression:', expressionData);
    
    // 1. Update the live feed overlay status
    if (expressionStatus) {
        expressionStatus.textContent = expressionData.reason;
        expressionStatus.classList.remove('hidden');
        setTimeout(() => expressionStatus.classList.add('hidden'), 5000);
    }
    
    // 2. Update the banner message
    if (expressionMessage) {
        expressionMessage.textContent = `Reason: ${expressionData.reason}`;
        expressionMessage.classList.remove('hidden');
    }

    // 3. Integrate into the main Alert Title (e.g., Baby Cry (Hungry)!)
    if (latestAlert.classList.contains('show') && alertTitle.textContent.includes('Baby Cry')) {
        alertTitle.textContent = `Baby Cry (${expressionData.reason})!`;
    }

    // 4. Update History Table
    // Find the most recent 'Baby Cry' alert to attach this reason to
    for (let i = alertsHistory.length - 1; i >= 0; i--) {
        if (alertsHistory[i].type === 'Baby Cry') {
            alertsHistory[i].subType = expressionData.reason;
            break;
        }
    }
    renderTable();
});


let lastFrameTime = Date.now();
const feedStatus = document.createElement('div');
feedStatus.id = 'feed-connectivity-status';
feedStatus.className = 'badge bg-orange hidden';
feedStatus.style.marginTop = '10px';
feedStatus.textContent = 'Disconnected';
const videoHeader = document.querySelector('.feed-card .card-header');
if (videoHeader) videoHeader.appendChild(feedStatus);

socket.on('video_frame', (frame) => {
    if (liveFeed) {
        liveFeed.src = frame;
        lastFrameTime = Date.now();
        if (!feedStatus.classList.contains('hidden')) {
            feedStatus.classList.add('hidden');
        }
    }
});

// Watchdog to check for disconnected "long distance" feed
setInterval(() => {
    const now = Date.now();
    if (now - lastFrameTime > 5000) { // No frames for 5 seconds
        feedStatus.textContent = 'Baby Monitor Offline/Lagging';
        feedStatus.classList.remove('hidden');
        feedStatus.classList.replace('bg-green', 'bg-orange');
    }
}, 2000);

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
    const displayTitle = (alert.type === 'Baby Cry' && alert.subType) ? `Baby Cry (${alert.subType})` : (alert.subType || alert.type);
    alertTitle.textContent = `${displayTitle}!`;
    let displayMsg = `${displayTitle} detected at ${alert.time} | ${alert.date}`;
    alertMessage.textContent = displayMsg;
    
    // Hide previous expression if new alert is not a cry
    if (alert.type !== 'Baby Cry' && expressionMessage) {
        expressionMessage.classList.add('hidden');
    }

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
        let displayType = (alert.type === 'Baby Cry' && alert.subType) ? `Baby Cry (${alert.subType})` : (alert.subType || alert.type);

        tr.innerHTML = `
            <td class="${typeClass}">${displayType}</td>
            <td>${alert.date}</td>
            <td>${alert.time}</td>
        `;
        alertsBody.appendChild(tr);
    });
}
