// SPDX-License-Identifier: LicenseRef-KinkyRaven-Proprietary
// Copyright (c) 2026 KinkyRaven. All rights reserved. This file is not licensed under LICENSE.txt; no permission is granted to use, copy, modify or distribute it.

import { create } from 'zustand'
import type { OwnServerId } from '@shared/dom'

export type FlowStep = 'plan' | 'signIn' | 'browser' | 'server' | 'key' | 'address' | 'model' | 'you'
export type FlowPlan = 'free' | 'supporter' | 'own'
export type SetupPage = 'ai' | 'pleasurePain' | 'advancedPain'

export interface FlowDraft {
  step: FlowStep
  plan: FlowPlan
  server: OwnServerId | null
  url: string
  models: string[]
  model: string
}

export interface OAuthState {
  provider: 'google' | 'discord'
  pending: boolean
  error: string | null
}

interface DomNav {
  flow: FlowDraft
  oauth: OAuthState
  lastSetup: SetupPage
}

export const FLOW_START: FlowDraft = { step: 'plan', plan: 'free', server: null, url: '', models: [], model: '' }

export const useDomNav = create<DomNav>()(() => ({ flow: FLOW_START, oauth: { provider: 'google', pending: false, error: null }, lastSetup: 'ai' }))

export const setFlow = (patch: Partial<FlowDraft>) => useDomNav.setState((s) => ({ flow: { ...s.flow, ...patch } }))
