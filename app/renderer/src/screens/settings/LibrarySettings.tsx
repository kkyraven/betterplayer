import { useEffect, useState } from 'react'
import { normaliseSource } from '@shared/peer'
import { TAGGER_MODEL } from '@shared/tagging'
import { Button } from '@/components/ui/Button'
import { Field } from '@/components/ui/Field'
import { Switch } from '@/components/ui/Switch'
import { invoke } from '@/ipc'
import { cx } from '@/lib/cx'
import { useT } from '@/state/i18n'
import { useLibrary } from '@/state/library'
import { useRemote } from '@/state/remote'
import { useSettings } from '@/state/settings'
import { SettingsAdvanced } from './SettingsSection'
import { ModelDownloads } from './ModelDownloads'

const TAGGER = [TAGGER_MODEL]

export function LibrarySettings() {
  const t = useT()
  const autoTag = useSettings((s) => s.settings?.library.autoTag) ?? true
  const tagServers = useSettings((s) => s.settings?.library.tagServers) ?? false
  const update = useSettings((s) => s.update)
  const tagsPending = useLibrary((s) => s.progress.tagsPending)
  return (
    <div className="set-library">
      <div className="panel">
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.tagging.autoTagging')}</div>
            <div className="sub">{t('settings.tagging.autoTaggingHint')}</div>
          </span>
          <span className="spacer" />
          <Switch checked={autoTag} onCheckedChange={(autoTag) => void update((s) => ({ ...s, library: { ...s.library, autoTag } }))} label={t('settings.tagging.autoTagging')} />
        </div>
        <div className="prow">
          <span>
            <div className="lbl">{t('settings.tagging.tagServers')}</div>
            <div className="sub">{t('settings.tagging.tagServersHint')}</div>
          </span>
          <span className="spacer" />
          <Switch
            checked={tagServers}
            disabled={!autoTag}
            onCheckedChange={(tagServers) => void update((s) => ({ ...s, library: { ...s.library, tagServers } }))}
            label={t('settings.tagging.tagServers')}
          />
        </div>
        <div data-setting="tagger-download" tabIndex={-1} aria-label={t('settings.tagging.taggerDownload')}>
          <ModelDownloads models={TAGGER} />
        </div>
      </div>
      <SettingsAdvanced page="tagging">
        <div className="panel">
          <div className="prow">
            <span className="lbl">{t('settings.tagging.recalculateTags')}</span>
            <span className="spacer" />
            {tagsPending > 0 && <span className="sub mono">{tagsPending}</span>}
            <Button disabled={!autoTag || tagsPending > 0} onClick={() => void invoke('library:retag')}>
              {t('settings.tagging.recalculate')}
            </Button>
          </div>
        </div>
      </SettingsAdvanced>
    </div>
  )
}

export function SourcePanel() {
  const t = useT()
  const remote = useSettings((s) => s.settings?.remote)
  const update = useSettings((s) => s.update)
  const status = useRemote((s) => s.status)
  const stored = remote?.source
  const [sourceError, setSourceError] = useState(false)
  const [source, setSource] = useState(stored ?? '')
  useEffect(() => {
    if (stored !== undefined) setSource(stored)
  }, [stored])
  const commit = (value: string) => {
    const next = normaliseSource(value)
    if (value.trim() && !next) {
      setSourceError(true)
      return
    }
    setSourceError(false)
    setSource(next)
    if (next !== stored) void update((s) => ({ ...s, remote: { ...s.remote, source: next } }))
  }
  const storedPassword = remote?.sourcePassword
  const [password, setPassword] = useState(storedPassword ?? '')
  useEffect(() => {
    if (storedPassword !== undefined) setPassword(storedPassword)
  }, [storedPassword])
  const commitPassword = (value: string) => {
    if (value !== storedPassword) void update((s) => ({ ...s, remote: { ...s.remote, sourcePassword: value } }))
  }
  return (
    <div className="panel">
      <div className="prow">
        <Field label={t('settings.source.librarySource')}>
          <input
            className="input mono"
            placeholder="host:port"
            aria-invalid={sourceError}
            aria-describedby={sourceError ? 'source-error' : undefined}
            value={source}
            onChange={(e) => setSource(e.target.value)}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(e.currentTarget.value)
            }}
          />
        </Field>
        {sourceError && (
          <span id="source-error" className="sub error" role="alert">
            {t('settings.source.invalidAddress')}
          </span>
        )}
        <Field label={t('settings.source.password')}>
          <input
            className="input"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onBlur={(e) => commitPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitPassword(e.currentTarget.value)
            }}
          />
        </Field>
        {status.source && <span className={cx('sub', !status.connected && 'error')}>{status.connected ? t('settings.source.connected') : (status.error ?? t('settings.source.connecting'))}</span>}
      </div>
      <div className="prow">
        <span className="lbl">{t('settings.source.follow')}</span>
        <span className="spacer" />
        <Switch
          checked={remote?.follow ?? false}
          disabled={!stored}
          onCheckedChange={(follow) => void update((s) => ({ ...s, remote: { ...s.remote, follow } }))}
          label={t('settings.source.follow')}
        />
      </div>
    </div>
  )
}
