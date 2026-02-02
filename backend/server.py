import sys
import asyncio

# Fix for asyncio subprocess support on Windows
# MUST BE SET BEFORE OTHER IMPORTS
if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import socketio
import uvicorn
from fastapi import FastAPI
import asyncio
from contextlib import asynccontextmanager
import threading
import sys
import os
import json
import time
from datetime import datetime
from pathlib import Path
from dataclasses import asdict



# Ensure we can import monikai
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

import monikai
from authenticator import FaceAuthenticator
from kasa_agent import KasaAgent

def _determine_sprite(state_dict: dict) -> str:
    """
    Determines the visual sprite based on personality state.
    Returns a filename stem (e.g. 'monika_happy') expected in /public/vn/.
    """
    mood = (state_dict.get("mood") or "neutral").lower()
    affection = float(state_dict.get("affection") or 0.0)
    energy = float(state_dict.get("energy") or 0.8)
    
    # Base mapping
    variant = "neutral"
    
    # Energy overrides
    if energy < 0.35:
        variant = "tired"
    
    # Mood overrides
    elif "happy" in mood or "sunny" in mood or "excited" in mood:
        variant = "happy"
    elif "sad" in mood or "rainy" in mood or "depressed" in mood or "lonely" in mood:
        variant = "sad"
    elif "angry" in mood or "annoyed" in mood:
        variant = "angry"
    elif "surprised" in mood or "shocked" in mood:
        variant = "surprised"
    elif "shy" in mood or "embarrassed" in mood or "flirty" in mood:
        variant = "shy"
    elif "mysterious" in mood or "foggy" in mood:
        variant = "leaning"
    elif "love" in mood:
        variant = "love"

    # Affection overrides (if not already negative mood)
    if variant not in ("sad", "angry", "tired"):
        if affection > 40.0 and variant == "neutral":
            variant = "happy"
        if affection > 80.0 and variant in ("happy", "neutral", "shy"):
            variant = "love"
            
    return f"monika_{variant}"


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Code to run on startup
    print(f"[SERVER DEBUG] Startup Event Triggered")
    print(f"[SERVER DEBUG] Python Version: {sys.version}")
    try:
        loop = asyncio.get_running_loop()
        print(f"[SERVER DEBUG] Running Loop: {type(loop)}")
        policy = asyncio.get_event_loop_policy()
        print(f"[SERVER DEBUG] Current Policy: {type(policy)}")
    except Exception as e:
        print(f"[SERVER DEBUG] Error checking loop: {e}")

    print("[SERVER] Startup: Initializing Kasa Agent...")
    await kasa_agent.initialize()

    # Initialize Global Managers (Persistent across AI sessions)
    global calendar_manager, reminder_manager, personality_system
    base_dir = Path(os.path.dirname(os.path.abspath(__file__)))
    data_dir = base_dir.parent / "data"
    user_memory_dir = data_dir / "user_memory"
    user_memory_dir.mkdir(parents=True, exist_ok=True)

    # 1. Calendar
    def on_calendar_update_server():
        if calendar_manager:
            events = [e.__dict__ for e in calendar_manager.get_all_events()]
            asyncio.create_task(sio.emit('calendar_data', events))
    
    calendar_manager = monikai.CalendarManager(storage_dir=user_memory_dir, on_update=on_calendar_update_server)
    calendar_manager.load()
    print("[SERVER] Calendar Manager initialized.")

    # 2. Reminders
    async def on_reminder_fired_server(rem):
        # Emit to UI
        payload = {
            "id": rem.id, "message": rem.message, "when_iso": rem.when_iso,
            "speak": bool(rem.speak), "alert": bool(getattr(rem, "alert", True))
        }
        asyncio.create_task(sio.emit('reminder_fired', payload))
        asyncio.create_task(sio.emit('reminders_list', {'reminders': _serialize_reminders()}))
        
        # If AI is running, let it handle speaking/logging
        if audio_loop:
            await audio_loop.handle_reminder_fired(rem)

    reminder_manager = monikai.ReminderManager(get_time_context_fn=monikai.get_time_context, storage_dir=user_memory_dir, on_reminder=on_reminder_fired_server)
    reminder_manager.load()
    print("[SERVER] Reminder Manager initialized.")

    # 3. Personality
    def on_personality_update_server(state):
        data = asdict(state)
        data["sprite"] = _determine_sprite(data)
        asyncio.create_task(sio.emit('personality_status', data))
    
    personality_system = monikai.PersonalitySystem(storage_dir=user_memory_dir, on_update=on_personality_update_server)
    print("[SERVER] Personality System initialized.")

    yield

# Create a Socket.IO server
sio = socketio.AsyncServer(async_mode='asgi', cors_allowed_origins='*')
app = FastAPI(lifespan=lifespan)
app_socketio = socketio.ASGIApp(sio, app)

import signal

# --- SHUTDOWN HANDLER ---
def signal_handler(sig, frame):
    print(f"\n[SERVER] Caught signal {sig}. Exiting gracefully...")
    # Clean up audio loop
    if audio_loop:
        try:
            print("[SERVER] Stopping Audio Loop...")
            audio_loop.stop() 
        except:
            pass
    # Force kill
    print("[SERVER] Force exiting...")
    os._exit(0)

signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)

# Global state
audio_loop = None
calendar_manager = None
reminder_manager = None
personality_system = None
loop_task = None
authenticator = None
kasa_agent = KasaAgent()
BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = BASE_DIR.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)
SETTINGS_FILE = DATA_DIR / "settings.json"
last_start_params = {}

