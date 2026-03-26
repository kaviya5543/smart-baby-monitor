const socket = io();

// UI Elements

const video = document.getElementById('baby-video');
const canvas = document.getElementById('video-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const motionIndicator = document.getElementById('motion-indicator');
const audioIndicator = document.getElementById('audio-indicator');
const camStatus = document.getElementById('cam-status');
const micStatus = document.getElementById('mic-status');

// Configuration
const MOTION_THRESHOLD = 30; // Lowered to be more sensitive to motion
const MOTION_PIXEL_COUNT_THRESHOLD = 2000; // Lowered to require fewer changed pixels
const AUDIO_THRESHOLD = 0.15; // Volume threshold for fallback detection
const COOLDOWN_MS = 2000; // 2 seconds between same-type alerts
const TM_MODEL_URL = "https://teachablemachine.withgoogle.com/models/NSw1kr-Re/"; // User's custom model URL

let lastMotionAlertTime = 0;
let lastAudioAlertTime = 0;
let previousFrame = null;
let animationFrameId = null;
let audioContext = null;
let modelsLoaded = false;
let recognizer = null;
let indicatorTimeouts = new Map();
let isDetectingExpression = false; // Prevention of scan clashes
let audioAnalyser = null; // Frequency analyzer for manual validation
let audioDataArray = null;
const streamCanvas = document.createElement('canvas'); // Reusable canvas
const sCtx = streamCanvas.getContext('2d', { alpha: false });
streamCanvas.width = 320;
streamCanvas.height = 240;

const pinOverlay = document.getElementById('pin-overlay');
const pinInput = document.getElementById('pin-input');
const pinSubmit = document.getElementById('pin-submit');
const pinError = document.getElementById('pin-error');
const busyOverlay = document.getElementById('busy-overlay');
const changeCodeBtn = document.getElementById('change-code-btn');

let authenticated = false;
let mediaStream = null;
let mediaRecorder = null;

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
        if (camStatus) camStatus.parentElement.style.borderBottom = "2px solid #4CAF50";
        
        // After authentication, register as the baby monitor
        socket.emit('register_as_baby');
    } else {
        console.error("Authentication failed:", data.message);
        showPinError(data.message || "Invalid access code.");
    }
});

socket.on('registration_failed', (data) => {
    console.error("Registration failed:", data.message);
    busyOverlay.classList.remove('hidden');
    document.getElementById('monitor-content').classList.add('hidden');
    stopMonitoring();
});

socket.on('registration_success', () => {
    console.log("Registered as active baby monitor.");
    startMonitoring();
    startFaceScanLoop();
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

// Resume AudioContext on first click to satisfy browser policies
document.addEventListener('click', () => {
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume();
        console.log("AudioContext resumed.");
    }
}, { once: true });

// Load face-api models
async function loadModels() {
    try {
        console.log("Loading models...");
        await faceapi.nets.ssdMobilenetv1.loadFromUri('/models');
        await faceapi.nets.faceExpressionNet.loadFromUri('/models');
        modelsLoaded = true;
        console.log("Models loaded successfully");
        if (document.getElementById('expression-type')) {
            document.getElementById('expression-type').textContent = 'Ready';
        }
    } catch (err) {
        console.error("Error loading models:", err);
        if (document.getElementById('expression-type')) {
            document.getElementById('expression-type').textContent = 'Model Error';
        }
    }
}

// Add authentication status listener
socket.on('authenticated', (data) => {
    if (data.success) {
        console.log("Successfully authenticated with server.");
        if (camStatus) camStatus.parentElement.style.borderBottom = "2px solid #4CAF50";
    } else {
        console.error("Authentication failed:", data.message);
        alert("Server authentication failed. Please check the ACCESS_CODE.");
    }
});

// Auto-load models on start
loadModels();

function stopMonitoring() {
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
    }
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (faceScanTimeout) clearTimeout(faceScanTimeout);
    if (mediaRecorder) mediaRecorder.stop();
}

// --- Media Access & Monitoring --- //
async function startMonitoring() {
    let stream;
    try {
        // Try getting both video and audio first
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' },
            audio: {
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false
            }
        });
        camStatus.textContent = 'Active';
        micStatus.textContent = 'Active';
        setupFrequencyAnalyzer(stream);
        startAudioDetection();
        startAudioStreaming(stream);
    } catch (err) {
        console.warn('Initial media request failed, trying video only...', err);
        // If it failed, maybe they don't have a mic. Try just video.
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { width: 640, height: 480, facingMode: 'user' }
            });
            camStatus.textContent = 'Active';
            micStatus.textContent = 'Failed (No Mic)';
            micStatus.classList.replace('success', 'error');
            console.warn('Running without audio detection.');
        } catch (videoErr) {
            handleMediaError(videoErr);
            return; // Stop execution
        }
    }

    // Connect stream to video element
    video.srcObject = stream;
    video.onloadedmetadata = () => {
        video.play().catch(e => console.error("Error playing video:", e));
    };

    // Wait for video metadata to load for accurate sizes
    video.addEventListener('loadedmetadata', () => {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    });

    video.addEventListener('play', () => {
        detectMotion();
    });
}

