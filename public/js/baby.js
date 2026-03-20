const socket = io();

// UI Elements

const video = document.getElementById('baby-video');
const canvas = document.getElementById('video-canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const motionIndicator = document.getElementById('motion-indicator');
const audioIndicator = document.getElementById('audio-indicator');
const camStatus = document.getElementById('cam-status');
const micStatus = document.getElementById('mic-status');
const loginOverlay = document.getElementById('login-overlay');
const accessCodeInput = document.getElementById('access-code');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const logoutBtn = document.getElementById('logout-btn');
const monitorContent = document.getElementById('monitor-content');
const cryTypeEl = document.getElementById('cry-type');

// Configuration
const MOTION_THRESHOLD = 30; // Lowered to be more sensitive to motion
const MOTION_PIXEL_COUNT_THRESHOLD = 2000; // Lowered to require fewer changed pixels
const AUDIO_THRESHOLD = 0.15; // Volume threshold for fallback detection
const COOLDOWN_MS = 2000; // 2 seconds between same-type alerts to make it lively

let lastMotionAlertTime = 0;
let lastAudioAlertTime = 0;
let previousFrame = null;
let animationFrameId = null;
let audioContext = null;

// --- AI Model Loading --- //
async function loadFaceModels() {
    try {
        console.log("Loading face-api models...");
        // Use a reliable CDN for model weights
        const MODEL_URL = 'https://raw.githubusercontent.com/justadudewhohacks/face-api.js/master/weights';
        await Promise.all([
            faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
            faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL)
        ]);
        console.log("Face-api models loaded.");
        if (camStatus) camStatus.textContent = 'Active (Ready)';
    } catch (err) {
        console.error("Failed to load face-api models:", err);
    }
}

// Start monitoring only after login
document.addEventListener('DOMContentLoaded', () => {
    loadFaceModels();
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
        if (monitorContent) monitorContent.classList.remove('hidden');
        startMonitoring();
    } else {
        localStorage.removeItem('baby_monitor_code');
        loginError.classList.remove('hidden');
        loginError.textContent = response.message || 'Invalid Access Code';
    }
});

// --- Media Access & Monitoring --- //
async function startMonitoring() {
    let stream;
    try {
        console.log("Requesting camera and microphone...");
        // Use simpler constraints to increase compatibility
        stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        console.log("Stream received with tracks:", stream.getTracks().map(t => `${t.kind}: ${t.label} (${t.readyState})`));

        camStatus.textContent = 'Active (Stream Received)';
        micStatus.textContent = 'Active (Stream Received)';
        micStatus.classList.remove('error');
        micStatus.classList.add('success');

        startAudioDetection(stream);
    } catch (err) {
        console.warn('Initial media request failed, trying video only...', err);
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: true
            });
            console.log("Video-only stream received:", stream.getVideoTracks()[0]?.label);
            camStatus.textContent = 'Active (Video Only)';
            micStatus.textContent = 'Failed (No Mic)';
            micStatus.classList.replace('success', 'error');
        } catch (videoErr) {
            handleMediaError(videoErr);
            return;
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
        console.log("Video playback started.");
        camStatus.textContent = 'Active (Playing)';
        camStatus.classList.replace('error', 'success');
        detectMotion();
    });

    // Manual play fallback
    video.style.cursor = 'pointer';
    video.title = 'Click to start camera if it does not load';
    video.onclick = () => {
        console.log("Manual play triggered by click.");
        camStatus.textContent = 'Attempting manual play...';
        video.play().then(() => {
            console.log("Manual play success");
        }).catch(err => {
            console.error("Manual play failed:", err);
            handleMediaError(err);
        });
    };
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
            handleEvent('Movement', 'Movement Detected');
            showIndicator(motionIndicator);
        }
    }

    // Save current frame for next comparison
    previousFrame = new Uint8ClampedArray(data);

    // Broadcast video frame over Socket.IO
    socket.emit('video_frame', canvas.toDataURL('image/jpeg', 0.4));

    // Throttle next frame to ~5-10 FPS for bandwidth and allow running in background
    setTimeout(() => {
        detectMotion();
    }, 150);
}

// --- AI Audio (Cry) Detection --- //
// URL TO YOUR TEACHABLE MACHINE MODEL
const URL = "https://teachablemachine.withgoogle.com/models/NSw1kr-Re/";

async function createModel() {
    const checkpointURL = URL + "model.json";
    const metadataURL = URL + "metadata.json";

    const recognizer = speechCommands.create(
        "BROWSER_FFT",
        undefined,
        checkpointURL,
        metadataURL
    );

    await recognizer.ensureModelLoaded();
    return recognizer;
}

