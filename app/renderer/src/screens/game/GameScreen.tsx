// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { AppWindow, ExternalLink, Gamepad2, Lock, Monitor, Play, RefreshCw, SlidersHorizontal, Square } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { SUBSCRIBE_URL, SUPPORTER_PRICE } from '@shared/account'
import { GAME_KINDS, GAME_KIND_LABEL, SYSTEM_AUDIO, gameSource, type GameKind } from '@shared/game'
import { TRACK_SOURCE_LABEL } from '@shared/tracking'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { electron } from '@/node'
import { isFree, useAccount } from '@/state/account'
import { outputName, useDevices } from '@/state/devices'
import { hasSystemAudio, useGame } from '@/state/game'
import { useT } from '@/state/i18n'
import { useSettings } from '@/state/settings'
import { useTracking } from '@/state/tracking'
import './GameScreen.css'

export function GameScreen() {
  const t = useT()
  const free = useAccount(isFree)
  const running = useGame((s) => s.running)
  return (
    <>
      <aside className="side-list">
        <h1>
          {t('screen.game')}
          {free && <Lock className="game-lock" aria-label={t('common.supporterOnly')} />}
        </h1>
        <ul>
          <li>
            <button type="button" className="side-row on" aria-current="true">
              <Gamepad2 />
              {t('game.simple')}
            </button>
          </li>
          <li>
            <button type="button" className="side-row game-soon" disabled title={t('game.soon')}>
              <SlidersHorizontal />
              {t('game.advanced')}
              <span className="game-soon-tag">{t('game.soon')}</span>
            </button>
          </li>
        </ul>
      </aside>
      <div className="page game-page">{running ? <Running /> : <Setup free={free} />}</div>
    </>
  )
}

function Setup({ free }: { free: boolean }) {
  const t = useT()
  const kind = useSettings((s) => s.settings?.game.kind ?? 'rhythm')
  const ai = useSettings((s) => s.settings?.game.ai ?? true)
  const sources = useGame((s) => s.sources)
  const screenAccess = useGame((s) => s.screenAccess)
  const pickedId = useGame((s) => s.pickedId)
  const audioDevices = useGame((s) => s.audioDevices)
  const audioId = useGame((s) => s.audioId)
  const error = useGame((s) => s.error)
  const starting = useGame((s) => s.starting)
  const { refreshSources, refreshAudio, pick, setAudio, setKind, setAi, start } = useGame.getState()
  const rhythm = kind === 'rhythm'
  useEffect(() => {
    void refreshSources()
    void refreshAudio()
  }, [refreshSources, refreshAudio])
  const audioOptions = [...(hasSystemAudio ? [{ value: SYSTEM_AUDIO, label: t('game.systemAudio') }] : []), ...audioDevices.map((d) => ({ value: d.id, label: d.label }))]
  const canStart = pickedId !== null && (!rhythm || audioId !== '')
  return (
    <>
      <div className="page-hd">
        <h1>
          {t('game.simple')}
          {free && <Lock className="game-lock" aria-label={t('common.supporterOnly')} />}
        </h1>
      </div>
      {free && (
        <div className="game-offer">
          <Lock />
          <span>
            {t('game.supporterOnly')} <span className="game-offer-price">{t('game.priceFrom', { price: SUPPORTER_PRICE })}</span>
          </span>
          <Button variant="primary" onClick={() => void electron.shell.openExternal(SUBSCRIBE_URL)}>
            {t('firstStart.supporter.become')}
            <ExternalLink />
          </Button>
        </div>
      )}
      <div className="game-form" inert={free || starting}>
        <div className="section">
          <h3 className="eyebrow">{t('game.game')}</h3>
          <div className="panel">
            <div className="prow">
              <span className="lbl">{t('game.game')}</span>
              <span className="spacer" />
              <Segmented options={GAME_KINDS.map((k) => ({ value: k, label: t(GAME_KIND_LABEL[k]) }))} value={kind} onChange={(k: GameKind) => setKind(k)} label={t('game.game')} />
            </div>
            <div className="prow">
              <span className="lbl">{rhythm ? t('game.runs') : t('game.ai')}</span>
              <span className="spacer" />
              <span className="val">{t(TRACK_SOURCE_LABEL[gameSource(kind, ai)])}</span>
              {!rhythm && <Switch checked={ai} onCheckedChange={setAi} label={t('game.ai')} />}
            </div>
          </div>
        </div>
        <div className="section">
          <h3 className="eyebrow">
            {t('game.capture')}
            <Button variant="ghost" icon aria-label={t('common.refresh')} title={t('common.refresh')} onClick={() => void refreshSources()}>
              <RefreshCw />
            </Button>
          </h3>
          {!screenAccess ? (
            <div className="panel">
              <div className="prow">
                <span className="sub">{t('game.screenAccess')}</span>
                <span className="spacer" />
                <Button onClick={() => void invoke('game:openScreenAccess')}>{t('game.openSystemSettings')}</Button>
              </div>
            </div>
          ) : sources.length === 0 ? (
            <p className="faint">{t('game.noSources')}</p>
          ) : (
            <div className="game-captures">
              {sources.map((s) => (
                <button key={s.id} type="button" className={cx('game-capture', s.id === pickedId && 'on')} aria-pressed={s.id === pickedId} onClick={() => pick(s.id)}>
                  <span className="game-thumb">
                    {s.thumbnail ? <img src={s.thumbnail} alt="" /> : null}
                    <span className="game-kind">{s.kind === 'screen' ? <Monitor /> : <AppWindow />}</span>
                  </span>
                  <span className="n">{s.name}</span>
                  <span className="s">{t(s.kind === 'screen' ? 'game.display' : 'game.window')}</span>
                </button>
              ))}
            </div>
          )}
          {rhythm && (
            <div className="panel">
              <div className="prow">
                <span className="lbl">{t('game.audio')}</span>
                {!hasSystemAudio && <span className="sub">{t('game.audioInputHint')}</span>}
                <span className="spacer" />
                {audioOptions.length === 0 ? <span className="val">{t('game.noAudioDevice')}</span> : <Select options={audioOptions} value={audioId} onChange={setAudio} label={t('game.audio')} />}
              </div>
            </div>
          )}
        </div>
        <div className="game-start">
          <Button variant="primary" className="game-start-btn" disabled={!canStart || starting} onClick={() => void start()}>
            <Play />
            {starting ? t('game.starting') : t('game.start')}
          </Button>
          <span className={cx('game-hint', error && 'err')}>{error ?? t('game.stayOpen')}</span>
        </div>
      </div>
    </>
  )
}

