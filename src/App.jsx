import React, { useEffect, useState, useRef, useMemo } from 'react';
import io from 'socket.io-client';

import Visualizer from './components/Visualizer';
import BrowserWindow from './components/BrowserWindow';
import ChatModule from './components/ChatModule';
import ToolsModule from './components/ToolsModule';
import { X, Minus, Clock } from 'lucide-react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import ConfirmationPopup from './components/ConfirmationPopup';
import AuthLock from './components/AuthLock';
import KasaWindow from './components/KasaWindow';
import SettingsWindow from './components/SettingsWindow';
import RemindersWindow from './components/RemindersWindow';
import NotesWindow from './components/NotesWindow';
import PersonalityWindow from './components/PersonalityWindow';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';

const socket = io('http://localhost:8000');
const { ipcRenderer } = window.require('electron');

const getDefaultPositions = () => ({
  video: { x: 40, y: 80 },
  visualizer: { x: window.innerWidth / 2, y: window.innerHeight / 2 - 150 }, // no longer used for VN
  chat: { x: window.innerWidth / 2, y: window.innerHeight / 2 + 100 },       // will be docked
  browser: { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 },
  kasa: { x: window.innerWidth / 2, y: window.innerHeight / 2 + 50 },
  reminders: { x: window.innerWidth / 2, y: window.innerHeight / 2 - 50 },
  notes: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  tools: { x: window.innerWidth / 2, y: window.innerHeight - 100 }
});

