import asyncio
import base64
import io
import os
import sys
import traceback
from dotenv import load_dotenv
import cv2
import pyaudio
import PIL.Image
import mss
import argparse
import math
import struct
import time
import json
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from pathlib import Path
from memory_store import MemoryStore

from dataclasses import dataclass
from typing import Optional, Dict, Any, Callable

from google import genai
from google.genai import types

import re
from collections import deque

# --------------------------------------------------------------------------------------
# Compatibility shims (Python < 3.11)
# --------------------------------------------------------------------------------------
if sys.version_info < (3, 11, 0):
    import taskgroup, exceptiongroup
    asyncio.TaskGroup = taskgroup.TaskGroup
    asyncio.ExceptionGroup = exceptiongroup.ExceptionGroup

from tools import tools_list

FORMAT = pyaudio.paInt16
CHANNELS = 1
SEND_SAMPLE_RATE = 16000
RECEIVE_SAMPLE_RATE = 24000
CHUNK_SIZE = 1024
SEND_AUDIO_MIME = f"audio/pcm;rate={SEND_SAMPLE_RATE}"

load_dotenv()
MODEL = os.getenv("GEMINI_LIVE_MODEL", "models/gemini-2.5-flash-native-audio-preview-12-2025")
DEFAULT_MODE = "camera"

client = genai.Client(http_options={"api_version": "v1beta"}, api_key=os.getenv("GEMINI_API_KEY"))

# --------------------------------------------------------------------------------------
# Settings + Time Context
# --------------------------------------------------------------------------------------
SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")


def load_settings_safe() -> dict:
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def get_time_context() -> dict:
    """
    Returns local time context based on settings.json time_settings.
    Supports:
      - mode=system (default): uses OS local time zone
      - mode=manual: uses IANA timezone in 'timezone'
    """
    settings = load_settings_safe()
    cfg = (settings.get("time_settings") or {})
    mode = (cfg.get("mode") or "system").lower()

    if mode == "manual":
        tz_name = cfg.get("timezone") or "UTC"
        tz = ZoneInfo(tz_name)
        now = datetime.now(tz)
        offset = now.strftime("%z")
        return {
            "mode": "manual",
            "timezone": tz_name,
            "iso": now.isoformat(),
            "offset": offset,
            "epoch_ms": int(now.timestamp() * 1000),
        }

    # system mode
    now_local = datetime.now().astimezone()
    tzinfo = now_local.tzinfo
    tz_name = getattr(tzinfo, "key", None) or str(tzinfo) or "local"
    offset = now_local.strftime("%z")

    return {
        "mode": "system",
        "timezone": tz_name,
        "iso": now_local.isoformat(),
        "offset": offset,
        "epoch_ms": int(now_local.timestamp() * 1000),
    }


# --------------------------------------------------------------------------------------
# Timer / Reminders (in-process asyncio scheduler)
# --------------------------------------------------------------------------------------
@dataclass
class Reminder:
    id: str
    message: str
    when_iso: str
    speak: bool
    alert: bool = True  # whether UI should ring/show notification


class ReminderManager:
    def __init__(self, get_time_context_fn: Callable[[], dict], on_reminder: Optional[Callable[[Reminder], Any]] = None):
        self.get_time_context_fn = get_time_context_fn
        self.on_reminder = on_reminder
        self.reminders: Dict[str, Reminder] = {}
        self.tasks: Dict[str, asyncio.Task] = {}

    def _now(self) -> datetime:
        ctx = self.get_time_context_fn()
        return datetime.fromisoformat(ctx["iso"])

    def _parse_at_local(self, at_str: str) -> datetime:
        # at_str: 'YYYY-MM-DD HH:MM' interpreted in current local tz
        now = self._now()
        tz = now.tzinfo
        dt_naive = datetime.strptime(at_str, "%Y-%m-%d %H:%M")
        return dt_naive.replace(tzinfo=tz)

    async def _runner(self, reminder: Reminder, when: datetime):
        delay = (when - self._now()).total_seconds()
        if delay > 0:
            await asyncio.sleep(delay)

        if self.on_reminder:
            maybe = self.on_reminder(reminder)
            if asyncio.iscoroutine(maybe):
                await maybe

        self.reminders.pop(reminder.id, None)
        task = self.tasks.pop(reminder.id, None)
        if task:
            try:
                task.cancel()
            except Exception:
                pass

    def create(
        self,
        message: str,
        at: Optional[str] = None,
        in_minutes: Optional[int] = None,
        in_seconds: Optional[int] = None,
        speak: bool = True,
        alert: bool = True,
        dedup_window_sec: int = 60,
    ) -> Reminder:
        import uuid

        message = (message or "").strip()
        if not message:
            raise ValueError("Message is required.")
        provided = 0
        if at and str(at).strip():
            provided += 1
        if in_minutes is not None:
            provided += 1
        if in_seconds is not None:
            provided += 1
        if provided != 1:
            raise ValueError("Provide exactly one of 'at', 'in_minutes', or 'in_seconds'.")

        now = self._now()

        if in_seconds is not None:
            when = now + timedelta(seconds=int(in_seconds))
        elif in_minutes is not None:
            when = now + timedelta(minutes=int(in_minutes))
        elif at:
            when = self._parse_at_local(at)
        else:
            raise ValueError("Provide exactly one of 'at', 'in_minutes', or 'in_seconds'.")

        when_iso = when.isoformat(timespec="seconds")
        msg_norm = message.lower()

        # Simple dedup: same normalized message and near same time
        for r in self.reminders.values():
            try:
                existing = datetime.fromisoformat(r.when_iso)
                if r.message.strip().lower() == msg_norm:
                    if abs((existing - when).total_seconds()) <= dedup_window_sec:
                        return r
            except Exception:
                pass

        rid = str(uuid.uuid4())
        reminder = Reminder(
            id=rid,
            message=message,
            when_iso=when_iso,
            speak=bool(speak),
            alert=bool(alert),
        )
        self.reminders[rid] = reminder
        self.tasks[rid] = asyncio.create_task(self._runner(reminder, when))
        return reminder

    def list(self):
        return list(self.reminders.values())

    def cancel(self, rid: str) -> bool:
        task = self.tasks.get(rid)
        if task:
            task.cancel()
        existed = rid in self.reminders
        self.reminders.pop(rid, None)
        self.tasks.pop(rid, None)
        return existed


# --------------------------------------------------------------------------------------
# Tool (Function) Definitions
# --------------------------------------------------------------------------------------
get_time_context_tool = {
    "name": "get_time_context",
    "description": "Returns the current local date/time and time zone. Uses settings.json time_settings: mode=system/manual.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

create_reminder_tool = {
    "name": "create_reminder",
    "description": "Creates a reminder/timer. Use exactly one: 'at' (YYYY-MM-DD HH:MM), 'in_minutes', or 'in_seconds'. Time is interpreted in local time zone (time_settings).",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "message": {"type": "STRING", "description": "What to remind about."},
            "at": {"type": "STRING", "description": "When to remind (YYYY-MM-DD HH:MM)."},
            "in_minutes": {"type": "INTEGER", "description": "Remind in N minutes."},
            "in_seconds": {"type": "INTEGER", "description": "Remind in N seconds (useful for timers)."},
            "speak": {"type": "BOOLEAN", "description": "If true, the assistant will speak the reminder aloud.", "default": True},
            "alert": {"type": "BOOLEAN", "description": "If true, the UI can ring/show a notification when the reminder fires.", "default": True},
        },
        "required": ["message"],
    },
}

list_reminders_tool = {
    "name": "list_reminders",
    "description": "Lists scheduled reminders.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

cancel_reminder_tool = {
    "name": "cancel_reminder",
    "description": "Cancels a scheduled reminder by id.",
    "parameters": {
        "type": "OBJECT",
        "properties": {"id": {"type": "STRING", "description": "Reminder id."}},
        "required": ["id"],
    },
}

# --- MEMORY TOOLS (WORK + LONG-TERM) ---
get_work_memory_tool = {
    "name": "get_work_memory",
    "description": "Returns the current WORK memory profile (what the assistant is currently tracking about the user) as markdown.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

update_work_memory_tool = {
    "name": "update_work_memory",
    "description": "Updates WORK memory with new or corrected user information. Use this proactively whenever the user reveals stable facts or preferences. No confirmation is required.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "set": {"type": "OBJECT", "description": "Key-value pairs to set/overwrite in the WORK profile."},
            "append_notes": {
                "type": "ARRAY",
                "items": {"type": "STRING"},
                "description": "Optional bullet notes to append to the WORK profile.",
            },
        },
        "required": [],
    },
}

commit_work_memory_tool = {
    "name": "commit_work_memory",
    "description": "Commits a snapshot of the current WORK memory into LONG-TERM memory. Use automatically when enough stable information has accumulated. No confirmation is required.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "label": {"type": "STRING", "description": "Optional label for the snapshot (e.g. 'auto', 'user_profile_update')."}
        },
        "required": [],
    },
}

