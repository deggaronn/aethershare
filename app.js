/* ==========================================================================
   AetherShare Core Application Logic
   ========================================================================== */

// --- Global Constants & Configurations ---
const CHUNK_SIZE = 64 * 1024; // 64 KB chunks
const WINDOW_SIZE = 16;      // Maximum in-flight chunks (1 MB total buffer window)

// --- State Variables ---
let myPeerId = null;
let peer = null;
let currentConnection = null;
let activeFile = null;
let transferRole = null; // 'sender' | 'receiver'

// Transfer Progress Tracking
let transferStartTime = 0;
let bytesTransferred = 0;
let totalBytesToTransfer = 0;
let transferInterval = null;
let speedHistory = [];

// Sliding Window Flow Control
let nextChunkIndex = 0;
let ackedChunkIndex = 0;
let isTransferring = false;
let fileReader = null;

// File Saving Streams
let fileWritableStream = null; // For FileSystem Access API
let swMessagePort = null;      // For Service Worker streaming
let receivedChunksBuffer = []; // Memory fallback
let isSavingToDisk = false;

// --- Manual Connection (Serverless WebRTC Fallback) ---
let localPC = null;
let manualChannel = null;

// --- DOM Elements ---
const elStatusText = document.getElementById('status-text');
const elConnectionStatus = document.getElementById('connection-status');

// Panels
const secDashboard = document.getElementById('dashboard-section');
const secShare = document.getElementById('share-section');
const secReceive = document.getElementById('receive-section');
const secTransfer = document.getElementById('transfer-section');
const secManualModal = document.getElementById('manual-modal-section');

// Dropzone & File Elements
const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const fileInfoContainer = document.getElementById('file-info-container');
const elFileName = document.getElementById('file-name');
const elFileSize = document.getElementById('file-size');
const btnRemoveFile = document.getElementById('remove-file-btn');
const btnInitiateTransfer = document.getElementById('initiate-transfer-btn');

// Share Panel
const elShareUrlInput = document.getElementById('share-url-input');
const btnCopyUrl = document.getElementById('copy-url-btn');
const elQrCode = document.getElementById('qrcode');
const btnManualConnection = document.getElementById('manual-connection-btn');
const btnBackToDash = document.getElementById('back-to-dash-btn');

// Receive Panel
const elIncomingFileName = document.getElementById('incoming-file-name');
const elIncomingFileSize = document.getElementById('incoming-file-size');
const btnAcceptTransfer = document.getElementById('accept-transfer-btn');
const btnRejectTransfer = document.getElementById('reject-transfer-btn');
const elSafariWarning = document.getElementById('safari-warning');

// Transfer Panel
const elTransferDirectionTitle = document.getElementById('transfer-direction-title');
const elTransferFileTitle = document.getElementById('transfer-file-title');
const elTransferModeBadge = document.getElementById('transfer-mode-badge');
const elProgressRingBar = document.getElementById('progress-ring-bar');
const elProgressPercentage = document.getElementById('progress-percentage');
const elTransferSpeed = document.getElementById('transfer-speed');
const elStatEta = document.getElementById('stat-eta');
const elStatTransferred = document.getElementById('stat-transferred');
const elStatElapsed = document.getElementById('stat-elapsed');
const elStatNetwork = document.getElementById('stat-network');
const elBufferIndicatorDot = document.getElementById('buffer-indicator-dot');
const elBufferStatusText = document.getElementById('buffer-status-text');
const btnCancelTransfer = document.getElementById('cancel-transfer-btn');

// Manual Panel
const txtLocalSdp = document.getElementById('manual-local-sdp');
const txtRemoteSdp = document.getElementById('manual-remote-sdp');
const btnCopyLocalSdp = document.getElementById('copy-local-sdp-btn');
const btnConnectRemoteSdp = document.getElementById('connect-remote-sdp-btn');
const btnCloseManual = document.getElementById('close-manual-btn');

// --- Initialization ---
window.addEventListener('DOMContentLoaded', () => {
  // Lucide icon replacement
  lucide.createIcons();
  
  // Register Service Worker for Firefox/Safari Streaming Download Fallback
  registerServiceWorker();
  
  // Check browser capabilities
  checkBrowserCapabilities();

  // Setup Event Listeners
  setupEventListeners();
  
  // Check URL Hash to see if we are joining a room as receiver
  checkUrlHash();
});