function handleMediaError(err) {
    console.error('Error accessing media devices:', err);
    camStatus.textContent = 'Failed';
    camStatus.classList.replace('success', 'error');
    micStatus.textContent = 'Failed';
    micStatus.classList.replace('success', 'error');

    let errorMsg = 'Could not access camera/microphone. Please ensure permissions are granted.\n\n';
    errorMsg += `Error: ${err.name} - ${err.message}\n\n`;

    if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
        errorMsg += 'Fix 1: Click the locked padlock or camera icon in your URL bar to Allow permissions.\n';
        errorMsg += 'Fix 2: If you are using an IP address (like 192.168.x.x) instead of localhost, browsers block the camera. Type chrome://flags/#unsafely-treat-insecure-origin-as-secure in Chrome, enable it, and add this URL.';
    } else if (err.name === 'NotFoundError') {
        errorMsg += 'Your device seems to be missing a web camera. A camera is required!';
    } else if (err.name === 'NotReadableError') {
        errorMsg += 'Your camera is currently being used by another application (like Zoom or Skype). Please close it and refresh.';
    }

    alert(errorMsg);
}

// --- Motion Detection --- //
function detectMotion() {
    if (video.paused || video.ended) return;

    // Draw current frame to hidden canvas
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const currentFrameData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = currentFrameData.data;

    if (previousFrame) {
        let changedPixels = 0;

        // Compare every 4th pixel for performance (RGBA)
        for (let i = 0; i < data.length; i += 16) {
            // Calculate simple greyscale difference
            const rDiff = Math.abs(data[i] - previousFrame[i]);
            const gDiff = Math.abs(data[i + 1] - previousFrame[i + 1]);
            const bDiff = Math.abs(data[i + 2] - previousFrame[i + 2]);

            if (rDiff > MOTION_THRESHOLD || gDiff > MOTION_THRESHOLD || bDiff > MOTION_THRESHOLD) {
                changedPixels++;
            }
        }

        if (changedPixels > MOTION_PIXEL_COUNT_THRESHOLD) {
            handleEvent('Movement');
            showIndicator(motionIndicator);
        }
    }

    // Save current frame for next comparison
    previousFrame = new Uint8ClampedArray(data);
    
    // Draw to scaling canvas (reuse persistent canvas for performance)
    sCtx.drawImage(canvas, 0, 0, 320, 240);

    // Broadcast video frame over Socket.IO with high compression (0.3)
    // JPEG quality 0.3 is highly optimized for "long distance" stability
    socket.emit('video_frame', streamCanvas.toDataURL('image/jpeg', 0.3));

    // Throttle next frame to ~5-10 FPS for bandwidth and allow running in background
    setTimeout(() => {
        detectMotion();
    }, 150);
}

// --- Manual Frequency Validation --- //

function setupFrequencyAnalyzer(stream) {
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const context = new AudioContext();
        const source = context.createMediaStreamSource(stream);
        audioAnalyser = context.createAnalyser();
        audioAnalyser.fftSize = 256;
        
        const bufferLength = audioAnalyser.frequencyBinCount;
        audioDataArray = new Uint8Array(bufferLength);
        
        source.connect(audioAnalyser);
        console.log("Frequency analyzer initialized.");
        
        // Save context globally for resumption
        audioContext = context;
    } catch (err) {
        console.warn("Failed to setup frequency analyzer:", err);
    }
}

function checkCryFrequencies() {
    if (!audioAnalyser || !audioDataArray) return true; // Fallback if failed

    audioAnalyser.getByteFrequencyData(audioDataArray);
    
    // Frequency bins calculation (assuming 44.1kHz sample rate):
    // Each bin is ~172 Hz (44100 / 256)
    // Bin 0: 0-172
    // Bin 1: 172-344 (Fundamental Range Start)
    // Bin 2: 344-516 (Fundamental Range)
    // Bin 11-23: ~2000-4000 Hz (Harmonics Range)

    // Check Energy in Fundamental Range (200-600Hz)
    const fundamentalEnergy = (audioDataArray[1] + audioDataArray[2] + audioDataArray[3]) / 3;
    
    // Check Energy in Piercing Range (2000-4000Hz)
    let harmonicsEnergy = 0;
    for (let i = 11; i <= 23; i++) {
        harmonicsEnergy += audioDataArray[i];
    }
    harmonicsEnergy /= 13;

    // Check Energy in Distracting Range (High end)
    let highEndEnergy = 0;
    for (let i = 40; i < audioDataArray.length; i++) {
        highEndEnergy += audioDataArray[i];
    }
    highEndEnergy /= (audioDataArray.length - 40);

    // Baby cry criteria: 
    // 1. Significant energy in the base pitch (fundamental)
    // 2. Strong presence in the "piercing" harmonics band
    // 3. Overall louder than high-end static/noise
    const hasBasePitch = fundamentalEnergy > 20; // Lowered from 40 for sensitivity
    const hasPiercingHarmonics = harmonicsEnergy > 15; // Lowered from 30 for sensitivity
    const isNotHighStatic = harmonicsEnergy > (highEndEnergy * 1.2); // Lowered from 1.5

    return (hasBasePitch && hasPiercingHarmonics && isNotHighStatic);
}

