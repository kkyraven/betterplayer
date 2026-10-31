import '../styles/tokens.css'
import '../styles/base.css'
import './vr.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startI18n } from '@/state/i18n'
import { VrDeck } from './VrDeck'

void startI18n()

const root = document.getElementById('root')
if (root) createRoot(root).render(<StrictMode><VrDeck /></StrictMode>)