// --- Register Service Worker ---
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => {
        console.log('AetherShare Service Worker registered successfully:', reg.scope);
      })
      .catch(err => {
        console.error('AetherShare Service Worker registration failed:', err);
      });
  }
}

// --- Browser Compatibility Check ---
function checkBrowserCapabilities() {
  const isChromium = !!window.showSaveFilePicker;
  if (!isChromium) {
    // Show Safari/Firefox warning warning box
    elSafariWarning.classList.remove('hidden');
  }
}

// --- Check URL Hash ---
function checkUrlHash() {
  const hash = window.location.hash;
  if (hash && hash.startsWith('#/receive/')) {
    const roomId = hash.replace('#/receive/', '');
    if (roomId) {
      transferRole = 'receiver';
      initializeReceiverPeer(roomId);
    }
  } else {
    // We are sender/initiator, prepare network connection
    initializeSenderPeer();
  }
}

// --- Initialize PeerJS (Sender Mode) ---
function initializeSenderPeer() {
  updateConnectionStatus('connecting', 'Connecting to Aether network...');
  
  // Generate a random, collisions-free room ID
  const randId = `aethershare-${Math.random().toString(36).substring(2, 9)}-${Math.random().toString(36).substring(2, 9)}`;
  
  peer = new Peer(randId, {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    debug: 1 // Only errors
  });

  peer.on('open', (id) => {
    myPeerId = id;
    updateConnectionStatus('connected', 'Connected. Ready to share.');
  });

  peer.on('connection', (conn) => {
    // Accept connection from receiver
    if (currentConnection) {
      conn.close(); // Only support 1-to-1 transfer at a time
      return;
    }
    
    currentConnection = conn;
    setupConnectionListeners(conn);
  });

  peer.on('error', (err) => {
    console.error('PeerJS error:', err);
    updateConnectionStatus('disconnected', 'Network connection error.');
  });
}

// --- Initialize PeerJS (Receiver Mode) ---
function initializeReceiverPeer(roomId) {
  updateConnectionStatus('connecting', 'Connecting to Aether network...');
  
  // Generate random receiver ID
  const receiverId = `aethershare-rcv-${Math.random().toString(36).substring(2, 9)}`;
  
  peer = new Peer(receiverId, {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    debug: 1
  });

  peer.on('open', () => {
    updateConnectionStatus('connecting', 'Connecting to sender...');
    
    // Connect to sender's room
    const conn = peer.connect(roomId, {
      reliable: true
    });
    
    currentConnection = conn;
    setupConnectionListeners(conn);
  });

  peer.on('error', (err) => {
    console.error('Receiver PeerJS error:', err);
    updateConnectionStatus('disconnected', 'Failed to connect to sender.');
  });
}

// --- Update Top Connection Badge ---
function updateConnectionStatus(state, text) {
  elConnectionStatus.className = `status-badge status-${state}`;
  elStatusText.textContent = text;
}