async function startAudioDetection(stream) {
    // If the user hasn't put in a real AI model yet, fallback to the custom basic frequency detection
    if (URL === "https://teachablemachine.withgoogle.com/models/YOUR_MODEL_LINK_HERE/") {
        console.warn("AI Model not trained. Using fallback legacy frequency detection. Please paste your Teachable Machine URL in baby.js.");
        startFallbackAudioDetection(stream);
        return;
    }

    try {
        const recognizer = await createModel();
        const classLabels = recognizer.wordLabels();

        // Volume Gate: Add Analyser to check volume level along with AI confidence
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 1024; // Higher resolution for frequency analysis
        source.connect(analyser);
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        const binSize = (audioCtx.sampleRate / 2) / analyser.frequencyBinCount;

        // Add a real-time prediction viewer on the screen for debugging
        const controlsCard = document.querySelector('.controls-card .status-grid');
        if (controlsCard) {
            controlsCard.innerHTML += `
            <div class="status-item">
                <span class="label">AI is hearing:</span>
                <span id="ai-prediction" class="value" style="color:var(--primary-color)">Listening...</span>
            </div>`;
        }

        recognizer.listen(result => {
            const scores = result.scores;

            // Check current volume and frequency distribution
            analyser.getByteFrequencyData(dataArray);
            let speechEnergy = 0; // 100Hz - 400Hz
            let cryEnergy = 0;    // 600Hz - 2000Hz
            let peakVol = 0;
            let sum = 0;

            for (let i = 0; i < dataArray.length; i++) {
                const freq = i * binSize;
                const val = dataArray[i];
                sum += val;
                if (val > peakVol) peakVol = val;
                if (freq >= 100 && freq <= 400) speechEnergy += val;
                else if (freq >= 600 && freq <= 2000) cryEnergy += val;
            }
            
            const avgVol = sum / dataArray.length;
            const cryRatio = speechEnergy > 0 ? (cryEnergy / speechEnergy).toFixed(1) : "0";

            let maxScore = 0;
            let maxClass = "";
            for (let i = 0; i < classLabels.length; i++) {
                if (scores[i] > maxScore) {
                    maxScore = scores[i];
                    maxClass = classLabels[i];
                }
            }

            const predictionEl = document.getElementById('ai-prediction');
            if (predictionEl) {
                // Show Peak instead of Average for better user calibration
                predictionEl.textContent = `${maxClass} (${Math.round(maxScore * 100)}%) | Peak: ${peakVol} | C/S Ratio: ${cryRatio}`;
            }

            // The model has classes like "Background Noise", "Burp", "Discomfort", "hungry", "pain", "sleepy"
            // We ONLY want to trigger on actual baby cries, which in your model are "hungry", "pain", and "sleepy"
            const cryClasses = ["hungry", "pain", "sleepy", "cry", "baby cry"];
            const detectedClass = maxClass.toLowerCase().trim();

            // Handle as 'Baby Cry' with Advanced Filtering:
            // 1. Must be a cry class
            // 2. High confidence (> 0.95 - set in recognizer options)
            // 3. Significant Peak (peakVol > 150)
            // 4. Frequency Check: Cry Energy must be significantly higher than Speech Energy (ratio > 1.6)
            if (cryClasses.includes(detectedClass) && maxScore > 0.95 && peakVol > 150 && parseFloat(cryRatio) > 1.6) {
                // Determine if it was a cry or just noise
                const isActualCry = (detectedClass === 'hungry' || detectedClass === 'pain' || detectedClass === 'sleepy' || detectedClass === 'cry' || detectedClass === 'baby cry');

                if (isActualCry) {
                    handleEvent('Baby Cry', maxClass);
                    showIndicator(audioIndicator);

                    if (cryTypeEl) {
                        cryTypeEl.textContent = `AI Detected: ${maxClass}`;
                    }
                    
                    // Trigger Facial Analysis to find out WHY the baby is crying
                    startFacialBurst();
                }
            }
        }, {
            includeSpectrogram: false,
            probabilityThreshold: 0.95, // Increased threshold for maximum confidence
            invokeCallbackOnNoiseAndUnknown: true,
            overlapFactor: 0.50 // How often to sample (0.50 is half a second)
        });

    } catch (e) {
        console.error("AI Model failed to load:", e);
        startFallbackAudioDetection(stream);
    }
}