DEFAULT_SETTINGS = {
    "face_auth_enabled": False, # Default OFF as requested
    "show_internal_thoughts": False, # UI Toggle state
    "tool_permissions": {
        "cancel_reminder": True,
        "control_light": True,
        "create_project": True,
        "clear_work_memory": True,
        "notes_set": True,
        "run_web_agent": True,
        "switch_project": True,
        "write_file": True
    },# List of {host, port, name, type}
    "kasa_devices": [], # List of {ip, alias, model}
    "camera_flipped": False, # Invert cursor horizontal direction
    "camera_source": "frontend", # "frontend" uses UI stream; "backend" uses OpenCV
    "video_mode": "none", # none | screen | camera
    "camera_capture": { # backend camera capture (if enabled)
        "fps": 2.0,
        "max_size": 1024,
        "jpeg_quality": 80
    },
    "screen_capture": { # backend screen capture (if enabled)
        "fps": 6.0,
        "max_size": 1920,
        "jpeg_quality": 85,
        "monitor": 1,
        "format": "jpeg",
        "region": None,
        "mode": "continuous"
    },
    "proactivity": {
        "idle_nudges": {
            "enabled": True,
           "threshold_sec": 180,
            "cooldown_sec": 300,
            "min_ai_quiet_sec": 10,
            "max_per_session": 6,
            "max_per_hour": 12,
            "topic_memory_size": 6
        },
        "reasoning": {
            "enabled": True,
            "interval_sec": 10.0
        }
    }
}

SETTINGS = DEFAULT_SETTINGS.copy()

def load_settings():
    global SETTINGS
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r') as f:
                loaded = json.load(f)
                # Merge with defaults to ensure new keys exist
                # Deep merge for tool_permissions would be better but shallow merge of top keys + tool_permissions check is okay for now
                for k, v in loaded.items():
                    if k == "tool_permissions" and isinstance(v, dict):
                         SETTINGS["tool_permissions"].update(v)
                    elif k == "proactivity" and isinstance(v, dict):
                        for pk, pv in v.items():
                            if pk == "idle_nudges" and isinstance(pv, dict):
                                SETTINGS["proactivity"]["idle_nudges"].update(pv)
                            else:
                                SETTINGS["proactivity"][pk] = pv
                    else:
                        SETTINGS[k] = v
            print(f"Loaded settings: {SETTINGS}")
        except Exception as e:
            print(f"Error loading settings: {e}")

def save_settings():
    try:
        with open(SETTINGS_FILE, 'w') as f:
            json.dump(SETTINGS, f, indent=4)
        print("Settings saved.")
    except Exception as e:
        print(f"Error saving settings: {e}")

# Load on startup
load_settings()

authenticator = None
kasa_agent = KasaAgent(known_devices=SETTINGS.get("kasa_devices"))
# tool_permissions is now SETTINGS["tool_permissions"]

@app.get("/status")
async def status():
    return {"status": "running", "service": "MonikAI Backend"}

@sio.event
async def connect(sid, environ):
    print(f"[SYSTEM NOTIFICATION] Client connected: {sid}")
    await sio.emit('status', {'msg': 'Connected to MonikAI Backend'}, room=sid)

    global authenticator
    
    # Callback for Auth Status
    async def on_auth_status(is_auth):
        print(f"[SERVER] Auth status change: {is_auth}")
        await sio.emit('auth_status', {'authenticated': is_auth})

    # Callback for Auth Camera Frames
    async def on_auth_frame(frame_b64):
        await sio.emit('auth_frame', {'image': frame_b64})

    # Initialize Authenticator if not already done
    if authenticator is None:
        authenticator = FaceAuthenticator(
            reference_image_path=str(DATA_DIR / "reference.jpg"),
            on_status_change=on_auth_status,
            on_frame=on_auth_frame
        )
    
    # Check if already authenticated or needs to start
    if authenticator.authenticated:
        await sio.emit('auth_status', {'authenticated': True})
    else:
        # Check Settings for Auth
        if SETTINGS.get("face_auth_enabled", False):
            await sio.emit('auth_status', {'authenticated': False})
            # Start the auth loop in background
            asyncio.create_task(authenticator.start_authentication_loop())
        else:
            # Bypass Auth
            print("Face Auth Disabled. Auto-authenticating.")
            # We don't change authenticator state to true to avoid confusion if re-enabled? 
            # Or we should just tell client it's auth'd.
            await sio.emit('auth_status', {'authenticated': True})

@sio.event
async def disconnect(sid):
    print(f"Client disconnected: {sid}")

