import React, { useMemo, useCallback } from 'react';
import { ALGORITHM_SCHEMAS, PREPROCESS_SCHEMA, POSTPROCESS_SCHEMA, LABELS_SCHEMA, getDefaults, getSchemaForAlgo } from '../schemas/AlgorithmSchemas.js';
import { useSettings } from '../hooks/useSettings.js';

/**
 * SettingsPanel — Data-Driven Settings Sidebar
 *
 * Architecture:
 * 1. ALGORITHM_SCHEMAS defines which sliders each algorithm needs.
 * 2. useSettings hook provides Two-Tier debounced state:
 *    - localSettings: updates instantly (smooth slider at 120fps)
 *    - workerSettings: debounced at 400ms (heavy engine work)
 * 3. When algorithm changes, settings reset to schema defaults.
 * 4. Global Pre-Processing uses the same Two-Tier pattern.
 *
 * Props:
 *   algo: string — current algorithm name
 *   onAlgoChange: (algo: string) => void
 *   onWorkerSettingsChange: (settings: object) => void
 *   onPreprocessChange: (settings: object) => void
 *   onPostprocessChange: (settings: object) => void
 *   onFlushSettings: () => void
 *   engineStats: { pathCount, pointCount }
 *   isProcessing: boolean
 *   canvasWarning: string | null
 */
