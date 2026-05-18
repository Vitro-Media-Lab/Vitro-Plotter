import { useState, useEffect, useRef, useCallback } from 'react';

/**
 * Two-Tier Debounced State Hook
 *
 * Solves the "laggy slider" problem by maintaining two copies of settings:
 *
 * localSettings — React state that updates instantly onChange.
 *                 The slider thumb moves smoothly at 120fps without lag.
 *
 * workerSettings — React state that only updates via a useEffect
 *                  with a strict setTimeout debounce (default 400ms).
 *
 * The useEffect that posts data to the engine must only depend on
 * workerSettings, ensuring heavy path math never fires while the user
 * is actively dragging a slider.
 *
 * @param {Object} initialValues — default settings object
 * @param {number} debounceMs — debounce delay in ms (default: 400)
 * @returns {[Object, Object, Function]}
 *   [localSettings, workerSettings, setLocalSettings]
 */
export function useSettings(initialValues = {}, debounceMs = 400) {
  const [localSettings, setLocalSettings] = useState(initialValues);
  const [workerSettings, setWorkerSettings] = useState(initialValues);
  const debounceTimer = useRef(null);

  // Debounce: when localSettings changes, schedule workerSettings update
  useEffect(() => {
    // Clear any existing timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Schedule the worker settings update
    debounceTimer.current = setTimeout(() => {
      setWorkerSettings(localSettings);
    }, debounceMs);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [localSettings, debounceMs]);

  /**
   * Update a single setting by id.
   * This updates localSettings immediately (smooth slider).
   * workerSettings will follow after the debounce delay.
   */
  const updateSetting = useCallback((id, value) => {
    setLocalSettings(prev => ({
      ...prev,
      [id]: value,
    }));
  }, []);

  /**
   * Reset all settings to new values (e.g., when algorithm changes).
   * Both local and worker settings update immediately.
   */
  const resetSettings = useCallback((newValues) => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    setLocalSettings(newValues);
    setWorkerSettings(newValues);
  }, []);

  /**
   * Force flush local settings to worker immediately.
   * Useful for "change" events (not "input") like selects/checkboxes.
   */
  const flushSettings = useCallback(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    setWorkerSettings(localSettings);
  }, [localSettings]);

  return [localSettings, workerSettings, updateSetting, resetSettings, flushSettings];
}