@sio.event
async def start_audio(sid, data=None):
    global audio_loop, loop_task, last_start_params
    
    # Save params for auto-restart
    last_start_params = {'sid': sid, 'data': data}
    
    # Optional: Block if not authenticated
    # Only block if auth is ENABLED and not authenticated
    if SETTINGS.get("face_auth_enabled", False):
        if authenticator and not authenticator.authenticated:
            print("[SYSTEM ERROR] Blocked start_audio: Not authenticated.")
            await sio.emit('error', {'msg': 'Authentication Required'})
            return

    print("[SYSTEM NOTIFICATION] Starting Audio Loop...")
    
    device_index = None
    device_name = None
    if data:
        if 'device_index' in data:
            device_index = data['device_index']
        if 'device_name' in data:
            device_name = data['device_name']
            
    print(f"[SYSTEM NOTIFICATION] Using input device: Name='{device_name}', Index={device_index}")
    
    if loop_task and not loop_task.done():
        print("[SYSTEM NOTIFICATION] Audio loop already running. Re-connecting client to session.")
        await sio.emit('status', {'msg': 'MonikAI Already Running'})
        return
    if audio_loop:
        if loop_task and (loop_task.done() or loop_task.cancelled()):
            print("[SYSTEM NOTIFICATION] Audio loop task appeared finished/cancelled. Clearing and restarting...")
            audio_loop = None
            loop_task = None
        else:
            print("[SYSTEM NOTIFICATION] Audio loop already running. Re-connecting client to session.")
            await sio.emit('status', {'msg': 'MonikAI Already Running'})
            return


    # Callback to send audio data to frontend
    def on_audio_data(data_bytes):
        # We need to schedule this on the event loop
        # This is high frequency, so we might want to downsample or batch if it's too much
        asyncio.create_task(sio.emit('audio_data', {'data': list(data_bytes)}))

    # Callback to send Browser data to frontend
    def on_web_data(data):
        print(f"Sending Browser data to frontend: {len(data.get('log', ''))} chars logs")
        asyncio.create_task(sio.emit('browser_frame', data))
        
    # Callback to send Transcription data to frontend
    def on_transcription(data):
        # data = {"sender": "User"|"MonikAI", "text": "..."}
        asyncio.create_task(sio.emit('transcription', data))

        # Scene switching based on user text
        try:
            sender = (data or {}).get("sender", "")
            if sender in ("Ty", "User"):
                global _vn_user_buf, _vn_user_last_ts, _vn_scene_task
                _vn_user_buf = (_vn_user_buf + " " + (data.get("text") or "")).strip()[-400:]
                _vn_user_last_ts = time.time()
                if _vn_scene_task is None or _vn_scene_task.done():
                    _vn_scene_task = asyncio.create_task(_debounced_vn_scene_check())
        except Exception:
            pass

    # Callback to send Confirmation Request to frontend
    def on_tool_confirmation(data):
        # data = {"id": "uuid", "tool": "tool_name", "args": {...}}
        tool_name = data.get('tool', 'unknown')
        print(f"[SYSTEM NOTIFICATION] Requesting confirmation for tool: {tool_name}")
        asyncio.create_task(sio.emit('tool_confirmation_request', data))

    # Callback to send Project Update to frontend
    def on_project_update(project_name):
        print(f"[SYSTEM NOTIFICATION] Project updated to: {project_name}")
        asyncio.create_task(sio.emit('project_update', {'project': project_name}))

    # Callback to send Device Update to frontend
    def on_device_update(devices):
        # devices is a list of dicts
        print(f"[SYSTEM NOTIFICATION] Smart device list updated: {len(devices)} devices found.")
        asyncio.create_task(sio.emit('kasa_devices', devices))

    # Callback to send Notes update to frontend
    def on_notes_update(payload):
        try:
            print("[SYSTEM NOTIFICATION] Notes were updated.")
            asyncio.create_task(sio.emit('notes_data', payload))
        except Exception:
            pass

    # Callback to send Error to frontend
    def on_error(msg):
        print(f"[SYSTEM ERROR] {msg}")
        asyncio.create_task(sio.emit('error', {'msg': msg}))

    # Callback to send Vision Frames (screen/camera) to frontend
    def on_video_frame(payload):
        try:
            asyncio.create_task(sio.emit('vision_frame', payload))
        except Exception:
            pass

    # Callback to send a reminder/timer alarm event to frontend (for ringing / notifications)
    def on_reminder_fired(payload):
        try:
            message = payload.get('message', 'No message')
            print(f"[SYSTEM NOTIFICATION] Reminder fired: {message}")
            asyncio.create_task(sio.emit('reminder_fired', payload))
            # Also push an updated list so UI stays consistent
            asyncio.create_task(sio.emit('reminders_list', {'reminders': _serialize_reminders()}))
        except Exception as e:
            print(f"[SERVER] Failed to emit reminder_fired: {e}")

    # Callback for Calendar data
    def on_calendar_update(events):
        try:
            print(f"[SERVER] Emitting calendar_data with {len(events)} events.")
            asyncio.create_task(sio.emit('calendar_data', events))
        except Exception as e:
            print(f"[SERVER] Failed to emit calendar_data: {e}")

    # Callback for Personality data
    def on_personality_update(data):
        try:
            if "sprite" not in data:
                data["sprite"] = _determine_sprite(data)
            asyncio.create_task(sio.emit('personality_status', data))
        except Exception as e:
            print(f"[SERVER] Failed to emit personality_status: {e}")

    # Callback for Internal Thoughts
    def on_internal_thought(thought):
        print(f"[SYSTEM NOTIFICATION] Internal Thought: {thought}")
        asyncio.create_task(sio.emit('internal_thought', {'thought': thought}))
        
        # Always emit to chat log so frontend can toggle visibility retroactively
        asyncio.create_task(sio.emit('transcription', {
            "sender": "Monika (Thought)",
            "text": f"💭 {thought}",
            "is_new": True
        }))

    def on_reminders_updated():
        try:
            asyncio.create_task(sio.emit('reminders_list', {'reminders': _serialize_reminders()}))
        except Exception as e:
            print(f"[SERVER] Failed to emit reminders_list update: {e}")

    # Initialize MonikAI
    try:
        video_mode = "none"
        if data and isinstance(data, dict) and data.get("video_mode"):
            video_mode = str(data.get("video_mode")).lower()
        else:
            video_mode = str(SETTINGS.get("video_mode", "none")).lower()

        print(f"[SYSTEM NOTIFICATION] Initializing AudioLoop with device_index={device_index}, video_mode={video_mode}")
        audio_loop = monikai.AudioLoop(
            video_mode=video_mode,
            on_audio_data=on_audio_data,
            on_video_frame=on_video_frame,
            on_web_data=on_web_data,
            on_transcription=on_transcription,
            on_tool_confirmation=on_tool_confirmation,
            on_project_update=on_project_update,
            on_device_update=on_device_update,
            on_notes_update=on_notes_update,
            on_error=on_error,
            on_reminder_fired=on_reminder_fired,
            on_reminders_updated=on_reminders_updated,
            on_calendar_update=on_calendar_update,
            on_personality_update=on_personality_update,
            on_internal_thought=on_internal_thought,

            input_device_index=device_index,
            input_device_name=device_name,
            kasa_agent=kasa_agent,
            calendar_manager=calendar_manager,
            reminder_manager=reminder_manager,
            personality=personality_system
            
        )
        print("[SYSTEM NOTIFICATION] AudioLoop initialized successfully.")
        try:
            audio_loop.note_user_activity("start_audio")
        except Exception:
            pass

        # Apply current permissions
        audio_loop.update_permissions(SETTINGS["tool_permissions"])
        
        # Check initial mute state
        if data and data.get('muted', False):
            print("[SYSTEM NOTIFICATION] Starting with Audio Paused")
            audio_loop.set_paused(True)

        print("[SYSTEM NOTIFICATION] Creating asyncio task for AudioLoop.run()")
        loop_task = asyncio.create_task(audio_loop.run())
        
        # Add a done callback to catch silent failures in the loop
        def handle_loop_exit(task):
            try:
                task.result()
            except asyncio.CancelledError:
                print("[SYSTEM NOTIFICATION] Audio Loop Cancelled")
            except Exception as e:
                print(f"[SYSTEM ERROR] Audio Loop Crashed: {e}. Attempting restart...")
                asyncio.create_task(sio.emit('status', {'msg': 'Connection lost. Reconnecting...'}))
                
                async def restart_session():
                    await asyncio.sleep(2)
                    # Use global params to ensure we have the latest valid config
                    if last_start_params.get('sid'):
                        print("[SERVER] Triggering auto-restart...")
                        await start_audio(last_start_params['sid'], last_start_params.get('data'))
                
                asyncio.create_task(restart_session())
        
        loop_task.add_done_callback(handle_loop_exit)
        
        print("[SYSTEM NOTIFICATION] MonikAI Started")
        await sio.emit('status', {'msg': 'MonikAI Started'})
        
    except Exception as e:
        print(f"[SYSTEM ERROR] CRITICAL ERROR STARTING MonikAI: {e}")
        import traceback
        traceback.print_exc()
        await sio.emit('error', {'msg': f"Failed to start: {str(e)}"})
        audio_loop = None # Ensure we can try again