// --- Audio Detection (Teachable Machine AI) --- //

async function createModel() {
    const checkpointURL = TM_MODEL_URL + "model.json";
    const metadataURL = TM_MODEL_URL + "metadata.json";

    const recognizer = speechCommands.create(
        "BROWSER_FFT",
        undefined,
        checkpointURL,
        metadataURL
    );

    // check that model and metadata are loaded via HTTPS requests.
    await recognizer.ensureModelLoaded();
    return recognizer;
}

async function startAudioDetection() {
    console.log("Initializing Teachable Machine Audio...");
    const cryTypeEl = document.getElementById('cry-type');
    const visualizerBar = document.getElementById('visualizer-bar');

    try {
        recognizer = await createModel();
        const classLabels = recognizer.wordLabels(); // get class labels
        
        console.log("Teachable Machine Model Loaded. Labels:", classLabels);

        // listen() takes two arguments:
        // 1. A callback function that is invoked anytime a word is recognized.
        // 2. A configuration object with probabilityThreshold
        recognizer.listen(result => {
            const scores = result.scores; // probability of prediction for each class
            
            // Find the index of the highest score
            let maxScore = 0;
            let maxIndex = 0;
            for (let i = 0; i < scores.length; i++) {
                if (scores[i] > maxScore) {
                    maxScore = scores[i];
                    maxIndex = i;
                }
            }

            const label = classLabels[maxIndex];
            const confidence = (maxScore * 100).toFixed(0);

            // Update UI Visualizer (Simulated from scores for activity feedback)
            if (visualizerBar) {
                const activityLevel = Math.max(...scores.slice(1)) * 100; // Ignore background noise for bar height
                visualizerBar.style.transform = `scaleY(${1 + (activityLevel / 20)})`;
                visualizerBar.style.backgroundColor = activityLevel > 50 ? '#ff4081' : '#4CAF50';
            }

            // Detection Logic
            // Note: Common labels are "Background Noise", "None", or "Cry"
            // We look for "Cry" or anything similar that isn't "Background" or "Silence"
            const lowercaseLabel = label.toLowerCase();
            // Broader matching: catch anything that isn't 'background' or 'silence' if it's strong enough
            const isCrying = (lowercaseLabel.includes('cry') || lowercaseLabel.includes('baby') || lowercaseLabel.includes('scream')) && 
                             maxScore > 0.15 && 
                             checkCryFrequencies();

            if (isCrying) {
                if (cryTypeEl) {
                    cryTypeEl.textContent = `Crying Detected (${confidence}%)`;
                    cryTypeEl.style.color = '#ff4081';
                }
                
                // snappier UI visual feedback
                if (audioIndicator) {
                    audioIndicator.textContent = "Baby Crying Detected";
                    showIndicator(audioIndicator);
                }
                
                // TRIGGER: Use face to classify the reason/expression (Async)
                detectExpression(true); 
            } else {
                if (cryTypeEl) {
                    if (maxScore > 0.5) {
                        cryTypeEl.textContent = `${label} (${confidence}%)`;
                        cryTypeEl.style.color = 'rgba(255,255,255,0.7)';
                    } else {
                        cryTypeEl.textContent = 'Listening...';
                        cryTypeEl.style.color = 'rgba(255,255,255,0.4)';
                    }
                }
            }
        }, {
            includeSpectrogram: true,
            probabilityThreshold: 0.15, // Lowered from 0.30 to catch low sound
            invokeCallbackOnNoiseAndUnknown: true,
            overlapFactor: 0.75
        });

        micStatus.textContent = 'AI Active';
        micStatus.classList.replace('error', 'success');

    } catch (err) {
        console.error("Teachable Machine Audio Error:", err);
        micStatus.textContent = 'AI Load Error';
        micStatus.classList.replace('success', 'error');
        if (cryTypeEl) cryTypeEl.textContent = 'AI Error: Check console';
    }
}