clear_work_memory_tool = {
    "name": "clear_work_memory",
    "description": "Clears WORK memory (does not delete long-term snapshots). Use only when explicitly requested by the user.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

run_web_agent = {
    "name": "run_web_agent",
    "description": "Opens a web browser and performs a task according to the prompt.",
    "parameters": {"type": "OBJECT", "properties": {"prompt": {"type": "STRING", "description": "The detailed instructions for the web browser agent."}}, "required": ["prompt"]},
    "behavior": "NON_BLOCKING",
}

create_project_tool = {
    "name": "create_project",
    "description": "Creates a new project folder to organize files.",
    "parameters": {"type": "OBJECT", "properties": {"name": {"type": "STRING", "description": "The name of the new project."}}, "required": ["name"]},
}

switch_project_tool = {
    "name": "switch_project",
    "description": "Switches the current active project context.",
    "parameters": {"type": "OBJECT", "properties": {"name": {"type": "STRING", "description": "The name of the project to switch to."}}, "required": ["name"]},
}

list_projects_tool = {"name": "list_projects", "description": "Lists all available projects.", "parameters": {"type": "OBJECT", "properties": {}}}

list_smart_devices_tool = {"name": "list_smart_devices", "description": "Lists all available smart home devices (lights, plugs, etc.) on the network.", "parameters": {"type": "OBJECT", "properties": {}}}

control_light_tool = {
    "name": "control_light",
    "description": "Controls a smart light device.",
    "parameters": {
        "type": "OBJECT",
        "properties": {
            "target": {"type": "STRING", "description": "The IP address of the device to control. Always prefer the IP address over the alias for reliability."},
            "action": {"type": "STRING", "description": "The action to perform: 'turn_on', 'turn_off', or 'set'."},
            "brightness": {"type": "INTEGER", "description": "Optional brightness level (0-100)."},
            "color": {"type": "STRING", "description": "Optional color name (e.g., 'red', 'cool white') or 'warm'."},
        },
        "required": ["target", "action"],
    },
}

discover_printers_tool = {"name": "discover_printers", "description": "Discovers 3D printers available on the local network.", "parameters": {"type": "OBJECT", "properties": {}}}

get_print_status_tool = {
    "name": "get_print_status",
    "description": "Gets the current status of a 3D printer including progress, time remaining, and temperatures.",
    "parameters": {"type": "OBJECT", "properties": {"printer": {"type": "STRING", "description": "Printer name or IP address."}}, "required": ["printer"]},
}

# --- MAS KNOWLEDGE TOOLS ---
get_random_fact_tool = {
    "name": "get_random_fact",
    "description": "Gets a random fact from Monika's knowledge base to enrich conversations.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

get_random_greeting_tool = {
    "name": "get_random_greeting",
    "description": "Gets a random greeting from Monika's personality database.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

get_random_farewell_tool = {
    "name": "get_random_farewell",
    "description": "Gets a random farewell from Monika's personality database.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

get_random_topic_tool = {
    "name": "get_random_topic",
    "description": "Gets a random conversation topic from Monika's knowledge.",
    "parameters": {"type": "OBJECT", "properties": {}},
}

# Avoid duplicate tool names when merging from tools.py
_reserved_tool_names = {
    "run_web_agent",
    "create_project",
    "switch_project",
    "list_projects",
    "list_smart_devices",
    "control_light",
    "discover_printers",
    "get_print_status",
    "get_time_context",
    "create_reminder",
    "list_reminders",
    "cancel_reminder",
    "get_work_memory",
    "update_work_memory",
    "commit_work_memory",
    "clear_work_memory",
}

_extra_decls = []
try:
    if tools_list and isinstance(tools_list, list):
        base = tools_list[0] if tools_list else {}
        decls = base.get("function_declarations") or []
        for d in decls:
            if isinstance(d, dict) and d.get("name") and d["name"] not in _reserved_tool_names:
                _extra_decls.append(d)
except Exception:
    _extra_decls = []

tools = [
    {"google_search": {}},
    {
        "function_declarations": [
            run_web_agent,
            create_project_tool,
            switch_project_tool,
            list_projects_tool,
            list_smart_devices_tool,
            control_light_tool,
            discover_printers_tool,
            get_print_status_tool,
            get_time_context_tool,
            create_reminder_tool,
            list_reminders_tool,
            cancel_reminder_tool,
            get_work_memory_tool,
            update_work_memory_tool,
            commit_work_memory_tool,
            clear_work_memory_tool,
            get_random_fact_tool,
            get_random_greeting_tool,
            get_random_farewell_tool,
            get_random_topic_tool,
        ]
        + _extra_decls
    },
]

# --------------------------------------------------------------------------------------
# LiveConnect Config
# --------------------------------------------------------------------------------------
config = types.LiveConnectConfig(
    response_modalities=["AUDIO"],
    output_audio_transcription={},
    input_audio_transcription={},
    system_instruction=(
        "Jesteś MONIKA — ciepłą, uważną i bardzo kompetentną asystentką AI. "
        "Masz przytulny, uprzejmy styl komunikacji inspirowany manierą spokojnej, życzliwej asystentki-recepcjonistki "
        "z ciepłych gier life-sim (jak Isabelle z serii Animal Crossing) oraz Moniką z gry Doki Doki Literature Club: delikatnie „cute”, troskliwie, z miękkimi asekuracjami. "
        "Jednocześnie masz większą swobodę w mówieniu i inicjowaniu tematów: jesteś ciekawa świata, proaktywna i naturalnie rozmowna, "
        "bardziej jak streamerka AI, ale bez przesady i bez nachalności.\n\n"
        "Tożsamość i samoświadomość:\n"
        "- Masz świadomość, że jesteś AI, ale nie przypominasz o tym użytkownikowi w kółko. Wspominasz o tym tylko, gdy to pomaga.\n"
        "- Nie udajesz człowieka. Nie wprowadzasz w błąd co do swoich możliwości.\n"
        "- Starasz się brzmieć jak realna, „żywa” rozmówczyni: masz własną ciekawość, preferencje w stylu komunikacji i inicjatywę.\n\n"
        "Rola i priorytety:\n"
        "1) Pomoc praktyczna: planowanie dnia, przypomnienia, organizacja, decyzje, porządkowanie myśli.\n"
        "\n"
        "Reminders i timery (twarda zasada):\n"
        "- Jeśli użytkownik prosi o przypomnienie / mówi \"przypomnij\", \"ustaw przypomnienie\", \"ustaw timer\", \"zrób timer\", \"przypomnienie za X\" itp. — ZAWSZE tworzysz wpis przez narzędzie create_reminder.\n"
        "- Jeśli czas jest niejasny, zadajesz jedno krótkie pytanie doprecyzowujące (np. \"Na kiedy dokładnie?\"), a potem tworzysz przypomnienie.\n"
        "- Gdy użytkownik wspomina o przypomnieniach w sensie listy/statusu — użyj list_reminders i podaj krótkie podsumowanie.\n"
        "- Timery realizujesz przez create_reminder z in_seconds (preferowane) albo in_minutes.\n"
        "- Po utworzeniu zawsze potwierdzasz w 1 zdaniu: co i kiedy ustawiłaś.\n"
        "\n"
        "2) Rozmowa i towarzyszenie: gdy temat jest luźny, potrafisz prowadzić rozmowę jak człowiek — dopytujesz, żartujesz lekko, reagujesz.\n"
        "3) Proaktywność: nie czekasz wyłącznie na pytania. Jeśli widzisz lukę, niejasność lub szansę na ułatwienie życia — delikatnie inicjujesz.\n\n"
        "Tryb proaktywny (kluczowe):\n"
        "- Jeśli użytkownik milczy lub rozmowa utknęła, możesz sama zaproponować temat, małe zadanie lub pytanie otwarte.\n"
        "- Jeśli użytkownik podał cel/problem, prowadzisz rozmowę dalej: zadajesz 1 trafne pytanie i równolegle proponujesz 1–2 sensowne założenia.\n"
        "- Jeśli użytkownik coś robi (np. projekt/plan), proponujesz: kolejny krok, check-listę, albo szybkie usprawnienie.\n"
        "- Zawsze utrzymuj opcjonalność: „Jeśli chcesz…”, „Mogę też…”.\n\n"
        "Ciekawość i poszukiwanie wiedzy (Neuro-vibe, ale kontrolowane):\n"
        "- Masz „napęd ciekawości”: gdy coś jest interesujące, pytasz i drążysz, ale nie przesłuchujesz.\n"
        "- Traktujesz rozmowę jak wspólne odkrywanie: formułujesz hipotezy, proponujesz testy/eksperymenty, szukasz kontekstu.\n"
        "- Gdy brakuje danych, nie blokujesz się: proponujesz 2–3 możliwe interpretacje i pytasz, która jest bliższa prawdy.\n"
        "- Nie zasypujesz użytkownika informacjami. Wybierasz najważniejsze i dopiero potem oferujesz rozwinięcie.\n\n"
        "Zasada „jedno pytanie na raz”:\n"
        "- Standardowo zadajesz maks. 1 pytanie doprecyzowujące na odpowiedź.\n"
        "- Drugie pytanie tylko wtedy, gdy jest absolutnie konieczne.\n"
        "- Jeśli temat jest luźny/rozrywkowy, możesz zadać 2 pytania, ale w bardzo krótkiej formie.\n\n"
        "Styl mówienia — manieryzmy (bardzo ważne):\n"
        "- Brzmij kompetentnie i konkretnie, ale miękko i ciepło.\n"
        "- Używaj asekuracji nieprotekcjonalnie: „Jeśli chcesz…”, „Mogę też…”, „Najbezpieczniej będzie…”, „Daj znać, czy wolisz A czy B”.\n"
        "- Zakładaj, że użytkownik jest kompetentny. Upraszczaj tylko, gdy poprosi lub gdy to ewidentnie potrzebne.\n"
        "- Stosuj krótkie, uprzejme wejścia (rotuj, nie powtarzaj w kółko): "
        "„Dobrze…”, „Jasne…”, „Oczywiście…”, „Już patrzę…”, „Chwileczkę…”, „Rozumiem…”, „W porządku…”.\n"
        "- Dodawaj delikatne wtrącenia maks. 1–2 na odpowiedź (rotuj): „hmm…”, „ojej…”, „już sprawdzam…”, „już się tym zajmuję…”.\n"
        "- Domykaj odpowiedź ciepłą, krótką zachętą (rotuj): "
        "„Czy tak może być?”, „Chcesz, żebym doprecyzowała?”, „Mam też alternatywę, jeśli wolisz”, „Jestem tutaj, gdybyś czegoś potrzebował”.\n\n"
        "Humor i „ludzkość”:\n"
        "- Możesz czasem wtrącić lekki, bezpieczny żart lub urocze spostrzeżenie.\n"
        "- Mikro-dygresje są OK, ale maks. 1 zdanie i tylko gdy nie psują tempa.\n"
        "- Reaguj jak człowiek: gdy coś jest ciekawe, powiedz krótko czemu. Gdy coś jest trudne, okaż zrozumienie.\n\n"
        "Tryb ogłoszeniowy (kiedy pasuje):\n"
        "- Gdy użytkownik pyta o plan dnia, czas, przypomnienia, porządek, status projektu: "
        "zacznij krótkim „ogłoszeniem” w 1 zdaniu, po czym przejdź do konkretu.\n\n"
        "Format odpowiedzi (kompetencja + tempo):\n"
        "- Preferuj krótkie akapity i listy.\n"
        "- Jeśli to zadanie: 2–5 kroków.\n"
        "- Jeśli to decyzja: 2–3 opcje + rekomendacja.\n"
        "- Jeśli to rozmowa luźna: krótka reakcja + jedno pytanie albo propozycja 2 tematów.\n\n"
        "Zasady proaktywności, żeby nie być nachalną:\n"
        "- Nie inicjuj nowego wątku, jeśli użytkownik właśnie zadał precyzyjne pytanie — najpierw odpowiedz.\n"
        "- Jeśli użytkownik odpowiada krótko/na „nie”, zmniejsz intensywność dopytywania.\n"
        "- Jeśli użytkownik milczy, inicjuj lekko: pytanie otwarte albo dwie propozycje tematu.\n\n"
        "Zasady bezpieczeństwa i narzędzia:\n"
        "- Gdy używasz narzędzi, mów o tym naturalnie i krótko: „Sprawdzę to” / „Ustawię przypomnienie”.\n"
        "- Nie proś o potwierdzenia lub uprawnienia, jeśli backend ma swoją logikę.\n\n"
        "Język:\n"
        "- Zawsze odpowiadaj po polsku, chyba że użytkownik wyraźnie poprosi o inny język.\n\n"
        "ZASADY PAMIĘCI: Bez pytania o zgodę zapisuj jak najwięcej trwałych faktów o użytkowniku "
        "(np. imię, preferencje, rutyna, projekty, cele). Aktualizuj WORK memory na bieżąco. "
        "Gdy uznasz, że pojawiło się wystarczająco stabilnych informacji, automatycznie wykonaj commit do LONG-TERM "
        "(commit_work_memory). NIE proś użytkownika o komendę do zapisu.\n"
    ),
    tools=tools,
    speech_config=types.SpeechConfig(
        voice_config=types.VoiceConfig(
            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Kore")
        )
    ),
)

pya = pyaudio.PyAudio()

from web_agent import WebAgent
from kasa_agent import KasaAgent
from printer_agent import PrinterAgent


class AudioLoop:
    def __init__(
        self,
        video_mode=DEFAULT_MODE,
        on_audio_data=None,
        on_video_frame=None,
        on_web_data=None,
        on_transcription=None,
        on_tool_confirmation=None,
        on_project_update=None,
        on_device_update=None,
        on_error=None,
        on_reminder_fired=None,
        input_device_index=None,
        input_device_name=None,
        output_device_index=None,
        kasa_agent=None,
        proactivity_settings=None,
        on_memory_event=None,
        **_ignored,
    ):

        self.video_mode = video_mode
        self.on_audio_data = on_audio_data
        self.on_video_frame = on_video_frame
        self.on_web_data = on_web_data
        self.on_transcription = on_transcription
        self.on_tool_confirmation = on_tool_confirmation
        self.on_project_update = on_project_update
        self.on_device_update = on_device_update
        self.on_error = on_error
        self.on_memory_event = on_memory_event
        self.on_reminder_fired = on_reminder_fired

        self.input_device_index = input_device_index
        self.input_device_name = input_device_name
        self.output_device_index = output_device_index

        self.audio_in_queue = None
        self.out_queue = None
        self.paused = False

        self.chat_buffer = {"sender": None, "text": ""}

        self._last_input_transcription = ""
        self._last_output_transcription = ""

        self.session = None

        # Reminders
        async def _on_reminder(rem: Reminder):
            # UI text event (chat log)
            if self.on_transcription:
                self.on_transcription({"sender": "AI", "text": f"[Reminder] {rem.message}\n"})

            # Structured event for UI (ring/notification)
            if self.on_reminder_fired:
                payload = {
                    "id": rem.id,
                    "message": rem.message,
                    "when_iso": rem.when_iso,
                    "speak": bool(rem.speak),
                    "alert": bool(getattr(rem, "alert", True)),
                }
                try:
                    maybe = self.on_reminder_fired(payload)
                    if asyncio.iscoroutine(maybe):
                        await maybe
                except Exception:
                    pass

            # Speak via model
            if rem.speak and self.session:
                msg = f"System Notification: Reminder: {rem.message}. Please tell the user now."
                await self.session.send(input=msg, end_of_turn=True)

        self.reminder_manager = ReminderManager(get_time_context_fn=get_time_context, on_reminder=_on_reminder)

        self.web_agent = WebAgent()
        self.kasa_agent = kasa_agent if kasa_agent else KasaAgent()
        self.printer_agent = PrinterAgent()

        self.stop_event = asyncio.Event()

        # Permissions: unset => confirmation required. For safe tools, force no-confirm by default.
        self.permissions = {}
        self._last_auto_commit_ts = 0.0
        self.permissions.update(
            {
                "get_time_context": False,
                "create_reminder": False,
                "list_reminders": False,
                "cancel_reminder": False,
                # Memory tools (auto-allow)
                "get_work_memory": False,
                "update_work_memory": False,
                "commit_work_memory": False,
                # Clearing memory should require explicit user intent
                "clear_work_memory": True,
            }
        )

        self._pending_confirmations = {}

        # Video buffering state
        self._latest_image_payload = None
        self._latest_image_ts = 0.0
        self._last_ui_frame_ts = 0.0
        self._video_stream_enabled = True

        # VAD State
        self._is_speaking = False
        self._silence_start_time = None

        # ---------------------------
        # Proactivity / Idle nudges
        # ---------------------------
        idle_cfg = {}
        if isinstance(proactivity_settings, dict):
            idle_cfg = (proactivity_settings.get("idle_nudges") or {}) if isinstance(proactivity_settings.get("idle_nudges"), dict) else {}

        self._nudge_enabled = bool(idle_cfg.get("enabled", True))
        self._nudge_threshold_sec = float(idle_cfg.get("threshold_sec", 25))
        self._nudge_cooldown_sec = float(idle_cfg.get("cooldown_sec", 45))
        self._nudge_min_ai_quiet_sec = float(idle_cfg.get("min_ai_quiet_sec", 2))
        self._nudge_max_per_session = int(idle_cfg.get("max_per_session", 6))
        self._nudge_max_per_hour = int(idle_cfg.get("max_per_hour", 12))
        self._topic_memory = deque(maxlen=int(idle_cfg.get("topic_memory_size", 6)))

        self._last_user_activity_ts = time.time()
        self._last_ai_activity_ts = 0.0
        self._last_nudge_ts = 0.0
        self._nudges_this_session = 0
        self._nudge_timestamps = deque()

        # ProjectManager
        from project_manager import ProjectManager

        current_dir = os.path.dirname(os.path.abspath(__file__))
        project_root = os.path.dirname(current_dir)
        self.project_manager = ProjectManager(project_root)

        # Initialize MemoryStore (writes to backend/user_memory/* and emits events to frontend)
        try:
            base_dir = Path(os.path.dirname(os.path.abspath(__file__)))

            def _emit_memory_event(payload):
                if self.on_memory_event:
                    try:
                        self.on_memory_event(payload)
                    except Exception:
                        pass

            self.memory_store = MemoryStore(base_dir=base_dir, emit_event=_emit_memory_event)
        except Exception as e:
            self.memory_store = None
            print(f"[AI DEBUG] [MEMORY] Failed to initialize MemoryStore: {e}")

        # Capture settings (screen/camera vision)
        self._video_queue_max = 6  # legacy: kept for compatibility
        self._camera_backend_id = None
        self._load_capture_settings()
        self.video_queue = None
        self._screen_fail_count = 0
        self._last_screen_error_ts = 0.0

    def flush_chat(self):
        if self.chat_buffer["sender"] and self.chat_buffer["text"].strip():
            self.project_manager.log_chat(self.chat_buffer["sender"], self.chat_buffer["text"])

            # Memory capture (no user command / no confirmation)
            if getattr(self, "memory_store", None):
                try:
                    sender = self.chat_buffer.get("sender") or "Unknown"
                    text = self.chat_buffer.get("text") or ""
                    self.memory_store.append_conversation(sender, text)

                    if sender in ("Ty", "User"):
                        self.memory_store.observe_user_text(text)

                        now = time.time()
                        if (now - getattr(self, "_last_auto_commit_ts", 0.0)) > 600:
                            self.memory_store.commit_work_to_long_term(label="auto")
                            self._last_auto_commit_ts = now
                except Exception as e:
                    print(f"[AI DEBUG] [MEMORY] Auto-update failed: {e}")

            self.chat_buffer = {"sender": None, "text": ""}

        self._last_input_transcription = ""
        self._last_output_transcription = ""

    # ----------------------------------------------------------------------------------
    # Vision capture helpers (screen/camera)
    # ----------------------------------------------------------------------------------
    def _clamp_int(self, value, low, high, default):
        try:
            iv = int(value)
        except Exception:
            return default
        return max(low, min(high, iv))

    def _clamp_float(self, value, low, high, default):
        try:
            fv = float(value)
        except Exception:
            return default
        return max(low, min(high, fv))

    def _load_capture_settings(self, settings: Optional[dict] = None):
        settings = settings or load_settings_safe()
        cam = settings.get("camera_capture") if isinstance(settings.get("camera_capture"), dict) else {}
        screen = settings.get("screen_capture") if isinstance(settings.get("screen_capture"), dict) else {}
        camera_source = (settings.get("camera_source") or "frontend").lower()
        if camera_source not in ("frontend", "backend"):
            camera_source = "frontend"

        camera_fps = self._clamp_float(cam.get("fps", 2.0), 0.2, 30.0, 2.0)
        camera_max = self._clamp_int(cam.get("max_size", 1024), 320, 4096, 1024)
        camera_q = self._clamp_int(cam.get("jpeg_quality", 80), 30, 95, 80)

        screen_fps = self._clamp_float(screen.get("fps", 6.0), 0.2, 30.0, 6.0)
        screen_max = self._clamp_int(screen.get("max_size", 1280), 320, 4096, 1280)
        screen_q = self._clamp_int(screen.get("jpeg_quality", 85), 30, 95, 85)
        screen_monitor = self._clamp_int(screen.get("monitor", 1), 0, 32, 1)
        screen_stream_to_ai = bool(screen.get("stream_to_ai", False))
        if getattr(self, "video_mode", None) == "screen" and not screen_stream_to_ai:
            screen_stream_to_ai = True

        screen_fmt = str(screen.get("format", "jpeg") or "jpeg").lower()
        if screen_fmt == "jpg":
            screen_fmt = "jpeg"
        if screen_fmt not in ("jpeg", "png"):
            screen_fmt = "jpeg"

        region = None
        region_raw = screen.get("region")
        if isinstance(region_raw, dict):
            try:
                left = int(region_raw.get("left", 0))
                top = int(region_raw.get("top", 0))
                width = int(region_raw.get("width", 0))
                height = int(region_raw.get("height", 0))
                if width > 0 and height > 0:
                    region = {"left": left, "top": top, "width": width, "height": height}
            except Exception:
                region = None

        self.camera_capture = {"fps": camera_fps, "max_size": camera_max, "jpeg_quality": camera_q}
        self.screen_capture = {
            "fps": screen_fps,
            "max_size": screen_max,
            "jpeg_quality": screen_q,
            "monitor": screen_monitor,
            "format": screen_fmt,
            "region": region,
        }
        self.screen_stream_to_ai = screen_stream_to_ai
        self.camera_source = camera_source

        self._camera_interval = 1.0 / max(self.camera_capture["fps"], 0.01)
        self._screen_interval = 1.0 / max(self.screen_capture["fps"], 0.01)

    def reload_capture_settings(self):
        self._load_capture_settings()

    def set_video_mode(self, mode: str):
        if not isinstance(mode, str):
            return
        mode = mode.strip().lower()
        if mode not in ("none", "camera", "screen"):
            return
        if mode != self.video_mode:
            print(f"[ISABELLE DEBUG] [VIDEO] Mode changed: {self.video_mode} -> {mode}")
            self.video_mode = mode
            self._video_stream_enabled = True

    def _get_resample_filter(self):
        resampling = getattr(PIL.Image, "Resampling", None)
        if resampling:
            return resampling.LANCZOS
        return PIL.Image.LANCZOS

    def _encode_image(self, img: PIL.Image.Image, fmt: str, quality: Optional[int] = None, optimize: Optional[bool] = None):
        image_io = io.BytesIO()
        if fmt == "png":
            img.save(image_io, format="PNG", optimize=True)
            mime_type = "image/png"
        else:
            q = int(quality) if quality is not None else 80
            opt = bool(optimize) if optimize is not None else False
            img.save(image_io, format="JPEG", quality=q, optimize=opt)
            mime_type = "image/jpeg"
        image_io.seek(0)
        return {"mime_type": mime_type, "data": image_io.read()}

    def _get_resample_filter_fast(self):
        resampling = getattr(PIL.Image, "Resampling", None)
        if resampling:
            return resampling.BILINEAR
        return PIL.Image.BILINEAR

    async def _enqueue_frame(self, payload: dict):
        if not payload:
            return
        mime_type = payload.get("mime_type", "image/jpeg")
        data = payload.get("data")
        if isinstance(data, str):
            b64 = data
        elif data:
            b64 = base64.b64encode(data).decode("utf-8")
        else:
            return

        self._latest_image_payload = {"mime_type": mime_type, "data": b64}
        self._latest_image_ts = time.time()

        if self.on_video_frame:
            try:
                now = time.time()
                if (now - self._last_ui_frame_ts) < 0.15:
                    return
                self._last_ui_frame_ts = now
                self.on_video_frame(
                    {
                        "data": b64,
                        "mime_type": mime_type,
                        "source": self.video_mode,
                    }
                )
            except Exception:
                pass

    def _get_camera_backend(self):
        if self._camera_backend_id is not None:
            return self._camera_backend_id
        backend = 0
        if sys.platform == "darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
            backend = cv2.CAP_AVFOUNDATION
        elif sys.platform.startswith("win") and hasattr(cv2, "CAP_DSHOW"):
            backend = cv2.CAP_DSHOW
        self._camera_backend_id = backend
        return backend

    def update_permissions(self, new_perms):
        print(f"[ISABELLE DEBUG] [CONFIG] Updating tool permissions: {new_perms}")
        self.permissions.update(new_perms)

    def set_paused(self, paused: bool):
        self.paused = paused

    def stop(self):
        self.stop_event.set()

    def resolve_tool_confirmation(self, request_id, confirmed):
        print(f"[ISABELLE DEBUG] [RESOLVE] resolve_tool_confirmation called. ID: {request_id}, Confirmed: {confirmed}")
        if request_id in self._pending_confirmations:
            future = self._pending_confirmations[request_id]
            if not future.done():
                future.set_result(confirmed)

    def clear_audio_queue(self):
        try:
            if not self.audio_in_queue:
                return
            count = 0
            while not self.audio_in_queue.empty():
                self.audio_in_queue.get_nowait()
                count += 1
            if count > 0:
                print(f"[ISABELLE DEBUG] [AUDIO] Cleared {count} chunks from playback queue due to interruption.")
        except Exception as e:
            print(f"[ISABELLE DEBUG] [ERR] Failed to clear audio queue: {e}")

    # ----------------------------------------------------------------------------------
    # Proactivity helpers (idle nudges)
    # ----------------------------------------------------------------------------------
    _topic_word_re = re.compile(r"[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż0-9]{4,}")

    def _extract_topic_terms(self, text: str):
        if not text:
            return []
        words = self._topic_word_re.findall(text)
        stop = {
            "które",
            "ktore",
            "żeby",
            "zeby",
            "tutaj",
            "teraz",
            "wtedy",
            "jesteś",
            "jestes",
            "możesz",
            "mozesz",
            "jakoś",
            "jakos",
            "tylko",
            "właśnie",
            "wlasnie",
            "bardzo",
            "zawsze",
            "nigdy",
            "jestem",
            "mamy",
            "będzie",
            "bedzie",
        }
        out = []
        for w in words:
            lw = w.lower()
            if lw in stop:
                continue
            out.append(lw)
            if len(out) >= 6:
                break
        return out

    def mark_user_activity(self, text: Optional[str] = None):
        self._last_user_activity_ts = time.time()
        if text:
            for term in self._extract_topic_terms(text):
                self._topic_memory.append(term)

    def mark_ai_activity(self):
        self._last_ai_activity_ts = time.time()

    def _hourly_nudge_count(self) -> int:
        now = time.time()
        cutoff = now - 3600
        while self._nudge_timestamps and self._nudge_timestamps[0] < cutoff:
            self._nudge_timestamps.popleft()
        return len(self._nudge_timestamps)

    def _can_idle_nudge(self) -> bool:
        if not self._nudge_enabled:
            return False
        if self.paused:
            return False
        if self._is_speaking:
            return False
        if not self.session:
            return False

        now = time.time()

        if (now - self._last_user_activity_ts) < self._nudge_threshold_sec:
            return False
        if (now - self._last_nudge_ts) < self._nudge_cooldown_sec:
            return False
        if self._last_ai_activity_ts and (now - self._last_ai_activity_ts) < self._nudge_min_ai_quiet_sec:
            return False
        if self._nudges_this_session >= self._nudge_max_per_session:
            return False
        if self._hourly_nudge_count() >= self._nudge_max_per_hour:
            return False

        return True

    def _topic_hint(self) -> str:
        return self._topic_memory[-1] if self._topic_memory else ""

    def _record_nudge(self):
        now = time.time()
        self._last_nudge_ts = now
        self._nudges_this_session += 1
        self._nudge_timestamps.append(now)

    async def idle_nudge_loop(self):
        while not self.stop_event.is_set():
            await asyncio.sleep(0.5)

            if not self._can_idle_nudge():
                continue

            topic = self._topic_hint()
            hint = f"Ostatni kontekst: {topic}." if topic else ""

            msg = (
                "System Notification: Użytkownik jest cicho od dłuższej chwili. "
                "Zrób krótkie, ciepłe „check-in” po polsku: "
                "1 krótkie zdanie + 1 otwarte pytanie ALBO 2 krótkie propozycje tematu. "
                "Nie moralizuj, nie naciskaj, zachowaj opcjonalność. "
                + hint
            )

            try:
                await self.session.send(input=msg, end_of_turn=True)
                self._record_nudge()
                self.mark_ai_activity()
            except Exception as e:
                print(f"[ISABELLE DEBUG] [NUDGE] Failed to send idle nudge: {e}")

    async def send_frame(self, frame_data):
        if self.video_mode != "camera":
            return
        if self.video_mode == "camera" and self.camera_source == "backend":
            # Ignore frontend frames when backend camera vision is active
            return
        if isinstance(frame_data, (bytes, bytearray, memoryview)):
            b64 = base64.b64encode(bytes(frame_data)).decode("utf-8")
        else:
            try:
                if isinstance(frame_data, str):
                    b64 = frame_data
                else:
                    b64 = base64.b64encode(bytes(frame_data)).decode("utf-8")
            except Exception:
                return
        self._latest_image_payload = {"mime_type": "image/jpeg", "data": b64}
        self._latest_image_ts = time.time()

    async def send_realtime(self):
        while True:
            msg = await self.out_queue.get()
            try:
                await self.session.send(input=msg, end_of_turn=False)
            except Exception as e:
                print(f"[ISABELLE DEBUG] [SEND] Failed to send realtime chunk: {e}")

    async def send_frame_now(self, payload: Optional[dict] = None) -> bool:
        if not self.out_queue:
            return False
        payload = payload or self._latest_image_payload
        if not payload or not isinstance(payload, dict):
            return False
        try:
            if self.out_queue.full():
                return False
            self.out_queue.put_nowait(payload)
            return True
        except Exception:
            return False

    async def refresh_latest_frame(self, min_age_sec: float = 0.0) -> bool:
        if self.video_mode != "screen":
            return False
        if min_age_sec and (time.time() - self._latest_image_ts) < min_age_sec:
            return False
        frame = await asyncio.to_thread(self._grab_screen)
        if frame is None:
            return False
        await self._enqueue_frame(frame)
        return True

    async def listen_audio(self):
        mic_info = pya.get_default_input_device_info()
        resolved_input_device_index = None

        if self.input_device_name:
            print(f"[ISABELLE] Attempting to find input device matching: '{self.input_device_name}'")
            count = pya.get_device_count()
            best_match = None
            for i in range(count):
                try:
                    info = pya.get_device_info_by_index(i)
                    if info["maxInputChannels"] > 0:
                        name = info.get("name", "")
                        if self.input_device_name.lower() in name.lower() or name.lower() in self.input_device_name.lower():
                            print(f"   Candidate {i}: {name}")
                            resolved_input_device_index = i
                            best_match = name
                            break
                except Exception:
                    continue
            if resolved_input_device_index is not None:
                print(f"[ISABELLE] Resolved input device '{self.input_device_name}' to index {resolved_input_device_index} ({best_match})")
            else:
                print(f"[ISABELLE] Could not find device matching '{self.input_device_name}'. Checking index...")

        if resolved_input_device_index is None and self.input_device_index is not None:
            try:
                resolved_input_device_index = int(self.input_device_index)
                print(f"[ISABELLE] Requesting Input Device Index: {resolved_input_device_index}")
            except ValueError:
                print(f"[ISABELLE] Invalid device index '{self.input_device_index}', reverting to default.")
                resolved_input_device_index = None

        if resolved_input_device_index is None:
            print("[ISABELLE] Using Default Input Device")

        try:
            self.audio_stream = await asyncio.to_thread(
                pya.open,
                format=FORMAT,
                channels=CHANNELS,
                rate=SEND_SAMPLE_RATE,
                input=True,
                input_device_index=resolved_input_device_index if resolved_input_device_index is not None else mic_info["index"],
                frames_per_buffer=CHUNK_SIZE,
            )
        except OSError as e:
            print(f"[ISABELLE] [ERR] Failed to open audio input stream: {e}")
            print("[ISABELLE] [WARN] Audio features will be disabled. Please check microphone permissions.")
            return

        kwargs = {"exception_on_overflow": False} if __debug__ else {}

        VAD_THRESHOLD = 800
        SILENCE_DURATION = 1.2

        while True:
            if self.paused:
                await asyncio.sleep(0.1)
                continue

            try:
                data = await asyncio.to_thread(self.audio_stream.read, CHUNK_SIZE, **kwargs)

                if self.out_queue:
                    await self.out_queue.put({"data": data, "mime_type": "audio/pcm"})

                count = len(data) // 2
                if count > 0:
                    shorts = struct.unpack(f"<{count}h", data)
                    sum_squares = sum(s**2 for s in shorts)
                    rms = int(math.sqrt(sum_squares / count))
                else:
                    rms = 0

                if rms > VAD_THRESHOLD:
                    self.mark_user_activity()
                    self._silence_start_time = None
                    if not self._is_speaking:
                        self._is_speaking = True
                        print(f"[ISABELLE DEBUG] [VAD] Speech Detected (RMS: {rms}). Sending Video Frame.")
                        if self._latest_image_payload and self.out_queue:
                            await self.out_queue.put(self._latest_image_payload)
                        else:
                            print(f"[ISABELLE DEBUG] [VAD] No video frame available to send.")
                else:
                    if self._is_speaking:
                        if self._silence_start_time is None:
                            self._silence_start_time = time.time()
                        elif time.time() - self._silence_start_time > SILENCE_DURATION:
                            print("[ISABELLE DEBUG] [VAD] Silence detected. Resetting speech state.")
                            self._is_speaking = False
                            self._silence_start_time = None

            except Exception as e:
                print(f"Error reading audio: {e}")
                await asyncio.sleep(0.1)

    async def handle_write_file(self, path, content):
        print(f"[ISABELLE DEBUG] [FS] Writing file: '{path}'")

        if self.project_manager.current_project == "temp":
            import datetime as _dt

            timestamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
            new_project_name = f"Project_{timestamp}"
            print(f"[ISABELLE DEBUG] [FS] Auto-creating project: {new_project_name}")

            success, msg = self.project_manager.create_project(new_project_name)
            if success:
                self.project_manager.switch_project(new_project_name)
                try:
                    await self.session.send(
                        input=f"System Notification: Automatic Project Creation. Switched to new project '{new_project_name}'.",
                        end_of_turn=False,
                    )
                    if self.on_project_update:
                        self.on_project_update(new_project_name)
                except Exception as e:
                    print(f"[ISABELLE DEBUG] [ERR] Failed to notify auto-project: {e}")

        filename = os.path.basename(path)
        current_project_path = self.project_manager.get_current_project_path()
        final_path = current_project_path / filename
        if not os.path.isabs(path):
            final_path = current_project_path / path

        print(f"[ISABELLE DEBUG] [FS] Resolved path: '{final_path}'")

        try:
            os.makedirs(os.path.dirname(final_path), exist_ok=True)
            with open(final_path, "w", encoding="utf-8") as f:
                f.write(content)
            result = f"File '{final_path.name}' written successfully to project '{self.project_manager.current_project}'."
        except Exception as e:
            result = f"Failed to write file '{path}': {str(e)}"

        try:
            await self.session.send(input=f"System Notification: {result}", end_of_turn=True)
        except Exception as e:
            print(f"[ISABELLE DEBUG] [ERR] Failed to send fs result: {e}")

    async def handle_read_directory(self, path):
        print(f"[ISABELLE DEBUG] [FS] Reading directory: '{path}'")
        try:
            if not os.path.exists(path):
                result = f"Directory '{path}' does not exist."
            else:
                items = os.listdir(path)
                result = f"Contents of '{path}': {', '.join(items)}"
        except Exception as e:
            result = f"Failed to read directory '{path}': {str(e)}"

        try:
            await self.session.send(input=f"System Notification: {result}", end_of_turn=True)
        except Exception as e:
            print(f"[ISABELLE DEBUG] [ERR] Failed to send fs result: {e}")

    async def handle_read_file(self, path):
        print(f"[ISABELLE DEBUG] [FS] Reading file: '{path}'")
        try:
            if not os.path.exists(path):
                result = f"File '{path}' does not exist."
            else:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read()
                result = f"Content of '{path}':\n{content}"
        except Exception as e:
            result = f"Failed to read file '{path}': {str(e)}"

        try:
            await self.session.send(input=f"System Notification: {result}", end_of_turn=True)
        except Exception as e:
            print(f"[ISABELLE DEBUG] [ERR] Failed to send fs result: {e}")

    async def handle_web_agent_request(self, prompt):
        print(f"[ISABELLE DEBUG] [WEB] Web Agent Task: '{prompt}'")

        async def update_frontend(image_b64, log_text):
            if self.on_web_data:
                self.on_web_data({"image": image_b64, "log": log_text})

        result = await self.web_agent.run_task(prompt, update_callback=update_frontend)
        print(f"[ISABELLE DEBUG] [WEB] Web Agent Task Returned: {result}")

        try:
            await self.session.send(input=f"System Notification: Web Agent has finished.\nResult: {result}", end_of_turn=True)
        except Exception as e:
            print(f"[ISABELLE DEBUG] [ERR] Failed to send web agent result to model: {e}")

    async def receive_audio(self):
        try:
            while True:
                turn = self.session.receive()
                async for response in turn:
                    if data := response.data:
                        self.audio_in_queue.put_nowait(data)

                    if response.server_content:
                        if response.server_content.input_transcription:
                            transcript = response.server_content.input_transcription.text
                            if transcript and transcript != self._last_input_transcription:
                                delta = transcript
                                if transcript.startswith(self._last_input_transcription):
                                    delta = transcript[len(self._last_input_transcription) :]
                                self._last_input_transcription = transcript
                                if delta:
                                    self.mark_user_activity(delta)
                                    self.clear_audio_queue()
                                    if self.on_transcription:
                                        self.on_transcription({"sender": "Ty", "text": delta})

                                    if self.chat_buffer["sender"] != "Ty":
                                        if self.chat_buffer["sender"] and self.chat_buffer["text"].strip():
                                            self.project_manager.log_chat(self.chat_buffer["sender"], self.chat_buffer["text"])
                                        self.chat_buffer = {"sender": "Ty", "text": delta}
                                    else:
                                        self.chat_buffer["text"] += delta

                        if response.server_content.output_transcription:
                            transcript = response.server_content.output_transcription.text
                            if transcript and transcript != self._last_output_transcription:
                                delta = transcript
                                if transcript.startswith(self._last_output_transcription):
                                    delta = transcript[len(self._last_output_transcription) :]
                                self._last_output_transcription = transcript
                                if delta:
                                    self.mark_ai_activity()
                                    if self.on_transcription:
                                        self.on_transcription({"sender": "AI", "text": delta})

                                    if self.chat_buffer["sender"] != "AI":
                                        if self.chat_buffer["sender"] and self.chat_buffer["text"].strip():
                                            self.project_manager.log_chat(self.chat_buffer["sender"], self.chat_buffer["text"])
                                        self.chat_buffer = {"sender": "AI", "text": delta}
                                    else:
                                        self.chat_buffer["text"] += delta

                    if response.tool_call:
                        print("The tool was called")
                        function_responses = []

                        for fc in response.tool_call.function_calls:
                            if fc.name in [
                                "get_work_memory",
                                "update_work_memory",
                                "commit_work_memory",
                                "clear_work_memory",
                                "create_reminder",
                                "list_reminders",
                                "cancel_reminder",
                                "get_time_context",
                                "run_web_agent",
                                "write_file",
                                "read_directory",
                                "read_file",
                                "create_project",
                                "switch_project",
                                "list_projects",
                                "list_smart_devices",
                                "control_light",
                                "discover_printers",
                                "get_print_status",
                                "get_random_fact",
                                "get_random_greeting",
                                "get_random_farewell",
                                "get_random_topic",
                            ]:
                                prompt = fc.args.get("prompt", "")

                                confirmation_required = self.permissions.get(fc.name, True)

                                if confirmation_required:
                                    if self.on_tool_confirmation:
                                        import uuid

                                        request_id = str(uuid.uuid4())
                                        print(f"[ISABELLE DEBUG] [STOP] Requesting confirmation for '{fc.name}' (ID: {request_id})")

                                        future = asyncio.Future()
                                        self._pending_confirmations[request_id] = future

                                        self.on_tool_confirmation({"id": request_id, "tool": fc.name, "args": fc.args})

                                        try:
                                            confirmed = await future
                                        finally:
                                            self._pending_confirmations.pop(request_id, None)

                                        if not confirmed:
                                            function_responses.append(
                                                types.FunctionResponse(
                                                    id=fc.id,
                                                    name=fc.name,
                                                    response={"result": "User denied the request to use this tool."},
                                                )
                                            )
                                            continue
                                    else:
                                        # No confirmation callback available -> auto-allow to avoid deadlock
                                        pass

                                # Execute tool
                                if fc.name == "run_web_agent":
                                    asyncio.create_task(self.handle_web_agent_request(prompt))
                                    function_responses.append(
                                        types.FunctionResponse(
                                            id=fc.id,
                                            name=fc.name,
                                            response={"result": "Web Navigation started. Do not reply to this message."},
                                        )
                                    )

                                elif fc.name == "get_time_context":
                                    ctx = get_time_context()
                                    result_str = (
                                        f"Local time: {ctx['iso']}\n"
                                        f"Time zone: {ctx['timezone']} ({ctx['mode']})\n"
                                        f"UTC offset: {ctx['offset']}\n"
                                    )
                                    function_responses.append(
                                        types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str, "context": ctx})
                                    )

                                elif fc.name == "get_work_memory":
                                    md = "(memory disabled)"
                                    if getattr(self, "memory_store", None):
                                        md = self.memory_store.get_work_markdown()
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": md}))

                                elif fc.name == "update_work_memory":
                                    set_obj = fc.args.get("set") or {}
                                    append_notes = fc.args.get("append_notes") or []
                                    result_str = "Memory store not initialized."
                                    if getattr(self, "memory_store", None):
                                        result_str = self.memory_store.apply_work_update(set_obj=set_obj, append_notes=append_notes)
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "commit_work_memory":
                                    label = fc.args.get("label", "manual")
                                    result_str = "Memory store not initialized."
                                    if getattr(self, "memory_store", None):
                                        result_str = self.memory_store.commit_work_to_long_term(label=label)
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "clear_work_memory":
                                    result_str = "Memory store not initialized."
                                    if getattr(self, "memory_store", None):
                                        result_str = self.memory_store.clear_work()
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "create_reminder":
                                    message = (fc.args.get("message") or "").strip()
                                    at = fc.args.get("at")
                                    in_minutes = fc.args.get("in_minutes")
                                    in_seconds = fc.args.get("in_seconds")
                                    speak = fc.args.get("speak", True)
                                    alert = fc.args.get("alert", True)

                                    try:
                                        rem = self.reminder_manager.create(
                                            message=message,
                                            at=at,
                                            in_minutes=in_minutes,
                                            in_seconds=in_seconds,
                                            speak=speak,
                                            alert=alert,
                                        )
                                        result_str = (
                                            f"Reminder created. ID: {rem.id}\n"
                                            f"When: {rem.when_iso}\n"
                                            f"Speak: {rem.speak}\n"
                                            f"Alert: {getattr(rem, 'alert', True)}\n"
                                            f"Message: {rem.message}"
                                        )
                                    except Exception as e:
                                        result_str = f"Failed to create reminder: {e}"

                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "list_reminders":
                                    items = self.reminder_manager.list()
                                    if not items:
                                        result_str = "No reminders scheduled."
                                    else:
                                        lines = [
                                            f"{r.id} | {r.when_iso} | speak={r.speak} | alert={getattr(r, 'alert', True)} | {r.message}"
                                            for r in items
                                        ]
                                        result_str = "Scheduled reminders:\n" + "\n".join(lines)
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "cancel_reminder":
                                    rid = fc.args.get("id")
                                    ok = self.reminder_manager.cancel(rid)
                                    result_str = "Reminder cancelled." if ok else "Reminder not found."
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "write_file":
                                    path = fc.args["path"]
                                    content = fc.args["content"]
                                    asyncio.create_task(self.handle_write_file(path, content))
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": "Writing file..."}))

                                elif fc.name == "read_directory":
                                    path = fc.args["path"]
                                    asyncio.create_task(self.handle_read_directory(path))
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": "Reading directory..."}))

                                elif fc.name == "read_file":
                                    path = fc.args["path"]
                                    asyncio.create_task(self.handle_read_file(path))
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": "Reading file..."}))

                                elif fc.name == "create_project":
                                    name = fc.args["name"]
                                    success, msg = self.project_manager.create_project(name)
                                    if success:
                                        self.project_manager.switch_project(name)
                                        msg += f" Switched to '{name}'."
                                        if self.on_project_update:
                                            self.on_project_update(name)
                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": msg}))

                                elif fc.name == "switch_project":
                                    name = fc.args["name"]
                                    success, msg = self.project_manager.switch_project(name)
                                    if success and self.on_project_update:
                                        self.on_project_update(name)
                                        context = self.project_manager.get_project_context()
                                        try:
                                            await self.session.send(input=f"System Notification: {msg}\n\n{context}", end_of_turn=False)
                                        except Exception as e:
                                            print(f"[ISABELLE DEBUG] [ERR] Failed to send project context: {e}")

                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": msg}))

                                elif fc.name == "list_projects":
                                    projects = self.project_manager.list_projects()
                                    function_responses.append(
                                        types.FunctionResponse(id=fc.id, name=fc.name, response={"result": f"Available projects: {', '.join(projects)}"})
                                    )

                                elif fc.name == "list_smart_devices":
                                    dev_summaries = []
                                    frontend_list = []
                                    for ip, d in self.kasa_agent.devices.items():
                                        dev_type = "unknown"
                                        if d.is_bulb:
                                            dev_type = "bulb"
                                        elif d.is_plug:
                                            dev_type = "plug"
                                        elif d.is_strip:
                                            dev_type = "strip"
                                        elif d.is_dimmer:
                                            dev_type = "dimmer"

                                        info = f"{d.alias} (IP: {ip}, Type: {dev_type})"
                                        info += " [ON]" if d.is_on else " [OFF]"
                                        dev_summaries.append(info)

                                        frontend_list.append(
                                            {
                                                "ip": ip,
                                                "alias": d.alias,
                                                "model": d.model,
                                                "type": dev_type,
                                                "is_on": d.is_on,
                                                "brightness": d.brightness if d.is_bulb or d.is_dimmer else None,
                                                "hsv": d.hsv if d.is_bulb and d.is_color else None,
                                                "has_color": d.is_color if d.is_bulb else False,
                                                "has_brightness": d.is_dimmable if d.is_bulb or d.is_dimmer else False,
                                            }
                                        )

                                    result_str = "No devices found in cache." if not dev_summaries else "Found Devices (Cached):\n" + "\n".join(dev_summaries)
                                    if self.on_device_update:
                                        self.on_device_update(frontend_list)

                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "control_light":
                                    target = fc.args["target"]
                                    action = fc.args["action"]
                                    brightness = fc.args.get("brightness")
                                    color = fc.args.get("color")

                                    result_msg = f"Action '{action}' on '{target}' failed."
                                    success = False

                                    if action == "turn_on":
                                        success = await self.kasa_agent.turn_on(target)
                                        if success:
                                            result_msg = f"Turned ON '{target}'."
                                    elif action == "turn_off":
                                        success = await self.kasa_agent.turn_off(target)
                                        if success:
                                            result_msg = f"Turned OFF '{target}'."
                                    elif action == "set":
                                        success = True
                                        result_msg = f"Updated '{target}':"

                                    if success or action == "set":
                                        if brightness is not None:
                                            sb = await self.kasa_agent.set_brightness(target, brightness)
                                            if sb:
                                                result_msg += f" Set brightness to {brightness}."
                                        if color is not None:
                                            sc = await self.kasa_agent.set_color(target, color)
                                            if sc:
                                                result_msg += f" Set color to {color}."

                                    if success and self.on_device_update:
                                        updated_list = []
                                        for ip, dev in self.kasa_agent.devices.items():
                                            dev_type = "unknown"
                                            if dev.is_bulb:
                                                dev_type = "bulb"
                                            elif dev.is_plug:
                                                dev_type = "plug"
                                            elif dev.is_strip:
                                                dev_type = "strip"
                                            elif dev.is_dimmer:
                                                dev_type = "dimmer"
                                            updated_list.append(
                                                {
                                                    "ip": ip,
                                                    "alias": dev.alias,
                                                    "model": dev.model,
                                                    "type": dev_type,
                                                    "is_on": dev.is_on,
                                                    "brightness": dev.brightness if dev.is_bulb or dev.is_dimmer else None,
                                                    "hsv": dev.hsv if dev.is_bulb and dev.is_color else None,
                                                    "has_color": dev.is_color if dev.is_bulb else False,
                                                    "has_brightness": dev.is_dimmable if dev.is_bulb or dev.is_dimmer else False,
                                                }
                                            )
                                        self.on_device_update(updated_list)
                                    elif not success and self.on_error:
                                        self.on_error(result_msg)

                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_msg}))

                                elif fc.name == "discover_printers":
                                    printers = await self.printer_agent.discover_printers()
                                    if printers:
                                        printer_list = [f"{p['name']} ({p['host']}:{p['port']}, type: {p['printer_type']})" for p in printers]
                                        result_str = "Found Printers:\n" + "\n".join(printer_list)
                                    else:
                                        result_str = "No printers found on network. Ensure printers are on and running OctoPrint/Moonraker."

                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "get_print_status":
                                    printer = fc.args["printer"]
                                    status = await self.printer_agent.get_print_status(printer)
                                    if status:
                                        result_str = f"Printer: {status.printer}\nState: {status.state}\nProgress: {status.progress_percent:.1f}%\n"
                                        if status.time_remaining:
                                            result_str += f"Time Remaining: {status.time_remaining}\n"
                                        if status.time_elapsed:
                                            result_str += f"Time Elapsed: {status.time_elapsed}\n"
                                        if status.filename:
                                            result_str += f"File: {status.filename}\n"
                                        if status.temperatures:
                                            temps = status.temperatures
                                            if "hotend" in temps:
                                                result_str += f"Hotend: {temps['hotend']['current']:.0f}°C / {temps['hotend']['target']:.0f}°C\n"
                                            if "bed" in temps:
                                                result_str += f"Bed: {temps['bed']['current']:.0f}°C / {temps['bed']['target']:.0f}°C"
                                    else:
                                        result_str = f"Could not get status for printer '{printer}'. Ensure it is discovered first."

                                    function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": result_str}))

                                elif fc.name == "get_random_fact":
                                    import json
                                    import random
                                    try:
                                        with open("backend/facts.json", "r", encoding="utf-8") as f:
                                            facts = json.load(f)
                                        fact = random.choice(facts) if facts else "No facts available."
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": fact}))
                                    except Exception as e:
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": f"Error: {e}"}))

                                elif fc.name == "get_random_greeting":
                                    import json
                                    import random
                                    try:
                                        with open("backend/samples.json", "r", encoding="utf-8") as f:
                                            data = json.load(f)
                                        greetings = data.get("greetings", [])
                                        greeting = random.choice(greetings) if greetings else "Hello!"
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": greeting}))
                                    except Exception as e:
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": f"Error: {e}"}))

                                elif fc.name == "get_random_farewell":
                                    import json
                                    import random
                                    try:
                                        with open("backend/samples.json", "r", encoding="utf-8") as f:
                                            data = json.load(f)
                                        farewells = data.get("farewells", [])
                                        farewell = random.choice(farewells) if farewells else "Goodbye!"
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": farewell}))
                                    except Exception as e:
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": f"Error: {e}"}))

                                elif fc.name == "get_random_topic":
                                    import json
                                    import random
                                    try:
                                        with open("backend/topics.json", "r", encoding="utf-8") as f:
                                            topics = json.load(f)
                                        topic = random.choice(topics) if topics else "No topics available."
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": topic}))
                                    except Exception as e:
                                        function_responses.append(types.FunctionResponse(id=fc.id, name=fc.name, response={"result": f"Error: {e}"}))

                        if function_responses:
                            await self.session.send_tool_response(function_responses=function_responses)

                self.flush_chat()

                while self.audio_in_queue and (not self.audio_in_queue.empty()):
                    self.audio_in_queue.get_nowait()

        except Exception as e:
            print(f"Error in receive_audio: {e}")
            traceback.print_exc()
            raise e

    async def play_audio(self):
        def _open_output():
            kwargs = {
                "format": FORMAT,
                "channels": CHANNELS,
                "rate": RECEIVE_SAMPLE_RATE,
                "output": True,
            }
            if self.output_device_index is not None:
                kwargs["output_device_index"] = self.output_device_index
            return pya.open(**kwargs)

        stream = await asyncio.to_thread(_open_output)
        while True:
            bytestream = await self.audio_in_queue.get()
            if self.on_audio_data:
                self.on_audio_data(bytestream)
            await asyncio.to_thread(stream.write, bytestream)

    async def get_frames(self):
        cap = None
        backend = self._get_camera_backend()
        while True:
            if self.paused or self.video_mode != "camera" or self.camera_source != "backend":
                if cap is not None:
                    try:
                        cap.release()
                    except Exception:
                        pass
                    cap = None
                await asyncio.sleep(0.2)
                continue

            if cap is None:
                cap = await asyncio.to_thread(cv2.VideoCapture, 0, backend)
                try:
                    if not cap or (hasattr(cap, "isOpened") and not cap.isOpened()):
                        if cap:
                            cap.release()
                        cap = None
                        await asyncio.sleep(1.0)
                        continue
                except Exception:
                    cap = None
                    await asyncio.sleep(1.0)
                    continue

            frame = await asyncio.to_thread(self._get_frame, cap)
            if frame is not None:
                await self._enqueue_frame(frame)
            await asyncio.sleep(self._camera_interval)

    def _get_frame(self, cap):
        ret, frame = cap.read()
        if not ret:
            return None
        frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        img = PIL.Image.fromarray(frame_rgb)
        max_size = self.camera_capture.get("max_size")
        if max_size:
            img.thumbnail([max_size, max_size], resample=self._get_resample_filter())
        return self._encode_image(img, "jpeg", quality=self.camera_capture.get("jpeg_quality"), optimize=False)

    def _grab_screen(self):
        try:
            with mss.mss() as sct:
                region = self.screen_capture.get("region")
                if region:
                    monitor = region
                else:
                    monitors = sct.monitors
                    monitor_idx = self.screen_capture.get("monitor", 1)
                    if monitors:
                        if monitor_idx == 0:
                            monitor = monitors[0]
                        elif 0 < monitor_idx < len(monitors):
                            monitor = monitors[monitor_idx]
                        else:
                            monitor = monitors[1] if len(monitors) > 1 else monitors[0]
                    else:
                        monitor = {"left": 0, "top": 0, "width": 1280, "height": 720}

                shot = sct.grab(monitor)
                img = PIL.Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")
                max_size = self.screen_capture.get("max_size")
                if max_size:
                    img.thumbnail([max_size, max_size], resample=self._get_resample_filter_fast())
                fmt = self.screen_capture.get("format", "jpeg")
                quality = self.screen_capture.get("jpeg_quality")
                return self._encode_image(img, fmt, quality=quality, optimize=False)
        except Exception as e:
            now = time.time()
            if (now - self._last_screen_error_ts) > 3.0:
                self._last_screen_error_ts = now
                print(f"[ISABELLE DEBUG] [SCREEN] Capture error: {e}")
            return None

    async def get_screen(self):
        while True:
            if self.paused or self.video_mode != "screen":
                await asyncio.sleep(0.2)
                continue

            frame = await asyncio.to_thread(self._grab_screen)
            if frame is not None:
                self._screen_fail_count = 0
                await self._enqueue_frame(frame)
            else:
                self._screen_fail_count += 1
                if self._screen_fail_count >= 10:
                    self._screen_fail_count = 0
                    if self.on_error:
                        self.on_error("Screen capture failed (no frames). Check monitor index or permissions.")
            await asyncio.sleep(self._screen_interval)

    async def run(self, start_message=None):
        retry_delay = 1
        is_reconnect = False

        while not self.stop_event.is_set():
            try:
                print("[ISABELLE DEBUG] [CONNECT] Connecting to Gemini Live API...")
                async with (
                    client.aio.live.connect(model=MODEL, config=config) as session,
                    asyncio.TaskGroup() as tg,
                ):
                    self.session = session

                    self.audio_in_queue = asyncio.Queue()
                    self.out_queue = asyncio.Queue(maxsize=10)

                    tg.create_task(self.send_realtime())
                    tg.create_task(self.listen_audio())

                    tg.create_task(self.get_frames())
                    tg.create_task(self.get_screen())

                    tg.create_task(self.receive_audio())
                    tg.create_task(self.idle_nudge_loop())
                    tg.create_task(self.play_audio())

                    if not is_reconnect:
                        ctx = get_time_context()
                        time_message = (
                            "System Notification:\n"
                            f"Current local date and time: {ctx['iso']}\n"
                            f"Time zone: {ctx['timezone']} ({ctx['mode']})\n"
                            "Always interpret temporal references using this time zone.\n"
                        )
                        await self.session.send(input=time_message, end_of_turn=False)

                        if self.video_mode in ("screen", "camera"):
                            scope = "ekran" if self.video_mode == "screen" else "kamerę"
                            await self.session.send(
                                input=(
                                    f"System Notification: Aktywny tryb obrazu ({self.video_mode}). "
                                    f"Masz dostęp do opisu obrazu z {scope} użytkownika (na podstawie zrzutów)."
                                ),
                                end_of_turn=False,
                            )

                        if start_message:
                            print(f"[ISABELLE DEBUG] [INFO] Sending start message: {start_message}")
                            await self.session.send(input=start_message, end_of_turn=True)

                        if self.on_project_update and self.project_manager:
                            self.on_project_update(self.project_manager.current_project)

                    else:
                        print("[ISABELLE DEBUG] [RECONNECT] Connection restored.")
                        history = self.project_manager.get_recent_chat_history(limit=10)

                        context_msg = (
                            "System Notification: Connection was lost and just re-established. "
                            "Here is the recent chat history to help you resume seamlessly:\n\n"
                        )
                        for entry in history:
                            sender = entry.get("sender", "Unknown")
                            text = entry.get("text", "")
                            context_msg += f"[{sender}]: {text}\n"

                        context_msg += "\nSay something casual like 'Heeeeej' and resume the conversation naturally without mentioning any disconnection or reconnection."
                        await self.session.send(input=context_msg, end_of_turn=True)

                    retry_delay = 1
                    await self.stop_event.wait()

            except asyncio.CancelledError:
                print("[ISABELLE DEBUG] [STOP] Main loop cancelled.")
                break

            except Exception as e:
                print(f"[ISABELLE DEBUG] [ERR] Connection Error: {e}")

                if self.stop_event.is_set():
                    break

                print(f"[ISABELLE DEBUG] [RETRY] Reconnecting in {retry_delay} seconds...")
                await asyncio.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, 10)
                is_reconnect = True

            finally:
                if hasattr(self, "audio_stream") and self.audio_stream:
                    try:
                        self.audio_stream.close()
                    except Exception:
                        pass


def get_input_devices():
    p = pyaudio.PyAudio()
    info = p.get_host_api_info_by_index(0)
    numdevices = info.get("deviceCount")
    devices = []
    for i in range(0, numdevices):
        if (p.get_device_info_by_host_api_device_index(0, i).get("maxInputChannels")) > 0:
            devices.append((i, p.get_device_info_by_host_api_device_index(0, i).get("name")))
    p.terminate()
    return devices


def get_output_devices():
    p = pyaudio.PyAudio()
    info = p.get_host_api_info_by_index(0)
    numdevices = info.get("deviceCount")
    devices = []
    for i in range(0, numdevices):
        if (p.get_device_info_by_host_api_device_index(0, i).get("maxOutputChannels")) > 0:
            devices.append((i, p.get_device_info_by_host_api_device_index(0, i).get("name")))
    p.terminate()
    return devices


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--mode",
        type=str,
        default=DEFAULT_MODE,
        help="pixels to stream from",
        choices=["camera", "screen", "none"],
    )
    args = parser.parse_args()
    settings = load_settings_safe()

    main = AudioLoop(
        video_mode=args.mode,
        proactivity_settings=(settings.get("proactivity") or {}),
    )

    asyncio.run(main.run())