@sio.event
async def stop_audio(sid):
    global audio_loop
    if audio_loop:
        audio_loop.stop() 
        print("[SYSTEM NOTIFICATION] Stopping Audio Loop")
    # Ensure background task is fully stopped to avoid duplicate sessions
    global loop_task
    if loop_task and not loop_task.done():
        try:
            loop_task.cancel()
            await loop_task
        except Exception:
            pass
        loop_task = None
    audio_loop = None
    print("[SYSTEM NOTIFICATION] MonikAI Stopped")
    await sio.emit('status', {'msg': 'MonikAI Stopped'})

@sio.event
async def pause_audio(sid):
    global audio_loop
    if audio_loop:
        audio_loop.set_paused(True)
        print("[SYSTEM NOTIFICATION] Audio Paused")
        await sio.emit('status', {'msg': 'Audio Paused'})

@sio.event
async def resume_audio(sid):
    global audio_loop
    if audio_loop:
        audio_loop.set_paused(False)
        print("[SYSTEM NOTIFICATION] Audio Resumed")
        await sio.emit('status', {'msg': 'Audio Resumed'})


# --------------------------------------------------------------------------------------
# Reminders API (frontend-driven list/cancel; creation optional)
# --------------------------------------------------------------------------------------

def _serialize_reminders():
    """Return a JSON-serializable list of reminders from the active audio_loop."""
    if not reminder_manager:
        return []

    items = reminder_manager.list()
    result = []
    for r in items:
        try:
            when_dt = datetime.fromisoformat(r.when_iso)
            when_epoch_ms = int(when_dt.timestamp() * 1000)
        except Exception:
            when_epoch_ms = None
        result.append({
            'id': r.id,
            'message': r.message,
            'when_iso': r.when_iso,
            'speak': bool(r.speak),
            'when_epoch_ms': when_epoch_ms,
            'alert': bool(getattr(r, 'alert', True)),
            'created_iso': getattr(r, 'created_iso', None),
        })
    # Sort by scheduled time
    result.sort(key=lambda x: (x['when_epoch_ms'] is None, x['when_epoch_ms'] or 0))
    return result


def _serialize_kasa_devices():
    """Return a JSON-serializable list of known Kasa devices (no discovery scan)."""
    devices = []
    if not kasa_agent:
        return devices
    for ip, dev in kasa_agent.devices.items():
        try:
            dev_type = "unknown"
            if dev.is_bulb:
                dev_type = "bulb"
            elif dev.is_plug:
                dev_type = "plug"
            elif dev.is_strip:
                dev_type = "strip"
            elif dev.is_dimmer:
                dev_type = "dimmer"

            device_info = {
                "ip": ip,
                "alias": dev.alias,
                "model": dev.model,
                "type": dev_type,
                "is_on": dev.is_on,
                "brightness": dev.brightness if dev.is_bulb or dev.is_dimmer else None,
                "hsv": dev.hsv if dev.is_bulb and dev.is_color else None,
                "has_color": dev.is_color if dev.is_bulb else False,
                "has_brightness": dev.is_dimmable if dev.is_bulb or dev.is_dimmer else False
            }
            devices.append(device_info)
        except Exception:
            continue
    return devices


# --------------------------------------------------------------------------------------
# VN Scene Switch (content-aware)
# --------------------------------------------------------------------------------------
VN_SCENE_KEYWORDS = [
    ("kitchen", [
        "gotow", "kuchar", "kuchni", "kuchnia", "obiad", "kolac", "śniad", "sniad",
        "piec", "piecz", "makaron", "przepis", "herbat", "kawa", "jedz", "jedzenie"
    ]),
    ("outside", [
        "na dworze", "na zewnątrz", "na zewnatrz", "spacer", "park", "natura", "pogod",
        "deszcz", "śnieg", "snieg", "wiatr", "słońc", "slonc", "plaż", "plaz", "las"
    ]),
    ("school", [
        "szkoł", "szkol", "uczeln", "studia", "lekcj", "egzamin", "nauka", "klasa"
    ]),
    ("room", [
        "pokój", "pokoj", "biurko", "prac", "kod", "komputer", "projekt", "pisan"
    ]),
    ("club", [
        "klub", "literatur", "wiersz", "poezj", "spotkanie"
    ]),
    ("library", [
        "bibliotek", "książk", "czyta", "lektur"
    ]),
    ("bedroom", [
        "sypialni", "łóżk", "spac", "drzemk", "noc"
    ]),
]

_vn_scene_state = {"current": None, "last_ts": 0.0}
_vn_user_buf = ""
_vn_user_last_ts = 0.0
_vn_scene_task = None


def _pick_scene_from_text(text: str):
    if not text:
        return None, None
    t = text.lower()
    for scene, keys in VN_SCENE_KEYWORDS:
        for k in keys:
            if k in t:
                return scene, k
    return None, None


async def _debounced_vn_scene_check():
    global _vn_user_buf, _vn_user_last_ts, _vn_scene_task
    await asyncio.sleep(0.8)
    if (time.time() - _vn_user_last_ts) < 0.7:
        _vn_scene_task = asyncio.create_task(_debounced_vn_scene_check())
        return

    text = (_vn_user_buf or "").strip()
    if len(text) < 6:
        return

    scene, keyword = _pick_scene_from_text(text)
    if not scene:
        return

    now = time.time()
    if _vn_scene_state["current"] == scene:
        return
    if (now - _vn_scene_state["last_ts"]) < 90:
        return

    _vn_scene_state["current"] = scene
    _vn_scene_state["last_ts"] = now
    _vn_user_buf = ""

    # Emit scene change to frontend
    try:
        asyncio.create_task(sio.emit('vn_scene', {"scene": scene, "reason": keyword, "ttl_ms": 180000}))
    except Exception:
        pass

    # Notify model so it can briefly acknowledge the change
    try:
        if audio_loop and getattr(audio_loop, "session", None):
            await audio_loop.session.send(
                input=(
                    "System Notification: Scene changed to '" + scene +
                    "' because user mentioned '" + str(keyword) +
                    "'. Briefly acknowledge the change in a natural way (1 short sentence), then continue."
                ),
                end_of_turn=False,
            )
    except Exception as e:
        print(f"[SERVER] Failed to notify model about scene change: {e}")