// Fallback logic until an AI model is properly trained & linked above
function startFallbackAudioDetection(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();

    analyser.fftSize = 1024;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const sampleRate = audioContext.sampleRate;
    const binSize = (sampleRate / 2) / bufferLength;

    function checkVolume() {
        analyser.getByteFrequencyData(dataArray);

        let peakCry = 0;
        let cryEnergy = 0;
        let speechEnergy = 0;
        let cryBins = 0;
        let speechBins = 0;

        for (let i = 0; i < bufferLength; i++) {
            const freq = i * binSize;
            const value = dataArray[i];
            
            if (value > peakCry) peakCry = value; // Track the peak volume

            if (freq >= 85 && freq <= 350) {
                speechEnergy += value;
                speechBins++;
            } else if (freq >= 500 && freq <= 2000) {
                cryEnergy += value;
                cryBins++;
            }
        }

        const avgSpeech = speechBins > 0 ? speechEnergy / speechBins : 0;
        const avgCry = cryBins > 0 ? cryEnergy / cryBins : 0;

        // Use Peak for much stricter suppression of noise
        const minimumPeakValue = 200;

        // Simply trigger for a baby cry (no sub-types anymore!)
        if (peakCry > minimumPeakValue && avgCry > avgSpeech * 1.5) {
            handleEvent('Baby Cry', 'Cry Detected');
            showIndicator(audioIndicator);
            if (cryTypeEl) {
                cryTypeEl.textContent = `Cry Detected`;
            }
            
            // Trigger Facial Analysis to find out WHY the baby is crying
            startFacialBurst();
        }

        setTimeout(checkVolume, 250);
    }

    checkVolume();
}

// --- Facial Analysis Burst --- //
let isAnalyzingFace = false;

async function startFacialBurst() {
    if (isAnalyzingFace) return;
    isAnalyzingFace = true;
    
    const expressionTypeEl = document.getElementById('expression-type');
    const expressionStatusEl = document.getElementById('expression-status');
    
    if (expressionTypeEl) expressionTypeEl.textContent = "Analyzing Face...";
    if (expressionStatusEl) {
        expressionStatusEl.textContent = "Reasoning...";
        expressionStatusEl.classList.remove('hidden');
    }

    console.log("Starting 3s facial analysis burst...");
    const results = [];
    const endTime = Date.now() + 3000;

    while (Date.now() < endTime) {
        // Detect expression
        try {
            const detection = await faceapi.detectSingleFace(video, new faceapi.TinyFaceDetectorOptions())
                .withFaceExpressions();
                
            if (detection) {
                results.push(detection.expressions);
            }
        } catch (e) {
            console.error("Analysis frame error:", e);
        }
        await new Promise(r => setTimeout(r, 250)); // Sample every 250ms
    }

    finalizeBurst(results);
}

function finalizeBurst(results) {
    isAnalyzingFace = false;
    const expressionTypeEl = document.getElementById('expression-type');
    const expressionStatusEl = document.getElementById('expression-status');

    if (results.length === 0) {
        if (expressionTypeEl) expressionTypeEl.textContent = "Face Not Clear";
        if (expressionStatusEl) expressionStatusEl.textContent = "...";
        return;
    }

    // Accumulate scores
    const totals = { happy:0, sad:0, fearful:0, angry:0, neutral:0, disgusted:0, surprised:0 };
    results.forEach(res => {
        Object.keys(totals).forEach(key => {
            if (res[key]) totals[key] += res[key];
        });
    });

    // Find dominant
    const dominant = Object.entries(totals).reduce((a, b) => a[1] > b[1] ? a : b)[0];
    
    // Map to reasons
    let reason = "Undetermined";
    if (['sad', 'fearful', 'angry'].includes(dominant)) reason = "Hungry / Discomfort";
    else if (['neutral', 'disgusted', 'surprised'].includes(dominant)) reason = "Sleepy / Bored";
    else if (dominant === 'happy') reason = "Just Playful";

    console.log("Dominant Expression:", dominant, "->", reason);
    
    if (expressionTypeEl) expressionTypeEl.textContent = reason;
    if (expressionStatusEl) {
        expressionStatusEl.textContent = reason;
        setTimeout(() => { if (expressionStatusEl) expressionStatusEl.classList.add('hidden'); }, 5000);
    }

    // Send to mother
    socket.emit('expression_alert', { reason: reason, type: dominant });
}

// --- UI & Event Handling --- //
function showIndicator(element) {
    element.classList.remove('hidden');
    // Hide after 2 seconds
    setTimeout(() => {
        element.classList.add('hidden');
    }, 2000);
}

function handleEvent(eventType, subType = '') {
    const now = Date.now();

    // Check cooldowns to avoid spam
    if (eventType === 'Movement' && (now - lastMotionAlertTime < COOLDOWN_MS)) return;
    if (eventType === 'Baby Cry' && (now - lastAudioAlertTime < COOLDOWN_MS)) return;

    if (eventType === 'Movement') lastMotionAlertTime = now;
    if (eventType === 'Baby Cry') lastAudioAlertTime = now;

    // Format date and time
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