function Running() {
  const t = useT()
  const stream = useGame((s) => s.stream)
  const pickedId = useGame((s) => s.pickedId)
  const name = useGame((s) => s.sources.find((x) => x.id === pickedId)?.name ?? '')
  const stop = useGame((s) => s.stop)
  const kind = useSettings((s) => s.settings?.game.kind ?? 'rhythm')
  const ai = useSettings((s) => s.settings?.game.ai ?? true)
  const audioId = useGame((s) => s.audioId)
  const audioLabel = useGame((s) => (audioId === SYSTEM_AUDIO ? t('game.systemAudio') : (s.audioDevices.find((d) => d.id === audioId)?.label ?? '')))
  const video = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = video.current
    if (!el) return
    el.srcObject = stream
    return () => {
      el.srcObject = null
    }
  }, [stream])
  const source = gameSource(kind, ai)
  return (
    <>
      <div className="page-hd">
        <h1>{t('game.simple')}</h1>
        <span className="pill-status ok">
          <span className="dot" />
          {t('game.running')}
        </span>
        <span className="spacer" />
        <Button onClick={stop}>
          <Square />
          {t('common.stop')}
        </Button>
      </div>
      <div className="section">
        <h3 className="eyebrow">{name}</h3>
        <div className="game-preview">
          <video ref={video} className="game-video" autoPlay muted playsInline />
          <div className="game-side">
            <div className="panel">
              <div className="prow">
                <span className="lbl">{t('game.live')}</span>
                <span className="spacer" />
                <LiveLine rhythm={kind === 'rhythm'} sourceLabel={t(TRACK_SOURCE_LABEL[source])} />
              </div>
            </div>
            <div className="panel">
              <div className="prow">
                <span className="lbl">{t('game.setup')}</span>
                <span className="spacer" />
                <span className="game-summary">
                  <b>{t(GAME_KIND_LABEL[kind])}</b>
                  <i>·</i>
                  <b>{t(TRACK_SOURCE_LABEL[source])}</b>
                  {kind === 'rhythm' && audioLabel && (
                    <>
                      <i>·</i>
                      <b>{audioLabel}</b>
                    </>
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function LiveLine({ rhythm, sourceLabel }: { rhythm: boolean; sourceLabel: string }) {
  const t = useT()
  const pos = useTracking((s) => Math.round((s.state?.position ?? 0.5) * 100))
  const st = useTracking((s) => s.state?.state ?? 'idle')
  const beat = useTracking((s) => s.beat)
  const outputs = useDevices((s) => s.outputs)
  const states = useDevices((s) => s.states)
  const device = outputs.find((o) => states[o.id]?.status === 'connected')
  const beatText = beat?.status === 'ready' ? null : beat?.status === 'error' ? (beat.error ?? t('tracking.bar.noBeats')) : t('tracking.bar.analysingAudio')
  return (
    <span className="game-live">
      <span className={cx('dot', rhythm ? (beat?.status === 'ready' ? 'ok' : 'warn') : st === 'tracking' ? 'ok' : 'warn')} />
      <span>{sourceLabel}</span>
      {rhythm ? (
        <>
          <span className="vsep" />
          <span className="game-bpm">
            <b>{beat?.status === 'ready' ? Math.round(beat.bpm) : '--'}</b>
            <span>BPM</span>
          </span>
          {beatText && <span className="sub">{beatText}</span>}
        </>
      ) : (
        <>
          <span className="game-bar">
            <i style={{ transform: `scaleX(${pos / 100})` }} />
          </span>
          <span className="val">{pos}</span>
        </>
      )}
      {device && (
        <>
          <span className="vsep" />
          <span className="dot ok" />
          <span>{outputName(device.config)}</span>
        </>
      )}
    </span>
  )
}
