import React, { createContext, useContext, useState, useEffect } from 'react';

const LanguageContext = createContext();

const defaultTranslations = {
  en: {
    system: {
      window_reset: "Window '{windowId}' position reset.",
      connecting: "Connecting...",
      connected: "Connected",
      disconnected: "Disconnected",
      monikai_started: "MonikAI Started",
      monikai_stopped: "MonikAI Stopped",
      model_connected: "Model Connected",
      project_focus: "Focusing on project: {project}",
      hand_tracking_active: "Hand tracking active",
      hand_tracking_error: "Hand tracking error: {error}",
      camera_error: "Camera error",
      reading_memory: "Reading memory file...",
      memory_empty: "Memory file is empty.",
      memory_error: "Error reading memory file.",
    },
    chat: {
      you: "You",
      attachments: "Attachments",
      sent_attachments: "Sent attachments",
    }
  },
  pl: {
    system: {
      window_reset: "Zresetowano pozycję okna '{windowId}'.",
      connecting: "Łączenie...",
      connected: "Połączono",
      disconnected: "Rozłączono",
      monikai_started: "MonikAI Uruchomiona",
      monikai_stopped: "MonikAI Zatrzymana",
      model_connected: "Model Połączony",
      project_focus: "Skupienie na projekcie: {project}",
      hand_tracking_active: "Śledzenie dłoni aktywne",
      hand_tracking_error: "Błąd śledzenia dłoni: {error}",
      camera_error: "Błąd kamery",
      reading_memory: "Wczytywanie pliku pamięci...",
      memory_empty: "Plik pamięci jest pusty.",
      memory_error: "Błąd odczytu pliku pamięci.",
    },
    chat: {
      you: "Ty",
      attachments: "Załączniki",
      sent_attachments: "Wysłano załączniki",
    }
  }
};

export const LanguageProvider = ({ children }) => {
  const [language, setLanguage] = useState('pl');
  const [translations, setTranslations] = useState(defaultTranslations);

  useEffect(() => {
    const loadTranslations = () => {
      try {
        if (window.require) {
          const fs = window.require('fs');
          const path = window.require('path');
          const localePath = path.join(process.cwd(), 'data', 'locales', `${language}.json`);
          
          if (fs.existsSync(localePath)) {
            const content = fs.readFileSync(localePath, 'utf-8');
            const json = JSON.parse(content);
            setTranslations(prev => ({ ...prev, [language]: json }));
          }
        }
      } catch (err) {
        console.error("Failed to load translations:", err);
      }
    };
    loadTranslations();
  }, [language]);

  const t = (key, params = {}) => {
    const keys = key.split('.');
    
    // Helper to safely access nested objects
    const getTranslation = (langObj, keyPath) => {
      let val = langObj;
      for (const k of keyPath) {
        if (val && val[k]) val = val[k];
        else return null;
      }
      return val;
    };

    // Try current language, fallback to English
    let value = getTranslation(translations[language], keys);
    if (!value && language !== 'en') {
      value = getTranslation(translations['en'], keys);
    }

    if (typeof value !== 'string') return key;

    return value.replace(/{(\w+)}/g, (_, match) => {
      return params[match] !== undefined ? params[match] : `{${match}}`;
    });
  };

  return (
    <LanguageContext.Provider value={{ t, language, setLanguage }}>
      {children}
    </LanguageContext.Provider>
  );
};

export const useLanguage = () => useContext(LanguageContext);