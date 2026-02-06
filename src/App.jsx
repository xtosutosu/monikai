import React, { useEffect, useState, useRef, useMemo } from 'react';
import io from 'socket.io-client';

import Visualizer from './components/Visualizer';
import BrowserWindow from './components/BrowserWindow';
import ChatModule from './components/ChatModule';
import ToolsModule from './components/ToolsModule';
import { X, Minus, Clock, Lightbulb, Activity, Bell, AlertCircle } from 'lucide-react';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import ConfirmationPopup from './components/ConfirmationPopup';
import AuthLock from './components/AuthLock';
import KasaWindow from './components/KasaWindow';
import SettingsWindow from './components/SettingsWindow';
import RemindersWindow from './components/RemindersWindow';
import NotesWindow from './components/NotesWindow';
import PersonalityWindow from './components/PersonalityWindow';
import CameraWindow from './components/CameraWindow';
import ScreenWindow from './components/ScreenWindow';
import CompanionWindow from './components/CompanionWindow';
import SessionPromptWindow from './components/SessionPromptWindow';
import { LanguageProvider, useLanguage } from './contexts/LanguageContext';

const socket = io('http://localhost:8000');
const { ipcRenderer } = window.require('electron');

const getDefaultPositions = () => ({
  video: { x: window.innerWidth - 230, y: window.innerHeight - 210 },
  screen: { x: window.innerWidth - 230, y: window.innerHeight - 210 },
  visualizer: { x: window.innerWidth / 2, y: window.innerHeight / 2 - 150 }, // no longer used for VN
  chat: { x: window.innerWidth / 2, y: window.innerHeight / 2 + 100 },       // will be docked
  browser: { x: 320, y: window.innerHeight - 315 },
  kasa: { x: window.innerWidth - 620, y: 310 },
  reminders: { x: window.innerWidth - 230, y: 340 },
  notes: { x: 270, y: 360 },
  tools: { x: window.innerWidth / 2, y: window.innerHeight - 115 },
  companion: { x: window.innerWidth / 2, y: window.innerHeight / 2 }
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
  const [showCompanionWindow, setShowCompanionWindow] = useState(false);

  const [currentTime, setCurrentTime] = useState(new Date());

  // ---------------------------------------------------------------------
  // VN Scene / Background (dynamic)
  // ---------------------------------------------------------------------
  const VN_BACKGROUNDS = {
    room: "/vn/location/bg_room.png",
    kitchen: "/vn/location/bg_kitchen.png",
    outside: "/vn/location/bg_outside.png",
    school: "/vn/location/bg_school.png",
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

    const ON = 0.06;
    const OFF = 0.04;
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
    // Reset user speaking state if muted or disconnected
    if (!isConnected || isMuted) {
      setUserSpeaking(false);
      if (userOffTimerRef.current) {
        clearTimeout(userOffTimerRef.current);
        userOffTimerRef.current = null;
      }
    }
  }, [isConnected, isMuted]);

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
  const [showPersonalityWindow, setShowPersonalityWindow] = useState(false);
  const [toolPermissions, setToolPermissions] = useState({});
  const [personalityState, setPersonalityState] = useState({ mood: 'neutral', affection: 0 });
  const [sessionMode, setSessionMode] = useState({ active: false, kind: 'reflective' });
  const [sessionPromptQueue, setSessionPromptQueue] = useState([]);

  // ---------------------------------------------------------------------
  // Modular/Windowed State (kept for your movable windows)
  // ---------------------------------------------------------------------
  const [isModularMode, setIsModularMode] = useState(false);

  const [elementPositions, setElementPositions] = useState(getDefaultPositions);

  const [elementSizes, setElementSizes] = useState({
    visualizer: { w: 550, h: 350 }, // no longer used for VN
    chat: { w: 980, h: 320 },
    tools: { w: 500, h: 80 },
    browser: { w: 600, h: 450 },
    video: { w: 360, h: 240 },
    screen: { w: 360, h: 240 },
    kasa: { w: 320, h: 500 },
    reminders: { w: 420, h: 560 },
    notes: { w: 500, h: 600 },
    companion: { w: 400, h: 500 },
  });

  const [activeDragElement, setActiveDragElement] = useState(null);

  // Z-Index Stacking Order (last element = highest z-index)
  const [zIndexOrder, setZIndexOrder] = useState([
    'visualizer', 'chat', 'tools', 'video', 'screen', 'browser', 'kasa', 'reminders', 'notes', 'companion'
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
  const makeId = () =>
    (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`;

  const pushToast = (text, variant = "system", ttl = 3500) => {
    const id = makeId();

    const toast = { id, text: String(text ?? ""), variant };

    setToasts(prev => [...prev, toast]);

    window.setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, ttl);
  };

  const dismissToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const enqueueSessionPrompt = (payload) => {
    if (!payload) return;
    setSessionPromptQueue(prev => [
      ...prev,
      { ...payload, _id: payload._id || payload.id || makeId() }
    ]);
  };

  const popSessionPrompt = () => {
    setSessionPromptQueue(prev => prev.slice(1));
  };

  const clearSessionPrompts = () => {
    setSessionPromptQueue([]);
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

      const baseChatMax = width - sidePad * 2;
      const sessionInset = sessionMode.active ? Math.min(180, Math.round(width * 0.12)) : 0;
      const minChatW = Math.min(520, baseChatMax);
      const chatW = Math.min(980, baseChatMax - sessionInset);
      const chatWFinal = Math.max(minChatW, chatW);

      // keep chat readable on small screens:
      const maxChatH = Math.min(360, Math.round(height * 0.30));
      const minChatH = 240;
      const chatH = Math.max(minChatH, maxChatH);

      // IMPORTANT: your ChatModule likely treats y as TOP (not center)
      const chatTop = Math.max(
        topBarHeight + 14,
        height - bottomToolsArea - bottomPad - chatH
      );

      const desiredChatX = width / 2 - Math.round(sessionInset * 0.5);
      const minChatX = chatWFinal / 2 + sidePad;
      const maxChatX = width - chatWFinal / 2 - sidePad;
      const chatX = Math.max(minChatX, Math.min(maxChatX, desiredChatX));

      setElementSizes(prev => ({
        ...prev,
        chat: { w: chatWFinal, h: chatH }
      }));

      setElementPositions(prev => ({
        ...prev,
        chat: { x: chatX, y: chatTop },
        tools: { x: width / 2, y: height - 100 },
        video: { x: width - 230, y: height - 210 },
        screen: { x: width - 230, y: height - 210 }
      }));
    };

    layout();
    window.addEventListener('resize', layout);
    return () => window.removeEventListener('resize', layout);
  }, [sessionMode.active]);

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
      const now = new Date();
      setCurrentTime(now);
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

  // ---------------------------------------------------------------------
  // Blinking Logic
  // ---------------------------------------------------------------------
  const [isBlinking, setIsBlinking] = useState(false);
  useEffect(() => {
    let timeout;
    const triggerBlink = () => {
      setIsBlinking(true);
      setTimeout(() => setIsBlinking(false), 150); // Blink duration
      timeout = setTimeout(triggerBlink, Math.random() * 3000 + 3000); // Random interval 3-6s
    };
    timeout = setTimeout(triggerBlink, 3000);
    return () => clearTimeout(timeout);
  }, []);

  // ---------------------------------------------------------------------
  // Random Glance Logic
  // ---------------------------------------------------------------------
  const [randomGlance, setRandomGlance] = useState(null);
  useEffect(() => {
    let timeout;
    const triggerGlance = () => {
      const roll = Math.random();
      if (roll < 0.3) {
        setRandomGlance('left');
        setTimeout(() => setRandomGlance(null), Math.random() * 1000 + 800);
      } else if (roll < 0.6) {
        setRandomGlance('right');
        setTimeout(() => setRandomGlance(null), Math.random() * 1000 + 800);
      }
      timeout = setTimeout(triggerGlance, Math.random() * 5000 + 4000);
    };
    timeout = setTimeout(triggerGlance, 5000);
    return () => clearTimeout(timeout);
  }, []);

  // ---------------------------------------------------------------------
  // Random Pose Logic (Fidgeting)
  // ---------------------------------------------------------------------
  const [randomPose, setRandomPose] = useState(null); // null, 'crossed', 'point', 'steepling'
  
  // Refs to access latest state in timeout without resetting it
  const aiSpeakingRef = useRef(aiSpeaking);
  useEffect(() => { aiSpeakingRef.current = aiSpeaking; }, [aiSpeaking]);

  useEffect(() => {
    let timeout;
    const triggerPose = () => {
      const isSpeaking = aiSpeakingRef.current;
      const roll = Math.random();

      if (isSpeaking) {
        // Active talking gestures (prioritize restpoint)
        if (roll < 0.50) {
          setRandomPose('restpoint');
          setTimeout(() => setRandomPose(null), Math.random() * 3000 + 3000);
        } else if (roll < 0.70) {
          setRandomPose('point');
          setTimeout(() => setRandomPose(null), Math.random() * 2000 + 2000);
        } else {
          setRandomPose(null);
        }
        timeout = setTimeout(triggerPose, Math.random() * 3000 + 2000);
      } else {
        // Idle fidgeting
        if (roll < 0.20) {
          setRandomPose('crossed');
          setTimeout(() => setRandomPose(null), Math.random() * 5000 + 5000);
        } else if (roll < 0.90) {
          setRandomPose('steepling');
          setTimeout(() => setRandomPose(null), Math.random() * 5000 + 5000);
        } else {
          setRandomPose(null);
        }
        timeout = setTimeout(triggerPose, Math.random() * 5000 + 5000);
      }
    };
    timeout = setTimeout(triggerPose, 2000);
    return () => clearTimeout(timeout);
  }, []);

  // ---------------------------------------------------------------------
  // MAS Layer Logic (Monika After Story Assets)
  // ---------------------------------------------------------------------
  const currentHour = currentTime.getHours();
  const currentMonth = currentTime.getMonth(); // 0-11
  const currentDay = currentTime.getDate();

  // Calculate Outfit State (Folder, Hair, Name)
  const visualState = useMemo(() => {
    const mood = (personalityState.mood || 'neutral').toLowerCase();
    const affection = personalityState.affection || 0;
    const weather = (personalityState.weather || '').toLowerCase();
    
    // Hair Style Logic
    // Day (7-20): def (Ponytail)
    // Night (20-7): down (Loose)
    let hairStyle = 'def';
    const isNight = currentHour >= 20 || currentHour < 7;
    // Shower times: 6-8 AM and 19-21 PM
    const isShowerTime = (currentHour >= 6 && currentHour < 8) || (currentHour >= 19 && currentHour < 21);

    if (isNight) {
      hairStyle = 'down';
    }
    
    // Clothes Logic
    let clothesFolder = 'def';
    let outfitName = "School Uniform";

    // New Year (Dec 31 - Jan 1)
    if ((currentMonth === 11 && currentDay === 31) || (currentMonth === 0 && currentDay === 1)) {
      clothesFolder = 'new_year';
      outfitName = "New Year's Dress";
    } else if (currentMonth === 1 && currentDay === 14) {
      // Valentine's Day (Feb 14)
      clothesFolder = isNight ? 'vday_lingerie' : 'blackpinkdress';
      outfitName = isNight ? "Valentine's Lingerie" : "Blackpink Dress";
    } else if (currentMonth === 9 && currentDay === 31) {
      // Halloween (Oct 31)
      clothesFolder = isNight ? 'spider_lingerie' : 'marisa';
      outfitName = isNight ? "Spider Lingerie" : "Witch Cosplay (Marisa)";
    } else if (currentMonth === 11 && (currentDay >= 24 && currentDay <= 26)) {
      // Christmas (Dec 24-26)
      clothesFolder = isNight ? 'santa_lingerie' : 'santa';
      outfitName = isNight ? "Santa Lingerie" : "Santa Costume";
    } else {
      // Intimacy Logic (High Affection + Flirty/Love + Night)
      if (isNight && affection > 50 && (mood.includes('flirty') || mood.includes('love') || mood.includes('romantic'))) {
         clothesFolder = 'vday_lingerie';
         outfitName = "Valentine's Lingerie";
      } else if (isShowerTime) {
         // Shower / Towel Mode
         clothesFolder = 'bath_towel_white';
         hairStyle = 'wet';
         outfitName = "White Bath Towel";
      } else if (!isNight && (weather.includes('sunny') || weather.includes('clear'))) {
         clothesFolder = 'sundress_white';
         outfitName = "White Sundress";
      } else if (!isNight && (showNotesWindow || mood.includes('focus') || mood.includes('thinking') || mood.includes('learning') || mood.includes('studying'))) {
         clothesFolder = 'blazerless';
         outfitName = "School Uniform (Blazerless)";
      } else if (isNight) {
         outfitName = "Pajamas (Pink Shirt)"; // Assuming default night look
      }
    }

    // Canon override: when Monika is outside, she wears the school uniform.
    if (vnScene === 'outside') {
      clothesFolder = 'def';
      outfitName = "School Uniform";
    }

    return { clothesFolder, hairStyle, outfitName };
  }, [personalityState.mood, personalityState.affection, personalityState.weather, currentHour, currentMonth, currentDay, showNotesWindow, vnScene]);

  // Report Visual State to Backend
  useEffect(() => {
    if (socketConnected) {
      socket.emit('report_visual_state', { 
        location: vnScene, 
        outfit: visualState.outfitName 
      });
    }
  }, [vnScene, visualState.outfitName, socketConnected]);

  const masLayers = useMemo(() => {
    const mood = (personalityState.mood || 'neutral').toLowerCase();
    const { clothesFolder, hairStyle } = visualState;
    
    // Determine Pose based on mood
    const isLeaning = mood.includes('leaning') || mood.includes('mysterious') || mood.includes('foggy') || mood.includes('dream') || mood.includes('love') || mood.includes('enchanted');

    // Arm Style Logic (moved up for shared use)
    let armStyle = 'def'; // def, crossed, point, steepling, restpoint
    if (!isLeaning) {
      if (mood.includes('angry') || mood.includes('annoyed') || mood.includes('bored')) {
        armStyle = 'crossed';
      } else if (mood.includes('thinking') || mood.includes('focus')) {
        armStyle = 'steepling';
      } else if (mood.includes('explaining') || mood.includes('teaching')) {
        armStyle = 'point';
      } else if (randomPose) {
        armStyle = randomPose;
      }
    }

    // --- OUTSIDE SCENE OVERRIDE (Single Layer Standing Poses) ---
    if (vnScene === 'outside') {
      let sprite = 'ai_normal.png';
      
      if (isLeaning) {
        sprite = 'ai_leaning.png';
      } else if (isBlinking) {
        sprite = 'ai_closed_eyes.png';
      } else if (armStyle === 'point') {
        sprite = (mood.includes('happy') || mood.includes('excited')) 
          ? 'ai_arm_point_happy.png' 
          : 'ai_arm_point_open.png';
      } else if (mood.includes('angry') || mood.includes('annoyed')) {
        sprite = 'ai_annoyed.png';
      } else if (mood.includes('worried') || mood.includes('sad') || mood.includes('anxious') || mood.includes('depressed')) {
        sprite = 'ai_worried.png';
      } else if (mood.includes('embarrassed')) {
        sprite = 'ai_embarrassed.png';
      } else if (mood.includes('shy') || mood.includes('love')) {
        sprite = 'ai_shy.png';
      } else if (mood.includes('happy') || mood.includes('excited')) {
        sprite = 'ai_happy.png'; 
      } else if (mood.includes('neutral')) {
        sprite = 'ai_neutral.png';
      }
      return [`/vn/monika/s/${sprite}`];
    }

    // Base path prefix for face parts
    // Normal: /vn/monika/f/face-[part].png
    // Leaning: /vn/monika/f/face-leaning-def-[part].png
    const facePrefix = isLeaning ? '/vn/monika/f/face-leaning-def-' : '/vn/monika/f/face-';

    // Default Face Parts
    let eyes = 'eyes-normal.png';
    let eyebrows = 'eyebrows-mid.png';
    let mouth = 'mouth-smile.png'; // Default closed mouth (listening)
    let nose = 'nose-def.png';
    let blush = null;

    // Mood Logic
    if (mood.includes('happy') || mood.includes('excited') || mood.includes('joy')) {
      mouth = 'mouth-smile.png';
      // eyes = 'eyes-closedhappy.png'; // Optional: happy closed eyes
    } else if (mood.includes('sad') || mood.includes('lonely') || mood.includes('depressed')) {
      eyebrows = 'eyebrows-knit.png';
    } else if (mood.includes('angry') || mood.includes('annoyed')) {
      eyebrows = 'eyebrows-furrowed.png';
      mouth = 'mouth-angry.png';
    } else if (mood.includes('love') || mood.includes('shy')) {
      eyes = 'eyes-soft.png';
      mouth = 'mouth-smile.png';
      blush = 'blush-shade.png'; 
    } else if (mood.includes('surprised') || mood.includes('shocked')) {
      eyes = 'eyes-wide.png';
      mouth = 'mouth-gasp.png';
      eyebrows = 'eyebrows-up.png';
    } else if (mood.includes('thinking')) {
      eyebrows = 'eyebrows-think.png';
      eyes = 'eyes-left.png';
    }

    // Random Glance Override
    if (randomGlance && !isBlinking) {
      // Don't override if eyes are closed (e.g. blinking or specific mood)
      if (!eyes.includes('closed')) {
        if (randomGlance === 'left') eyes = 'eyes-left.png';
        else if (randomGlance === 'right') eyes = 'eyes-right.png';
      }
    }

    // Blinking Override
    if (isBlinking) {
      if (mood.includes('angry') || mood.includes('annoyed')) {
        eyes = 'eyes-closedangry.png';
      } else {
        eyes = 'eyes-closedhappy.png';
      }
    }

    // Hair logic:
    // Normal: 0 (back), 10 (front)
    // Leaning: def-0 (back), def-10 (front)
    const hairBack = isLeaning ? `/vn/monika/h/${hairStyle}/def-0.png` : `/vn/monika/h/${hairStyle}/0.png`;
    const hairFront = isLeaning ? `/vn/monika/h/${hairStyle}/def-10.png` : `/vn/monika/h/${hairStyle}/10.png`;

    const layers = [
      '/vn/monika/t/chair-def.png',      // Chair (Background)
      hairBack,                          // Hair Back
    ];

    const armLayers = [];
    let headBase = null;

    if (isLeaning) {
      // Leaning Pose (Body + Arms + Head)
      layers.push(
        '/vn/monika/b/body-leaning-def-0.png',       // Body Skin
        '/vn/monika/b/body-leaning-def-1.png',       // Body Skin 1
        `/vn/monika/c/${clothesFolder}/body-leaning-def-1.png`    // Body Clothes 1
      );
      headBase = '/vn/monika/b/body-leaning-def-head.png';
      
      armLayers.push(
        '/vn/monika/b/arms-leaning-def-left-def-10.png', // Left Arm Skin
        `/vn/monika/c/${clothesFolder}/arms-leaning-def-left-def-10.png`, // Left Arm Clothes
        '/vn/monika/b/arms-leaning-def-right-def-10.png', // Right Arm Skin
        `/vn/monika/c/${clothesFolder}/arms-leaning-def-right-def-10.png` // Right Arm Clothes
      );
    } else {
      // Normal Pose (Body + Arms + Head)
      layers.push(
        '/vn/monika/b/body-def-0.png',       // Body Skin
        `/vn/monika/c/${clothesFolder}/body-def-0.png`,   // Body Clothes 0
        '/vn/monika/b/body-def-1.png',       // Body Skin 1
        `/vn/monika/c/${clothesFolder}/body-def-1.png`    // Body Clothes 1
      );
      headBase = '/vn/monika/b/body-def-head.png';

      // Arms based on style
      if (armStyle === 'crossed') {
        armLayers.push(
          '/vn/monika/b/arms-crossed-10.png',
          `/vn/monika/c/${clothesFolder}/arms-crossed-10.png`
        );
      } else if (armStyle === 'steepling') {
        armLayers.push(
          '/vn/monika/b/arms-steepling-10.png',
          `/vn/monika/c/${clothesFolder}/arms-steepling-10.png`
        );
      } else if (armStyle === 'point') {
        armLayers.push(
          '/vn/monika/b/arms-left-down-0.png', `/vn/monika/c/${clothesFolder}/arms-left-down-0.png`,
          '/vn/monika/b/arms-right-point-0.png', `/vn/monika/c/${clothesFolder}/arms-right-point-0.png`
        );
      } else if (armStyle === 'restpoint') {
        armLayers.push(
          '/vn/monika/b/arms-left-rest-10.png', `/vn/monika/c/${clothesFolder}/arms-left-rest-10.png`,
          '/vn/monika/b/arms-right-restpoint-10.png', `/vn/monika/c/${clothesFolder}/arms-right-restpoint-10.png`
        );
      } else {
        // Default Down
        armLayers.push(
          '/vn/monika/b/arms-left-down-0.png', `/vn/monika/c/${clothesFolder}/arms-left-down-0.png`,
          '/vn/monika/b/arms-right-down-0.png', `/vn/monika/c/${clothesFolder}/arms-right-down-0.png`
        );
      }
    }

    // Table & Shadow (Before Arms)
    layers.push('/vn/monika/t/table-def.png');
    layers.push('/vn/monika/t/table-def-s.png');

    // Arms
    layers.push(...armLayers);

    // Head Base (Face Skin)
    if (headBase) layers.push(headBase);

    // Face Parts (Nose -> Mouth -> Eyes -> Eyebrows)
    layers.push(facePrefix + nose, facePrefix + mouth, facePrefix + eyes, facePrefix + eyebrows);

    if (blush) layers.push(facePrefix + blush);

    // Front Hair
    layers.push(hairFront);

    return layers;
  }, [personalityState.mood, visualState, isBlinking, randomGlance, randomPose, vnScene]);

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

    socket.on('personality_status', (data) => {
      // Update local state for Visualizer layers
      setPersonalityState(prev => ({ ...prev, ...data }));
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
      if (settings.tool_permissions) {
        setToolPermissions(settings.tool_permissions);
      }
      setSettingsLoaded(true);
    });

    socket.on('error', (data) => {
      console.error("Socket Error:", data);
      pushToast(`Something feels off... (${data.msg})`, 'error');
    });

    socket.on('browser_frame', (data) => {
      setBrowserData(prev => ({
        image: data.image,
        logs: [...prev.logs, data.log].filter(l => l).slice(-50)
      }));
      setShowBrowserWindow(true);

      if (!elementPositions.browser) {
        const size = { w: 600, h: 450 };
        const clamped = clampToViewport({ x: 320, y: window.innerHeight - 315 }, size);
        setElementPositions(prev => ({ ...prev, browser: clamped }));
      }
    });

    socket.on('transcription', (data) => {
      // Trigger listening state only when text is actually transcribed
      if (data.sender === 'Ty' || data.sender === 'User') {
        setUserSpeaking(true);
        if (userOffTimerRef.current) clearTimeout(userOffTimerRef.current);
        userOffTimerRef.current = setTimeout(() => {
          setUserSpeaking(false);
        }, 3000);
      }

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

    socket.on('session_mode', (data) => {
      const active = !!(data && data.active);
      const kind = data?.kind || 'reflective';
      setSessionMode({ active, kind });
      if (!active) {
        clearSessionPrompts();
      }
      pushToast(active ? `Session mode: ${kind}` : 'Session mode ended', 'system');
    });

    socket.on('session_prompt', (payload) => {
      enqueueSessionPrompt(payload);
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
      socket.off('session_mode');
      socket.off('session_prompt');
      socket.off('error');
      socket.off('personality_status');
      socket.off('auth_status');
      socket.off('settings');

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
            const draggableElements = ['browser', 'kasa', 'reminders', 'notes', 'companion'];

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

  const toggleSessionMode = () => {
    if (!isConnected) return;
    const nextActive = !sessionMode.active;
    const kind = sessionMode.kind || 'reflective';
    socket.emit('session_mode_set', { active: nextActive, kind });
  };

  const handleSessionPromptSubmit = (payload) => {
    if (!payload) return;
    socket.emit('session_exercise_submit', payload);
  };

  const handleSessionSketchSave = (payload) => {
    if (!payload) return;
    socket.emit('session_sketch_save', payload);
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

  const handleTogglePermission = (key) => {
    setToolPermissions(prev => {
      const next = { ...prev, [key]: !prev[key] };
      socket.emit('update_settings', { tool_permissions: next });
      return next;
    });
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
    const fixedElements = ['visualizer', 'chat', 'video', 'screen'];
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

  // Shortcut for Companion Window (Alt+C)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.altKey && (e.code === 'KeyC')) {
        handleToggleWindow('companion', showCompanionWindow, setShowCompanionWindow);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showCompanionWindow]);

  const activeSessionPrompt = sessionPromptQueue.length ? sessionPromptQueue[0] : null;

  const sessionPromptPosition = useMemo(() => {
    const chatX = elementPositions.chat?.x ?? window.innerWidth / 2;
    const chatTop = elementPositions.chat?.y ?? 220;
    const chatW = elementSizes.chat?.w ?? 720;
    const placeInside = chatTop < 220;
    return {
      x: chatX,
      y: chatTop,
      width: Math.min(760, chatW),
      placement: placeInside ? 'inside' : 'above',
      viewportH: viewport.h,
    };
  }, [elementPositions.chat, elementSizes.chat, viewport.h]);
  const sessionVisualShift = sessionMode.active ? Math.min(180, Math.round(viewport.w * 0.12)) : 0;

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
          layers={masLayers} // Pass the composed layers
          sprites={{
            idle: isConnected ? "/vn/ai_idle.png" : "/vn/ai_sleeping.png",
            listen: "/vn/ai_listen.png",
            talk: ["/vn/ai_talk_1.png", "/vn/ai_talk_2.png"],
          }}
          isAssistantSpeaking={aiSpeaking}
          isUserSpeaking={userSpeaking}
          characterScale={1.20}
          characterY={-40}
          characterX={sessionVisualShift}
        />
        {/* Subtle VN vignette */}
        <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/20 to-black/55" />
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-15 mix-blend-overlay" />

        {/* Session Mode Overlay */}
        {sessionMode.active && (
          <div className="absolute inset-0 bg-gradient-to-b from-[#0f172a]/40 via-black/30 to-[#1f1a12]/50 border-t border-white/10" />
        )}

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
        className="z-50 flex items-center justify-between px-4 h-14 border-b border-white/10 bg-black/40 backdrop-blur-2xl select-none sticky top-0"
        style={{ WebkitAppRegion: 'drag' }}
      >
        <div className="flex items-center gap-6" style={{ WebkitAppRegion: 'no-drag' }}>
          {/* Logo / Personality Trigger */}
          <div 
            className="flex items-center gap-3 group cursor-pointer"
            onMouseEnter={() => setShowPersonalityWindow(true)}
            onMouseLeave={() => setShowPersonalityWindow(false)}
          >
            <div className="w-2 h-2 rounded-full bg-white shadow-[0_0_8px_white] group-hover:scale-125 transition-transform duration-300" />
            <h1 className="text-sm font-bold tracking-[0.25em] text-white/80 group-hover:text-white transition-colors uppercase">
              Monik.AI
            </h1>
          </div>

          {/* Status Chips */}
          <div className="flex items-center gap-2">
            {sessionMode.active && (
              <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/10 border border-white/20 text-[10px] font-mono text-white/80">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-300/80" />
                <span>SESSION</span>
              </div>
            )}
            {isVideoOn && (
              <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-mono text-white/50">
                <Activity size={10} className="text-green-400" />
                <span>FPS: {fps}</span>
              </div>
            )}

            {kasaDevices.length > 0 && (
              <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] font-mono text-white/50">
                <Lightbulb size={10} className="text-yellow-500" />
                <span>{kasaDevices.length} DEV</span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4" style={{ WebkitAppRegion: 'no-drag' }}>
          {/* Clock */}
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10">
            <Clock size={12} className="text-white" />
            <span className="text-xs font-mono text-white/80 tracking-wide">
              {currentTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          {/* Window Controls */}
          <div className="flex items-center gap-1 pl-4 border-l border-white/10">
            <button 
              onClick={handleMinimize} 
              className="p-2 hover:bg-white/10 rounded-lg text-white/50 hover:text-white transition-colors"
            >
              <Minus size={16} />
            </button>
            <button 
              onClick={handleMaximize} 
              className="p-2 hover:bg-white/10 rounded-lg text-white/50 hover:text-white transition-colors"
            >
              <div className="w-3.5 h-3.5 border-2 border-current rounded-[3px]" />
            </button>
            <button 
              onClick={handleCloseRequest} 
              className="p-2 hover:bg-red-500/20 hover:text-red-400 rounded-lg text-white/50 transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* Toasts (System notifications) */}
      <div className="fixed top-16 right-4 z-[100] flex flex-col gap-3 pointer-events-none">
        {toasts.map(t => (
          <div
            key={t.id}
            className="pointer-events-auto w-80 bg-black/60 backdrop-blur-2xl border border-white/10 rounded-xl shadow-2xl overflow-hidden animate-in slide-in-from-right-5 fade-in duration-300"
          >
            <div className="p-4 flex gap-3">
              <div className="shrink-0 mt-0.5">
                {t.variant === 'error' ? (
                  <div className="w-8 h-8 rounded-full bg-red-500/10 flex items-center justify-center text-red-400 border border-red-500/20">
                    <AlertCircle size={16} />
                  </div>
                ) : (
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-white border border-white/20">
                    <Bell size={16} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-white/90 leading-relaxed break-words">
                  {t.text}
                </p>
              </div>
              <button
                onClick={() => dismissToast(t.id)}
                className="shrink-0 -mt-1 -mr-1 p-1.5 text-white/30 hover:text-white hover:bg-white/10 rounded-lg transition-colors h-fit"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Main Content (over VN background) */}
      <div className="flex-1 relative z-10">
        {/* Floating Scope Label */}
        <div className="absolute top-[64px] left-1/2 -translate-x-1/2 text-white/65 text-xs tracking-widest pointer-events-none z-50 bg-black/50 px-2 py-1 rounded backdrop-blur-sm border border-white/12">
          GLOBAL
        </div>

        {/* Screen Window */}
        {visionMode === 'screen' && (
          <ScreenWindow
            imageSrc={visionFrame}
            onClose={toggleScreenCapture}
            position={elementPositions.screen}
            onMouseDown={(e) => handleMouseDown(e, 'screen')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('screen')}
          />
        )}

        {/* Camera Window */}
        {isVideoOn && (
          <CameraWindow
            videoRef={videoRef}
            canvasRef={canvasRef}
            isCameraFlipped={isCameraFlipped}
            onClose={toggleVideo}
            position={elementPositions.video}
            onMouseDown={(e) => handleMouseDown(e, 'video')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('video')}
          />
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
            toolPermissions={toolPermissions}
            onTogglePermission={handleTogglePermission}
            handleFileUpload={handleFileUpload}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* Browser Window */}
        {showBrowserWindow && (
          <BrowserWindow
            imageSrc={browserData.image}
            logs={browserData.logs}
            onClose={() => setShowBrowserWindow(false)}
            socket={socket}
            position={elementPositions.browser}
            onMouseDown={(e) => handleMouseDown(e, 'browser')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('browser')}
          />
        )}

        {/* Session Prompt Window (dynamic, above chat) */}
        {activeSessionPrompt && (
          <SessionPromptWindow
            prompt={activeSessionPrompt}
            position={sessionPromptPosition}
            onClose={popSessionPrompt}
            onSubmit={(payload) => {
              handleSessionPromptSubmit(payload);
              popSessionPrompt();
            }}
            onSketchSave={(payload) => {
              handleSessionSketchSave(payload);
              popSessionPrompt();
            }}
            zIndex={95}
          />
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

        {/* Tools Module */}
          <ToolsModule
            isConnected={isConnected}
            isMuted={isMuted}
            isVideoOn={isVideoOn}
            isScreenCaptureOn={visionMode === 'screen'}
            isHandTrackingEnabled={isHandTrackingEnabled}
            sessionActive={sessionMode.active}
            showSettings={showSettings}
            onTogglePower={togglePower}
            onToggleMute={toggleMute}
            onToggleVideo={toggleVideo}
            onToggleScreenCapture={toggleScreenCapture}
            onToggleSettings={() => setShowSettings(!showSettings)}
            onToggleSession={toggleSessionMode}
            onToggleReminders={() => handleToggleWindow('reminders', showRemindersWindow, setShowRemindersWindow)}
            showRemindersWindow={showRemindersWindow}
            onToggleNotes={() => handleToggleWindow('notes', showNotesWindow, setShowNotesWindow)}
            showNotesWindow={showNotesWindow}
            onToggleHand={() => setIsHandTrackingEnabled(!isHandTrackingEnabled)}
            onToggleKasa={() => handleToggleWindow('kasa', showKasaWindow, setShowKasaWindow)}
            showKasaWindow={showKasaWindow}
            onToggleBrowser={() => handleToggleWindow('browser', showBrowserWindow, setShowBrowserWindow)}
            showBrowserWindow={showBrowserWindow}
            onToggleCompanion={() => handleToggleWindow('companion', showCompanionWindow, setShowCompanionWindow)}
            showCompanionWindow={showCompanionWindow}
            onResetPosition={handleResetPosition}
            activeDragElement={activeDragElement}
            position={elementPositions.tools}
            onMouseDown={(e) => handleMouseDown(e, 'tools')}
            zIndex={getZIndex('tools')}
          />

        {/* Kasa Window */}
        {showKasaWindow && (
          <KasaWindow
            socket={socket}
            devices={kasaDevices}
            onClose={() => setShowKasaWindow(false)}
            position={elementPositions.kasa}
            onMouseDown={(e) => handleMouseDown(e, 'kasa')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('kasa')}
          />
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
          <NotesWindow
            socket={socket}
            onClose={() => setShowNotesWindow(false)}
            position={elementPositions.notes}
            onMouseDown={(e) => handleMouseDown(e, 'notes')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('notes')}
          />
        )}

        {/* Companion Window */}
        {showCompanionWindow && (
          <CompanionWindow
            socket={socket}
            onClose={() => setShowCompanionWindow(false)}
            position={elementPositions.companion}
            onMouseDown={(e) => handleMouseDown(e, 'companion')}
            activeDragElement={activeDragElement}
            zIndex={getZIndex('companion')}
          />
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
      <style>{`
        ::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        ::-webkit-scrollbar-track {
          background: transparent;
        }
        ::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 3px;
          transition: background 0.2s ease;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.4);
        }
        ::-webkit-scrollbar-corner {
          background: transparent;
        }
        * {
          scrollbar-width: thin;
          scrollbar-color: rgba(255, 255, 255, 0.1) transparent;
        }
      `}</style>
      <AppContent />
    </LanguageProvider>
  );
}

export default App;