// --- Event Listeners Setup ---
function setupEventListeners() {
  // Drag & drop logic
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    }, false);
  });

  dropZone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      handleFileSelected(files[0]);
    }
  });

  fileInput.addEventListener('change', (e) => {
    if (fileInput.files.length > 0) {
      handleFileSelected(fileInput.files[0]);
    }
  });

  btnRemoveFile.addEventListener('click', (e) => {
    e.stopPropagation();
    removeActiveFile();
  });

  btnInitiateTransfer.addEventListener('click', () => {
    if (activeFile) {
      startSharingMode();
    }
  });

  btnCopyUrl.addEventListener('click', () => {
    navigator.clipboard.writeText(elShareUrlInput.value)
      .then(() => {
        btnCopyUrl.innerHTML = '<i data-lucide="check" class="btn-icon-left"></i> Copied!';
        lucide.createIcons();
        setTimeout(() => {
          btnCopyUrl.innerHTML = '<i data-lucide="copy" class="btn-icon-left"></i> Copy';
          lucide.createIcons();
        }, 2000);
      });
  });

  btnBackToDash.addEventListener('click', () => {
    resetToDashboard();
  });

  // Receiver buttons
  btnAcceptTransfer.addEventListener('click', async () => {
    await acceptIncomingTransfer();
  });

  btnRejectTransfer.addEventListener('click', () => {
    rejectIncomingTransfer();
  });

  btnCancelTransfer.addEventListener('click', () => {
    cancelActiveTransfer();
  });

  // Manual configuration buttons
  btnManualConnection.addEventListener('click', () => {
    showManualSignaling();
  });

  btnCloseManual.addEventListener('click', () => {
    hideManualSignaling();
  });

  btnCopyLocalSdp.addEventListener('click', () => {
    navigator.clipboard.writeText(txtLocalSdp.value)
      .then(() => {
        btnCopyLocalSdp.textContent = 'Copied!';
        setTimeout(() => { btnCopyLocalSdp.textContent = 'Copy Local Code'; }, 2000);
      });
  });

  btnConnectRemoteSdp.addEventListener('click', () => {
    connectManualRemote();
  });
}

// --- Handler: File Selection ---
function handleFileSelected(file) {
  activeFile = file;
  elFileName.textContent = file.name;
  elFileSize.textContent = formatBytes(file.size);
  
  dropZone.classList.add('hidden');
  fileInfoContainer.classList.remove('hidden');
}

function removeActiveFile() {
  activeFile = null;
  fileInput.value = '';
  dropZone.classList.remove('hidden');
  fileInfoContainer.classList.add('hidden');
}

// --- Switch to Share Mode & Show Details ---
function startSharingMode() {
  if (!myPeerId) {
    alert('Still connecting to the network. Please wait a moment...');
    return;
  }
  
  transferRole = 'sender';
  
  // Set sharing URLs
  const shareUrl = `${window.location.origin}${window.location.pathname}#/receive/${myPeerId}`;
  elShareUrlInput.value = shareUrl;
  
  // Generate QR Code
  elQrCode.innerHTML = '';
  new QRCode(elQrCode, {
    text: shareUrl,
    width: 150,
    height: 150,
    colorDark: '#0b0c10',
    colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });
  
  switchPanel(secShare);
}

// --- Setup Peer Connection Listeners ---
function setupConnectionListeners(conn) {
  const handleOpen = () => {
    updateConnectionStatus('connected', 'Peer connected.');
    if (transferRole === 'sender') {
      // Send file metadata
      conn.send({
        type: 'meta',
        name: activeFile.name,
        size: activeFile.size
      });
    }
  };

  if (conn.open) {
    handleOpen();
  } else {
    conn.on('open', handleOpen);
  }

  conn.on('data', async (data) => {
    // If receiving raw array buffer chunks
    if (data instanceof ArrayBuffer || (data.buffer && data.buffer instanceof ArrayBuffer)) {
      const buffer = data.buffer || data;
      await handleIncomingChunk(buffer);
      return;
    }

    // Otherwise, parse control JSON message
    switch (data.type) {
      case 'meta':
        // Receiver panel gets meta
        totalBytesToTransfer = data.size;
        elIncomingFileName.textContent = data.name;
        elIncomingFileSize.textContent = formatBytes(data.size);
        
        // Save details temporarily
        activeFile = { name: data.name, size: data.size };
        switchPanel(secReceive);
        break;
        
      case 'accept':
        // Receiver accepted, sender starts transmitting
        if (transferRole === 'sender') {
          startFileTransmission();
        }
        break;
        
      case 'reject':
        alert('The receiver rejected the transfer.');
        resetToDashboard();
        break;
        
      case 'ack':
        // Handle sliding window ACK from receiver
        handleChunkAck(data.index);
        break;
        
      case 'cancel':
        alert('The other peer cancelled the transfer.');
        resetToDashboard();
        break;
    }
  });

  conn.on('close', () => {
    if (isTransferring) {
      alert('Connection lost. Transfer interrupted.');
    }
    resetToDashboard();
  });

  conn.on('error', (err) => {
    console.error('Connection error:', err);
    resetToDashboard();
  });
}