function AppContent() {
  const { t } = useLanguage();

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------
  const calcLevelRms = (arr) => {
    if (!arr || !arr.length) return 0;
    let sum = 0;
    for (let i = 0; i < arr.length; i++) {
      const x = (arr[i] || 0) / 255;
      sum += x * x;
    }
    return Math.sqrt(sum / arr.length);
  };

  // ---------------------------------------------------------------------
  // Viewport (for fullscreen VN Visualizer)
  // ---------------------------------------------------------------------
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ---------------------------------------------------------------------
  // Core State
  // ---------------------------------------------------------------------
  const [status, setStatus] = useState('Disconnected');
  const [socketConnected, setSocketConnected] = useState(socket.connected);

  // Auth State
  const [isAuthenticated, setIsAuthenticated] = useState(() => {
    return localStorage.getItem('face_auth_enabled') !== 'true';
  });

  const [isLockScreenVisible, setIsLockScreenVisible] = useState(() => {
    const saved = localStorage.getItem('face_auth_enabled');
    return saved === 'true';
  });

  const [faceAuthEnabled, setFaceAuthEnabled] = useState(() => {
    return localStorage.getItem('face_auth_enabled') === 'true';
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const [isConnected, setIsConnected] = useState(true);
  const [isMuted, setIsMuted] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(false);

  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');

  const [browserData, setBrowserData] = useState({ image: null, logs: [] });
  const [confirmationRequest, setConfirmationRequest] = useState(null);

  const [kasaDevices, setKasaDevices] = useState([]);
  const [showKasaWindow, setShowKasaWindow] = useState(false);
  const [showRemindersWindow, setShowRemindersWindow] = useState(false);
  const [showNotesWindow, setShowNotesWindow] = useState(false);
  const [showBrowserWindow, setShowBrowserWindow] = useState(false);

  const [currentTime, setCurrentTime] = useState(new Date());

  // ---------------------------------------------------------------------
  // VN Scene / Background (dynamic)
  // ---------------------------------------------------------------------
  const VN_BACKGROUNDS = {
    room: "/vn/bg_room.png",
    kitchen: "/vn/bg_kitchen.png",
    outside: "/vn/bg_outside.png",
    school: "/vn/bg_school.png",
  };

  const [vnScene, setVnScene] = useState("room");
  const [vnBackground, setVnBackground] = useState(VN_BACKGROUNDS.room);
  const lastSceneChangeRef = useRef(0);
  const lastActivityRef = useRef(Date.now());
  const sceneRef = useRef(vnScene);
  const [sceneOverrideUntil, setSceneOverrideUntil] = useState(0);

  // ---------------------------------------------------------------------
  // RESTORED STATE (must be declared BEFORE talking logic uses it)
  // ---------------------------------------------------------------------
  const [aiAudioData, setAiAudioData] = useState(new Array(64).fill(0));
  const [micAudioData, setMicAudioData] = useState(new Array(32).fill(0));
  const [fps, setFps] = useState(0);

  // Compute continuous levels (RMS)
  const aiLevel = useMemo(() => calcLevelRms(aiAudioData), [aiAudioData]);
  const micLevel = useMemo(() => calcLevelRms(micAudioData), [micAudioData]);

  // ---------------------------------------------------------------------
  // Talking state (AI / USER) with hysteresis + hold (prevents "stuck TALK")
  // ---------------------------------------------------------------------
  const [aiSpeaking, setAiSpeaking] = useState(false);
  const [userSpeaking, setUserSpeaking] = useState(false);

  const aiOffTimerRef = useRef(null);
  const userOffTimerRef = useRef(null);

  useEffect(() => {
    if (!isConnected) {
      setAiSpeaking(false);
      return;
    }

    const ON = 0.030;
    const OFF = 0.020;
    const HOLD_MS = 240;

    if (aiLevel > ON) {
      if (aiOffTimerRef.current) {
        clearTimeout(aiOffTimerRef.current);
        aiOffTimerRef.current = null;
      }
      setAiSpeaking(true);
      return;
    }

    if (aiSpeaking && aiLevel < OFF && !aiOffTimerRef.current) {
      aiOffTimerRef.current = setTimeout(() => {
        setAiSpeaking(false);
        aiOffTimerRef.current = null;
      }, HOLD_MS);
    }

    if (!aiSpeaking && aiLevel < ON) {
      setAiSpeaking(false);
    }
  }, [aiLevel, aiSpeaking, isConnected]);

  useEffect(() => {
    const canListen = isConnected && !isMuted;
    if (!canListen) {
      setUserSpeaking(false);
      return;
    }

    const ON = 0.035;
    const OFF = 0.025;
    const HOLD_MS = 200;

    if (micLevel > ON) {
      if (userOffTimerRef.current) {
        clearTimeout(userOffTimerRef.current);
        userOffTimerRef.current = null;
      }
      setUserSpeaking(true);
      return;
    }

    if (userSpeaking && micLevel < OFF && !userOffTimerRef.current) {
      userOffTimerRef.current = setTimeout(() => {
        setUserSpeaking(false);
        userOffTimerRef.current = null;
      }, HOLD_MS);
    }

    if (!userSpeaking && micLevel < ON) {
      setUserSpeaking(false);
    }
  }, [micLevel, userSpeaking, isConnected, isMuted]);

  useEffect(() => {
    return () => {
      if (aiOffTimerRef.current) clearTimeout(aiOffTimerRef.current);
      if (userOffTimerRef.current) clearTimeout(userOffTimerRef.current);
    };
  }, []);

  // ---------------------------------------------------------------------
  // Device states - microphones, speakers, webcams
  // ---------------------------------------------------------------------
  const [micDevices, setMicDevices] = useState([]);
  const [speakerDevices, setSpeakerDevices] = useState([]);
  const [webcamDevices, setWebcamDevices] = useState([]);

  // Selected device IDs - restored from localStorage
  const [selectedMicId, setSelectedMicId] = useState(() => localStorage.getItem('selectedMicId') || '');
  const [selectedSpeakerId, setSelectedSpeakerId] = useState(() => localStorage.getItem('selectedSpeakerId') || '');
  const [selectedWebcamId, setSelectedWebcamId] = useState(() => localStorage.getItem('selectedWebcamId') || '');
  const [showSettings, setShowSettings] = useState(false);
  const [currentProject, setCurrentProject] = useState('default');
  const [showPersonalityWindow, setShowPersonalityWindow] = useState(false);

  // ---------------------------------------------------------------------
  // Modular/Windowed State (kept for your movable windows)
  // ---------------------------------------------------------------------
  const [isModularMode, setIsModularMode] = useState(false);

  const [elementPositions, setElementPositions] = useState(getDefaultPositions);

  const [elementSizes, setElementSizes] = useState({
    visualizer: { w: 550, h: 350 }, // no longer used for VN
    chat: { w: 980, h: 320 },
    tools: { w: 500, h: 80 },
    browser: { w: 550, h: 380 },
    video: { w: 320, h: 180 },
    kasa: { w: 320, h: 500 },
    reminders: { w: 420, h: 560 },
    notes: { w: 500, h: 600 },
  });

  const [activeDragElement, setActiveDragElement] = useState(null);

  // Z-Index Stacking Order (last element = highest z-index)
  const [zIndexOrder, setZIndexOrder] = useState([
    'visualizer', 'chat', 'tools', 'video', 'browser', 'kasa', 'reminders', 'notes'
  ]);

  // ---------------------------------------------------------------------
  // Hand Control State
  // ---------------------------------------------------------------------
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [isPinching, setIsPinching] = useState(false);
  const [isHandTrackingEnabled, setIsHandTrackingEnabled] = useState(false);
  const [cursorSensitivity, setCursorSensitivity] = useState(2.0);
  const [isCameraFlipped, setIsCameraFlipped] = useState(false);
  const [visionMode, setVisionMode] = useState(() => localStorage.getItem('video_mode') || 'none');
  const [visionFrame, setVisionFrame] = useState(null);

  // Refs for Loop Access (Avoiding Closure Staleness)
  const isHandTrackingEnabledRef = useRef(false);
  const cursorSensitivityRef = useRef(2.0);
  const isCameraFlippedRef = useRef(false);
  const handLandmarkerRef = useRef(null);

  // Web Audio Context for Mic Visualization
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const animationFrameRef = useRef(null);

  // Video Refs
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const transmissionCanvasRef = useRef(null);
  const lastFrameTimeRef = useRef(0);
  const frameCountRef = useRef(0);
  const lastVideoTimeRef = useRef(-1);
  const lastTransmitTimeRef = useRef(0);
  const lastCameraProcessTimeRef = useRef(0);
  const CAMERA_PROCESS_INTERVAL_MS = 66;

  // Ref to track video state for the loop (avoids closure staleness)
  const isVideoOnRef = useRef(false);
  const isModularModeRef = useRef(false);
  const elementPositionsRef = useRef(elementPositions);
  const activeDragElementRef = useRef(null);
  const lastActiveDragElementRef = useRef(null);
  const lastWristPosRef = useRef({ x: 0, y: 0 });

  // Smoothing and Snapping Refs
  const smoothedCursorPosRef = useRef({ x: 0, y: 0 });
  const snapStateRef = useRef({ isSnapped: false, element: null, snapPos: { x: 0, y: 0 } });

  // Mouse Drag Refs
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const isDraggingRef = useRef(false);

  // ---------------------------------------------------------------------
  // Toasts (System notifications)
  // ---------------------------------------------------------------------
  const [toasts, setToasts] = useState([]);

  const pushToast = (text, variant = "system", ttl = 3500) => {
    const id =
      (typeof crypto !== "undefined" && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random()}`;

    const toast = { id, text: String(text ?? ""), variant };

    setToasts(prev => [...prev, toast]);

    window.setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, ttl);
  };

  const dismissToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const handleResetPosition = (windowId) => {
    const defaultPositions = getDefaultPositions();
    if (defaultPositions[windowId]) {
      setElementPositions(prev => ({
        ...prev,
        [windowId]: defaultPositions[windowId]
      }));
      pushToast(t('system.window_reset', { windowId }));
    }
  };

  // ---------------------------------------------------------------------
  // VN Dock Layout: chat is bottom textbox, leaving space for bottom tools
  // ---------------------------------------------------------------------
  useEffect(() => {
    const layout = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;

      const topBarHeight = 60;
      const sidePad = 16;
      const bottomToolsArea = 140; // space reserved for bottom icons bar
      const bottomPad = 16;

      const chatW = Math.min(980, width - sidePad * 2);

      // keep chat readable on small screens:
      const maxChatH = Math.min(360, Math.round(height * 0.30));
      const minChatH = 240;
      const chatH = Math.max(minChatH, maxChatH);

      // IMPORTANT: your ChatModule likely treats y as TOP (not center)
      const chatTop = Math.max(
        topBarHeight + 14,
        height - bottomToolsArea - bottomPad - chatH
      );

      setElementSizes(prev => ({
        ...prev,
        chat: { w: chatW, h: chatH }
      }));

      setElementPositions(prev => ({
        ...prev,
        chat: { x: width / 2, y: chatTop },
        tools: { x: width / 2, y: height - 100 }
      }));
    };

    layout();
    window.addEventListener('resize', layout);
    return () => window.removeEventListener('resize', layout);
  }, []);

  // ---------------------------------------------------------------------
  // Update refs when state changes
  // ---------------------------------------------------------------------
  useEffect(() => {
    isModularModeRef.current = isModularMode;
    elementPositionsRef.current = elementPositions;
    isHandTrackingEnabledRef.current = isHandTrackingEnabled;
    cursorSensitivityRef.current = cursorSensitivity;
    isCameraFlippedRef.current = isCameraFlipped;
  }, [isModularMode, elementPositions, isHandTrackingEnabled, cursorSensitivity, isCameraFlipped]);
  
  // Live Clock Update
  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    sceneRef.current = vnScene;
  }, [vnScene]);

  const pickVnScene = (date, quietForMs = 0) => {
    const h = date.getHours();
    // If it's been quiet for a while, let Monika "step outside"
    if (quietForMs >= 120000) return "outside";
    if (h >= 6 && h < 10) return "kitchen";
    if (h >= 10 && h < 16) return "school";
    if (h >= 16 && h < 22) return "room";
    return "outside";
  };

  useEffect(() => {
    const initialScene = pickVnScene(new Date(), 0);
    setVnScene(initialScene);
    setVnBackground(VN_BACKGROUNDS[initialScene] || VN_BACKGROUNDS.room);
  }, []);

  useEffect(() => {
    if (aiSpeaking || userSpeaking) {
      lastActivityRef.current = Date.now();
    }
  }, [aiSpeaking, userSpeaking]);

  useEffect(() => {
    const now = Date.now();
    if (sceneOverrideUntil && now < sceneOverrideUntil) return;
    const quietFor = now - lastActivityRef.current;
    const minQuietMs = 8000;
    const minGapMs = 60000;

    if (quietFor < minQuietMs) return;
    if (now - lastSceneChangeRef.current < minGapMs) return;

    const nextScene = pickVnScene(currentTime, quietFor);
    if (nextScene !== sceneRef.current) {
      setVnScene(nextScene);
      setVnBackground(VN_BACKGROUNDS[nextScene] || VN_BACKGROUNDS.room);
      lastSceneChangeRef.current = now;
    }
  }, [currentTime, aiSpeaking, userSpeaking]);

  // Utility: Clamp position to viewport so component stays fully visible
  const clampToViewport = (pos, size) => {
    const margin = 10;
    const topBarHeight = 60;
    const width = window.innerWidth;
    const height = window.innerHeight;

    return {
      x: Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, pos.x)),
      y: Math.max(size.h / 2 + margin + topBarHeight, Math.min(height - size.h / 2 - margin, pos.y))
    };
  };

  // Utility: Get z-index for an element based on stacking order
  const getZIndex = (id) => {
    const baseZ = 30;
    const index = zIndexOrder.indexOf(id);
    return baseZ + (index >= 0 ? index : 0);
  };

  // Utility: Bring element to front (highest z-index)
  const bringToFront = (id) => {
    setZIndexOrder(prev => {
      const filtered = prev.filter(el => el !== id);
      return [...filtered, id];
    });
  };

  // Ref to track if model has been auto-connected (prevents duplicate connections)
  const hasAutoConnectedRef = useRef(false);

  // Auto-Connect Model on Start (Only after Auth and devices loaded)
  useEffect(() => {
    if (isConnected && isAuthenticated && socketConnected && settingsLoaded && micDevices.length > 0 && !hasAutoConnectedRef.current) {
      hasAutoConnectedRef.current = true;

      socket.emit('list_kasa');

      setTimeout(() => {
        const index = micDevices.findIndex(d => d.deviceId === selectedMicId);
        const queryDevice = micDevices.find(d => d.deviceId === selectedMicId);
        const deviceName = queryDevice ? queryDevice.label : null;

        console.log("Auto-connecting to model with device:", deviceName, "Index:", index);

        setStatus(t('system.connecting'));
        socket.emit('start_audio', {
          device_index: index >= 0 ? index : null,
          device_name: deviceName,
          muted: isMuted,
          video_mode: visionMode || 'none'
        });
      }, 500);
    }
  }, [isConnected, isAuthenticated, socketConnected, settingsLoaded, micDevices, selectedMicId, isMuted, visionMode]);

  useEffect(() => {
    socket.on('connect', () => {
      setStatus(t('system.connected'));
      setSocketConnected(true);
      socket.emit('get_settings');
    });

    socket.on('disconnect', () => {
      setStatus(t('system.disconnected'));
      setSocketConnected(false);
    });

    socket.on('status', (data) => {
      let displayMsg = data.msg;

      // Persona translation for status messages
      if (data.msg === 'MonikAI Started') displayMsg = t('system.monikai_started');
      else if (data.msg === 'MonikAI Stopped') displayMsg = t('system.monikai_stopped');

      addMessage('System', displayMsg);
      if (data.msg === 'MonikAI Started') {
        setStatus(t('system.model_connected'));
      } else if (data.msg === 'MonikAI Stopped') {
        setStatus(t('system.connected'));
      }
    });

    socket.on('audio_data', (data) => {
      setAiAudioData(data.data);
    });

    socket.on('vision_frame', (data) => {
      if (data && data.data) {
        setVisionFrame(data);
      }
    });

    socket.on('request_camera_frame', () => {
      if (isVideoOnRef.current) {
        sendCameraFrameNow();
      }
    });

    socket.on('auth_status', (data) => {
      console.log("Auth Status:", data);
      setIsAuthenticated(data.authenticated);
      if (!data.authenticated) setIsLockScreenVisible(true);
    });

    socket.on('settings', (settings) => {
      console.log("[Settings] Received:", settings);
      if (settings && typeof settings.face_auth_enabled !== 'undefined') {
        setFaceAuthEnabled(settings.face_auth_enabled);
        localStorage.setItem('face_auth_enabled', settings.face_auth_enabled);
      }
      if (typeof settings.camera_flipped !== 'undefined') {
        console.log("[Settings] Camera flip set to:", settings.camera_flipped);
        setIsCameraFlipped(settings.camera_flipped);
      }
      if (typeof settings.video_mode !== 'undefined') {
        setVisionMode(settings.video_mode || 'none');
        localStorage.setItem('video_mode', settings.video_mode || 'none');
      }
      setSettingsLoaded(true);
    });

    socket.on('error', (data) => {
      console.error("Socket Error:", data);
      addMessage('System', `Something feels off... (${data.msg})`); // Keeping generic fallback for now or use t() if msg is known
    });

    socket.on('browser_frame', (data) => {
      setBrowserData(prev => ({
        image: data.image,
        logs: [...prev.logs, data.log].filter(l => l).slice(-50)
      }));
      setShowBrowserWindow(true);

      if (!elementPositions.browser) {
        const size = { w: 550, h: 380 };
        const clamped = clampToViewport({ x: window.innerWidth / 2 - 200, y: window.innerHeight / 2 }, size);
        setElementPositions(prev => ({ ...prev, browser: clamped }));
      }
    });

    socket.on('transcription', (data) => {
      setMessages(prev => {
        const list = prev || [];
        const lastMsg = list[list.length - 1];

        // Append only if same sender AND not a new turn
        if (lastMsg && lastMsg.sender === data.sender && !data.is_new) {
          if (data.is_correction) {
            return [
              ...list.slice(0, -1),
              { ...lastMsg, text: data.text }
            ];
          }
          return [
            ...list.slice(0, -1),
            { ...lastMsg, text: lastMsg.text + data.text }
          ];
        }

        // Otherwise create new bubble
        return [...list, {
          sender: data.sender,
          text: data.text,
          time: new Date().toLocaleTimeString()
        }];
      });
    });

    socket.on('tool_confirmation_request', (data) => {
      console.log("Received Confirmation Request:", data);
      setConfirmationRequest(data);
    });

    socket.on('kasa_devices', (devices) => {
      console.log("Kasa Devices:", devices);
      setKasaDevices(Array.isArray(devices) ? devices : []);
    });

    socket.on('kasa_update', (data) => {
      setKasaDevices(prev => prev.map(d => {
        if (d.ip === data.ip) {
          return {
            ...d,
            is_on: data.is_on !== null ? data.is_on : d.is_on,
            brightness: data.brightness !== null ? data.brightness : d.brightness
          };
        }
        return d;
      }));
    });

    socket.on('vn_scene', (payload) => {
      const scene = payload?.scene;
      if (!scene || !VN_BACKGROUNDS[scene]) return;
      const ttl = typeof payload?.ttl_ms === 'number' ? payload.ttl_ms : 180000;
      setVnScene(scene);
      setVnBackground(VN_BACKGROUNDS[scene]);
      setSceneOverrideUntil(Date.now() + ttl);
      lastSceneChangeRef.current = Date.now();
    });

    socket.on('project_update', (data) => {
      console.log("Project Update:", data.project);
      setCurrentProject(data.project);
      addMessage('System', t('system.project_focus', { project: data.project }));
    });

    navigator.mediaDevices.enumerateDevices().then(devs => {
      const audioInputs = devs.filter(d => d.kind === 'audioinput');
      const audioOutputs = devs.filter(d => d.kind === 'audiooutput');
      const videoInputs = devs.filter(d => d.kind === 'videoinput');

      setMicDevices(audioInputs);
      setSpeakerDevices(audioOutputs);
      setWebcamDevices(videoInputs);

      const savedMicId = localStorage.getItem('selectedMicId');
      if (savedMicId && audioInputs.some(d => d.deviceId === savedMicId)) {
        setSelectedMicId(savedMicId);
      } else if (audioInputs.length > 0) {
        setSelectedMicId(audioInputs[0].deviceId);
      }

      const savedSpeakerId = localStorage.getItem('selectedSpeakerId');
      if (savedSpeakerId && audioOutputs.some(d => d.deviceId === savedSpeakerId)) {
        setSelectedSpeakerId(savedSpeakerId);
      } else if (audioOutputs.length > 0) {
        setSelectedSpeakerId(audioOutputs[0].deviceId);
      }

      const savedWebcamId = localStorage.getItem('selectedWebcamId');
      if (savedWebcamId && videoInputs.some(d => d.deviceId === savedWebcamId)) {
        setSelectedWebcamId(savedWebcamId);
      } else if (videoInputs.length > 0) {
        setSelectedWebcamId(videoInputs[0].deviceId);
      }
    });

    const initHandLandmarker = async () => {
      try {
        console.log("Initializing HandLandmarker...");

        const response = await fetch('/hand_landmarker.task');
        if (!response.ok) {
          throw new Error(`Failed to fetch model: ${response.status} ${response.statusText}`);
        }

        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm"
        );

        handLandmarkerRef.current = await HandLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `/hand_landmarker.task`,
            delegate: "GPU"
          },
          runningMode: "VIDEO",
          numHands: 1
        });

        addMessage('System', t('system.hand_tracking_active'));
      } catch (error) {
        console.error("Failed to initialize HandLandmarker:", error);
        addMessage('System', t('system.hand_tracking_error', { error: error.message }));
      }
    };
    initHandLandmarker();

    return () => {
      socket.off('connect');
      socket.off('disconnect');
      socket.off('status');
      socket.off('audio_data');
      socket.off('vision_frame');
      socket.off('request_camera_frame');
      socket.off('browser_frame');
      socket.off('transcription');
      socket.off('tool_confirmation_request');
      socket.off('kasa_devices');
      socket.off('kasa_update');
      socket.off('vn_scene');
      socket.off('error');

      stopMicVisualizer();
      stopVideo();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (visionMode === 'camera' && !isVideoOn && webcamDevices.length > 0) {
      startVideo();
    }
  }, [visionMode, isVideoOn, webcamDevices.length]);

  // Initial check in case we are already connected (fix race condition)
  useEffect(() => {
    if (socket.connected) {
      setStatus(t('system.connected'));
      socket.emit('get_settings');
    }
  }, []);

  // Persist device selections to localStorage when they change
  useEffect(() => {
    if (selectedMicId) {
      localStorage.setItem('selectedMicId', selectedMicId);
      console.log('[Settings] Saved microphone:', selectedMicId);
    }
  }, [selectedMicId]);

  useEffect(() => {
    if (selectedSpeakerId) {
      localStorage.setItem('selectedSpeakerId', selectedSpeakerId);
      console.log('[Settings] Saved speaker:', selectedSpeakerId);
    }
  }, [selectedSpeakerId]);

  useEffect(() => {
    if (selectedWebcamId) {
      localStorage.setItem('selectedWebcamId', selectedWebcamId);
      console.log('[Settings] Saved webcam:', selectedWebcamId);
    }
  }, [selectedWebcamId]);

  // Start/Stop Mic Visualizer
  useEffect(() => {
    if (selectedMicId) {
      startMicVisualizer(selectedMicId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMicId]);

  const startMicVisualizer = async (deviceId) => {
    stopMicVisualizer();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } }
      });

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 64;

      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(analyserRef.current);

      const updateMicData = () => {
        if (!analyserRef.current) return;
        const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(dataArray);
        setMicAudioData(Array.from(dataArray));
        animationFrameRef.current = requestAnimationFrame(updateMicData);
      };

      updateMicData();
    } catch (err) {
      console.error("Error accessing microphone:", err);
    }
  };

  const stopMicVisualizer = () => {
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioContextRef.current) audioContextRef.current.close();
  };

  const startVideo = async () => {
    try {
      const constraints = {
        video: {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          aspectRatio: 16 / 9
        }
      };

      if (selectedWebcamId) {
        constraints.video.deviceId = { exact: selectedWebcamId };
      }

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }

      if (!transmissionCanvasRef.current) {
        transmissionCanvasRef.current = document.createElement('canvas');
        transmissionCanvasRef.current.width = 640;
        transmissionCanvasRef.current.height = 360;
        console.log("Initialized transmission canvas (640x360)");
      }

      setIsVideoOn(true);
      isVideoOnRef.current = true;

      console.log("Starting video loop with webcam:", selectedWebcamId || "default");
      requestAnimationFrame(predictWebcam);

    } catch (err) {
      console.error("Error accessing camera:", err);
      addMessage('System', t('system.camera_error'));
    }
  };

  const sendCameraFrameNow = () => {
    if (!videoRef.current || videoRef.current.readyState < 2) return;
    if (!transmissionCanvasRef.current) {
      transmissionCanvasRef.current = document.createElement('canvas');
      transmissionCanvasRef.current.width = 320;
      transmissionCanvasRef.current.height = 180;
    }
    const transCanvas = transmissionCanvasRef.current;
    const transCtx = transCanvas.getContext('2d');
    transCtx.drawImage(videoRef.current, 0, 0, transCanvas.width, transCanvas.height);
    transCanvas.toBlob((blob) => {
      if (blob) socket.emit('video_frame', { image: blob });
    }, 'image/jpeg', 0.4);
  };

  const predictWebcam = () => {
    if (!videoRef.current || !canvasRef.current || !isVideoOnRef.current) return;

    if (videoRef.current.readyState < 2 || videoRef.current.videoWidth === 0 || videoRef.current.videoHeight === 0) {
      requestAnimationFrame(predictWebcam);
      return;
    }

    const ctx = canvasRef.current.getContext('2d');

    if (canvasRef.current.width !== videoRef.current.videoWidth || canvasRef.current.height !== videoRef.current.videoHeight) {
      canvasRef.current.width = videoRef.current.videoWidth;
      canvasRef.current.height = videoRef.current.videoHeight;
    }

    ctx.drawImage(videoRef.current, 0, 0, canvasRef.current.width, canvasRef.current.height);

    if (isConnected) {
      if (frameCountRef.current % 5 === 0) {
        const transCanvas = transmissionCanvasRef.current;
        if (transCanvas) {
          const transCtx = transCanvas.getContext('2d');
          transCtx.drawImage(videoRef.current, 0, 0, transCanvas.width, transCanvas.height);

          transCanvas.toBlob((blob) => {
            if (blob) socket.emit('video_frame', { image: blob });
          }, 'image/jpeg', 0.6);
        }
      }
    }

    let startTimeMs = performance.now();

    if (isHandTrackingEnabledRef.current && handLandmarkerRef.current && videoRef.current.currentTime !== lastVideoTimeRef.current) {
      lastVideoTimeRef.current = videoRef.current.currentTime;
      const results = handLandmarkerRef.current.detectForVideo(videoRef.current, startTimeMs);

      if (frameCountRef.current % 100 === 0) {
        console.log("Tracking loop running... Last result:", results.landmarks.length > 0 ? "Hand Found" : "No Hand");
      }

      if (results.landmarks && results.landmarks.length > 0) {
        const landmarks = results.landmarks[0];

        const indexTip = landmarks[8];
        const thumbTip = landmarks[4];

        const SENSITIVITY = cursorSensitivityRef.current;

        const rawX = isCameraFlippedRef.current ? (1 - indexTip.x) : indexTip.x;

        let normX = (rawX - 0.5) * SENSITIVITY + 0.5;
        normX = Math.max(0, Math.min(1, normX));

        let normY = (indexTip.y - 0.5) * SENSITIVITY + 0.5;
        normY = Math.max(0, Math.min(1, normY));

        const targetX = normX * window.innerWidth;
        const targetY = normY * window.innerHeight;

        const lerpFactor = 0.2;
        smoothedCursorPosRef.current.x = smoothedCursorPosRef.current.x + (targetX - smoothedCursorPosRef.current.x) * lerpFactor;
        smoothedCursorPosRef.current.y = smoothedCursorPosRef.current.y + (targetY - smoothedCursorPosRef.current.y) * lerpFactor;

        let finalX = smoothedCursorPosRef.current.x;
        let finalY = smoothedCursorPosRef.current.y;

        const SNAP_THRESHOLD = 50;
        const UNSNAP_THRESHOLD = 100;

        if (snapStateRef.current.isSnapped) {
          const dist = Math.sqrt(
            Math.pow(finalX - snapStateRef.current.snapPos.x, 2) +
            Math.pow(finalY - snapStateRef.current.snapPos.y, 2)
          );

          if (dist > UNSNAP_THRESHOLD) {
            if (snapStateRef.current.element) {
              snapStateRef.current.element.classList.remove('snap-highlight');
              snapStateRef.current.element.style.boxShadow = '';
              snapStateRef.current.element.style.backgroundColor = '';
              snapStateRef.current.element.style.borderColor = '';
            }
            snapStateRef.current = { isSnapped: false, element: null, snapPos: { x: 0, y: 0 } };
          } else {
            finalX = snapStateRef.current.snapPos.x;
            finalY = snapStateRef.current.snapPos.y;
          }
        } else {
          const targets = Array.from(document.querySelectorAll('button, input, select, .draggable'));
          let closest = null;
          let minDist = Infinity;

          for (const el of targets) {
            const rect = el.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const dist = Math.sqrt(Math.pow(finalX - centerX, 2) + Math.pow(finalY - centerY, 2));

            if (dist < minDist) {
              minDist = dist;
              closest = { el, centerX, centerY };
            }
          }

          if (closest && minDist < SNAP_THRESHOLD) {
            snapStateRef.current = {
              isSnapped: true,
              element: closest.el,
              snapPos: { x: closest.centerX, y: closest.centerY }
            };
            finalX = closest.centerX;
            finalY = closest.centerY;

            closest.el.classList.add('snap-highlight');
            closest.el.style.boxShadow = '0 0 20px rgba(255,255,255,0.25)';
            closest.el.style.backgroundColor = 'rgba(255,255,255,0.06)';
            closest.el.style.borderColor = 'rgba(255,255,255,0.35)';
          }
        }

        setCursorPos({ x: finalX, y: finalY });

        const distance = Math.sqrt(
          Math.pow(indexTip.x - thumbTip.x, 2) + Math.pow(indexTip.y - thumbTip.y, 2)
        );

        const isPinchNow = distance < 0.05;

        if (isPinchNow && !isPinching) {
          console.log("Click triggered at", finalX, finalY);

          const el = document.elementFromPoint(finalX, finalY);
          if (el) {
            const clickable = el.closest('button, input, a, [role="button"]');
            if (clickable && typeof clickable.click === 'function') {
              clickable.click();
            } else if (typeof el.click === 'function') {
              el.click();
            }
          }
        }
        setIsPinching(isPinchNow);

        const isFingerFolded = (tipIdx, mcpIdx) => {
          const tip = landmarks[tipIdx];
          const mcp = landmarks[mcpIdx];
          const wrist = landmarks[0];
          const distTip = Math.sqrt(Math.pow(tip.x - wrist.x, 2) + Math.pow(tip.y - wrist.y, 2));
          const distMcp = Math.sqrt(Math.pow(mcp.x - wrist.x, 2) + Math.pow(mcp.y - wrist.y, 2));
          return distTip < distMcp;
        };

        const isFist = isFingerFolded(8, 5) && isFingerFolded(12, 9) && isFingerFolded(16, 13) && isFingerFolded(20, 17);

        const wrist = landmarks[0];
        const wristRawX = isCameraFlippedRef.current ? (1 - wrist.x) : wrist.x;
        const wristNormX = Math.max(0, Math.min(1, (wristRawX - 0.5) * SENSITIVITY + 0.5));
        const wristNormY = Math.max(0, Math.min(1, (wrist.y - 0.5) * SENSITIVITY + 0.5));
        const wristScreenX = wristNormX * window.innerWidth;
        const wristScreenY = wristNormY * window.innerHeight;

        if (isFist) {
          if (!activeDragElementRef.current) {
            const draggableElements = ['browser', 'kasa', 'reminders', 'notes'];

            for (const id of draggableElements) {
              const el = document.getElementById(id);
              if (el) {
                const rect = el.getBoundingClientRect();
                if (finalX >= rect.left && finalX <= rect.right && finalY >= rect.top && finalY <= rect.bottom) {
                  activeDragElementRef.current = id;
                  bringToFront(id);
                  lastWristPosRef.current = { x: wristScreenX, y: wristScreenY };
                  break;
                }
              }
            }
          }

          if (activeDragElementRef.current) {
            const dx = wristScreenX - lastWristPosRef.current.x;
            const dy = wristScreenY - lastWristPosRef.current.y;

            if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
              updateElementPosition(activeDragElementRef.current, dx, dy);
            }

            lastWristPosRef.current = { x: wristScreenX, y: wristScreenY };
          }
        } else {
          activeDragElementRef.current = null;
        }

        if (activeDragElementRef.current !== lastActiveDragElementRef.current) {
          setActiveDragElement(activeDragElementRef.current);
          lastActiveDragElementRef.current = activeDragElementRef.current;
        }

        drawSkeleton(ctx, landmarks);
      }
    }

    frameCountRef.current++;
    if (nowMs - lastFrameTimeRef.current >= 1000) {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
      lastFrameTimeRef.current = nowMs;
    }

    if (isVideoOnRef.current) {
      requestAnimationFrame(predictWebcam);
    }
  };

  const drawSkeleton = (ctx, landmarks) => {
    ctx.strokeStyle = '#00FFFF';
    ctx.lineWidth = 2;

    const connections = HandLandmarker.HAND_CONNECTIONS;
    for (const connection of connections) {
      const start = landmarks[connection.start];
      const end = landmarks[connection.end];
      ctx.beginPath();
      ctx.moveTo(start.x * canvasRef.current.width, start.y * canvasRef.current.height);
      ctx.lineTo(end.x * canvasRef.current.width, end.y * canvasRef.current.height);
      ctx.stroke();
    }
  };

  const stopVideo = () => {
    if (videoRef.current && videoRef.current.srcObject) {
      videoRef.current.srcObject.getTracks().forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }
    setIsVideoOn(false);
    isVideoOnRef.current = false;
    setFps(0);
  };

  const setVisionModeAndPersist = (mode, extraSettings = {}) => {
    const next = mode || 'none';
    setVisionMode(next);
    localStorage.setItem('video_mode', next);
    socket.emit('update_settings', { video_mode: next, ...extraSettings });
  };

  const toggleVideo = () => {
    if (isVideoOn) {
      stopVideo();
      setVisionModeAndPersist('none', { screen_capture: { stream_to_ai: false } });
    } else {
      startVideo();
      setVisionModeAndPersist('camera', { screen_capture: { stream_to_ai: false } });
    }
  };

  const toggleScreenCapture = () => {
    if (visionMode === 'screen') {
      setVisionModeAndPersist('none', { screen_capture: { stream_to_ai: false } });
    } else {
      if (isVideoOn) stopVideo();
      setVisionModeAndPersist('screen', { screen_capture: { stream_to_ai: true } });
    }
  };

  const addMessage = (sender, text) => {
    const s = String(sender ?? "");
    if (s.toLowerCase() === "system") {
      pushToast(text, "system");
      return;
    }
    setMessages(prev => [...prev, { sender: s, text: String(text ?? ""), time: new Date().toLocaleTimeString() }]);
  };

  const togglePower = () => {
    if (isConnected) {
      socket.emit('stop_audio');
      setIsConnected(false);
      setIsMuted(false);
    } else {
      const index = micDevices.findIndex(d => d.deviceId === selectedMicId);
      socket.emit('start_audio', {
        device_index: index >= 0 ? index : null,
        video_mode: visionMode || 'none'
      });
      setIsConnected(true);
      setIsMuted(false);
    }
  };

  const toggleMute = () => {
    if (!isConnected) return;
    if (isMuted) {
      socket.emit('resume_audio');
      setIsMuted(false);
    } else {
      socket.emit('pause_audio');
      setIsMuted(true);
    }
  };

const handleSend = (e) => {
  if (!e || e.key !== 'Enter') return;

  const text = (inputValue || '').trim();
  const attachments = Array.isArray(e.attachments) ? e.attachments : [];

  // pozwól wysłać: (tekst) lub (same załączniki) lub (oba)
  if (!text && attachments.length === 0) return;

  socket.emit('user_input', { text, attachments });

  // Lokalne dodanie wiadomości użytkownika do UI (bo backend nie zawsze echo-uje usera)
  if (attachments.length > 0) {
    const names = attachments
      .map(a => a?.name)
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');

    const attachLine = names
      ? `\n\n[Załączniki: ${names}${attachments.length > 8 ? ', …' : ''}]`
      : `\n\n[${t('chat.attachments')}: ${attachments.length}]`;

    addMessage(t('chat.you'), (text || `(${t('chat.sent_attachments')})`) + attachLine);
  } else {
    addMessage(t('chat.you'), text);
  }

  setInputValue('');
};


  const handleMinimize = () => ipcRenderer.send('window-minimize');
  const handleMaximize = () => ipcRenderer.send('window-maximize');

  const handleCloseRequest = () => {
    const closeWindow = () => ipcRenderer.send('window-close');

    if (socket.connected) {
      console.log('[APP] Sending shutdown signal to backend...');
      socket.emit('shutdown', {}, () => {
        console.log('[APP] Shutdown acknowledged');
        closeWindow();
      });
      setTimeout(closeWindow, 500);
    } else {
      closeWindow();
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const textContent = event.target.result;
        if (typeof textContent === 'string' && textContent.length > 0) {
          socket.emit('upload_memory', { memory: textContent });
          addMessage('System', t('system.reading_memory'));
        } else {
          addMessage('System', t('system.memory_empty'));
        }
      } catch (err) {
        console.error("Error reading file:", err);
        addMessage('System', t('system.memory_error'));
      }
    };
    reader.readAsText(file);
  };

  const handleConfirmTool = () => {
    if (confirmationRequest) {
      socket.emit('confirm_tool', { id: confirmationRequest.id, confirmed: true });
      setConfirmationRequest(null);
    }
  };

  const handleDenyTool = () => {
    if (confirmationRequest) {
      socket.emit('confirm_tool', { id: confirmationRequest.id, confirmed: false });
      setConfirmationRequest(null);
    }
  };

  const updateElementPosition = (id, dx, dy) => {
    setElementPositions(prev => {
      const currentPos = prev[id];
      if (!currentPos) {
        console.error(`[Drag] Hand tracking cannot update position for unknown element ID: ${id}`);
        return prev; // Do not update if the element position is not found
      }
      const size = elementSizes[id] || { w: 100, h: 100 };
      const rawNewX = currentPos.x + dx;
      const rawNewY = currentPos.y + dy;

      const width = window.innerWidth;
      const height = window.innerHeight;
      const margin = 0;
      const topBarHeight = 60;

      // This logic should be identical to handleMouseDrag
      const newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, rawNewX));
      const newY = Math.max(size.h / 2 + margin + topBarHeight, Math.min(height - size.h / 2 - margin, rawNewY));

      return { ...prev, [id]: { x: newX, y: newY } };
    });
  };

  // --- MOUSE DRAG HANDLERS ---
  const handleMouseDown = (e, id) => {
    console.log(`[MouseDrag] MouseDown on ${id}`, { target: e.target.tagName });

    // In VN layout: visualizer + chat stay fixed
    const fixedElements = ['visualizer', 'chat', 'video', 'tools'];
    if (fixedElements.includes(id)) {
      console.log(`[MouseDrag] ${id} is a fixed element, not draggable`);
      return;
    }

    bringToFront(id);

    const tagName = e.target.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'button' || tagName === 'textarea' || tagName === 'canvas' || e.target.closest('button')) {
      console.log("[MouseDrag] Interaction blocked by interactive element");
      return;
    }

    const isDragHandle = e.target.closest('[data-drag-handle]');
    if (!isDragHandle && !isModularModeRef.current) {
      console.log("[MouseDrag] Not a drag handle and modular mode off");
      return;
    }

    const elPos = elementPositions[id];
    if (!elPos) return;

    dragOffsetRef.current = {
      x: e.clientX - elPos.x,
      y: e.clientY - elPos.y
    };

    setActiveDragElement(id);
    activeDragElementRef.current = id;
    isDraggingRef.current = true;

    window.addEventListener('mousemove', handleMouseDrag);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleMouseDrag = (e) => {
    if (!isDraggingRef.current || !activeDragElementRef.current) return;

    const id = activeDragElementRef.current;

    const rawNewX = e.clientX - dragOffsetRef.current.x;
    const rawNewY = e.clientY - dragOffsetRef.current.y;

    setElementPositions(prev => {
      const size = elementSizes[id] || { w: 100, h: 100 };

      const width = window.innerWidth;
      const height = window.innerHeight;
      const margin = 0;
      const topBarHeight = 60; // Approximate height of the top bar

      // All draggable windows use center-based positioning with translate(-50%, -50%)
      // We clamp the center position to keep the window within the viewport.
      const newX = Math.max(size.w / 2 + margin, Math.min(width - size.w / 2 - margin, rawNewX));
      const newY = Math.max(size.h / 2 + margin + topBarHeight, Math.min(height - size.h / 2 - margin, rawNewY));

      return { ...prev, [id]: { x: newX, y: newY } };
    });
  };

  const handleMouseUp = () => {
    isDraggingRef.current = false;
    setActiveDragElement(null);
    activeDragElementRef.current = null;
    window.removeEventListener('mousemove', handleMouseDrag);
    window.removeEventListener('mouseup', handleMouseUp);
  };

  const handleToggleWindow = (windowId, isVisible, setVisibility) => {
    if (!isVisible) {
      // Reset position when opening the window
      bringToFront(windowId);
      const defaultPositions = getDefaultPositions();
      if (defaultPositions[windowId]) {
        setElementPositions(prev => ({
          ...prev,
          [windowId]: defaultPositions[windowId]
        }));
      }
    }
    setVisibility(!isVisible);
  };
  return (
    <div className="h-screen w-screen bg-black text-white/85 font-sans overflow-hidden flex flex-col relative selection:bg-white/10 selection:text-white">
      {isLockScreenVisible && (
        <AuthLock
          socket={socket}
          onAuthenticated={() => setIsAuthenticated(true)}
          onAnimationComplete={() => setIsLockScreenVisible(false)}
        />
      )}

      {showPersonalityWindow && <PersonalityWindow socket={socket} />}

      {/* VN FULLSCREEN BACKGROUND + CHARACTER (behind UI) */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <Visualizer
          audioData={aiAudioData}
          intensity={aiLevel}
          width={viewport.w}
          height={viewport.h}
          backgroundSrc={vnBackground}
          sprites={{
            idle: isConnected ? "/vn/ai_idle.png" : "/vn/ai_sleeping.png",
            listen: "/vn/ai_listen.png",
            talk: ["/vn/ai_talk_1.png", "/vn/ai_talk_2.png"],
          }}
          isAssistantSpeaking={aiSpeaking}
          isUserSpeaking={userSpeaking}
          characterScale={1.20}
          characterY={10}
        />
        {/* Subtle VN vignette */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/20 to-black/55" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-15 mix-blend-overlay" />

        {/* Sleep Dimmer */}
        <div className={`absolute inset-0 bg-black/60 transition-opacity duration-[2000ms] ${isConnected ? 'opacity-0' : 'opacity-100'}`} />
      </div>

      {/* Hand Cursor - Only show if tracking is enabled */}
      {isVideoOn && isHandTrackingEnabled && (
        <div
          className={[
            "fixed w-6 h-6 border-2 rounded-full pointer-events-none z-[100] transition-transform duration-75",
            isPinching
              ? "bg-white/35 border-white/50 scale-75 shadow-[0_0_15px_rgba(255,255,255,0.25)]"
              : "border-white/50 shadow-[0_0_10px_rgba(255,255,255,0.18)]"
          ].join(" ")}
          style={{
            left: cursorPos.x,
            top: cursorPos.y,
            transform: 'translate(-50%, -50%)'
          }}
        >
          <div className="absolute top-1/2 left-1/2 w-1 h-1 bg-white rounded-full -translate-x-1/2 -translate-y-1/2" />
        </div>
      )}

      {/* Top Bar */}
      <div
        className="z-50 flex items-center justify-between p-2 border-b border-white/10 bg-black/40 backdrop-blur-md select-none sticky top-0"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <div className="flex items-center gap-4 pl-2">
          <h1 
            className="text-xl font-semibold tracking-[0.1em] text-white/70 drop-shadow-[0_0_10px_rgba(255,255,255,0.18)] cursor-help hover:text-white/90 transition-colors"
            onMouseEnter={() => setShowPersonalityWindow(true)}
            onMouseLeave={() => setShowPersonalityWindow(false)}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            Monik.AI
          </h1>

          {isVideoOn && (
            <div className="text-[10px] text-white/70 border border-white/12 bg-white/5 px-1.5 py-0.5 rounded ml-2">
              FPS: {fps}
            </div>
          )}

          {kasaDevices.length > 0 && (
            <div className="flex items-center gap-1.5 text-[10px] text-white/70 border border-white/12 bg-white/5 px-2 py-0.5 rounded ml-2">
              <span className="text-white/70">💡</span>
              <span>{kasaDevices.length} Device{kasaDevices.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pr-2" style={{ WebkitAppRegion: 'no-drag' }}>
          <div className="flex items-center gap-1.5 text-[12px] text-white/60 px-2">
            <Clock size={12} className="text-white/35" />
            <span>{currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </div>

          <button onClick={handleMinimize} className="p-1 hover:bg-white/10 rounded text-white/70 transition-colors">
            <Minus size={18} />
          </button>

          <button onClick={handleMaximize} className="p-1 hover:bg-white/10 rounded text-white/70 transition-colors">
            <div className="w-[14px] h-[14px] border-2 border-current rounded-[2px]" />
          </button>

          <button onClick={handleCloseRequest} className="p-1 hover:bg-white/10 rounded text-white/70 transition-colors">
            <X size={18} />
          </button>
        </div>
      </div>

      {/* Toasts (System notifications) */}
      <div className="fixed top-[72px] right-4 z-[999] flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className="pointer-events-auto w-[360px] max-w-[calc(100vw-24px)] rounded-2xl border border-cyan-500/30 bg-black/80 backdrop-blur-xl shadow-[0_0_30px_rgba(34,211,238,0.15)] overflow-hidden relative"
          >
            <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay"></div>

            <div className="relative z-10 px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_5px_cyan]"></div>
                  <div className="text-[10px] tracking-[0.22em] uppercase text-cyan-500 font-mono font-bold">
                    MONIKA
                  </div>
                </div>
                <div className="text-[13px] leading-relaxed text-cyan-100/90 break-words font-mono">
                  {t.text}
                </div>
              </div>

              <button
                onClick={() => dismissToast(t.id)}
                className="shrink-0 p-1 rounded-lg hover:bg-cyan-900/30 text-cyan-600 hover:text-cyan-400 transition-colors"
                title="Dismiss"
              >
                <X size={14} />
              </button>
            </div>

            <div className="relative z-10 h-[1px] w-full bg-gradient-to-r from-transparent via-cyan-500/50 to-transparent opacity-70" />
          </div>
        ))}
      </div>

      {/* Main Content (over VN background) */}
      <div className="flex-1 relative z-10">
        {/* Floating Project Label */}
        <div className="absolute top-[70px] left-1/2 -translate-x-1/2 text-white/65 text-xs tracking-widest pointer-events-none z-50 bg-black/50 px-2 py-1 rounded backdrop-blur-sm border border-white/12">
          {currentProject?.toUpperCase()}
        </div>

        {/* Video / Screen Stack */}
        {(visionMode === 'screen' || isVideoOn) && (
          <div className="fixed bottom-4 right-4 flex flex-col gap-3 z-20">
            {/* Screen Preview */}
            {visionMode === 'screen' && (
              <div className="relative transition-all duration-200 backdrop-blur-md bg-white/[0.06] border border-white/[0.14] shadow-xl rounded-xl">
                <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none mix-blend-overlay" />

                <div className="relative border border-white/12 rounded-lg overflow-hidden shadow-[0_0_20px_rgba(255,255,255,0.10)] w-80 aspect-video bg-black/80">
                  {visionFrame?.data ? (
                    <img
                      src={`data:${visionFrame?.mime_type || 'image/jpeg'};base64,${visionFrame.data}`}
                      className="absolute inset-0 w-full h-full object-cover"
                      alt="SCREEN"
                    />
                  ) : (
                    <div className="absolute inset-0 flex items-center justify-center text-[10px] text-white/50 tracking-widest">
                      NO SIGNAL
                    </div>
                  )}

                  <div className="absolute top-2 left-2 text-[10px] text-white/70 bg-black/60 backdrop-blur px-2 py-0.5 rounded border border-white/12 z-10 font-semibold tracking-wider">
                    SCREEN
                  </div>
                </div>
              </div>
            )}

            {/* Camera Preview */}
            <div
              id="video"
              className={`transition-all duration-200 
                ${isVideoOn ? 'opacity-100' : 'opacity-0 pointer-events-none hidden'} 
                backdrop-blur-md bg-white/[0.06] border border-white/[0.14] shadow-xl rounded-xl
              `}
            >
              <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-5 pointer-events-none mix-blend-overlay" />

              <div className="relative border border-white/12 rounded-lg overflow-hidden shadow-[0_0_20px_rgba(255,255,255,0.10)] w-80 aspect-video bg-black/80">
                <video ref={videoRef} autoPlay muted className="absolute inset-0 w-full h-full object-cover opacity-0" />

                <div className="absolute top-2 left-2 text-[10px] text-white/70 bg-black/60 backdrop-blur px-2 py-0.5 rounded border border-white/12 z-10 font-semibold tracking-wider">
                  CAM_01
                </div>

                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full opacity-80"
                  style={{ transform: isCameraFlipped ? 'scaleX(-1)' : 'none' }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Settings Modal */}
        {showSettings && (
          <SettingsWindow
            socket={socket}
            micDevices={micDevices}
            speakerDevices={speakerDevices}
            webcamDevices={webcamDevices}
            selectedMicId={selectedMicId}
            setSelectedMicId={setSelectedMicId}
            selectedSpeakerId={selectedSpeakerId}
            setSelectedSpeakerId={setSelectedSpeakerId}
            selectedWebcamId={selectedWebcamId}
            setSelectedWebcamId={setSelectedWebcamId}
            cursorSensitivity={cursorSensitivity}
            setCursorSensitivity={setCursorSensitivity}
            isCameraFlipped={isCameraFlipped}
            setIsCameraFlipped={setIsCameraFlipped}
            handleFileUpload={handleFileUpload}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* Browser Window */}
        {showBrowserWindow && (
          <div
            id="browser"
            className={`absolute flex flex-col transition-[box-shadow,background-color,border-color] duration-200
              backdrop-blur-xl bg-white/[0.06] border border-white/[0.14] shadow-2xl overflow-hidden rounded-lg
              ${activeDragElement === 'browser' ? 'ring-2 ring-white/30 bg-white/[0.08]' : ''}
            `}
            style={{
              left: elementPositions.browser?.x || window.innerWidth / 2 - 200,
              top: elementPositions.browser?.y || window.innerHeight / 2,
              transform: 'translate(-50%, -50%)',
              width: `${elementSizes.browser.w}px`,
              height: `${elementSizes.browser.h}px`,
              pointerEvents: 'auto',
              zIndex: getZIndex('browser')
            }}
            onMouseDown={(e) => handleMouseDown(e, 'browser')}
          >
            <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay z-10" />
            <div className="relative z-20 w-full h-full">
              <BrowserWindow
                imageSrc={browserData.image}
                logs={browserData.logs}
                onClose={() => setShowBrowserWindow(false)}
                socket={socket}
              />
            </div>
          </div>
        )}

        {/* VN Chat (docked bottom textbox) */}
        <ChatModule
          messages={messages}
          inputValue={inputValue}
          setInputValue={setInputValue}
          handleSend={handleSend}
          socket={socket}
          isModularMode={false}
          activeDragElement={null}
          position={elementPositions.chat}
          width={elementSizes.chat.w}
          height={elementSizes.chat.h}
          onMouseDown={() => {}}
          userSpeaking={userSpeaking}
          micAudioData={micAudioData}
          zIndex={10}
        />

        {/* Footer Controls / Tools Module */}
        <div className="z-20 flex justify-center pb-10 pointer-events-none">
          <ToolsModule
            isConnected={isConnected}
            isMuted={isMuted}
            isVideoOn={isVideoOn}
            isScreenCaptureOn={visionMode === 'screen'}
            isHandTrackingEnabled={isHandTrackingEnabled}
            showSettings={showSettings}
            onTogglePower={togglePower}
            onToggleMute={toggleMute}
            onToggleVideo={toggleVideo}
            onToggleScreenCapture={toggleScreenCapture}
            onToggleSettings={() => setShowSettings(!showSettings)}
            onToggleReminders={() => handleToggleWindow('reminders', showRemindersWindow, setShowRemindersWindow)}
            showRemindersWindow={showRemindersWindow}
            onToggleNotes={() => handleToggleWindow('notes', showNotesWindow, setShowNotesWindow)}
            showNotesWindow={showNotesWindow}
            onToggleHand={() => setIsHandTrackingEnabled(!isHandTrackingEnabled)}
            onToggleKasa={() => handleToggleWindow('kasa', showKasaWindow, setShowKasaWindow)}
            showKasaWindow={showKasaWindow}
            onToggleBrowser={() => handleToggleWindow('browser', showBrowserWindow, setShowBrowserWindow)}
            showBrowserWindow={showBrowserWindow}
            onResetPosition={handleResetPosition}
            activeDragElement={activeDragElement}
            position={elementPositions.tools}
            onMouseDown={(e) => handleMouseDown(e, 'tools')}
          />
        </div>

        {/* Kasa Window */}
        {showKasaWindow && (
          <div
            id="kasa"
            className={`absolute flex flex-col transition-[box-shadow,background-color,border-color] duration-200
              backdrop-blur-xl bg-white/[0.06] border border-white/[0.14] shadow-2xl overflow-hidden rounded-lg
              ${activeDragElement === 'kasa' ? 'ring-2 ring-white/30 bg-white/[0.08]' : ''}
            `}
            style={{
              left: elementPositions.kasa?.x,
              top: elementPositions.kasa?.y,
              transform: 'translate(-50%, -50%)',
              width: `${elementSizes.kasa.w}px`,
              height: `${elementSizes.kasa.h}px`,
              pointerEvents: 'auto',
              zIndex: getZIndex('kasa')
            }}
            onMouseDown={(e) => handleMouseDown(e, 'kasa')}
          >
            <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay z-10" />
            <div className="relative z-20 w-full h-full">
              <KasaWindow
                socket={socket}
                devices={kasaDevices}
                onClose={() => setShowKasaWindow(false)}
              />
            </div>
          </div>
        )}

        {/* Reminders Window */}
        {showRemindersWindow && (
          <RemindersWindow
            socket={socket}
            onClose={() => setShowRemindersWindow(false)}
            position={elementPositions.reminders}
            onMouseDown={(e) => handleMouseDown(e, 'reminders')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('reminders')}
          />
        )}

        {/* Notes Window */}
        {showNotesWindow && (
          <div
            id="notes"
            className={`absolute flex flex-col transition-[box-shadow,background-color,border-color] duration-200
              backdrop-blur-xl bg-white/[0.06] border border-white/[0.14] shadow-2xl overflow-hidden rounded-lg
              ${activeDragElement === 'notes' ? 'ring-2 ring-white/30 bg-white/[0.08]' : ''}
            `}
            style={{
              left: elementPositions.notes?.x,
              top: elementPositions.notes?.y,
              transform: 'translate(-50%, -50%)',
              width: `${elementSizes.notes.w}px`,
              height: `${elementSizes.notes.h}px`,
              pointerEvents: 'auto',
              zIndex: getZIndex('notes')
            }}
            onMouseDown={(e) => handleMouseDown(e, 'notes')}
          >
            <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-10 pointer-events-none mix-blend-overlay z-10" />
            <div className="relative z-20 w-full h-full">
              <NotesWindow
                socket={socket}
                onClose={() => setShowNotesWindow(false)}
              />
            </div>
          </div>
        )}

        {/* Tool Confirmation Modal */}
        <ConfirmationPopup
          request={confirmationRequest}
          onConfirm={handleConfirmTool}
          onDeny={handleDenyTool}
        />
      </div>
    </div>
  );
}

function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}

export default App;