@sio.event
async def list_reminders(sid, data=None):
    """Frontend requests current reminder list."""
    await sio.emit('reminders_list', {'reminders': _serialize_reminders()}, room=sid)


@sio.event
async def list_calendar(sid, data=None):
    """Frontend requests current calendar events."""
    events = []
    if calendar_manager:
        events = [e.__dict__ for e in calendar_manager.get_all_events()]
    await sio.emit('calendar_data', events, room=sid)

@sio.event
async def get_personality_status(sid):
    """Frontend requests current personality status."""
    if personality_system:
        await sio.emit('personality_status', asdict(personality_system.state), room=sid)

@sio.event
async def delete_event(sid, data):
    """Frontend deletes a calendar event."""
    eid = (data or {}).get('id')
    if not eid:
        return
    if calendar_manager:
        calendar_manager.delete_event(eid)

@sio.event
async def update_reminder(sid, data):
    rid = data.get('id')
    msg = data.get('message')
    if reminder_manager and rid:
        reminder_manager.update(rid, message=msg)
        await sio.emit('reminders_list', {'reminders': _serialize_reminders()}, room=sid)

@sio.event
async def update_event(sid, data):
    eid = data.get('id')
    summary = data.get('summary')
    if calendar_manager and eid:
        calendar_manager.update_event(eid, summary=summary)
        # emit calendar_data
        events = [e.__dict__ for e in calendar_manager.get_all_events()]
        await sio.emit('calendar_data', events, room=sid)

@sio.event
async def cancel_reminder(sid, data):
    """Frontend cancels a reminder by id."""
    rid = (data or {}).get('id')
    if not rid:
        await sio.emit('error', {'msg': 'cancel_reminder: Missing id'}, room=sid)
        return

    if not reminder_manager:
        await sio.emit('error', {'msg': 'Reminders not available'}, room=sid)
        return

    ok = reminder_manager.cancel(rid)
    await sio.emit('reminders_list', {'reminders': _serialize_reminders()}, room=sid)
    if ok:
        await sio.emit('status', {'msg': 'Reminder cancelled'}, room=sid)
    else:
        await sio.emit('status', {'msg': 'Reminder not found'}, room=sid)


@sio.event
async def create_reminder(sid, data):
    """Optional: Frontend can create a reminder (same semantics as the model tool)."""
    if not reminder_manager:
        await sio.emit('error', {'msg': 'Reminders not available'}, room=sid)
        return

    data = data or {}
    message = (data.get('message') or '').strip()
    at = data.get('at')
    in_minutes = data.get('in_minutes')
    in_seconds = data.get('in_seconds')
    speak = data.get('speak', True)
    alert = data.get('alert', True)

    if not message:
        await sio.emit('error', {'msg': 'create_reminder: Missing message'}, room=sid)
        return

    try:
        rem = reminder_manager.create(message=message, at=at, in_minutes=in_minutes, in_seconds=in_seconds, speak=speak, alert=alert)
        await sio.emit('status', {'msg': f"Reminder created ({rem.id})"}, room=sid)

        # Let the model know (so it can reference it later)
        try:
            if getattr(audio_loop, 'session', None):
                kind = 'timer' if (in_seconds is not None or in_minutes is not None) and (at is None) else 'reminder'
                when_desc = rem.when_iso
                await audio_loop.session.send(
                    input=(
                        f"System Notification: User manually created a {kind}. \
Message: {rem.message}. \
When: {when_desc}. \
Speak: {bool(rem.speak)}. Alert: {bool(getattr(rem, 'alert', True))}."
                    ),
                    end_of_turn=False
                )
        except Exception as e:
            print(f"[SERVER] Failed to notify model about reminder: {e}")
    except Exception as e:
        await sio.emit('error', {'msg': f"Failed to create reminder: {e}"}, room=sid)

    await sio.emit('reminders_list', {'reminders': _serialize_reminders()}, room=sid)

@sio.event
async def create_event(sid, data):
    """Frontend creates a calendar event."""
    if not calendar_manager:
        await sio.emit('error', {'msg': 'Calendar not available'}, room=sid)
        return

    data = data or {}
    summary = data.get('summary')
    start_iso = data.get('start_iso')
    end_iso = data.get('end_iso')
    description = data.get('description')

    if not summary or not start_iso or not end_iso:
        await sio.emit('error', {'msg': 'create_event: Missing summary, start_iso, or end_iso'}, room=sid)
        return

    try:
        event = calendar_manager.create_event(summary=summary, start_iso=start_iso, end_iso=end_iso, description=description)
        await sio.emit('status', {'msg': f"Event created ({event.id})"}, room=sid)
    except Exception as e:
        await sio.emit('error', {'msg': f"Failed to create event: {e}"}, room=sid)

    # Emit update
    if calendar_manager:
        events = [e.__dict__ for e in calendar_manager.get_all_events()]
        await sio.emit('calendar_data', events, room=sid)

@sio.event
async def confirm_tool(sid, data):
    # data: { "id": "...", "confirmed": True/False }
    request_id = data.get('id')
    confirmed = data.get('confirmed', False)
    
    print(f"[SERVER DEBUG] Received confirmation response for {request_id}: {confirmed}")
    
    if audio_loop:
        audio_loop.resolve_tool_confirmation(request_id, confirmed)
    else:
        print("Audio loop not active, cannot resolve confirmation.")