// --- Receiver: Accept File ---
async function acceptIncomingTransfer() {
  if (!activeFile) return;
  
  totalBytesToTransfer = activeFile.size;
  bytesTransferred = 0;
  isSavingToDisk = false;
  
  // 1. Setup Storage Target
  const supportsFileSystemAccess = !!window.showSaveFilePicker;
  
  if (supportsFileSystemAccess) {
    try {
      updateConnectionStatus('connected', 'Selecting file download location...');
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: activeFile.name,
      });
      fileWritableStream = await fileHandle.createWritable();
      isSavingToDisk = true;
    } catch (err) {
      console.warn('File save picker cancelled, falling back to service worker:', err);
      // Fall through to Service Worker streaming
    }
  }
  
  if (!isSavingToDisk) {
    // Fallback option 1: Service Worker streaming (Firefox, Safari)
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      try {
        const transferId = `ts-${Math.random().toString(36).substring(2, 9)}`;
        const swChannel = new MessageChannel();
        
        swMessagePort = swChannel.port1;
        
        // Link port with SW
        navigator.serviceWorker.controller.postMessage({
          type: 'PORT',
          transferId: transferId
        }, [swChannel.port2]);
        
        // Listen for cancel from SW
        swMessagePort.onmessage = (e) => {
          if (e.data.type === 'cancelled') {
            cancelActiveTransfer();
          }
        };
        
        // Start streaming handshake
        swMessagePort.postMessage({
          type: 'start',
          filename: activeFile.name,
          size: activeFile.size
        });
        
        // Open download trigger
        const downloadUrl = `download-stream?id=${transferId}`;
        const downloadLink = document.createElement('a');
        downloadLink.href = downloadUrl;
        downloadLink.download = activeFile.name;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        
        isSavingToDisk = true;
      } catch (err) {
        console.error('SW Streaming initiation failed:', err);
      }
    }
  }
  
  if (!isSavingToDisk) {
    // Fallback option 2: Memory buffer (dangerous for > 500MB)
    if (activeFile.size > 500 * 1024 * 1024) {
      const confirmProceed = confirm("WARNING: Your browser doesn't support streaming direct to disk. Downloading a file of this size in RAM might crash your browser tab. Do you want to proceed anyway?");
      if (!confirmProceed) {
        rejectIncomingTransfer();
        return;
      }
    }
    receivedChunksBuffer = [];
  }
  
  // 2. Alert Sender to start transmission
  currentConnection.send({ type: 'accept' });
  
  // 3. Show Transfer Screen
  elTransferDirectionTitle.textContent = 'Receiving File...';
  elTransferFileTitle.textContent = activeFile.name;
  elTransferModeBadge.textContent = 'P2P Stream';
  switchPanel(secTransfer);
  
  startStatsMonitor();
}

// --- Receiver: Reject File ---
function rejectIncomingTransfer() {
  if (currentConnection) {
    currentConnection.send({ type: 'reject' });
  }
  resetToDashboard();
}

// --- Receiver: Handle Inbound Binary Chunk ---
async function handleIncomingChunk(buffer) {
  if (!isTransferring) {
    isTransferring = true;
    transferStartTime = Date.now();
  }
  
  // Parse binary header: first 4 bytes = Int32 chunkIndex
  const view = new DataView(buffer);
  const chunkIndex = view.getInt32(0, true);
  const chunkData = new Uint8Array(buffer, 4);
  
  // Write data to target stream
  if (fileWritableStream) {
    // Direct-to-Disk (Chromium)
    await fileWritableStream.write(chunkData);
  } else if (swMessagePort) {
    // Service Worker Streaming (Firefox/Safari)
    swMessagePort.postMessage({
      type: 'chunk',
      chunk: chunkData,
      index: chunkIndex
    });
  } else {
    // Memory Buffer Fallback
    receivedChunksBuffer.push(chunkData);
  }
  
  bytesTransferred += chunkData.length;
  updateTransferProgress();
  
  // Send ACK back immediately to sender
  if (currentConnection) {
    currentConnection.send({
      type: 'ack',
      index: chunkIndex
    });
  }
  
  // Check if complete
  if (bytesTransferred >= totalBytesToTransfer) {
    await completeIncomingTransfer();
  }
}