// --- Live Audio Streaming --- //
function startAudioStreaming(stream) {
    try {
        // Use MediaRecorder to send audio chunks
        // Check for supported types, opus is preferred
        const options = { mimeType: 'audio/webm;codecs=opus' };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) {
            console.warn("Opus not supported, using default");
            delete options.mimeType;
        }

        mediaRecorder = new MediaRecorder(stream, options);
        
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0 && socket.connected) {
                // Convert Blob to ArrayBuffer to send over socket
                event.data.arrayBuffer().then(buffer => {
                    socket.emit('audio_chunk', buffer);
                });
            }
        };

        // Send chunks every 500ms for "live" feel with low latency
        mediaRecorder.start(500);
        console.log("Audio streaming started.");
    } catch (err) {
        console.error("Error starting audio streaming:", err);
    }
}

// --- UI & Event Handling --- //
function showIndicator(element) {
    if (indicatorTimeouts.has(element)) {
        clearTimeout(indicatorTimeouts.get(element));
    }
    element.classList.remove('hidden');
    const timer = setTimeout(() => {
        element.classList.add('hidden');
        indicatorTimeouts.delete(element);
    }, 3000); // 3 seconds for better visibility
    indicatorTimeouts.set(element, timer);
}

function handleEvent(eventType, subType = '') {
    const now = Date.now();

    if (eventType === 'Movement' && (now - lastMotionAlertTime < COOLDOWN_MS)) return;
    if (eventType === 'Baby Cry' && (now - lastAudioAlertTime < COOLDOWN_MS)) return;

    if (eventType === 'Movement') {
        lastMotionAlertTime = now;
        showIndicator(motionIndicator);
    }
    
    if (eventType === 'Baby Cry') {
        lastAudioAlertTime = now;
        if (audioIndicator) {
            audioIndicator.textContent = "Baby Crying Detected";
            showIndicator(audioIndicator);
        }
    }

    const dateObj = new Date();
    const dateStr = dateObj.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-');
    const timeStr = dateObj.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    const alertData = {
        type: eventType,
        subType: subType,
        date: dateStr,
        time: timeStr,
        timestamp: now
    };

    console.log('Sending alert:', alertData);
    socket.emit('baby_alert', alertData);
}

// --- Facial Expression Detection --- //
let faceScanTimeout = null;

async function startFaceScanLoop() {
    if (faceScanTimeout) clearTimeout(faceScanTimeout);
    
    // Scan every 1 second to give user feedback
    await detectExpression(false);
    
    faceScanTimeout = setTimeout(startFaceScanLoop, 1000);
}

async function detectExpression(isCryTrigger = false) {
    if (!modelsLoaded || video.paused || video.ended || isDetectingExpression) return;

    isDetectingExpression = true; // Lock

    const expressionTypeEl = document.getElementById('expression-type');
    const expressionResultCard = document.getElementById('expression-result');
    
    try {
        // High sensitivity: lowered minConfidence to 0.25
        const detections = await faceapi.detectSingleFace(video, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.25 }))
            .withFaceExpressions();

        let reason = "Normal";
        let topExpression = "";

        if (detections) {
            const expressions = detections.expressions;
            topExpression = Object.keys(expressions).reduce((a, b) => expressions[a] > expressions[b] ? a : b);
            
            switch(topExpression) {
                case 'angry': reason = "Hungry / Frustrated"; break;
                case 'sad': reason = "Sleepy / Lonely"; break;
                case 'fearful': reason = "Discomfort / Scared"; break;
                case 'disgusted': reason = "Check Nappy"; break;
                case 'surprised': reason = "Startled"; break;
                case 'happy': reason = "Playing / Calm"; break;
                default: reason = "Crying (Unknown)";
            }

            if (expressionTypeEl) {
                expressionTypeEl.textContent = reason;
                expressionTypeEl.style.color = '#fff';
            }
            
            // Visual feedback: Highlight the card green when face is detected
            if (expressionResultCard) {
                expressionResultCard.style.backgroundColor = 'rgba(76, 175, 80, 0.2)'; // Faint green
                expressionResultCard.style.borderColor = '#4CAF50';
            }
            
            // Send standalone expression broadcast
            socket.emit('expression_alert', { reason: reason, expression: topExpression });
        } else {
            // No face detected in this frame
            if (expressionTypeEl) {
                // If it's just a background scan, don't show "Face Not Seen" if we were just seeing one
                // unless it stays gone.
                if (isCryTrigger) expressionTypeEl.textContent = 'Face Not Seen';
            }
            
            if (expressionResultCard) {
                expressionResultCard.style.backgroundColor = '';
                expressionResultCard.style.borderColor = '';
            }
            
            reason = "Crying (Face not visible)";
        }

        // If this was triggered by a cry sound, send the official alert now
        if (isCryTrigger) {
            handleEvent('Baby Cry', reason);
        }

    } catch (err) {
        console.error("Expression detection error:", err);
    } finally {
        isDetectingExpression = false; // Unlock
    }
}