@sio.event
async def shutdown(sid, data=None):
    """Gracefully shutdown the server when the application closes."""
    global audio_loop, loop_task, authenticator
    
    print("[SERVER] ========================================")
    print("[SERVER] SHUTDOWN SIGNAL RECEIVED FROM FRONTEND")
    print("[SERVER] ========================================")
    
    # Stop audio loop
    if audio_loop:
        print("[SERVER] Stopping Audio Loop...")
        audio_loop.stop()
        audio_loop = None
    
    # Cancel the loop task if running
    if loop_task and not loop_task.done():
        print("[SERVER] Cancelling loop task...")
        loop_task.cancel()
        loop_task = None
    
    # Stop authenticator if running
    if authenticator:
        print("[SERVER] Stopping Authenticator...")
        authenticator.stop()
    
    print("[SERVER] Graceful shutdown complete. Terminating process...")
    
    # Force exit immediately - os._exit bypasses cleanup but ensures termination
    os._exit(0)

@sio.event
async def user_input(sid, data):
    text = data.get('text')
    attachments = data.get('attachments') or []
    print(f"[SERVER DEBUG] User input received: '{text}'")
    
    if not audio_loop:
        print("[SERVER DEBUG] [Error] Audio loop is None. Cannot send text.")
        return

    if not audio_loop.session:
        print("[SERVER DEBUG] [Error] Session is None. Cannot send text.")
        return

    if text or attachments:
        if text:
            print(f"[SERVER DEBUG] Sending message to model: '{text}'")
        if attachments:
            print(f"[SERVER DEBUG] Received {len(attachments)} attachment(s).")

        sent_visual = False
        max_visual_age_sec = 2.0
        latest_age = None

        # Mark user activity (prevents idle nudges + updates topic memory)
        try:
            audio_loop_mark_user_activity(audio_loop, text)
        except Exception:
            pass
        
        # Log User Input to Project History
        if audio_loop and audio_loop.project_manager:
            audio_loop.project_manager.log_chat("User", text)
            
        # INJECT VIDEO FRAME IF AVAILABLE (VAD-style logic for Text Input)
        # Refresh screen frame for lowest latency
        if audio_loop and getattr(audio_loop, "video_mode", None) == "screen":
            try:
                await audio_loop.refresh_latest_frame(min_age_sec=0.05)
            except Exception:
                pass

        # If camera is frontend-based, request a fresh frame from UI
        if audio_loop and getattr(audio_loop, "video_mode", None) == "camera":
            try:
                if getattr(audio_loop, "camera_source", "frontend") == "frontend":
                    await sio.emit("request_camera_frame", to=sid)
                    await asyncio.sleep(0.08)
            except Exception:
                pass

        # Send attachments (if any) before the text
        if attachments:
            try:
                summary = []
                for a in attachments:
                    name = a.get("name") or "unnamed"
                    mime_type = a.get("mime_type") or "application/octet-stream"
                    size = a.get("size")
                    size_str = f"{size} bytes" if isinstance(size, int) else "unknown size"
                    summary.append(f"{name} ({mime_type}, {size_str})")
                await audio_loop.session.send(
                    input=("System Notification: User attached files: " + "; ".join(summary)),
                    end_of_turn=False,
                )
            except Exception as e:
                print(f"[SERVER DEBUG] Failed to send attachment summary: {e}")

            for a in attachments:
                try:
                    payload = {
                        "mime_type": a.get("mime_type") or "application/octet-stream",
                        "data": a.get("data"),
                    }
                    if payload["data"]:
                        await audio_loop.session.send(input=payload, end_of_turn=False)
                        if str(payload["mime_type"]).startswith("image/"):
                            sent_visual = True
                except Exception as e:
                    print(f"[SERVER DEBUG] Failed to send attachment payload: {e}")

        if audio_loop and getattr(audio_loop, "_latest_image_payload", None):
            if getattr(audio_loop, "_latest_image_ts", None):
                latest_age = time.time() - audio_loop._latest_image_ts
            if latest_age is None or latest_age <= max_visual_age_sec:
                print(f"[SERVER DEBUG] Piggybacking video frame with text input.")
                try:
                    await audio_loop.session.send(input=audio_loop._latest_image_payload, end_of_turn=False)
                    sent_visual = True
                except Exception as e:
                    print(f"[SERVER DEBUG] Failed to send piggyback frame: {e}")
            else:
                print(f"[SERVER DEBUG] Skipping stale visual frame (age {latest_age:.2f}s).")

        if not sent_visual and audio_loop and getattr(audio_loop, "video_mode", None) in ("screen", "camera"):
            note = "System Notification: No visual frame was sent with this turn. If you did not receive an image, say you cannot see the user's screen/camera."
            if latest_age is not None:
                note += f" Last visual frame age: {latest_age:.2f}s."
            try:
                await audio_loop.session.send(input=note, end_of_turn=False)
            except Exception:
                pass
                
        if text:
            await audio_loop.session.send(input=text, end_of_turn=True)
            print(f"[SERVER DEBUG] Message sent to model successfully.")
        else:
            await audio_loop.session.send(
                input="System Notification: User sent attachments without additional text.",
                end_of_turn=True,
            )
            print(f"[SERVER DEBUG] Attachments-only message sent to model.")

import json
from datetime import datetime
from pathlib import Path

# ... (imports)

@sio.event
async def video_frame(sid, data):
    # data should contain 'image' which is binary (blob) or base64 encoded
    image_data = data.get('image')
    if image_data and audio_loop:
        # We don't await this because we don't want to block the socket handler
        # But send_frame is async, so we create a task
        asyncio.create_task(audio_loop.send_frame(image_data))

@sio.event
async def save_memory(sid, data):
    try:
        messages = data.get('messages', [])
        if not messages:
            print("No messages to save.")
            return

        # Ensure directory exists
        memory_dir = DATA_DIR / "long_term_memory"
        memory_dir.mkdir(exist_ok=True)

        # Generate filename
        # Use provided filename if available, else timestamp
        provided_name = data.get('filename')
        
        if provided_name:
            # Simple sanitization
            if not provided_name.endswith('.txt'):
                provided_name += '.txt'
            # Prevent directory traversal
            filename = memory_dir / Path(provided_name).name 
        else:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = memory_dir / f"memory_{timestamp}.txt"

        # Write to file
        with open(filename, 'w', encoding='utf-8') as f:
            for msg in messages:
                sender = msg.get('sender', 'Unknown')
                text = msg.get('text', '')
        print(f"Conversation saved to {filename}")
        await sio.emit('status', {'msg': 'Memory Saved Successfully'})

    except Exception as e:
        print(f"Error saving memory: {e}")
        await sio.emit('error', {'msg': f"Failed to save memory: {str(e)}"})