export default function SettingsPanel({
  algo,
  onAlgoChange,
  onWorkerSettingsChange,
  onPreprocessChange,
  onPostprocessChange,
  onLabelsChange,
  onFlushSettings,
  engineStats,
  isProcessing,
  canvasWarning,
  sourcePreviewRef,
  markerColors,
  defaultActiveMarkerIds,
  onMarkerToggle,
}) {
  // ── Algorithm Settings (Two-Tier) ──────────────────────────
  const algoSchema = useMemo(() => getSchemaForAlgo(algo), [algo]);
  const algoDefaults = useMemo(() => getDefaults(algoSchema), [algoSchema]);

  const [algoLocal, algoWorker, setAlgoSetting, resetAlgoSettings, flushAlgo] = useSettings(algoDefaults, 400);

  // ── Pre-Process Settings (Two-Tier) ────────────────────────
  const preDefaults = useMemo(() => getDefaults(PREPROCESS_SCHEMA), []);
  const [preLocal, preWorker, setPreSetting, resetPreSettings, flushPre] = useSettings(preDefaults, 400);

  // ── Post-Process Settings (Two-Tier) ───────────────────────
  const postDefaults = useMemo(() => getDefaults(POSTPROCESS_SCHEMA), []);
  const [postLocal, postWorker, setPostSetting, resetPostSettings, flushPost] = useSettings(postDefaults, 400);

  // ── Artwork Labels Settings (Two-Tier) ─────────────────────
  const labelsDefaults = useMemo(() => getDefaults(LABELS_SCHEMA), []);
  const [labelsLocal, labelsWorker, setLabelsSetting, resetLabelsSettings, flushLabels] = useSettings(labelsDefaults, 400);

  // ── Notify parent when debounced settings change ───────────
  React.useEffect(() => {
    if (onWorkerSettingsChange) onWorkerSettingsChange(algoWorker);
  }, [algoWorker]);

  React.useEffect(() => {
    if (onPreprocessChange) onPreprocessChange(preWorker);
  }, [preWorker]);

  React.useEffect(() => {
    if (onPostprocessChange) onPostprocessChange(postWorker);
  }, [postWorker]);

  React.useEffect(() => {
    if (onLabelsChange) onLabelsChange(labelsWorker);
  }, [labelsWorker]);

  // ── Spot marker checked state ─────────────────────────────
  const [checkedMarkerIds, setCheckedMarkerIds] = React.useState(
    () => new Set(defaultActiveMarkerIds || [])
  );

  // ── Algorithm switch handler ───────────────────────────────
  const handleAlgoSwitch = useCallback((newAlgo) => {
    const newSchema = getSchemaForAlgo(newAlgo);
    const newDefaults = getDefaults(newSchema);
    resetAlgoSettings(newDefaults);
    if (onAlgoChange) onAlgoChange(newAlgo);
  }, [onAlgoChange, resetAlgoSettings]);

  // ── Render a single slider from schema ─────────────────────
  const renderSlider = useCallback((field, local, setter) => {
    const value = local[field.id] ?? field.default;
    const displayValue = field.suffix
      ? `${value}${field.suffix}`
      : field.type === 'range' && field.id === 'tspNodes'
        ? Number(value).toLocaleString()
        : value;

    // ── Checkbox group (row of toggle tiles) ─────────────────
    if (field.type === 'checkboxGroup') {
      return (
        <div key={field.id}>
          <label className="sidebar-label">{field.label}</label>
          <div className="grid grid-cols-4 gap-1.5">
            {field.options.map(opt => {
              const checked = !!(local[opt.id] ?? opt.default ?? true);
              return (
                <label
                  key={opt.id}
                  className={`flex items-center justify-center py-2 rounded border cursor-pointer transition-colors select-none font-mono text-base ${
                    checked
                      ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300'
                      : 'border-neutral-700/50 bg-neutral-800/30 text-neutral-500 hover:bg-neutral-700/40'
                  }`}
                >
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={checked}
                    disabled={isProcessing}
                    onChange={(e) => setter(opt.id, e.target.checked)}
                  />
                  {opt.label}
                </label>
              );
            })}
          </div>
        </div>
      );
    }

    // ── Select (dropdown) fields ─────────────────────────────
    if (field.type === 'select') {
      return (
        <div key={field.id}>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor={`slider-${field.id}`} className="sidebar-label mb-0">
              {field.label}
            </label>
          </div>
          <select
            id={`slider-${field.id}`}
            value={value}
            disabled={isProcessing}
            onChange={(e) => setter(field.id, e.target.value)}
            className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-cyan-500 transition-colors"
          >
            {(field.options || []).map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>
      );
    }

    // ── Range slider fields ──────────────────────────────────
    return (
      <div key={field.id}>
        <div className="flex items-center justify-between mb-1">
          <label htmlFor={`slider-${field.id}`} className="sidebar-label mb-0">
            {field.label}
          </label>
          <span className="value-badge">{displayValue}</span>
        </div>
        <input
          type="range"
          id={`slider-${field.id}`}
          min={field.min}
          max={field.max}
          step={field.step ?? 1}
          value={value}
          disabled={isProcessing}
          onChange={(e) => {
            const raw = e.target.value;
            const parsed = field.step != null && field.step < 1 ? parseFloat(raw) : parseInt(raw, 10);
            setter(field.id, parsed);
          }}
        />
        <div className="flex justify-between text-[10px] text-neutral-700 mt-0.5">
          <span>{field.min}{field.suffix || ''}</span>
          <span>{field.max}{field.suffix || ''}</span>
        </div>
      </div>
    );
  }, [isProcessing]);

  // ── Algorithm pills ────────────────────────────────────────
  const ALGORITHM_LIST = [
    { id: 'squiggle', label: 'Squiggle' },
    { id: 'crosshatch', label: 'Crosshatch' },
    { id: 'stipple', label: 'Stipple' },
    { id: 'flowfield', label: 'Flow Field' },
    { id: 'modulatedspiral', label: 'Modulated Spiral' },
    { id: 'vectorsvg', label: 'Vector' },
    { id: 'vectortrace', label: 'Topographic Map' },
    { id: 'skeletonize', label: 'Skeletonize' },
    { id: 'calligraphy', label: 'Calligraphy' },
    { id: 'subjectoutline',    label: 'Subject Outline' },
    { id: 'outlinecrosshatch', label: 'Outline + Hatch' },
    { id: 'staticmoire',       label: 'Static Moiré' },
    { id: 'topocontour',       label: 'Topo Contour' },
    { id: 'curvilinearnoise',  label: 'Curvilinear Noise Moiré' },
    { id: 'freqmod',           label: 'Freq. Mod. Moiré' },
    { id: 'warpedgrid',        label: 'Phase-Key Moiré' },
  ];

  return (
    <>
      {/* ── Upload Section ─────────────────────────────── */}
      <div className="panel-card">
        <h2 className="panel-title">Source</h2>
        <div id="fileZone" className="file-zone">
          <input type="file" id="fileInput" accept=".svg,.jpg,.jpeg,.png" className="hidden" />
          <div id="filePlaceholder">
            <svg className="w-7 h-7 mx-auto mb-1.5 text-cyan-400/50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <p className="text-xs text-neutral-500">Drop or click to upload</p>
            <p className="text-[10px] text-neutral-700 mt-0.5">SVG, JPG, PNG</p>
          </div>
          <div id="fileInfo" className="hidden">
            <div className="flex items-center gap-2 justify-center">
              <svg className="w-4 h-4 text-green-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span id="fileName" className="text-sm text-green-300 truncate max-w-[170px]"></span>
            </div>
            <p id="fileSize" className="text-[10px] text-neutral-600 mt-1"></p>
          </div>
        </div>
      </div>

      {/* ── Algorithm Selection ─────────────────────────── */}
      <div className="panel-card">
        <h2 className="panel-title">Algorithm</h2>
        <div className="algo-pill-group">
          {ALGORITHM_LIST.map(({ id, label }) => (
            <label
              key={id}
              className={`algo-pill${algo === id ? ' active' : ''}`}
              data-algo={id}
            >
              <input
                type="radio"
                name="algorithm"
                value={id}
                checked={algo === id}
                onChange={() => handleAlgoSwitch(id)}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      <form autoComplete="off" id="settingsForm">
        {/* ── Algorithm-Specific Settings ───────────────── */}
        {algoSchema.length > 0 && (
          <div className="panel-card space-y-3">
            <h2 className="panel-title">Algorithm Controls</h2>
            {algoSchema.map(field => renderSlider(field, algoLocal, setAlgoSetting))}
          </div>
        )}

        {/* ── Post-Processing: Curve Smoothing ──────────── */}
        {POSTPROCESS_SCHEMA.length > 0 && (
          <div className="panel-card space-y-3">
            <h2 className="panel-title">Post-Processing</h2>
            {POSTPROCESS_SCHEMA.map(field => renderSlider(field, postLocal, setPostSetting))}
          </div>
        )}

        {/* ── Artwork Labels ────────────────────────────── */}
        <div className="panel-card space-y-3">
          <h2 className="panel-title">Artwork Labels</h2>

          {/* Title Input */}
          <div>
            <label htmlFor="labelTitle" className="sidebar-label">Title</label>
            <input
              type="text"
              id="labelTitle"
              className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-cyan-500 transition-colors placeholder-neutral-600"
              placeholder="e.g. My Artwork"
              value={labelsLocal.title ?? ''}
              disabled={isProcessing}
              onChange={(e) => {
                setLabelsSetting('title', e.target.value);
              }}
            />
          </div>

          {/* Subtitle Input */}
          <div>
            <label htmlFor="labelSubtitle" className="sidebar-label">Subtitle</label>
            <input
              type="text"
              id="labelSubtitle"
              className="w-full bg-neutral-800 border border-neutral-700 rounded px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-cyan-500 transition-colors placeholder-neutral-600"
              placeholder="e.g. Generated by Vitro Vector Engine"
              value={labelsLocal.subtitle ?? ''}
              disabled={isProcessing}
              onChange={(e) => {
                setLabelsSetting('subtitle', e.target.value);
              }}
            />
          </div>

          {/* Text Scale Slider */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label htmlFor="labelTextScale" className="sidebar-label mb-0">Text Scale</label>
              <span className="value-badge">{labelsLocal.textScale ?? 1.0}</span>
            </div>
            <input
              type="range"
              id="labelTextScale"
              min="0.5"
              max="5.0"
              step="0.1"
              value={labelsLocal.textScale ?? 1.0}
              disabled={isProcessing}
              onChange={(e) => {
                setLabelsSetting('textScale', parseFloat(e.target.value));
              }}
            />
            <div className="flex justify-between text-[10px] text-neutral-700 mt-0.5">
              <span>0.5</span>
              <span>5.0</span>
            </div>
          </div>
        </div>

        {/* ── Color Mode & Engine Resolution ────────────── */}
        <div className="panel-card space-y-3">
          <h2 className="panel-title">Output Settings</h2>

          <div>
            <label htmlFor="colorMode" className="sidebar-label">Color Mode</label>
            <select id="colorMode" disabled={isProcessing}>
              <option value="monochrome">Monochrome</option>
              <option value="spot">Spot Color</option>
            </select>
          </div>

          <div id="spotMarkerGroup" className="hidden space-y-1.5">
            <label className="sidebar-label">Active Markers</label>
            <div className="grid grid-cols-2 gap-1">
              {(markerColors || []).map(marker => {
                const isActive = checkedMarkerIds.has(marker.id);
                return (
                  <label
                    key={marker.id}
                    style={isActive ? {
                      borderColor: `${marker.hex}99`,
                      backgroundColor: `${marker.hex}1A`,
                    } : {}}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded border cursor-pointer transition-colors select-none ${
                      isActive
                        ? 'border-transparent'
                        : 'border-neutral-700/50 bg-neutral-800/30 hover:bg-neutral-700/40'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isActive}
                      disabled={isProcessing}
                      onChange={(e) => {
                        const next = new Set(checkedMarkerIds);
                        if (e.target.checked) next.add(marker.id);
                        else next.delete(marker.id);
                        if (next.size === 0) return;
                        setCheckedMarkerIds(next);
                        onMarkerToggle && onMarkerToggle(marker.id, e.target.checked);
                      }}
                      className="sr-only"
                    />
                    <span
                      className="w-3 h-3 rounded-full shrink-0 transition-shadow"
                      style={{
                        background: marker.hex,
                        boxShadow: isActive ? `0 0 0 2px ${marker.hex}70` : 'none',
                      }}
                    />
                    <span className={`text-[11px] truncate transition-colors ${isActive ? 'text-white' : 'text-neutral-500'}`}>
                      {marker.label}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="engineResolution" className="sidebar-label">Internal Engine Resolution</label>
            <select id="engineResolution" defaultValue="1000" disabled={isProcessing}>
              <option value="600">Fast Preview (600px)</option>
              <option value="1000">Standard (1000px)</option>
              <option value="1500">High Detail (1500px)</option>
            </select>
          </div>
        </div>

        {/* ── Global Pre-Processing ─────────────────────── */}
        <div className="panel-card space-y-3">
          <h2 className="panel-title">Image Pre-Processing</h2>
          {PREPROCESS_SCHEMA.map(field => renderSlider(field, preLocal, setPreSetting))}

          <div className="flex items-center justify-between">
            <label htmlFor="invertPreprocessCheck" className="sidebar-label mb-0">Invert</label>
            <input type="checkbox" id="invertPreprocessCheck" className="w-4 h-4 rounded accent-cyan-500 cursor-pointer" disabled={isProcessing} />
          </div>

          {/* Source Preview Thumbnail */}
          <div>
            <label className="sidebar-label mb-1">Source Preview</label>
            <canvas ref={sourcePreviewRef} id="sourcePreview" width="200" height="200" className="w-full aspect-square rounded-lg border border-neutral-800/60 bg-neutral-950" style={{ imageRendering: 'pixelated' }}></canvas>
            <p className="text-[10px] text-neutral-600 mt-1">What the algorithm "sees" after filtering</p>
          </div>
        </div>
      </form>

      {/* ── Layout Settings ─────────────────────────────── */}
      <div className="panel-card space-y-3">
        <h2 className="panel-title">Layout</h2>

        <div>
          <label htmlFor="paperSize" className="sidebar-label">Paper Size</label>
          <select id="paperSize">
            <option value="bambu256">Bambu A1 256×256</option>
            <option value="a4">A4 210×297</option>
            <option value="a3">A3 297×420</option>
            <option value="letter">US Letter 215.9×279.4</option>
            <option value="custom">Custom</option>
          </select>
        </div>

        <div id="customSizeGroup" className="hidden grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-neutral-500 font-mono">Width (mm)</label>
            <input type="number" id="customWidth" defaultValue="256" min="10" max="1000" className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-cyan-500" />
          </div>
          <div>
            <label className="text-[10px] text-neutral-500 font-mono">Height (mm)</label>
            <input type="number" id="customHeight" defaultValue="256" min="10" max="1000" className="w-full bg-neutral-800 border border-neutral-700 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-cyan-500" />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="marginSlider" className="sidebar-label mb-0">Margin</label>
            <span id="marginValue" className="value-badge">10 mm</span>
          </div>
          <input type="range" id="marginSlider" min="0" max="50" defaultValue="10" step="1" disabled={isProcessing} />
          <div className="flex justify-between text-[10px] text-neutral-700 mt-0.5">
            <span>0 mm</span>
            <span>50 mm</span>
          </div>
        </div>
      </div>

      {/* ── Stats ───────────────────────────────────────── */}
      <div className="panel-card">
        <h2 className="panel-title">Stats</h2>
        <div className="grid grid-cols-2 gap-2">
          <div className="stat-box">
            <span className="text-neutral-600">Paths</span>
            <p className="text-white text-sm mt-0.5">
              {engineStats ? Number(engineStats.pathCount).toLocaleString() : '\u2014'}
            </p>
          </div>
          <div className="stat-box">
            <span className="text-neutral-600">Points</span>
            <p className="text-white text-sm mt-0.5">
              {engineStats ? Number(engineStats.pointCount).toLocaleString() : '\u2014'}
            </p>
          </div>
          <div className="stat-box col-span-2">
            <span className="text-neutral-600">Output Size</span>
            <p id="statGcode" className="text-white text-sm mt-0.5">&mdash;</p>
          </div>
        </div>
      </div>

      {/* ── Canvas Warning (Empty Paths Guardrail) ──────── */}
      {canvasWarning && (
        <div className="panel-card border border-amber-700/50 bg-amber-950/20">
          <p className="text-xs text-amber-400 font-medium flex items-center gap-2">
            <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            {canvasWarning}
          </p>
        </div>
      )}
    </>
  );
}