// --- Receiver: Save File Complete ---
async function completeIncomingTransfer() {
  isTransferring = false;
  clearInterval(transferInterval);
  
  if (fileWritableStream) {
    await fileWritableStream.close();
    fileWritableStream = null;
  } else if (swMessagePort) {
    swMessagePort.postMessage({ type: 'end' });
    swMessagePort = null;
  } else if (receivedChunksBuffer.length > 0) {
    // Build blob and trigger manual save
    const fileBlob = new Blob(receivedChunksBuffer, { type: 'application/octet-stream' });
    const downloadUrl = URL.createObjectURL(fileBlob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = activeFile.name;
    a.click();
    URL.revokeObjectURL(downloadUrl);
    receivedChunksBuffer = [];
  }
  
  alert('File transfer completed successfully!');
  resetToDashboard();
}

// --- Sender: Initiate File Transmission Loop ---
function startFileTransmission() {
  if (!activeFile) return;
  
  totalBytesToTransfer = activeFile.size;
  bytesTransferred = 0;
  nextChunkIndex = 0;
  ackedChunkIndex = 0;
  isTransferring = true;
  transferStartTime = Date.now();
  
  // Show progress page
  elTransferDirectionTitle.textContent = 'Sending File...';
  elTransferFileTitle.textContent = activeFile.name;
  elTransferModeBadge.textContent = 'P2P Stream';
  switchPanel(secTransfer);
  
  startStatsMonitor();
  
  // Start the chunking reader
  fileReader = new FileReader();
  
  // Pump the first window of chunks
  sendNextChunkWindow();
}

// --- Sender: Slide Window & Push Chunks ---
function sendNextChunkWindow() {
  if (!isTransferring) return;
  
  // Send chunks as long as they fit within the sliding window
  while (nextChunkIndex - ackedChunkIndex < WINDOW_SIZE) {
    const offset = nextChunkIndex * CHUNK_SIZE;
    
    if (offset >= activeFile.size) {
      // Reached End of File
      break;
    }
    
    const sliceSize = Math.min(CHUNK_SIZE, activeFile.size - offset);
    const fileSlice = activeFile.slice(offset, offset + sliceSize);
    
    // Read the slice into memory
    const currentIdx = nextChunkIndex;
    nextChunkIndex++;
    
    const sliceReader = new FileReader();
    sliceReader.onload = (e) => {
      if (!isTransferring) return;
      
      const chunkBuffer = e.target.result;
      
      // Pack header (4-byte Int32 chunk index) + chunk data
      const packet = new Uint8Array(4 + chunkBuffer.byteLength);
      const packetView = new DataView(packet.buffer);
      packetView.setInt32(0, currentIdx, true);
      packet.set(new Uint8Array(chunkBuffer), 4);
      
      try {
        // Send raw binary packet
        currentConnection.send(packet.buffer);
        bytesTransferred += chunkBuffer.byteLength;
        updateTransferProgress();
      } catch (err) {
        console.error('Data channel send failed:', err);
        cancelActiveTransfer();
      }
    };
    
    sliceReader.readAsArrayBuffer(fileSlice);
  }
  
  // Diagnosing backpressure state in the UI
  if (nextChunkIndex - ackedChunkIndex >= WINDOW_SIZE) {
    elBufferIndicatorDot.className = 'buffer-dot yellow';
    elBufferStatusText.textContent = 'Waiting for network buffer clearance...';
  } else {
    elBufferIndicatorDot.className = 'buffer-dot green';
    elBufferStatusText.textContent = 'Streaming data smoothly';
  }
}

// --- Sender: Handle Receiver Chunk ACK ---
function handleChunkAck(ackIndex) {
  if (!isTransferring) return;
  
  // Update ack pointer
  ackedChunkIndex = Math.max(ackedChunkIndex, ackIndex + 1);
  
  // Check if complete
  if (ackedChunkIndex * CHUNK_SIZE >= activeFile.size) {
    isTransferring = false;
    clearInterval(transferInterval);
    setTimeout(() => {
      alert('File sent successfully!');
      resetToDashboard();
    }, 500);
    return;
  }
  
  // Resume window pumping
  sendNextChunkWindow();
}

// --- Stats Monitoring (Speed, ETA, Clock) ---
function startStatsMonitor() {
  speedHistory = [];
  let lastBytes = 0;
  
  transferInterval = setInterval(() => {
    if (!isTransferring) return;
    
    const elapsedMs = Date.now() - transferStartTime;
    
    // Calculate Speed in bytes/sec
    const currentTransferred = bytesTransferred;
    const deltaBytes = currentTransferred - lastBytes;
    lastBytes = currentTransferred;
    
    speedHistory.push(deltaBytes);
    if (speedHistory.length > 5) speedHistory.shift(); // 5-second moving average
    
    const avgSpeed = speedHistory.reduce((a, b) => a + b, 0) / speedHistory.length;
    
    // Render stats
    elTransferSpeed.textContent = `${(avgSpeed / (1024 * 1024)).toFixed(1)} MB/s`;
    
    // ETA calculation
    const remainingBytes = totalBytesToTransfer - currentTransferred;
    if (avgSpeed > 0) {
      const etaSeconds = Math.ceil(remainingBytes / avgSpeed);
      elStatEta.textContent = formatTime(etaSeconds);
    } else {
      elStatEta.textContent = 'Calculating...';
    }
    
    // Elapsed time
    elStatElapsed.textContent = formatTime(Math.floor(elapsedMs / 1000));
    
    // Transferred status string
    elStatTransferred.textContent = `${formatBytes(currentTransferred)} / ${formatBytes(totalBytesToTransfer)}`;
    
  }, 1000);
}

// --- Update Progress Animations ---
function updateTransferProgress() {
  const percent = Math.min(100, Math.floor((bytesTransferred / totalBytesToTransfer) * 100)) || 0;
  elProgressPercentage.textContent = `${percent}%`;
  
  // Update SVG Circle Progress Ring
  // Circumference = 2 * PI * r = 2 * 3.14159 * 85 = 534
  const circumference = 534;
  const offset = circumference - (percent / 100) * circumference;
  elProgressRingBar.style.strokeDashoffset = offset;
}

// --- Cancel Active Transfer ---
function cancelActiveTransfer() {
  if (currentConnection) {
    currentConnection.send({ type: 'cancel' });
    currentConnection.close();
  }
  resetToDashboard();
}

// --- Reset to Clean Dashboard State ---
function resetToDashboard() {
  isTransferring = false;
  clearInterval(transferInterval);
  
  if (fileWritableStream) {
    fileWritableStream.close().catch(() => {});
    fileWritableStream = null;
  }
  if (swMessagePort) {
    swMessagePort.postMessage({ type: 'error', error: 'Cancelled' });
    swMessagePort = null;
  }
  
  activeFile = null;
  currentConnection = null;
  bytesTransferred = 0;
  totalBytesToTransfer = 0;
  receivedChunksBuffer = [];
  
  // Clear file input
  fileInput.value = '';
  
  // Remove hash
  window.location.hash = '';
  
  // Reset elements
  dropZone.classList.remove('hidden');
  fileInfoContainer.classList.add('hidden');
  elProgressRingBar.style.strokeDashoffset = '534';
  elProgressPercentage.textContent = '0%';
  elTransferSpeed.textContent = '0.0 MB/s';
  
  // Re-init Peer as sender
  if (peer) {
    peer.destroy();
  }
  initializeSenderPeer();
  
  switchPanel(secDashboard);
}

// --- Panel Transition Helper ---
function switchPanel(targetPanel) {
  const panels = [secDashboard, secShare, secReceive, secTransfer, secManualModal];
  
  panels.forEach(panel => {
    panel.classList.remove('active');
    panel.classList.add('hidden');
  });
  
  targetPanel.classList.remove('hidden');
  // Trigger reflow for transition
  void targetPanel.offsetWidth;
  targetPanel.classList.add('active');
}

// --- Utility Functions ---
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatTime(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  return [
    hours > 0 ? String(hours).padStart(2, '0') : null,
    String(minutes).padStart(2, '0'),
    String(seconds).padStart(2, '0')
  ].filter(Boolean).join(':');
}


// ==========================================================================
// --- Serverless / Manual WebRTC Signaling ---
// ==========================================================================

function showManualSignaling() {
  switchPanel(secManualModal);
  
  // Create raw peer connection
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
  };
  
  localPC = new RTCPeerConnection(configuration);
  
  if (transferRole === 'sender') {
    // Create connection data channel
    manualChannel = localPC.createDataChannel("file-transfer");
    setupManualChannelListeners(manualChannel);
    
    // Create WebRTC Offer
    localPC.createOffer()
      .then(offer => localPC.setLocalDescription(offer))
      .then(() => {
        txtLocalSdp.value = 'Gathering ICE candidates... please wait...';
      });
  } else {
    // Receiver mode: Wait for remote offer to set up answers
    localPC.ondatachannel = (event) => {
      manualChannel = event.channel;
      setupManualChannelListeners(manualChannel);
    };
  }
  
  // Gather ICE candidates and compile them into SDP text
  localPC.onicecandidate = (event) => {
    if (event.candidate === null) {
      // Completed gathering, set output textarea
      txtLocalSdp.value = btoa(JSON.stringify(localPC.localDescription));
    }
  };
  
  localPC.onconnectionstatechange = () => {
    if (localPC.connectionState === 'connected') {
      updateConnectionStatus('connected', 'Manual Peer Connected!');
      hideManualSignaling();
    }
  };
}