def _notes_path():
    try:
        if audio_loop and getattr(audio_loop, "project_manager", None):
            base = audio_loop.project_manager.get_current_project_path()
        else:
            base = DATA_DIR / "projects" / "temp"
        base.mkdir(parents=True, exist_ok=True)
        return base / "notes.md"
    except Exception:
        return DATA_DIR / "projects" / "temp" / "notes.md"

def _read_notes_text():
    path = _notes_path()
    try:
        if not path.exists():
            return ""
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception as e:
        return f"[ERROR] Failed to read notes: {e}"

def _write_notes_text(content: str):
    path = _notes_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content or "", encoding="utf-8")
    return path

def _append_notes_text(content: str):
    path = _notes_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = ""
    if path.exists():
        existing = path.read_text(encoding="utf-8", errors="ignore")
    addition = content or ""
    if existing and not existing.endswith("\n"):
        existing += "\n"
    new_text = existing + addition + ("\n" if addition and not addition.endswith("\n") else "")
    path.write_text(new_text, encoding="utf-8")
    return path

@sio.event
async def notes_get(sid):
    text = _read_notes_text()
    project = audio_loop.project_manager.current_project if audio_loop and getattr(audio_loop, "project_manager", None) else "temp"
    await sio.emit('notes_data', {'text': text, 'project': project}, room=sid)

@sio.event
async def notes_set(sid, data):
    try:
        content = (data or {}).get("content", "")
        _write_notes_text(content)
        project = audio_loop.project_manager.current_project if audio_loop and getattr(audio_loop, "project_manager", None) else "temp"
        await sio.emit('notes_data', {'text': content, 'project': project}, room=sid)
    except Exception as e:
        await sio.emit('error', {'msg': f"Failed to save notes: {e}"}, room=sid)

@sio.event
async def notes_append(sid, data):
    try:
        content = (data or {}).get("content", "")
        _append_notes_text(content)
        text = _read_notes_text()
        project = audio_loop.project_manager.current_project if audio_loop and getattr(audio_loop, "project_manager", None) else "temp"
        await sio.emit('notes_data', {'text': text, 'project': project}, room=sid)
    except Exception as e:
        await sio.emit('error', {'msg': f"Failed to append notes: {e}"}, room=sid)

@sio.event
async def notes_clear(sid):
    try:
        _write_notes_text("")
        project = audio_loop.project_manager.current_project if audio_loop and getattr(audio_loop, "project_manager", None) else "temp"
        await sio.emit('notes_data', {'text': "", 'project': project}, room=sid)
    except Exception as e:
        await sio.emit('error', {'msg': f"Failed to clear notes: {e}"}, room=sid)

@sio.event
async def upload_memory(sid, data):
    print(f"Received memory upload request")
    try:
        memory_text = data.get('memory', '')
        if not memory_text:
            print("No memory data provided.")
            return

        if not audio_loop:
             print("[SERVER DEBUG] [Error] Audio loop is None. Cannot load memory.")
             await sio.emit('error', {'msg': "System not ready (Audio Loop inactive)"})
             return
        
        if not audio_loop.session:
             print("[SERVER DEBUG] [Error] Session is None. Cannot load memory.")
             await sio.emit('error', {'msg': "System not ready (No active session)"})
             return

        # Send to model
        print("Sending memory context to model...")
        context_msg = f"System Notification: The user has uploaded a long-term memory file. Please load the following context into your understanding. The format is a text log of previous conversations:\n\n{memory_text}"
        
        await audio_loop.session.send(input=context_msg, end_of_turn=True)
        print("Memory context sent successfully.")
        await sio.emit('status', {'msg': 'Memory Loaded into Context'})

    except Exception as e:
        print(f"Error uploading memory: {e}")
        await sio.emit('error', {'msg': f"Failed to upload memory: {str(e)}"})

@sio.event
async def discover_kasa(sid):
    print(f"Received discover_kasa request")
    try:
        devices = await kasa_agent.discover_devices()
        await sio.emit('kasa_devices', devices)
        await sio.emit('status', {'msg': f"Found {len(devices)} Kasa devices"})
        
        # Save to settings
        # devices is a list of full device info dicts. minimizing for storage.
        saved_devices = []
        for d in devices:
            saved_devices.append({
                "ip": d["ip"],
                "alias": d["alias"],
                "model": d["model"]
            })
        
        # Merge with existing to preserve any manual overrides? 
        # For now, just overwrite with latest scan result + previously known if we want to be fancy,
        # but user asked for "Any new devices that are scanned are added there".
        # A simple full persistence of current state is safest.
        SETTINGS["kasa_devices"] = saved_devices
        save_settings()
        print(f"[SERVER] Saved {len(saved_devices)} Kasa devices to settings.")
        
    except Exception as e:
        print(f"Error discovering kasa: {e}")
        await sio.emit('error', {'msg': f"Kasa Discovery Failed: {str(e)}"})


@sio.event
async def list_kasa(sid, data=None):
    """Return cached/known Kasa devices without discovery scan."""
    await sio.emit('kasa_devices', _serialize_kasa_devices(), room=sid)

@sio.event
async def prompt_web_agent(sid, data):
    # data: { prompt: "find xyz" }
    prompt = data.get('prompt')
    print(f"Received web agent prompt: '{prompt}'")
    
    if not audio_loop or not audio_loop.web_agent:
        await sio.emit('error', {'msg': "Web Agent not available"})
        return

    try:
        await sio.emit('status', {'msg': 'Web Agent running...'})
        
        # We assume web_agent has a run method or similar.
        # This might block the loop if not strictly async or offloaded.
        # Ideally web_agent.run is async.
        # And it should emit 'browser_snap' and logs automatically via hooks if setup.
        
        # We might need to launch this as a task if it's long running?
        # asyncio.create_task(audio_loop.web_agent.run(prompt))
        # But we want to catch errors here.
        
        # Based on typical agent design, run() is the entry point.
        await audio_loop.web_agent.run(prompt)
        
        await sio.emit('status', {'msg': 'Web Agent finished'})
        
    except Exception as e:
        print(f"Error running Web Agent: {e}")
        await sio.emit('error', {'msg': f"Web Agent Error: {str(e)}"})


