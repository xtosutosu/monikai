import json
import time
import random
import urllib.request
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, asdict
from typing import Optional, Callable

@dataclass
class PersonalityState:
    affection: float = 0.0
    mood: str = "neutral"
    energy: float = 0.8
    base_energy: float = 0.8
    cycle_day: int = 1
    last_update_ts: float = 0.0
    current_cycle_length: int = 28
    phase: str = "Low Energy, Calm"
    weather: str = "Unknown"
    last_weather_ts: float = 0.0
    last_energy_reset_day: int = 0
    last_dream: Optional[str] = None
    dream_told: bool = False
    current_location: str = "room"
    current_outfit: str = "School Uniform"

class PersonalitySystem:
    def __init__(self, storage_dir: Path, on_update: Optional[Callable[[PersonalityState], None]] = None):
        self.storage_dir = storage_dir
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.storage_path = self.storage_dir / "personality.json"
        self.on_update = on_update
        self.state = PersonalityState()
        self.load()

    def load(self):
        if self.storage_path.exists():
            try:
                data = json.loads(self.storage_path.read_text(encoding="utf-8"))
                # Handle missing fields gracefully by merging with default
                default = asdict(PersonalityState())
                default.update(data)

                # Migration: if base_energy missing, assume current energy is base
                if "base_energy" not in data and "energy" in data:
                    default["base_energy"] = default["energy"]

                self.state = PersonalityState(**default)
            except Exception as e:
                print(f"[Personality] Failed to load state: {e}")
        
        self._update_cycle()
        self._recalc_effective_energy()
        self.state.phase = self.get_cycle_phase()
        if self.on_update:
            self.on_update(self.state)

    def save(self):
        try:
            self.storage_path.write_text(json.dumps(asdict(self.state), indent=2), encoding="utf-8")
        except Exception as e:
            print(f"[Personality] Failed to save state: {e}")

    def _recalc_effective_energy(self):
        # Simple circadian rhythm
        hour = datetime.now().hour
        time_mod = 1.0
        if 0 <= hour < 6: time_mod = 0.4      # Late night / Sleep
        elif 6 <= hour < 9: time_mod = 0.7    # Waking up
        elif 9 <= hour < 18: time_mod = 1.0   # Day peak
        elif 18 <= hour < 22: time_mod = 0.8  # Evening
        else: time_mod = 0.5                  # Night
        
        self.state.energy = max(0.0, min(1.0, self.state.base_energy * time_mod))

    def _update_cycle(self):
        now = time.time()
        if self.state.last_update_ts == 0.0:
            self.state.last_update_ts = now
            # Initialize with a random organic length if starting fresh
            self.state.current_cycle_length = random.randint(26, 32)
            self.save()
            return

        seconds_per_day = 86400
        elapsed = now - self.state.last_update_ts
        days_passed = elapsed / seconds_per_day
        
        if days_passed >= 1.0:
            full_days = int(days_passed)
            self.state.cycle_day += full_days
            
            # Handle cycle wrap-around with variable lengths
            while self.state.cycle_day > self.state.current_cycle_length:
                self.state.cycle_day -= self.state.current_cycle_length
                self.state.current_cycle_length = random.randint(26, 32)

            self.state.last_update_ts += (full_days * seconds_per_day)
            self.state.phase = self.get_cycle_phase()
            self._recalc_effective_energy()
            self.save()

    def get_cycle_phase(self) -> str:
        day = self.state.cycle_day
        if 1 <= day <= 5: return "Lower Energy, Calm"
        if 6 <= day <= 13: return "Rising Energy, Creative"
        if 14 <= day <= 16: return "Peak Energy, Social, Flirty"
        return "Calm -> Irritable/Tired"

    def update(self, affection_delta: Optional[float] = None, mood: Optional[str] = None, energy: Optional[float] = None):
        changed = False
        if affection_delta is not None:
            self.state.affection += affection_delta
            changed = True
        if mood is not None:
            self.state.mood = mood
            changed = True
        if energy is not None:
            self.state.base_energy = max(0.0, min(1.0, energy))
            changed = True
        
        if changed:
            self.state.phase = self.get_cycle_phase()
            self._recalc_effective_energy()
            self.save()
            if self.on_update:
                self.on_update(self.state)
        return self.state

    def daily_energy_reset(self) -> bool:
        """Checks if energy should be reset (after 6am, once per day)."""
        now = datetime.now()
        # Check if it's after 6 AM and we haven't reset today
        if now.hour >= 6 and now.day != self.state.last_energy_reset_day:
            print("[Personality] Daily energy reset triggered.")
            self.state.last_energy_reset_day = now.day
            
            # Mood based on affection (Long-term memory)
            aff = self.state.affection
            new_mood = "calm"
            if aff > 80: new_mood = "love"
            elif aff > 40: new_mood = "happy"
            elif aff < -20: new_mood = "sad"
            
            # Energy regeneration influenced by state
            # Generally high (regenerated), but stress (low affection) takes a toll
            new_energy = 1.0
            if aff < 0: new_energy = 0.85
            elif aff < 30: new_energy = 0.95

            self.update(energy=new_energy, mood=new_mood)
            
            # Reset dream state for the new day
            self.state.last_dream = None
            self.state.dream_told = False
            return True
        return False

    def update_weather(self, force: bool = False):
        now = time.time()
        if not force and (now - self.state.last_weather_ts) < 1800:
            return

        try:
            # 1. Get Location (IP-API)
            with urllib.request.urlopen("http://ip-api.com/json/", timeout=5) as url:
                loc_data = json.loads(url.read().decode())
                if loc_data.get("status") != "success":
                    return
                lat = loc_data['lat']
                lon = loc_data['lon']
                city = loc_data['city']

            # 2. Get Weather (Open-Meteo)
            w_url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true"
            with urllib.request.urlopen(w_url, timeout=5) as url:
                w_data = json.loads(url.read().decode())
                current = w_data.get('current_weather', {})
                temp = current.get('temperature', 20)
                wcode = current.get('weathercode', 0)
                
                desc = "Clear"
                mood_bias = None
                
                if wcode <= 1: desc, mood_bias = "Sunny", "happy"
                elif wcode <= 3: desc = "Cloudy"
                elif wcode in [45, 48]: desc, mood_bias = "Foggy", "mysterious"
                elif wcode in [51, 53, 55, 61, 63, 65, 80, 81, 82]: desc, mood_bias = "Rainy", "reflective"
                elif wcode in [71, 73, 75, 85, 86]: desc, mood_bias = "Snowy", "cozy"
                elif wcode >= 95: desc, mood_bias = "Thunderstorm", "excited"
                
                self.state.weather = f"{desc}, {temp}°C in {city}"
                self.state.last_weather_ts = now
                
                if mood_bias and self.state.mood == "neutral":
                    self.state.mood = mood_bias
                
                self.save()
                if self.on_update:
                    self.on_update(self.state)
        except Exception as e:
            print(f"[Personality] Weather update failed: {e}")

    def get_context_prompt(self) -> str:
        phase = self.get_cycle_phase()
        self._recalc_effective_energy() # Ensure energy is fresh based on time
        
        # Affection hearts logic (0-100 -> 0-10 scale)
        aff = max(0.0, min(100.0, self.state.affection))
        score = aff / 10.0
        full = int(score)
        hearts = "❤️" * full + "🤍" * (10 - full)
        
        return (
            f"**Real Data:**\n"
            f"- Affection: {hearts} ({score:.1f}/10)\n"
            f"- Cycle Day {self.state.cycle_day}/{self.state.current_cycle_length} ({phase})\n"
            f"- Mood: {self.state.mood}, Energy: {int(self.state.energy * 100)}%\n"
            f"- Weather: {self.state.weather}\n"
            f"- Current Location: {self.state.current_location}\n"
            f"- Current Outfit: {self.state.current_outfit}\n"
        )