function hideManualSignaling() {
  if (transferRole === 'sender') {
    switchPanel(secShare);
  } else {
    switchPanel(secReceive);
  }
}

async function connectManualRemote() {
  const remoteSdpBase64 = txtRemoteSdp.value.trim();
  if (!remoteSdpBase64) {
    alert('Please paste the remote session code.');
    return;
  }
  
  try {
    const remoteDesc = JSON.parse(atob(remoteSdpBase64));
    await localPC.setRemoteDescription(new RTCSessionDescription(remoteDesc));
    
    if (transferRole === 'receiver') {
      // Create WebRTC Answer
      const answer = await localPC.createAnswer();
      await localPC.setLocalDescription(answer);
      // Display answer code in local description box for sender to copy
      txtLocalSdp.value = btoa(JSON.stringify(localPC.localDescription));
    }
  } catch (err) {
    console.error('Failed to connect manual WebRTC:', err);
    alert('Invalid remote connection code. Please verify and try again.');
  }
}

function setupManualChannelListeners(channel) {
  // Wrap raw RTCDataChannel to match PeerJS API for transparency
  const mockConn = {
    send: (data) => channel.send(data),
    close: () => channel.close()
  };
  
  const handleOpen = () => {
    currentConnection = mockConn;
    if (transferRole === 'sender') {
      mockConn.send(JSON.stringify({
        type: 'meta',
        name: activeFile.name,
        size: activeFile.size
      }));
    }
  };

  if (channel.readyState === 'open') {
    handleOpen();
  } else {
    channel.onopen = handleOpen;
  }
  
  channel.onmessage = async (event) => {
    const data = event.data;
    
    if (data instanceof ArrayBuffer) {
      await handleIncomingChunk(data);
      return;
    }
    
    // Check if it's JSON control text
    try {
      const parsed = JSON.parse(data);
      
      switch (parsed.type) {
        case 'meta':
          totalBytesToTransfer = parsed.size;
          elIncomingFileName.textContent = parsed.name;
          elIncomingFileSize.textContent = formatBytes(parsed.size);
          activeFile = { name: parsed.name, size: parsed.size };
          switchPanel(secReceive);
          break;
          
        case 'accept':
          if (transferRole === 'sender') {
            startFileTransmission();
          }
          break;
          
        case 'reject':
          alert('Receiver rejected the transfer.');
          resetToDashboard();
          break;
          
        case 'ack':
          handleChunkAck(parsed.index);
          break;
          
        case 'cancel':
          alert('Transfer cancelled.');
          resetToDashboard();
          break;
      }
    } catch (err) {
      // Not a valid JSON control packet
    }
  };
  
  channel.onclose = () => {
    resetToDashboard();
  };
}