@sio.event
async def control_kasa(sid, data):
    # data: { ip, action: "on"|"off"|"brightness"|"color", value: ... }
    ip = data.get('ip')
    action = data.get('action')
    print(f"Kasa Control: {ip} -> {action}")
    
    try:
        success = False
        if action == "on":
            success = await kasa_agent.turn_on(ip)
        elif action == "off":
            success = await kasa_agent.turn_off(ip)
        elif action == "brightness":
            val = data.get('value')
            success = await kasa_agent.set_brightness(ip, val)
        elif action == "color":
            # value is {h, s, v} - convert to tuple for set_color
            h = data.get('value', {}).get('h', 0)
            s = data.get('value', {}).get('s', 100)
            v = data.get('value', {}).get('v', 100)
            success = await kasa_agent.set_color(ip, (h, s, v))
        
        if success:
            await sio.emit('kasa_update', {
                'ip': ip,
                'is_on': True if action == "on" else (False if action == "off" else None),
                'brightness': data.get('value') if action == "brightness" else None,
            })
 
        else:
             await sio.emit('error', {'msg': f"Failed to control device {ip}"})

    except Exception as e:
         print(f"Error controlling kasa: {e}")
         await sio.emit('error', {'msg': f"Kasa Control Error: {str(e)}"})

@sio.event
async def get_settings(sid):
    await sio.emit('settings', SETTINGS)

@sio.event
async def update_settings(sid, data):
    # Generic update
    print(f"Updating settings: {data}")
    
    # Handle specific keys if needed
    if "tool_permissions" in data:
        SETTINGS["tool_permissions"].update(data["tool_permissions"])
        if audio_loop:
            audio_loop.update_permissions(SETTINGS["tool_permissions"])
            
    if "show_internal_thoughts" in data:
        SETTINGS["show_internal_thoughts"] = bool(data["show_internal_thoughts"])
            
    if "face_auth_enabled" in data:
        SETTINGS["face_auth_enabled"] = data["face_auth_enabled"]
        # If turned OFF, maybe emit auth status true?
        if not data["face_auth_enabled"]:
             await sio.emit('auth_status', {'authenticated': True})
             # Stop auth loop if running?
             if authenticator:
                 authenticator.stop() 

    if "camera_flipped" in data:
        SETTINGS["camera_flipped"] = data["camera_flipped"]
        print(f"[SERVER] Camera flip set to: {data['camera_flipped']}")

    if "camera_source" in data:
        SETTINGS["camera_source"] = data["camera_source"]
        if audio_loop and hasattr(audio_loop, "reload_capture_settings"):
            try:
                audio_loop.reload_capture_settings()
            except Exception:
                pass

    if "video_mode" in data:
        SETTINGS["video_mode"] = data["video_mode"]
        mode = str(SETTINGS["video_mode"]).lower()
        if mode == "screen":
            SETTINGS.setdefault("screen_capture", {})["stream_to_ai"] = True
        else:
            SETTINGS.setdefault("screen_capture", {})["stream_to_ai"] = False
        if audio_loop and hasattr(audio_loop, "set_video_mode"):
            try:
                audio_loop.set_video_mode(SETTINGS["video_mode"])
            except Exception:
                pass
        if audio_loop and getattr(audio_loop, "session", None):
            try:
                if mode in ("screen", "camera"):
                    scope = "ekran" if mode == "screen" else "kamerę"
                    await audio_loop.session.send(
                        input=(
                            f"System Notification: Włączono tryb obrazu ({mode}). "
                            f"Masz dostęp do opisu obrazu z {scope} użytkownika (na podstawie zrzutów)."
                        ),
                        end_of_turn=False,
                    )
                else:
                    await audio_loop.session.send(
                        input="System Notification: Tryb obrazu został wyłączony.",
                        end_of_turn=False,
                    )
            except Exception:
                pass

    if "camera_capture" in data and isinstance(data.get("camera_capture"), dict):
        SETTINGS.setdefault("camera_capture", {}).update(data["camera_capture"])
        if audio_loop and hasattr(audio_loop, "reload_capture_settings"):
            try:
                audio_loop.reload_capture_settings()
            except Exception:
                pass

    if "screen_capture" in data and isinstance(data.get("screen_capture"), dict):
        SETTINGS.setdefault("screen_capture", {}).update(data["screen_capture"])
        if audio_loop and hasattr(audio_loop, "reload_capture_settings"):
            try:
                audio_loop.reload_capture_settings()
            except Exception:
                pass

    save_settings()
    # Broadcast new full settings
    await sio.emit('settings', SETTINGS)


# Deprecated/Mapped for compatibility if frontend still uses specific events
@sio.event
async def get_tool_permissions(sid):
    await sio.emit('tool_permissions', SETTINGS["tool_permissions"])

@sio.event
async def update_tool_permissions(sid, data):
    print(f"Updating permissions (legacy event): {data}")
    SETTINGS["tool_permissions"].update(data)
    save_settings()
    
    if audio_loop:
        audio_loop.update_permissions(SETTINGS["tool_permissions"])
    # Broadcast update to all
    await sio.emit('tool_permissions', SETTINGS["tool_permissions"])

if __name__ == "__main__":
    uvicorn.run(
        "server:app_socketio", 
        host="127.0.0.1", 
        port=8000, 
        reload=False, # Reload enabled causes spawn of worker which might miss the event loop policy patch
        loop="asyncio",
        reload_excludes=["output.stl", "*.stl"]
    )
def audio_loop_mark_user_activity(loop, text: str):
    """Prefer AudioLoop.mark_user_activity(text) if available; fall back to legacy names."""
    if loop is None:
        return
    for fn_name in ("mark_user_activity", "note_user_activity", "note_user_activity_ts"):
        if _loop_has(loop, fn_name):
            try:
                getattr(loop, fn_name)(text)
                return
            except Exception:
                return
    # Best-effort: update timestamp fields if present
    try:
        if hasattr(loop, "_last_user_activity_ts"):
            setattr(loop, "_last_user_activity_ts", asyncio.get_event_loop().time())
    except Exception:
        pass
